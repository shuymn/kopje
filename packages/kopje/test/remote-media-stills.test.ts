import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeName } from "../src/domain/media-probes";
import {
  CACHED_MEDIA_BYTES,
  cachedMediaUrls,
  confirmRemoteMediaDeleted,
  DEFER_MS,
  dropAttachmentFiles,
  LANE1_HEADROOM,
  LATE_PUT_MS,
  maintainRemoteMedia,
  recordRemoteMedia,
  RETRY_DELAYS_MS,
  remoteMediaOrphans,
  REMOTE_SETTLE_MS,
  retireAccountSlots,
  retireStatusMediaSlots,
  STILL_ROUND_MS,
  type StillsActivation,
  syncAttachmentFiles,
} from "../src/domain/remote-media";
import {
  admitRemoteStill,
  claimRemoteStill,
  failRemoteStill,
  recordRemoteStill,
  STILL_CLAIM_WALK,
  STILL_LEASE_MS,
} from "../src/domain/remote-media-stills";
import { type MediaRow, presentMedia } from "../src/domain/status-presenter";
import { STILL_OUTPUT_LIMIT } from "../src/platform/av-bytes";
import { VIDEO_POSTER } from "../src/platform/brand-assets";
import { REMOTE_MEDIA_CACHE_MIN_BYTES } from "../src/platform/config";
import { R2_DELETE_KEYS, restoreMarkerKey } from "../src/platform/media-files";
import { type Restore, withMarker } from "../src/platform/restore-marker";
import type { StoreOperation } from "../src/platform/store-kernel";
import { BLURHASH_BYTES, mediaCacheSql, STILL_CHARGE_MAX } from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { BUILD, rejectionOf } from "./helpers";
import { dumpViaRpc } from "./ops-helpers";
import { mp4 } from "./remote-media-fixtures";
import { claimWith, fence, mediaWorld, type MediaWorld } from "./remote-media-helpers";

// Remote video stills, the Store's side (#1828 PR5-1; domain/remote-media-stills.ts and the cache's own transitions in
// domain/remote-media.ts): the queue in the cache's record, the claim, admission, record and failure, each charge move
// asserted on the ledger row, remote_media_usage and the audit accumulator together, the doom delay and the deletion's
// keys, and the sweep's rule for keys no row names. The operations run in one transaction each at the test's time; the
// restore marker is passed through withMarker with a counting reader, so each case states how often it was read.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
});

afterEach(() => {
  vi.useRealTimers();
});

const CAP = 4 * 1024 * 1024 * 1024;
const STILLS: StillsActivation = { binding: true, budget: 5, build: BUILD };
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

function at(w: MediaWorld, ms: number): void {
  w.clock.now = ms;
  vi.setSystemTime(ms);
}

let tokens = 0;
const token = () => `${(++tokens).toString(16).padStart(8, "0")}${"a".repeat(32)}`;

async function passStill(w: MediaWorld, build = BUILD, ok = true): Promise<void> {
  await sql(
    w.t.store,
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
    probeName("record", "still@standard-1"),
    JSON.stringify({ version: build, imageTag: null, at: w.clock.now, ok, ...(ok ? { imagesVerified: true } : {}) }),
  );
}

let videos = 0;

// A remote status's attachment of `type`, its file cached by a claim and its record with `stills`.
async function video(
  w: MediaWorld,
  options: { type?: string; preview?: string | null; blurhash?: string; stills?: StillsActivation; url?: string } = {},
) {
  const n = ++videos;
  const account = await w.remote({ avatar: null });
  const url = options.url ?? `https://files.example/v/${n}.mp4`;
  const { status, media } = await w.attach(account.id, url, {
    type: options.type ?? "video",
    preview: options.preview ?? null,
  });
  if (options.blurhash !== undefined) {
    await sql(w.t.store, "UPDATE media_attachments SET blurhash = ? WHERE id = ?", options.blurhash, media);
  }
  const claimed = await claimWith(w, token, 8);
  const claim = claimed.claims.find((c) => c.kind === "attachment")!;
  const category = claim.category;
  const contentType = category === "audio" ? "audio/mpeg" : category === "image" ? "image/png" : "video/mp4";
  expect(
    await w.op(recordRemoteMedia, {
      ...fence(claim),
      now: w.clock.now,
      outcome: { kind: "stored", contentType, stillType: null, bytes: 1000, hosts: ["files.example"], category },
      ...(options.stills === undefined ? {} : { stills: options.stills }),
    }),
  ).toEqual({ held: true });
  return { account: account.id, status, media, token: claim.token, slot: claim.slot, url };
}

type StillRow = {
  token: string;
  state: string;
  claims: number;
  due_at: number | null;
  claimed_at: number | null;
  attempt: string | null;
  outcome: string | null;
  still_charge: number;
};

const stillRows = (w: MediaWorld) => sql<StillRow>(w.t.store, "SELECT * FROM remote_media_stills ORDER BY token");
const stillOf = async (w: MediaWorld, t: string) =>
  (await sql<StillRow>(w.t.store, "SELECT * FROM remote_media_stills WHERE token = ?", t))[0];
const slotOf = async (w: MediaWorld, slot: string) =>
  (
    await sql<{
      token: string | null;
      still_ext: string | null;
      still_key: string | null;
      still_blurhash: string | null;
    }>(w.t.store, "SELECT token, still_ext, still_key, still_blurhash FROM remote_media WHERE id = ?", slot)
  )[0];
const leaseOf = async (w: MediaWorld) => {
  const [row] = await sql<{ value: string }>(
    w.t.store,
    "SELECT value FROM kopje_state WHERE name = 'remote_still_lease'",
  );
  return row === undefined ? null : (JSON.parse(row.value) as { holder: string; until: number });
};
const chargeOf = async (w: MediaWorld, t: string) =>
  (await sql<{ charge: number }>(w.t.store, "SELECT charge FROM remote_media_objects WHERE token = ?", t))[0]?.charge;

// The operation `op` at the world's time with the restore marker `marker`, read through withMarker: its answer and the
// marker reads.
async function marked<I extends object, O>(
  w: MediaWorld,
  op: StoreOperation<never, O>,
  input: I,
  marker: Restore = null,
): Promise<{ out: O; reads: number }> {
  let reads = 0;
  const out = await withMarker(
    (restoredAt) => w.op(op as StoreOperation<object, O>, { ...input, now: w.clock.now, restoredAt }),
    () => {
      reads++;
      return Promise.resolve(marker);
    },
  );
  return { out, reads };
}

