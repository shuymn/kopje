import type { AvActivation } from "../domain/media-processing";
import type { BackupConfigResult } from "../platform/backup-config";
import type { BackupState } from "../platform/backup-state";
import { type Config, type ConfigResult, userKek } from "../platform/config";
import { errorMessage } from "../platform/error-message";
import type { StoreStub } from "../platform/store-client";
import { wrapsAlike } from "../security/key-wrap";
import { checkKey } from "../security/keyring";

type Check = { ok: boolean; [detail: string]: unknown };

// The Store RPCs the report uses.
export type HealthStore = Pick<StoreStub, "health" | "localKeys" | "backupState"> &
  Partial<Pick<StoreStub, "avActivation">>;

export type HealthReport = { ok: boolean; build: string; checks: Record<string, Check> };

// The detailed report: env validity and issues, the runtime's compatibility flags, Store reachability and build, schema
// version, DB size, and the keys.
// It is for the admin side only (a later /admin route behind Access); the public /health answers with publicHealth,
// which skips the key check (an unwrap and an RSA signature per key is too much work for an unauthenticated GET).
export async function healthReport(
  build: string,
  config: ConfigResult,
  store: () => HealthStore,
  {
    checkKeys = true,
    backup,
    now = Date.now(),
    compatibilityFlags = Cloudflare.compatibilityFlags,
    mediaProcessor,
  }: {
    checkKeys?: boolean;
    backup?: BackupConfigResult | undefined;
    // Whether the processor's binding is present: the detailed report shows the media processor's state.
    mediaProcessor?: { binding: boolean } | undefined;
    now?: number;
    compatibilityFlags?: Readonly<Record<string, boolean>>;
  } = {},
): Promise<HealthReport> {
  const checks: Record<string, Check> = {
    env: config.ok ? { ok: true } : { ok: false, issues: config.issues },
    runtime: runtimeCheck(compatibilityFlags),
  };
  if (config.ok) {
    try {
      const health = await store().health(build);
      checks.store = { ok: health.versionMatch, build: health.build };
      checks.schema = {
        ok: health.schema.status === "current" && !health.readonly,
        status: health.schema.status,
        applied: health.schema.applied.at(-1) ?? null,
        expected: health.schema.expected.at(-1) ?? null,
        hold: health.hold,
      };
      checks.database = { ok: true, size: health.databaseSize };
    } catch (error) {
      checks.store = { ok: false, error: errorMessage(error) };
    }
    if (checkKeys && checks.store.ok) {
      checks.keys = await keysCheck(build, config.config, store);
    }
    if (backup !== undefined) {
      checks.backup = await backupCheck(build, backup, store, now);
    }
    if (mediaProcessor !== undefined) {
      checks.mediaProcessor = await mediaProcessorCheck(build, config.config, mediaProcessor.binding, store);
    }
  }
  return { ok: Object.values(checks).every((check) => check.ok), build, checks };
}

// The media processor's state for video and audio uploads (#1828 design 4.15; docs/media-processor.md), read from the
// Store's activation (avActivation) and never starting a container:
//   disabled     no binding, or MEDIA_UPLOAD_MONTHLY_JOBS 0 (`reason` says which)
//   provisioned  the binding and a budget, and no verdict for this build yet: `lastProbe` "unavailable" when a probe was
//                attempted for it and reached none, "never" when none was
//   ready        a pass for this build: uploads are admitted; `imagesVerified` false when its Images step answered 9422,
//                and `infrastructureFailure` when an upload met one since (a re-probe is due; admission stands)
//   degraded     a failed probe for this build: uploads are refused
// with the month's spent units, the budget, and the slots counting now. Only `degraded` is not ok.
async function mediaProcessorCheck(
  build: string,
  config: Config,
  binding: boolean,
  store: () => HealthStore,
): Promise<Check> {
  const budget = config.MEDIA_UPLOAD_MONTHLY_JOBS;
  const read = store().avActivation;
  if (read === undefined) {
    return { ok: true, state: "disabled", reason: "unread" };
  }
  let activation: AvActivation;
  try {
    activation = await read(build, { binding, budget, build });
  } catch (error) {
    return { ok: false, state: "unknown", error: errorMessage(error) };
  }
  const usage = { spent: activation.spent, budget, slots: activation.slots };
  if (!binding || budget <= 0) {
    return { ok: true, state: "disabled", reason: binding ? "budget" : "binding", ...usage };
  }
  const { record, attempt, failure } = activation.probe;
  const verdict = record !== null && record.version === build ? record : null;
  if (verdict === null) {
    const attempted = attempt !== null && attempt.version === build;
    return { ok: true, state: "provisioned", lastProbe: attempted ? "unavailable" : "never", ...usage };
  }
  if (!verdict.ok) {
    return { ok: false, state: "degraded", ...usage };
  }
  return {
    ok: true,
    state: "ready",
    imagesVerified: verdict.imagesVerified !== false,
    ...(failure !== null && failure.version === build && failure.at >= verdict.at
      ? { infrastructureFailure: true }
      : {}),
    ...usage,
  };
}

