import type { Db } from "../db/sql";
import { isProbeProfile, type ProbeProfile } from "../platform/media-transcoder";
import { setState } from "./kopje-state";
import { readOperation, writeOperation } from "./operation";

// The media processor's probe records (#1828 design 4.15), one set per execution profile, kept in kopje_state (not
// dumped, so a restored or imported Store probes again):
//
//   media_probe:<profile>          the verdict: the Worker version (the build) it passed or failed for, the image tag
//                                  the container reported, when (Store time), and for a pass whether Images re-encoded
//                                  its still (imagesVerified)
//   media_probe_attempt:<profile>  the last claim of a probe: its build, when, its claim token and the outcome
//                                  recorded under it (neither in one an earlier release's media rebuild wrote)
//   media_probe_failure:<profile>  the last infrastructure failure an upload met on the profile: its build and when
//
// A use is admitted while its profile's verdict passed for the running build (probePassed); an infrastructure failure
// after the pass revokes nothing and only makes the profile due for a probe again (claimProbe). One claim is shared by
// every prober of a profile: the CLI and the cron's probe round (claimProbe, recordProbeResult), and for
// `still@standard-1` the media rebuild under its lease (domain/media-rebuild.ts claimRebuildProbe and
// recordRebuildProbe). Each claims through claimProbeIn, which refuses a claim for the same build within PROBE_RETRY_MS
// of the last one when that one recorded a result, and within PROBE_CLAIM_MS when it recorded none, and records through
// recordProbeResultIn, only under the claim it is given, so two probers never both record. A claim keeps the verdict, so
// a probe that reaches none leaves admission as it was.

// The profiles probed, as the processor's client names them (platform/media-transcoder.ts PROBE_PROFILES).
export type { ProbeProfile };

// The profile an upload runs on, whose pass admits video and audio uploads (design 4.15).
export const NORMALIZE_PROFILE: ProbeProfile = "normalize@standard-4";

// How soon a profile is claimed again for the same build (design 4.15), once its claim recorded a result.
export const PROBE_RETRY_MS = 60 * 60 * 1000;
// How long a claim that recorded no result holds the profile: a probe request's whole bound and more
// (mastodon/media-activation.ts PROBE_ROUTE_MS, which a test holds under it), so a claim whose reply was lost, or whose
// request ended before its probe or its record, is over by then and holds nothing longer.
export const PROBE_CLAIM_MS = 5 * 60 * 1000;

export type ProbeRecord = {
  version: string;
  imageTag: string | null;
  at: number;
  ok: boolean;
  imagesVerified?: boolean;
};

type ProbeAttempt = {
  version: string;
  at: number;
  claim?: string;
  result?: ProbeOutcome;
};

export type ProbeFailure = { version: string; at: number };

export type ProbeOutcome = "pass" | "fail" | "no-verdict";
const OUTCOMES: readonly ProbeOutcome[] = ["pass", "fail", "no-verdict"];

const PROBE_RECORD = "media_probe:";
const PROBE_ATTEMPT = "media_probe_attempt:";
const PROBE_FAILURE = "media_probe_failure:";

export function probeName(kind: "record" | "attempt" | "failure", profile: ProbeProfile): string {
  if (!isProbeProfile(profile)) {
    throw new Error("not a recorded probe profile");
  }
  return `${kind === "record" ? PROBE_RECORD : kind === "attempt" ? PROBE_ATTEMPT : PROBE_FAILURE}${profile}`;
}

// The bounds of the stored values (RES-2): the build a Worker version id and the image tag as the container reported
// it, both printable ASCII; the tag is the processor's, so the Worker keeps one past its bound as null (probeImageTag).
// A claim token is the Store's own UUID. A stored value is read only within PROBE_VALUE_BYTES and as JSON.
const PROBE_VERSION_BYTES = 64;
const PROBE_IMAGE_TAG_BYTES = 512;
const PROBE_CLAIM_BYTES = 64;
const PROBE_VALUE_BYTES = 1024;
const PRINTABLE = /^[\x21-\x7e]+$/;

function printable(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length <= bytes && PRINTABLE.test(value);
}

export function probeImageTag(tag: string | null): string | null {
  return printable(tag, PROBE_IMAGE_TAG_BYTES) ? tag : null;
}

// An object whose keys are all of `required` and some of `optional`, or null.
function shaped(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const own = Object.keys(record);
  return required.every((key) => own.includes(key)) &&
    own.every((key) => required.includes(key) || optional.includes(key))
    ? record
    : null;
}

// A time the Store stamped: a safe integer, not after `now` (a later one is not trusted to suppress anything).
function stamped(at: unknown, now: number): boolean {
  return Number.isSafeInteger(at) && (at as number) >= 0 && (at as number) <= now;
}