const claim = (w: MediaWorld, marker: Restore = null, input: Partial<StillsActivation & { cap: number }> = {}) =>
  marked(w, claimRemoteStill, { ...STILLS, cap: CAP, ...input }, marker);
const recordStill = (w: MediaWorld, t: string, attempt: string, bytes = 5000, marker: Restore = null) =>
  marked(w, recordRemoteStill, { token: t, attempt, facts: { bytes, blurhash: BLURHASH } }, marker);
const failStill = (
  w: MediaWorld,
  t: string,
  attempt: string,
  outcome: "retry" | "park" = "retry",
  keepLease = false,
  marker: Restore = null,
) => marked(w, failRemoteStill, { token: t, attempt, outcome, keepLease }, marker);
const admit = (w: MediaWorld, t: string, attempt: string, marker: Restore = null) =>
  marked(w, admitRemoteStill, { token: t, attempt }, marker);

// Charge totals: the ledger's sums equal the usage row, and the audit, started before the change with every token
// behind its cursor, completes after it without drift (chargeObject's accumulator kept the change).
async function auditBehind(w: MediaWorld): Promise<void> {
  const [sums] = await sql<{ bytes: number; doomed: number }>(
    w.t.store,
    `SELECT coalesce(sum(charge), 0) AS bytes, coalesce(sum(CASE state WHEN 'doomed' THEN charge ELSE 0 END), 0) AS doomed
			FROM remote_media_objects`,
  );
  await sql(
    w.t.store,
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('remote_media_audit', ?)",
    JSON.stringify({ cursor: "z".repeat(64), ...sums }),
  );
}

async function totalsAgree(w: MediaWorld): Promise<void> {
  await w.exact();
  const done = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
  expect(done.drift).toBeNull();
}

describe("the queue (P18a, P18b)", () => {
  it.each([
    ["a video without a preview", {}, true],
    ["a gifv without a preview", { type: "gifv" }, true],
    ["a preview of ''", { preview: "" }, true],
    ["a preview that is the file with a fragment", { preview: "FILE#t=1" }, true],
    ["a blurhash of its own", { blurhash: BLURHASH }, true],
    ["an icon of its own", { preview: "https://files.example/icon.png" }, false],
    ["audio", { type: "audio" }, false],
    ["an image", { type: "image" }, false],
  ] as const)("for %s: queued %s", async (_name, options, queued) => {
    const w = await mediaWorld();
    await passStill(w);
    const url = `https://files.example/q/${++videos}.mp4`;
    const v = await video(w, {
      ...options,
      ...("preview" in options ? { preview: options.preview.replace("FILE", url) } : {}),
      url,
      stills: STILLS,
    });
    expect(await stillRows(w)).toEqual(
      queued
        ? [
            {
              token: v.token,
              state: "queued",
              claims: 0,
              due_at: w.clock.now,
              claimed_at: null,
              attempt: null,
              outcome: null,
              still_charge: 0,
            },
          ]
        : [],
    );
  });

  it.each([
    ["no stills input", undefined, true],
    ["a budget of 0", { ...STILLS, budget: 0 }, true],
    ["no binding", { ...STILLS, binding: false }, true],
    ["no pass", STILLS, false],
    ["another build's pass", { ...STILLS, build: "other-build" }, true],
  ] as const)("queues none with %s", async (_name, stills, pass) => {
    const w = await mediaWorld();
    if (pass) {
      await passStill(w);
    }
    await video(w, stills === undefined ? {} : { stills });
    expect(await stillRows(w)).toEqual([]);
    // The control: the same video with stills active is queued.
    await passStill(w);
    await video(w, { stills: STILLS });
    expect(await stillRows(w)).toHaveLength(1);
  });

  it("queues none with a failed probe for the build", async () => {
    const w = await mediaWorld();
    await passStill(w, BUILD, false);
    await video(w, { stills: STILLS });
    expect(await stillRows(w)).toEqual([]);
  });

  it("commits the queue and the object's record together: a refused queue insert rolls the record back", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await sql(
      w.t.store,
      "CREATE TRIGGER test_refuse_still BEFORE INSERT ON remote_media_stills BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const account = await w.remote({ avatar: null });
    await w.attach(account.id, "https://files.example/v/rolled.mp4", { type: "video" });
    const claimed = (await claimWith(w, token, 8)).claims[0]!;
    const usage = await w.usage();
    const recorded = w.op(recordRemoteMedia, {
      ...fence(claimed),
      now: w.clock.now,
      outcome: {
        kind: "stored",
        contentType: "video/mp4",
        stillType: null,
        bytes: 1000,
        hosts: ["files.example"],
        category: "video",
      },
      stills: STILLS,
    });
    expect(String(await rejectionOf(recorded))).toContain("refused");
    expect(await w.objects()).toMatchObject([{ token: claimed.token, state: "reserved" }]);
    expect(await slotOf(w, claimed.slot)).toMatchObject({ token: null });
    expect(await w.usage()).toEqual(usage);
  });
});