// The compatibility flags the code relies on, as the running Worker has them: an instance's own wrangler.jsonc may lack
// one the template has. NET-1: global_fetch_strictly_public gives every outbound fetch public routing.
const REQUIRED_FLAGS = ["global_fetch_strictly_public"] as const;

function runtimeCheck(flags: Readonly<Record<string, boolean>>): Check {
  const missing = REQUIRED_FLAGS.filter((flag) => flags[flag] !== true);
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        missing,
        fix: `add ${missing.join(", ")} to compatibility_flags in wrangler.jsonc and redeploy (docs/upgrade.md)`,
      };
}

// Every local key (users and the instance actor) must unwrap with the configured KEK, and a signature made with it must
// verify against the stored public key. An empty KEK, or one that wraps as the empty KEK does (wrapsAlike), is legal but
// reported as a warning.
async function keysCheck(build: string, config: Config, store: () => HealthStore): Promise<Check> {
  const kek = userKek(config);
  const warning = (await wrapsAlike(kek, "")) ? { warning: "USER_KEK is empty" } : {};
  try {
    const keys = await store().localKeys(build);
    const failures: { owner: string; result: string }[] = [];
    for (const { owner, key } of keys) {
      const result = await checkKey(kek, key);
      if (result !== "ok") {
        failures.push({ owner: owner ?? "(instance actor)", result });
      }
    }
    return { ok: failures.length === 0, count: keys.length, failures, ...warning };
  } catch (error) {
    return { ok: false, error: errorMessage(error), ...warning };
  }
}

// The scheduled backup (jobs/backup.ts): its settings and the last success, failure and run. Enabled but not configured
// is a warning, not a failure, so an instance whose operator has not chosen a storage provider yet stays healthy; a
// failure newer than the last success fails the check. Nothing secret is shown: variable names, ids, times, sizes and
// fixed reason codes only (DATA-9).
async function backupCheck(
  build: string,
  settings: BackupConfigResult,
  store: () => HealthStore,
  now: number,
): Promise<Check> {
  switch (settings.state) {
    case "disabled":
      return { ok: true, state: "disabled" };
    case "not-configured":
      return {
        ok: true,
        state: "not-configured",
        missing: settings.missing,
        warning: "backups are enabled but not configured, so none are taken (docs/backup.md)",
      };
    case "invalid":
      return { ok: false, state: "invalid", issues: settings.issues };
  }
  let state: BackupState;
  try {
    state = await store().backupState(build);
  } catch (error) {
    return { ok: false, state: "unknown", error: errorMessage(error) };
  }
  const { lastSuccess, lastFailure, run, runner, retryAt, retentionFailure } = state;
  const failing = lastFailure !== null && (lastSuccess === null || lastFailure.at > lastSuccess.at);
  return {
    ok: !failing,
    state: runner !== null && now < runner.until ? "running" : run !== null ? "pending" : "idle",
    retention: settings.config.retention,
    lastSuccess,
    lastFailure,
    inProgress:
      run === null
        ? null
        : {
            id: run.id,
            stage: run.stage,
            startedAt: run.startedAt,
            parts: run.dump?.parts ?? 0,
            copied: run.copied,
          },
    retryAt,
    retentionFailure,
  };
}

// What the public /health discloses: ok or fail, nothing else.
export async function publicHealth(
  build: string,
  config: ConfigResult,
  store: () => StoreStub,
  backup?: BackupConfigResult,
): Promise<Response> {
  const { ok } = await healthReport(build, config, store, { checkKeys: false, backup });
  return new Response(ok ? "ok" : "fail", {
    status: ok ? 200 : 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