function probeRecordValid(value: unknown, now: number): value is ProbeRecord {
  const record = shaped(value, ["version", "imageTag", "at", "ok"], ["imagesVerified"]);
  return (
    record !== null &&
    printable(record.version, PROBE_VERSION_BYTES) &&
    (record.imageTag === null || printable(record.imageTag, PROBE_IMAGE_TAG_BYTES)) &&
    stamped(record.at, now) &&
    typeof record.ok === "boolean" &&
    (record.imagesVerified === undefined || (record.ok && typeof record.imagesVerified === "boolean"))
  );
}

function probeAttemptValid(value: unknown, now: number): value is ProbeAttempt {
  const attempt = shaped(value, ["version", "at"], ["claim", "result"]);
  return (
    attempt !== null &&
    printable(attempt.version, PROBE_VERSION_BYTES) &&
    stamped(attempt.at, now) &&
    (attempt.claim === undefined || printable(attempt.claim, PROBE_CLAIM_BYTES)) &&
    (attempt.result === undefined || (attempt.claim !== undefined && OUTCOMES.includes(attempt.result as ProbeOutcome)))
  );
}

function probeFailureValid(value: unknown, now: number): value is ProbeFailure {
  const failure = shaped(value, ["version", "at"], []);
  return failure !== null && printable(failure.version, PROBE_VERSION_BYTES) && stamped(failure.at, now);
}