describe("the claim (P19a)", () => {
  it.each([
    ["the cap off", { cap: REMOTE_MEDIA_CACHE_MIN_BYTES - 1 }, "cap"],
    ["a budget of 0", { budget: 0 }, "inactive"],
    ["no binding", { binding: false }, "inactive"],
    ["another build", { build: "other-build" }, "inactive"],
  ] as const)("answers idle before the marker with %s", async (_name, input, reason) => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w, { stills: STILLS });
    expect(await claim(w, "unknown", input)).toEqual({ out: { status: "idle", reason }, reads: 0 });
    // The control: claimed, the marker read once.
    expect(await claim(w)).toMatchObject({ out: { status: "claimed" }, reads: 1 });
  });

  it("answers idle before the marker when the month's unit is spent, the lease is live or nothing is due", async () => {
    const w = await mediaWorld();
    await passStill(w);
    expect(await claim(w, "unknown")).toEqual({ out: { status: "idle", reason: "none" }, reads: 0 });
    const a = await video(w, { stills: STILLS });
    await video(w, { stills: STILLS });
    const first = await claim(w, null, { budget: 2 });
    expect(first).toMatchObject({ out: { status: "claimed", token: a.token, claims: 1 }, reads: 1 });
    expect(await claim(w, "unknown", { budget: 2 })).toEqual({ out: { status: "idle", reason: "leased" }, reads: 0 });
    at(w, w.clock.now + STILL_LEASE_MS);
    expect(await claim(w, null, { budget: 2 })).toMatchObject({ out: { status: "claimed", claims: 1 } });
    at(w, w.clock.now + STILL_LEASE_MS);
    // Two units spent this month: no claim, no unit.
    expect(await claim(w, "unknown", { budget: 2 })).toEqual({ out: { status: "idle", reason: "spent" }, reads: 0 });
    const [spent] = await sql<{ value: string }>(
      w.t.store,
      "SELECT value FROM kopje_state WHERE name = ?",
      `media_still_jobs:${new Date(w.clock.now).toISOString().slice(0, 7)}`,
    );
    expect(spent?.value).toBe("2");
    // The month turns: a unit again.
    at(w, Date.UTC(2026, 11, 1));
    expect(await claim(w, null, { budget: 2 })).toMatchObject({ out: { status: "claimed" } });
  });

  it("refuses while a restore settles or awaits its validation, and on an unknown marker", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w, { stills: STILLS });
    expect(await claim(w, w.clock.now - REMOTE_SETTLE_MS + 1)).toEqual({ out: { status: "restoring" }, reads: 1 });
    expect(await claim(w, w.clock.now - REMOTE_SETTLE_MS)).toEqual({ out: { status: "restoring" }, reads: 1 });
    expect(String(await rejectionOf(claim(w, "unknown")))).toMatch(/maintenance|transient|unavailable/i);
    await sql(
      w.t.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('remote_media_validated_at', ?)",
      String(w.clock.now - REMOTE_SETTLE_MS),
    );
    expect(await claim(w, w.clock.now - REMOTE_SETTLE_MS)).toMatchObject({ out: { status: "claimed" }, reads: 1 });
    expect(await stillRows(w)).toHaveLength(1);
  });

  it("is refused by the Store in readonly maintenance (a write)", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w, { stills: STILLS });
    await sql(w.t.store, "INSERT INTO kopje_state (name, value) VALUES ('maintenance', ?)", JSON.stringify({ at: 1 }));
    expect(await rejectionOf(w.t.store.claimRemoteStill(BUILD, { ...STILLS, cap: CAP }))).toBeInstanceOf(Error);
    expect(await stillRows(w)).toMatchObject([{ claims: 0 }]);
    await sql(w.t.store, "DELETE FROM kopje_state WHERE name = 'maintenance'");
    expect(await w.t.store.claimRemoteStill(BUILD, { ...STILLS, cap: CAP })).toMatchObject({ status: "claimed" });
  });

  it("reserves STILL_OUTPUT_LIMIT, a unit, a fresh attempt and the lease, with exact charge totals", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    await auditBehind(w);
    const before = await chargeOf(w, v.token);
    const { out } = await claim(w);
    expect(out).toMatchObject({ status: "claimed", token: v.token, claims: 1 });
    const attempt = (out as { attempt: string }).attempt;
    expect(attempt).toMatch(/^[0-9a-f]{32}$/);
    expect(await stillOf(w, v.token)).toMatchObject({
      state: "queued",
      claims: 1,
      claimed_at: w.clock.now,
      attempt,
      outcome: null,
      still_charge: STILL_OUTPUT_LIMIT,
      due_at: w.clock.now + LATE_PUT_MS,
    });
    expect(await chargeOf(w, v.token)).toBe(before! + STILL_OUTPUT_LIMIT);
    expect(await leaseOf(w)).toEqual({ holder: attempt, until: w.clock.now + STILL_LEASE_MS });
    await totalsAgree(w);
  });

  it("admits a claim at exactly the cap less LANE1_HEADROOM, defers one byte over, and claims once room is made", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const bytes = (await w.usage()).bytes;
    const cap = REMOTE_MEDIA_CACHE_MIN_BYTES;
    // The usage padded (a filler of other cached files) so that one more reservation lands one byte past the limit.
    const fit = cap - LANE1_HEADROOM - STILL_OUTPUT_LIMIT - bytes;
    const pad = (n: number) => sql(w.t.store, "UPDATE remote_media_usage SET bytes = bytes + ?", n);
    await pad(fit + 1);
    expect(await claim(w, null, { cap })).toMatchObject({ out: { status: "walked", deferred: 1 } });
    expect(await stillOf(w, v.token)).toMatchObject({ claims: 0, due_at: w.clock.now + DEFER_MS, still_charge: 0 });
    expect(await leaseOf(w)).toBeNull();
    // Room made (one byte of the filler released, as reclamation's confirmed deletions do): at exactly the limit, the
    // claim succeeds once DEFER_MS has passed.
    await pad(-1);
    expect(await claim(w, null, { cap })).toEqual({ out: { status: "idle", reason: "none" }, reads: 0 });
    at(w, w.clock.now + DEFER_MS);
    expect(await claim(w, null, { cap })).toMatchObject({ out: { status: "claimed", token: v.token } });
    await pad(-fit);
    await w.exact();
  });

  it("replaces an unsettled reservation of a due retry at exactly the cap less LANE1_HEADROOM (net 0)", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const first = (await claim(w)).out as { attempt: string };
    // The round died: its row is due again LATE_PUT_MS after the claim, its reservation unsettled.
    at(w, w.clock.now + LATE_PUT_MS);
    await auditBehind(w);
    const bytes = (await w.usage()).bytes;
    const pad = REMOTE_MEDIA_CACHE_MIN_BYTES;
    await sql(w.t.store, "UPDATE remote_media_usage SET bytes = bytes + ?", pad);
    // The limit is the bytes charged now: only the net delta (0) fits.
    const { out } = await claim(w, null, { cap: bytes + pad + LANE1_HEADROOM });
    expect(out).toMatchObject({ status: "claimed", token: v.token, claims: 2 });
    expect((out as { attempt: string }).attempt).not.toBe(first.attempt);
    await sql(w.t.store, "UPDATE remote_media_usage SET bytes = bytes - ?", pad);
    expect(await stillOf(w, v.token)).toMatchObject({ still_charge: STILL_OUTPUT_LIMIT, claims: 2 });
    await totalsAgree(w);
  });

  it("deletes a due row whose video gained an icon, releasing its unsettled reservation", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    await claim(w);
    const reserved = await chargeOf(w, v.token);
    at(w, w.clock.now + LATE_PUT_MS);
    await sql(
      w.t.store,
      "UPDATE media_attachments SET preview_url = ? WHERE id = ?",
      "https://files.example/i.png",
      v.media,
    );
    await auditBehind(w);
    expect(await claim(w)).toMatchObject({ out: { status: "walked", deleted: 1, deferred: 0 } });
    expect(await stillRows(w)).toEqual([]);
    expect(await chargeOf(w, v.token)).toBe(reserved! - STILL_OUTPUT_LIMIT);
    await totalsAgree(w);
  });

  it("leaves a doomed object's row and charge to its deletion", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const { out } = await claim(w);
    const attempt = (out as { attempt: string }).attempt;
    const charged = await chargeOf(w, v.token);
    const usage = await w.usage();
    await w.db((d) => dropAttachmentFiles(d, v.media, w.clock.now));
    at(w, w.clock.now + LATE_PUT_MS);
    expect(await claim(w)).toEqual({ out: { status: "idle", reason: "none" }, reads: 0 });
    expect(await stillOf(w, v.token)).toMatchObject({ attempt, still_charge: STILL_OUTPUT_LIMIT, claims: 1 });
    expect(await chargeOf(w, v.token)).toBe(charged);
    expect(
      await w.op(confirmRemoteMediaDeleted, { results: [{ token: v.token, deleted: true }], now: w.clock.now }),
    ).toEqual({ confirmed: 1 });
    expect(await stillRows(w)).toEqual([]);
    expect(await w.usage()).toEqual({ ...usage, bytes: usage.bytes - charged!, doomed: 0, pending: usage.pending });
    await w.exact();
  });

  it("stops after STILL_CLAIMS claims", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    for (const n of [1, 2, 3]) {
      const { out } = await claim(w);
      expect(out).toMatchObject({ status: "claimed", claims: n });
      await failStill(w, v.token, (out as { attempt: string }).attempt);
      at(w, w.clock.now + RETRY_DELAYS_MS[2] + LATE_PUT_MS);
    }
    expect(await stillOf(w, v.token)).toMatchObject({ claims: 3, due_at: null, outcome: "retry", still_charge: 0 });
    expect(await claim(w)).toEqual({ out: { status: "idle", reason: "none" }, reads: 0 });
  });

  it("walks at most STILL_CLAIM_WALK due rows: past that many dead ones, it reaches a live one the next tick", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const dead = [];
    for (let i = 0; i < STILL_CLAIM_WALK; i++) {
      dead.push(await video(w, { stills: STILLS }));
      at(w, w.clock.now + 1);
    }
    const live = await video(w, { stills: STILLS });
    for (const v of dead) {
      await sql(
        w.t.store,
        "UPDATE media_attachments SET preview_url = ? WHERE id = ?",
        "https://files.example/i.png",
        v.media,
      );
    }
    expect(await claim(w)).toMatchObject({ out: { status: "walked", deleted: STILL_CLAIM_WALK } });
    // No lease without a claim.
    expect(await leaseOf(w)).toBeNull();
    expect(await claim(w)).toMatchObject({ out: { status: "claimed", token: live.token } });
  });
});

describe("admission (P19d, the Store's part)", () => {
  it("admits the lease's attempt only, and refuses a settled, stale or pre-restore attempt", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const claimedAt = w.clock.now;
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    expect(await admit(w, v.token, attempt)).toEqual({ out: { admitted: true }, reads: 1 });
    expect(await admit(w, v.token, "f".repeat(32), "unknown")).toEqual({ out: { admitted: false }, reads: 0 });
    // A restore at or after the claim.
    expect(await admit(w, v.token, attempt, claimedAt)).toEqual({ out: { admitted: false }, reads: 1 });
    // reject_media on the author's domain: no longer eligible.
    await sql(
      w.t.store,
      "UPDATE media_attachments SET preview_url = 'https://files.example/i.png' WHERE id = ?",
      v.media,
    );
    expect(await admit(w, v.token, attempt)).toEqual({ out: { admitted: false }, reads: 0 });
    await sql(w.t.store, "UPDATE media_attachments SET preview_url = NULL WHERE id = ?", v.media);
    // An expired lease.
    at(w, w.clock.now + STILL_LEASE_MS);
    expect(await admit(w, v.token, attempt)).toEqual({ out: { admitted: false }, reads: 0 });
    at(w, w.clock.now - STILL_LEASE_MS);
    // A settled attempt.
    await failStill(w, v.token, attempt, "retry", true);
    expect(await admit(w, v.token, attempt)).toEqual({ out: { admitted: false }, reads: 0 });
  });
});