// A stored value of kopje_state as JSON, or null when it is missing, past PROBE_VALUE_BYTES or not JSON.
function storedJson(db: Db, name: string): unknown {
  const value = db.first<{ value: string }>(
    "SELECT value FROM kopje_state WHERE name = ? AND length(CAST(value AS BLOB)) <= ?",
    name,
    PROBE_VALUE_BYTES,
  )?.value;
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// Writes a value its validator accepted within PROBE_VALUE_BYTES; throws otherwise, so nothing out of bounds is stored.
function writeProbeValue(db: Db, name: string, value: unknown, valid: boolean): void {
  const text = JSON.stringify(value);
  if (!valid || new TextEncoder().encode(text).byteLength > PROBE_VALUE_BYTES) {
    throw new Error("probe record out of bounds");
  }
  setState(db, name, text);
}

export type ProbeState = { record: ProbeRecord | null; attempt: ProbeAttempt | null; failure: ProbeFailure | null };

// The profile's records at the Store's `now`. A stored value that is out of bounds, not JSON or dated after `now` reads
// as none, so it never holds a probe back or admits anything.
export function probeState(db: Db, profile: ProbeProfile, now: number): ProbeState {
  const record = storedJson(db, probeName("record", profile));
  const attempt = storedJson(db, probeName("attempt", profile));
  const failure = storedJson(db, probeName("failure", profile));
  return {
    record: probeRecordValid(record, now) ? record : null,
    attempt: probeAttemptValid(attempt, now) ? attempt : null,
    failure: probeFailureValid(failure, now) ? failure : null,
  };
}

// Whether the profile's verdict passed for `build`: what admits its use. A later infrastructure failure does not revoke
// it (design 4.15).
export function probePassed(db: Db, profile: ProbeProfile, build: string, now: number): boolean {
  const { record } = probeState(db, profile, now);
  return record !== null && record.version === build && record.ok;
}

// Whether an infrastructure failure for the verdict's build came at or after it (health shows it; the probe round
// probes again).
export function failedSince(failure: ProbeFailure | null, record: ProbeRecord): boolean {
  return failure !== null && failure.version === record.version && failure.at >= record.at;
}

// Whether the profile needs a probe for `build`: no verdict for it, a failure, a pass Images did not verify, or an
// infrastructure failure for the build at or after its pass.
export function probeDue(state: ProbeState, build: string): boolean {
  const { record, failure } = state;
  if (record === null || record.version !== build || !record.ok || record.imagesVerified === false) {
    return true;
  }
  return failedSince(failure, record);
}

export type ProbeClaim =
  | { status: "claimed"; claim: string }
  // The profile was claimed for this build within PROBE_RETRY_MS (a claim that recorded a result) or PROBE_CLAIM_MS
  // (one that recorded none): no claim before `retryAt`.
  | { status: "cooldown"; retryAt: number }
  // `due` was asked and the profile has a verified pass for this build with no failure after it.
  | { status: "not_due" };

// One claim of a probe of `profile` for `build`, shared by the CLI (`due` false: on request) and the probe round (`due`
// true: only when the profile needs one). The claim is recorded before the probe runs, with a token recordProbeResult
// must name; it keeps the verdict, so a probe that reaches none leaves admission as it was.
export const claimProbe = writeOperation.atStoreTime("now")<
  { profile: ProbeProfile; build: string; due: boolean; now: number },
  ProbeClaim
>((db, { profile, build, due, now }) => claimProbeIn(db, profile, build, due, now));

// claimProbe's decision and write, which the media rebuild's claim shares (media-rebuild.ts claimRebuildProbe), passing
// the profile's state it has read in the same transaction as `read`.
export function claimProbeIn(
  db: Db,
  profile: ProbeProfile,
  build: string,
  due: boolean,
  now: number,
  read?: ProbeState,
): ProbeClaim {
  if (!printable(build, PROBE_VERSION_BYTES)) {
    throw new Error("not a build");
  }
  const state = read ?? probeState(db, profile, now);
  if (due && !probeDue(state, build)) {
    return { status: "not_due" };
  }
  const { attempt } = state;
  if (attempt !== null && attempt.version === build) {
    const retryAt = attempt.at + (attempt.result === undefined ? PROBE_CLAIM_MS : PROBE_RETRY_MS);
    if (now < retryAt) {
      return { status: "cooldown", retryAt };
    }
  }
  const claim = crypto.randomUUID();
  const value: ProbeAttempt = { version: build, at: now, claim };
  writeProbeValue(db, probeName("attempt", profile), value, probeAttemptValid(value, now));
  return { status: "claimed", claim };
}

// The outcome of the probe `claim` started (design 4.15; its classification is the prober's): `pass` and `fail`
// replace the verdict, for the claim's build, and clear the infrastructure failure the probe answers; `no-verdict`
// leaves the verdict. Only the profile's last claim records, once: a repeat answers `recorded` and changes nothing, and
// a claim another has replaced answers `stale`. A pass whose claim is older than an infrastructure failure for its
// build answers `stale` too, recording nothing: the failure is the newer evidence, and the claim, with no result,
// holds the profile only for PROBE_CLAIM_MS.
export type ProbeResult = {
  profile: ProbeProfile;
  claim: string;
  outcome: ProbeOutcome;
  imagesVerified: boolean;
  imageTag: string | null;
};

export const recordProbeResult = writeOperation.atStoreTime("now")<
  ProbeResult & { now: number },
  { status: "recorded" } | { status: "stale" }
>((db, { now, ...result }) => recordProbeResultIn(db, result, now));

// recordProbeResult's decision and write, which the media rebuild's record shares (media-rebuild.ts
// recordRebuildProbe).
export function recordProbeResultIn(
  db: Db,
  { profile, claim, outcome, imagesVerified, imageTag }: ProbeResult,
  now: number,
): { status: "recorded" } | { status: "stale" } {
  const { attempt, failure } = probeState(db, profile, now);
  if (attempt === null || attempt.claim === undefined || attempt.claim !== claim || !OUTCOMES.includes(outcome)) {
    return { status: "stale" };
  }
  if (attempt.result !== undefined) {
    return { status: "recorded" };
  }
  if (outcome === "pass" && failure !== null && failure.version === attempt.version && failure.at > attempt.at) {
    return { status: "stale" };
  }
  if (outcome !== "no-verdict") {
    const record: ProbeRecord = {
      version: attempt.version,
      imageTag: probeImageTag(imageTag),
      at: now,
      ok: outcome === "pass",
      ...(outcome === "pass" ? { imagesVerified } : {}),
    };
    writeProbeValue(db, probeName("record", profile), record, probeRecordValid(record, now));
    db.run("DELETE FROM kopje_state WHERE name = ?", probeName("failure", profile));
  }
  const done: ProbeAttempt = { ...attempt, result: outcome };
  writeProbeValue(db, probeName("attempt", profile), done, probeAttemptValid(done, now));
  return { status: "recorded" };
}

// An upload met an infrastructure failure on `profile` under `build` (design 4.15): recorded, so the probe round
// probes the profile again; admission is not revoked.
export const recordInfrastructureFailure = writeOperation.atStoreTime("now")<
  { profile: ProbeProfile; build: string; now: number },
  { status: "recorded" }
>((db, { profile, build, now }) => {
  const failure: ProbeFailure = { version: build, at: now };
  writeProbeValue(db, probeName("failure", profile), failure, probeFailureValid(failure, now));
  return { status: "recorded" };
});

// The profile's records as the Store holds them, at its own time (the CLI and health read them; avActivation reads the
// normalize profile's).
export const probeRecords = readOperation.atStoreTime("now")<
  { profile: ProbeProfile; now: number },
  ProbeState & { now: number }
>((db, { profile, now }) => ({ ...probeState(db, profile, now), now }));