describe("the record (P19b)", () => {
  it("names the still on the slot and moves the reservation to its bytes, once, with exact charge totals", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    const reserved = await chargeOf(w, v.token);
    await auditBehind(w);
    expect(await recordStill(w, v.token, attempt, 5000)).toEqual({ out: { status: "recorded" }, reads: 1 });
    expect(await slotOf(w, v.slot)).toEqual({
      token: v.token,
      still_ext: "webp",
      still_key: `s${attempt}`,
      still_blurhash: BLURHASH,
    });
    expect(await stillOf(w, v.token)).toMatchObject({ state: "stored", due_at: null, still_charge: 5000 });
    expect(await chargeOf(w, v.token)).toBe(reserved! - STILL_OUTPUT_LIMIT + 5000);
    expect(await leaseOf(w)).toBeNull();
    // A repeat answers recorded before the marker, after a restore to a bookmark after the commit too.
    expect(await recordStill(w, v.token, attempt, 5000, "unknown")).toEqual({ out: { status: "recorded" }, reads: 0 });
    expect(await chargeOf(w, v.token)).toBe(reserved! - STILL_OUTPUT_LIMIT + 5000);
    await totalsAgree(w);
  });

  it("refuses bytes of 0 or past STILL_OUTPUT_LIMIT, and a record at claimed_at + STILL_ROUND_MS", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const claimedAt = w.clock.now;
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    expect(STILL_OUTPUT_LIMIT).toBe(STILL_CHARGE_MAX);
    for (const bytes of [0, STILL_OUTPUT_LIMIT + 1]) {
      expect(await recordStill(w, v.token, attempt, bytes)).toEqual({ out: { status: "refused" }, reads: 0 });
    }
    at(w, claimedAt + STILL_ROUND_MS);
    expect(await recordStill(w, v.token, attempt, STILL_OUTPUT_LIMIT)).toEqual({
      out: { status: "refused" },
      reads: 0,
    });
    at(w, claimedAt + STILL_ROUND_MS - 1);
    expect(await recordStill(w, v.token, attempt, STILL_OUTPUT_LIMIT)).toEqual({
      out: { status: "recorded" },
      reads: 1,
    });
  });

  it.each([
    [
      "an icon added mid-flight",
      "UPDATE media_attachments SET preview_url = 'https://files.example/i.png' WHERE id = ?",
    ],
    [
      "the status withdrawn",
      "UPDATE statuses SET withdrawn = 1 WHERE id = (SELECT status_id FROM media_attachments WHERE id = ?)",
    ],
  ])("refuses after %s, changing nothing", async (_name, change) => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await sql(w.t.store, change, v.media);
    const before = {
      row: await stillOf(w, v.token),
      charge: await chargeOf(w, v.token),
      slot: await slotOf(w, v.slot),
    };
    expect(await recordStill(w, v.token, attempt)).toEqual({ out: { status: "refused" }, reads: 0 });
    expect({
      row: await stillOf(w, v.token),
      charge: await chargeOf(w, v.token),
      slot: await slotOf(w, v.slot),
    }).toEqual(before);
  });

  it("refuses after the slot was reset to another URL", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await sql(
      w.t.store,
      "UPDATE media_attachments SET url = ? WHERE id = ?",
      "https://files.example/other.mp4",
      v.media,
    );
    await w.db((d) => syncAttachmentFiles(d, v.media, w.clock.now));
    expect(await recordStill(w, v.token, attempt)).toEqual({ out: { status: "refused" }, reads: 0 });
  });

  it("fences on the attempt across a restore: an old attempt with the same claim number neither records nor fails", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const taken = await bookmark(w);
    const a = ((await claim(w)).out as { attempt: string }).attempt;
    // A restore to the bookmark (claims 0), validated after its settle period.
    at(w, w.clock.now + 1000);
    const restoredAt = w.clock.now;
    await restoreTo(w, taken);
    at(w, restoredAt + REMOTE_SETTLE_MS);
    await sql(
      w.t.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('remote_media_validated_at', ?)",
      String(restoredAt),
    );
    const { out } = await claim(w, restoredAt);
    expect(out).toMatchObject({ status: "claimed", claims: 1 });
    const b = (out as { attempt: string }).attempt;
    expect(b).not.toBe(a);
    // The old attempt is refused before the marker; the new one records.
    expect(await recordStill(w, v.token, a, 5000, restoredAt)).toEqual({ out: { status: "refused" }, reads: 0 });
    expect(await failStill(w, v.token, a, "retry", false, restoredAt)).toEqual({ out: { status: "stale" }, reads: 0 });
    expect(await recordStill(w, v.token, b, 5000, restoredAt)).toEqual({ out: { status: "recorded" }, reads: 1 });
  });

  it("refuses an attempt claimed before the last restore whose bookmark kept it current (W-S8)", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const a = ((await claim(w)).out as { attempt: string }).attempt;
    at(w, w.clock.now + 1000);
    const restoredAt = w.clock.now;
    expect(await recordStill(w, v.token, a, 5000, restoredAt)).toEqual({ out: { status: "refused" }, reads: 1 });
    expect(await failStill(w, v.token, a, "retry", false, restoredAt)).toEqual({ out: { status: "stale" }, reads: 1 });
    expect(await admit(w, v.token, a, restoredAt)).toEqual({ out: { admitted: false }, reads: 1 });
    expect(await stillOf(w, v.token)).toMatchObject({ attempt: a, outcome: null, still_charge: STILL_OUTPUT_LIMIT });
  });
});

describe("the failure (P19c, the Store's part)", () => {
  it("settles a retry once, releasing its reservation; a replay at a later clock changes nothing", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const claimedAt = w.clock.now;
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    const reserved = await chargeOf(w, v.token);
    await auditBehind(w);
    at(w, claimedAt + 1000);
    expect(await failStill(w, v.token, attempt, "retry", true)).toEqual({
      out: { status: "settled", outcome: "retry" },
      reads: 1,
    });
    const due = Math.max(claimedAt + LATE_PUT_MS, claimedAt + 1000 + RETRY_DELAYS_MS[0]);
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "retry", still_charge: 0, due_at: due });
    expect(await chargeOf(w, v.token)).toBe(reserved! - STILL_OUTPUT_LIMIT);
    // keepLease: the lease stays.
    expect(await leaseOf(w)).toMatchObject({ holder: attempt });
    at(w, claimedAt + 5 * 60 * 60 * 1000);
    expect(await failStill(w, v.token, attempt, "park", false, "unknown")).toEqual({
      out: { status: "settled", outcome: "retry" },
      reads: 0,
    });
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "retry", still_charge: 0, due_at: due });
    expect(await chargeOf(w, v.token)).toBe(reserved! - STILL_OUTPUT_LIMIT);
    // The replay released the lease its attempt held.
    expect(await leaseOf(w)).toBeNull();
    await totalsAgree(w);
  });

  it("parks on the first claim, and settles a failure past claimed_at + STILL_ROUND_MS", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    at(w, w.clock.now + STILL_ROUND_MS + 1);
    expect(await failStill(w, v.token, attempt, "park")).toEqual({
      out: { status: "settled", outcome: "park" },
      reads: 1,
    });
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "park", still_charge: 0, due_at: null, claims: 1 });
    await w.exact();
  });

  it("answers doomed on a doomed object and changes nothing; the deletion then releases every charge", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const usage = await w.usage();
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await w.db((d) => dropAttachmentFiles(d, v.media, w.clock.now));
    const before = { row: await stillOf(w, v.token), charge: await chargeOf(w, v.token), usage: await w.usage() };
    expect(await failStill(w, v.token, attempt)).toEqual({ out: { status: "doomed" }, reads: 1 });
    expect({ row: await stillOf(w, v.token), charge: await chargeOf(w, v.token), usage: await w.usage() }).toEqual(
      before,
    );
    at(w, w.clock.now + LATE_PUT_MS);
    expect(
      await w.op(confirmRemoteMediaDeleted, { results: [{ token: v.token, deleted: true }], now: w.clock.now }),
    ).toEqual({ confirmed: 1 });
    expect(await w.usage()).toEqual({ bytes: usage.bytes - 1000, doomed: 0, pending: usage.pending });
    await w.exact();
  });

  it("releases the lease only for its holder: a stale release after a newer lease changes nothing", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const a = await video(w, { stills: STILLS });
    const b = await video(w, { stills: STILLS });
    const first = ((await claim(w)).out as { attempt: string }).attempt;
    at(w, w.clock.now + STILL_LEASE_MS);
    const second = ((await claim(w)).out as { attempt: string }).attempt;
    expect(await failStill(w, a.token, first, "retry", false)).toMatchObject({ out: { status: "settled" } });
    expect(await leaseOf(w)).toMatchObject({ holder: second });
    expect(await failStill(w, b.token, second, "retry", false)).toMatchObject({ out: { status: "settled" } });
    expect(await leaseOf(w)).toBeNull();
  });
});

describe("dooms and deletions (P20d)", () => {
  // Each caller that dooms a slot's object, run on a video whose still was claimed now.
  const callers = {
    "a dropped attachment": (w: MediaWorld, v: Awaited<ReturnType<typeof video>>) =>
      w.db((d) => dropAttachmentFiles(d, v.media, w.clock.now)),
    "a reset slot": async (w: MediaWorld, v: Awaited<ReturnType<typeof video>>) => {
      await sql(w.t.store, "UPDATE media_attachments SET url = ? WHERE id = ?", `${v.url}?2`, v.media);
      await w.db((d) => syncAttachmentFiles(d, v.media, w.clock.now));
    },
    "a removed status": (w: MediaWorld, v: Awaited<ReturnType<typeof video>>) =>
      w.db((d) => retireStatusMediaSlots(d, v.status, { left: () => 100 }, w.clock.now)),
    "a purged account": (w: MediaWorld, v: Awaited<ReturnType<typeof video>>) =>
      w.db((d) => retireAccountSlots(d, v.account, { left: () => 100 }, w.clock.now)),
    "the validity walk": async (w: MediaWorld, v: Awaited<ReturnType<typeof video>>) => {
      await sql(w.t.store, "UPDATE statuses SET withdrawn = 1 WHERE id = ?", v.status);
      await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
    },
  } as const;

  it.each(Object.keys(callers) as (keyof typeof callers)[])(
    "%s with a still claimed: deletion due at claimed_at + LATE_PUT_MS, of `full` alone",
    async (name) => {
      const w = await mediaWorld();
      await passStill(w);
      const v = await video(w, { stills: STILLS });
      const claimedAt = w.clock.now;
      await claim(w);
      at(w, claimedAt + 1000);
      await callers[name](w, v);
      expect(await w.objects()).toMatchObject([{ token: v.token, state: "doomed", due_at: claimedAt + LATE_PUT_MS }]);
      at(w, claimedAt + LATE_PUT_MS - 1);
      const early = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
      expect(early.deletions).toEqual([]);
      at(w, claimedAt + LATE_PUT_MS);
      const due = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
      expect(due.deletions).toEqual([[{ token: v.token, keys: [`remote/${v.token}/full`] }]]);
    },
  );

  it("a doom of a video without a claimed still is due at once, with main's keys", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    await w.db((d) => dropAttachmentFiles(d, v.media, w.clock.now));
    const due = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
    expect(due.deletions).toEqual([[{ token: v.token, keys: [`remote/${v.token}/full`, `remote/${v.token}/still`] }]]);
  });

  it("deletes `full` and the named still of a recorded still, and confirmed deletion releases the recorded charge", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const usage = await w.usage();
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await recordStill(w, v.token, attempt, 5000);
    expect(await chargeOf(w, v.token)).toBe(1000 + 5000);
    at(w, w.clock.now + LATE_PUT_MS);
    await w.db((d) => dropAttachmentFiles(d, v.media, w.clock.now));
    const due = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
    expect(due.deletions).toEqual([
      [{ token: v.token, keys: [`remote/${v.token}/full`, `remote/${v.token}/s${attempt}`] }],
    ]);
    await w.op(confirmRemoteMediaDeleted, { results: [{ token: v.token, deleted: true }], now: w.clock.now });
    expect(await w.usage()).toEqual({ bytes: usage.bytes - 1000, doomed: 0, pending: usage.pending });
    await w.exact();
  });

  it("keeps a deletion group of DELETE_BATCH objects with named stills within R2_DELETE_KEYS", async () => {
    const w = await mediaWorld();
    const n = 500;
    await sql(
      w.t.store,
      `WITH RECURSIVE i(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM i WHERE n < ?1)
			INSERT INTO remote_media_objects (token, state, charge, kind, content_type, claimed_at, stored_at, due_at)
			SELECT printf('%032d', n), 'doomed', 2, 'attachment', 'video/mp4', 1, 1, 1 FROM i`,
      n,
    );
    await sql(
      w.t.store,
      `INSERT INTO remote_media_stills (token, state, claims, claimed_at, attempt, still_charge)
			SELECT token, 'stored', 1, 1, lower(hex(randomblob(16))), 1 FROM remote_media_objects`,
    );
    const due = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt: null, cap: CAP, retentionDays: 0 });
    expect(due.deletions).toHaveLength(1);
    const keys = due.deletions[0]!.flatMap((d) => d.keys);
    expect(keys).toHaveLength(2 * n);
    expect(keys.length).toBeLessThanOrEqual(R2_DELETE_KEYS);
    expect(keys.filter((k) => /\/s[0-9a-f]{32}$/.test(k))).toHaveLength(n);
  });
});

describe("the sweep's rule for keys no row names (P20f)", () => {
  const sweep = (w: MediaWorld, keys: { key: string; uploaded: number }[]) =>
    w.op(remoteMediaOrphans, { keys, cursor: null, now: w.clock.now });

  it("keeps a named key at any age, deletes an unnamed one only past LATE_PUT_MS, and keeps main's rule elsewhere", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await recordStill(w, v.token, attempt);
    const unnamed = `remote/${v.token}/s${"0".repeat(32)}`;
    const named = `remote/${v.token}/s${attempt}`;
    const now = w.clock.now;
    expect(
      await sweep(w, [
        { key: named, uploaded: 0 },
        { key: unnamed, uploaded: now - LATE_PUT_MS },
        { key: `remote/${v.token}/full`, uploaded: 0 },
        { key: `remote/${v.token}/still`, uploaded: 0 },
      ]),
    ).toEqual({ orphans: [] });
    expect(await sweep(w, [{ key: unnamed, uploaded: now - LATE_PUT_MS - 1 }])).toEqual({ orphans: [unnamed] });
    // A token the ledger does not hold: main's 24 hours, for every variant.
    const gone = "b".repeat(40);
    expect(
      await sweep(w, [
        { key: `remote/${gone}/s${attempt}`, uploaded: now - LATE_PUT_MS - 1 },
        { key: `remote/${gone}/full`, uploaded: now - 24 * 60 * 60 * 1000 + 1 },
      ]),
    ).toEqual({ orphans: [] });
    expect(
      await sweep(w, [
        { key: `remote/${gone}/s${attempt}`, uploaded: now - 24 * 60 * 60 * 1000 },
        { key: `remote/${gone}/still`, uploaded: now - 24 * 60 * 60 * 1000 },
      ]),
    ).toEqual({ orphans: [`remote/${gone}/s${attempt}`, `remote/${gone}/still`] });
  });

  it("keeps a key whose attempt can still record on the Store's clock, whatever its uploaded time", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const claimedAt = w.clock.now;
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    const key = `remote/${v.token}/s${attempt}`;
    // A days-old uploaded time (a skewed R2 clock): kept while the attempt can record, and the record names it.
    at(w, claimedAt + STILL_ROUND_MS - 1);
    expect(await sweep(w, [{ key, uploaded: claimedAt - 3 * 24 * 60 * 60 * 1000 }])).toEqual({ orphans: [] });
    expect(await recordStill(w, v.token, attempt)).toMatchObject({ out: { status: "recorded" } });
    expect(await sweep(w, [{ key, uploaded: 0 }])).toEqual({ orphans: [] });
  });

  it("collects a key whose attempt is past its record deadline, and the record after the cut is refused", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const claimedAt = w.clock.now;
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    const key = `remote/${v.token}/s${attempt}`;
    // The attempt held current and unsettled; the sweep classifies its key after the cut.
    at(w, claimedAt + STILL_ROUND_MS);
    expect(await sweep(w, [{ key, uploaded: claimedAt - LATE_PUT_MS - 1 }])).toEqual({ orphans: [key] });
    expect(await recordStill(w, v.token, attempt)).toEqual({ out: { status: "refused" }, reads: 0 });
    expect(await slotOf(w, v.slot)).toMatchObject({ still_key: null });
  });

  it.each([
    ["31 hex digits", `s${"a".repeat(31)}`],
    ["33 hex digits", `s${"a".repeat(33)}`],
    ["upper case", `s${"A".repeat(32)}`],
    ["other letters", `s${"g".repeat(32)}`],
    ["a public suffix", `s${"a".repeat(32)}.webp`],
    ["an extra slash", `s${"a".repeat(32)}/x`],
  ])("leaves a key with %s to no rule of its own", async (_name, variant) => {
    const w = await mediaWorld();
    const v = await video(w);
    const key = `remote/${v.token}/${variant}`;
    expect(await sweep(w, [{ key, uploaded: 0 }])).toEqual({ orphans: [] });
    const gone = `remote/${"c".repeat(40)}/${variant}`;
    expect(await sweep(w, [{ key: gone, uploaded: 0 }])).toEqual({ orphans: [] });
    // The control: a well-formed unnamed key of the same token is collected.
    const good = `remote/${v.token}/s${"a".repeat(32)}`;
    expect(await sweep(w, [{ key: good, uploaded: 0 }])).toEqual({ orphans: [good] });
  });
});

describe("slot writers clear a named still (P21b)", () => {
  async function recorded(w: MediaWorld) {
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await recordStill(w, v.token, attempt);
    expect(await slotOf(w, v.slot)).toMatchObject({ still_key: `s${attempt}`, still_blurhash: BLURHASH });
    return v;
  }

  it("a reset of the slot to another URL", async () => {
    const w = await mediaWorld();
    const v = await recorded(w);
    await sql(w.t.store, "UPDATE media_attachments SET url = ? WHERE id = ?", `${v.url}?2`, v.media);
    await w.db((d) => syncAttachmentFiles(d, v.media, w.clock.now));
    expect(await slotOf(w, v.slot)).toEqual({ token: null, still_ext: null, still_key: null, still_blurhash: null });
  });

  it("validation's whole-object fallback when the pending limit refuses the reset", async () => {
    const w = await mediaWorld();
    const v = await recorded(w);
    await sql(w.t.store, "UPDATE remote_media_usage SET pending = 20000");
    const restoredAt = w.clock.now;
    at(w, restoredAt + REMOTE_SETTLE_MS);
    const started = await w.op(maintainRemoteMedia, { now: w.clock.now, restoredAt, cap: CAP, retentionDays: 0 });
    expect(started.validation.map((b) => b.token)).toContain(v.token);
    const { recordRemoteMediaValidation } = await import("../src/domain/remote-media");
    await w.op(recordRemoteMediaValidation, { results: [{ token: v.token, missing: true }], now: w.clock.now });
    expect(await slotOf(w, v.slot)).toEqual({ token: null, still_ext: null, still_key: null, still_blurhash: null });
  });
});

describe("presentation (P21a, P21c)", () => {
  const ORIGIN = "https://kopje.test";
  // The attachment row as the status presenter reads it, its packed columns from the production SQL.
  const presented = async (w: MediaWorld, media: string) => {
    const [row] = await sql<MediaRow>(
      w.t.store,
      `SELECT m.id, m.type, m.url, m.preview_url, m.description, m.meta, NULL AS focus_x, 0 AS focus_y, m.blurhash,
				1 AS remote, ${mediaCacheSql("m", "attachment")} AS cached, ${mediaCacheSql("m", "thumbnail")} AS cached_preview
			FROM media_attachments m WHERE m.id = ?`,
      media,
    );
    return presentMedia({ ...row!, description: row!.description ?? "" }, ORIGIN);
  };

  async function withStill(w: MediaWorld, options: { blurhash?: string } = {}) {
    await passStill(w);
    const v = await video(w, { stills: STILLS, ...options });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await recordStill(w, v.token, attempt);
    return { ...v, still: `${ORIGIN}/media/r/${v.token}/s${attempt}.webp` };
  }

  it("shows the named still and its blurhash for a video without an icon or a blurhash of its own", async () => {
    const w = await mediaWorld();
    const v = await withStill(w);
    expect(await presented(w, v.media)).toMatchObject({
      url: `${ORIGIN}/media/r/${v.token}/full.mp4`,
      preview_url: v.still,
      blurhash: BLURHASH,
    });
  });

  it("keeps the attachment's own blurhash over the still's", async () => {
    const w = await mediaWorld();
    const own = "UBL_:rOpGG-;~qRjWBay00t7%Mof%May9ZRj";
    const v = await withStill(w, { blurhash: own });
    expect(await presented(w, v.media)).toMatchObject({ preview_url: v.still, blurhash: own });
  });

  it("shows an icon added by an edit, uncached, over the still, without the still's blurhash", async () => {
    const w = await mediaWorld();
    const v = await withStill(w);
    await sql(
      w.t.store,
      "UPDATE media_attachments SET preview_url = ? WHERE id = ?",
      "https://files.example/i.png",
      v.media,
    );
    expect(await presented(w, v.media)).toMatchObject({ preview_url: "https://files.example/i.png", blurhash: null });
  });

  it("shows the poster once the slot is replaced by another file", async () => {
    const w = await mediaWorld();
    const v = await withStill(w);
    await sql(w.t.store, "UPDATE media_attachments SET url = ? WHERE id = ?", `${v.url}?2`, v.media);
    await w.db((d) => syncAttachmentFiles(d, v.media, w.clock.now));
    expect(await presented(w, v.media)).toMatchObject({ preview_url: `${ORIGIN}${VIDEO_POSTER}`, blurhash: null });
  });

  it("keeps an image's cached preview: its file over an uncached remote icon, or its animated still", () => {
    const row = (over: Partial<MediaRow>): MediaRow => ({
      id: "800000000000000001",
      type: "image",
      url: "https://files.example/m/1.png",
      preview_url: "https://files.example/p/1.png",
      description: "",
      meta: null,
      focus_x: null,
      focus_y: 0,
      blurhash: null,
      remote: 1,
      cached: null,
      cached_preview: null,
      ...over,
    });
    const t = "F".repeat(43);
    expect(presentMedia(row({ cached: `${t}:png:` }), ORIGIN).preview_url).toBe(`${ORIGIN}/media/r/${t}/full.png`);
    expect(presentMedia(row({ cached: `${t}:gif:png` }), ORIGIN).preview_url).toBe(`${ORIGIN}/media/r/${t}/still.png`);
  });

  it("parses a packed file at CACHED_MEDIA_BYTES, and refuses one past it or malformed", () => {
    const t = "T".repeat(64);
    const key = `s${"a".repeat(32)}`;
    const blurhash = `e0${":".repeat(BLURHASH_BYTES - 2)}`;
    const packed = `${t}:webm:avif:${key} ${blurhash}`;
    expect(packed.length).toBe(CACHED_MEDIA_BYTES);
    expect(cachedMediaUrls(packed, ORIGIN)).toEqual({
      image: `${ORIGIN}/media/r/${t}/full.webm`,
      still: `${ORIGIN}/media/r/${t}/${key}.avif`,
      stillBlurhash: blurhash,
    });
    expect(cachedMediaUrls(`${packed}0`, ORIGIN)).toBeNull();
    expect(cachedMediaUrls(`${t}:mp4::${key} `, ORIGIN)).toBeNull();
    expect(cachedMediaUrls(`${t}:mp4:webp:s${"A".repeat(32)} `, ORIGIN)).toBeNull();
    expect(cachedMediaUrls(`${t}:mp4:webp:${key}:x `, ORIGIN)).toBeNull();
    expect(cachedMediaUrls(`${t}:mp4:webp:${key} bad`, ORIGIN)).toMatchObject({ stillBlurhash: null });
  });
});

describe("PR5-1 leaves remote stills unreachable (P18c, P-PITR1)", () => {
  // A remote video the real round caches, with a `still@standard-1` pass recorded through the generic probe claim.
  async function cachedVideo(w: MediaWorld) {
    const claimed = await w.t.store.claimMediaProbe(BUILD, { profile: "still@standard-1", build: BUILD, due: false });
    if (claimed.status !== "claimed") {
      throw new Error(claimed.status);
    }
    await w.t.store.recordMediaProbeResult(BUILD, {
      profile: "still@standard-1",
      claim: claimed.claim,
      outcome: "pass",
      imagesVerified: true,
      imageTag: null,
    });
    const author = await w.remote({ avatar: null });
    const url = `https://files.example/m/${++videos}.mp4`;
    const { media } = await w.attach(author.id, url, { type: "video" });
    const file = mp4({ mdat: 1000 });
    w.serve(url, file, { "content-length": String(file.length) });
    expect(await w.round()).toMatchObject({ claimed: 1, stored: 1 });
    const [object] = await w.objects();
    return { media, token: object!.token };
  }

  it("queues no still from the real round, with a pass and stills otherwise possible", async () => {
    const w = await mediaWorld();
    await cachedVideo(w);
    expect(await stillRows(w)).toEqual([]);
  });

  it("validates a restored full-only video as main does: it stays cached and served", async () => {
    const w = await mediaWorld();
    const { token: t } = await cachedVideo(w);
    const restoredAt = w.clock.now;
    await env.MEDIA.put(restoreMarkerKey(w.t.store.id.toString()), JSON.stringify({ at: restoredAt }));
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      expect((await w.round()).validated).toBe(1);
      expect((await w.round()).validated).toBe(0);
      expect(await w.objects()).toMatchObject([{ token: t, state: "stored" }]);
      expect(await env.MEDIA.head(`remote/${t}/full`)).not.toBeNull();
      await w.exact();
    } finally {
      await env.MEDIA.delete(restoreMarkerKey(w.t.store.id.toString()));
    }
  });
});

describe("the dump (DATA-3)", () => {
  it("leaves out the stills, the lease and the stills counter", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w, { stills: STILLS });
    const attempt = ((await claim(w)).out as { attempt: string }).attempt;
    await recordStill(w, v.token, attempt);
    await video(w, { stills: STILLS });
    at(w, w.clock.now + STILL_LEASE_MS);
    await claim(w);
    expect(await stillRows(w)).toHaveLength(2);
    expect(await leaseOf(w)).not.toBeNull();
    vi.useRealTimers();
    const { text } = await dumpViaRpc(w.t.store);
    expect(text).toMatch(/INSERT INTO "media_attachments"/);
    expect(text).not.toMatch(/"remote_media_stills"|remote_still_lease|media_still_jobs|"still_key"/);
    expect(text).toMatch(/"name":"0122_remote_media_stills"/);
  });
});

// A PITR bookmark of the tables the stills' cases read, and the restore to it (the tables put back as they were).
type Bookmark = Record<string, Record<string, SqlStorageValue>[]>;
const REWOUND = ["remote_media", "remote_media_objects", "remote_media_stills", "remote_media_usage", "kopje_state"];

async function bookmark(w: MediaWorld): Promise<Bookmark> {
  const taken: Bookmark = {};
  for (const table of REWOUND) {
    taken[table] = await sql(w.t.store, `SELECT * FROM ${table}`);
  }
  return taken;
}

async function restoreTo(w: MediaWorld, taken: Bookmark): Promise<void> {
  for (const table of REWOUND.toReversed()) {
    await sql(w.t.store, `DELETE FROM ${table}`);
  }
  for (const table of REWOUND) {
    for (const row of taken[table] ?? []) {
      const columns = Object.keys(row);
      await sql(
        w.t.store,
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((c) => row[c] ?? null),
      );
    }
  }
}
