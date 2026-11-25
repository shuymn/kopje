import { DurableObject } from "cloudflare:workers";

import { MIGRATIONS } from "./db/migrations";
import { Db } from "./db/sql";
import { announceConvertedProfiles } from "./domain/actor-update";
import { type Authorized, checkCredential, type Credential, type Judged } from "./domain/auth";
import { HANDSHAKE_REPLAYS_PER_ROUND, handshakeReplaysDue, handshakeReplayStep } from "./domain/handshake-replays";
import * as inbox from "./domain/inbox";
import * as instanceActivity from "./domain/instance-activity";
import * as media from "./domain/media";
import * as mediaProcessing from "./domain/media-processing";
import * as mediaRebuild from "./domain/media-rebuild";
import * as remoteActors from "./domain/remote-actors";
import * as remoteMedia from "./domain/remote-media";
import * as scheduled from "./domain/scheduled-statuses";
import { UNLOCK_ACCEPTS_PER_ROUND, unlockAcceptStep } from "./domain/unlock-accepts";
import {
  captureMedia,
  claimBackup,
  type MediaCopyRecord,
  mediaCoverage,
  mediaPage,
  readBackupState,
  recordMedia,
  saveBackup,
} from "./platform/backup-state";
import { errorFields } from "./platform/error-message";
import { restoreMarkerKey } from "./platform/media-files";
import { readRestore, type Restore } from "./platform/restore-marker";
import { type ImportAuthority, StoreAdmin } from "./platform/store-admin";
import { type MaintenanceReason, toStoreUnavailable, WRITE_REFUSALS } from "./platform/store-errors";
import { readFlags } from "./platform/store-flags";
import { type OperationInput, type StoreOperation, StoreKernel, type TimedOperation } from "./platform/store-kernel";
import { defineRpc, STORE_RPC, type StoreRpc } from "./store-rpc";
import { StreamHub } from "./stream-hub";
import { buildOf, PACKAGE_VERSION } from "./version";

// When a PITR restore was last scheduled (store.ts pitrToBookmark), or null.
type StartInput = Omit<OperationInput<typeof media.startTransforms>, "restoredAt">;

const needsMarker = (output: Authorized<media.Started | { status: "needs_marker" }>) =>
  output.status === "ok" && output.value.status === "needs_marker";

// The image path's start (domain/media.ts startTransforms). The restore marker is read (`readMarker`) only when the
// row is a candidate (`needs_marker`, a pass that writes nothing, so it runs no after-commit hook), and the start runs
// again with it, so a candidate reserved at or before the last restore is refused as S1 refuses it, one whose marker
// is unknown is refused as transient (restoreTime), and an ordinary image's start never depends on the marker.
export async function startImagePath(
  kernel: StoreKernel,
  callerBuild: string,
  input: StartInput,
  readMarker: () => Promise<Restore>,
): Promise<Authorized<media.Started>> {
  const first = await kernel.executeQuiet(
    callerBuild,
    media.startTransforms,
    { ...input, restoredAt: "unread" },
    needsMarker,
  );
  if (first.status !== "ok") {
    return first;
  }
  if (first.value.status !== "needs_marker") {
    return { status: "ok", value: first.value };
  }
  const second = await kernel.execute(callerBuild, media.startTransforms, { ...input, restoredAt: await readMarker() });
  if (second.status !== "ok") {
    return second;
  }
  if (second.value.status === "needs_marker") {
    throw new Error("the start asked for the marker it was given");
  }
  return { status: "ok", value: second.value };
}

type OwnerInput<Op> = Omit<OperationInput<Op>, "restoredAt">;

const asksMarker = (output: Authorized<unknown>) =>
  output.status === "ok" && (output.value as { status?: unknown }).status === "needs_marker";

// The owner's GET, PUT and DELETE of an upload (domain/media-processing.ts ownerMedia, updateOwnerMedia,
// deleteOwnerMedia), in startImagePath's two passes: the first without the restore marker, which an upload without a
// processing row K3 could act on (every image) answers; one with such a row answers `needs_marker`, writing nothing,
// and the operation runs again with the marker read, which refuses it as transient (503) where it is unknown and K3
// decides the answer (platform/restore-marker.ts restoreTime).
export async function ownerRun<O>(
  kernel: StoreKernel,
  callerBuild: string,
  operation: TimedOperation<never, Authorized<O | { status: "needs_marker" }>, "now">,
  input: object,
  readMarker: () => Promise<Restore>,
): Promise<Authorized<Exclude<O, { status: "needs_marker" }>>> {
  const op = operation as TimedOperation<
    { now: number; [field: string]: unknown },
    Authorized<O | { status: "needs_marker" }>,
    "now"
  >;
  const first = await kernel.executeQuiet(callerBuild, op, { ...input, restoredAt: "unread" }, asksMarker);
  if (!asksMarker(first)) {
    return first as Authorized<Exclude<O, { status: "needs_marker" }>>;
  }
  const second = await kernel.execute(callerBuild, op, { ...input, restoredAt: await readMarker() });
  if (asksMarker(second)) {
    throw new Error("the owner's operation asked for the marker it was given");
  }
  return second as Authorized<Exclude<O, { status: "needs_marker" }>>;
}

// The refusals a media processing write answers as `maintenance` (K1): the Store refuses writes, and the caller
// repeats later.
const AV_MAINTENANCE: ReadonlySet<MaintenanceReason> = new Set<MaintenanceReason>([
  ...WRITE_REFUSALS,
  "import-in-progress",
  "rebuild-in-progress",
]);

type AvMaintenance = { status: "maintenance" };

// `run`, a refusal in AV_MAINTENANCE answered `maintenance`.
async function avRefusal<T>(run: () => Promise<T>): Promise<T | AvMaintenance> {
  try {
    return await run();
  } catch (error) {
    const reason = toStoreUnavailable(error)?.reason;
    if (reason !== undefined && AV_MAINTENANCE.has(reason)) {
      return { status: "maintenance" };
    }
    throw error;
  }
}

// A media processing operation's input as its Store method takes it: the Store fills its time and the restore marker.
type AvInput<Op> = Omit<OperationInput<Op>, "restoredAt">;

// The types of the methods STORE_RPC defines on the Store (the static block below). The class and this interface are
// merged on purpose, and the interface has no members of its own: they all come from StoreRpc.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging, typescript/no-empty-object-type -- see above
export interface Store extends StoreRpc {}

// The single source of truth of an instance: one SQLite-backed Durable Object. Every RPC takes the caller's build
// (the Workers version id, see version.ts). Domain operations run through the kernel's gate. Rescue RPCs work in every
// Store state. Of those, health(), version(), the inspection RPCs and the dump RPCs only read data and accept any caller
// build, since they are what an operator needs while the Worker and the Store disagree; the dump's freeze flag is
// bookkeeping, not data. pitrToBookmark(), maintenance, upgrade retry and import mutate, so they require the caller's
// build to match like any other mutation.
//
// How a request talks to the Store, and when a call stays separate for its timing: docs/engineering.md, "How a request
// talks to the Store".
//
// A method that only runs one domain operation is an entry of STORE_RPC (store-rpc.ts), defined below; the methods
// written here have logic of their own.
export class Store extends DurableObject<Env> {
  readonly #kernel: StoreKernel;
  readonly #admin: StoreAdmin;
  readonly #streams: StreamHub;

  static {
    defineRpc(Store.prototype, STORE_RPC, (store, operation, callerBuild, input) =>
      store.#kernel.execute(callerBuild, operation, input as never),
    );
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const build = buildOf(env);
    this.#kernel = new StoreKernel(ctx, {
      build,
      migrations: MIGRATIONS,
      afterCommit: (operation) => this.#streams.written(operation),
    });
    this.#admin = new StoreAdmin(ctx, this.#kernel, {
      source: { build, version: PACKAGE_VERSION },
      onPublish: (sql, now) => announceConvertedProfiles(new Db(sql, (fn) => ctx.storage.transactionSync(fn)), now),
    });
    // A turn is a request to this object's own stub (stream-hub.ts).
    this.#streams = new StreamHub(ctx, this.#kernel, (headers) =>
      env.STORE.get(ctx.id).fetch("https://store.internal/stream/turn", { method: "POST", headers }),
    );
  }

  // The streaming API (stream-hub.ts): the upgrade the Worker forwards (mastodon/streaming.ts), and the turns of the
  // fan-out, which only this object requests of itself.
  override fetch(request: Request): Promise<Response> {
    return this.#streams.fetch(request);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#streams.message(ws, message);
  }

  override webSocketClose(ws: WebSocket, code: number): Promise<void> {
    return this.#streams.closed(ws, code);
  }

  override webSocketError(ws: WebSocket): Promise<void> {
    return this.#streams.closed(ws, 1011);
  }

  // The cron's turn of the streaming API: closes the sockets of expired tokens and prunes the journal.
  streamTick(_callerBuild: string) {
    this.#streams.tick();
  }

  // The streaming tests' drain barrier (stream-hub.ts drained): resolves once the fan-out has caught up.
  streamDrained(_callerBuild: string) {
    return this.#streams.drained();
  }

  health(callerBuild: string) {
    return this.#kernel.health(callerBuild);
  }

  async version(_callerBuild: string) {
    return { ...(await this.#kernel.version()), version: PACKAGE_VERSION };
  }

  // The restore is recorded in R2 first (restoreMarkerKey): a restore rewinds the database, maintenance start and
  // unpublished flag included, so a media rebuild counts its settle period from this record instead.
  pitrToBookmark(callerBuild: string, bookmark: string) {
    return this.#kernel.restoreBookmark(callerBuild, bookmark, async () => {
      await this.env.MEDIA.put(restoreMarkerKey(this.ctx.id.toString()), JSON.stringify({ at: Date.now() }));
    });
  }

  // ---- operations tooling (platform/store-admin.ts), called from /admin/*

  capacity(_callerBuild: string) {
    return this.#admin.capacity();
  }

  spool(_callerBuild: string) {
    return this.#admin.spool();
  }

  adminGate(_callerBuild: string) {
    return this.#admin.gate();
  }

  query(_callerBuild: string, sql: string, limit?: number) {
    return this.#admin.query(sql, limit);
  }

  pitrBookmark(_callerBuild: string, at?: number) {
    return this.#admin.bookmark(at);
  }

  setMaintenance(callerBuild: string, on: boolean) {
    return this.#admin.setMaintenance(callerBuild, on);
  }

  retryUpgrade(callerBuild: string) {
    return this.#kernel.retryUpgrade(callerBuild);
  }

  dumpStart(_callerBuild: string, leaseSeconds?: number, opId?: string) {
    return this.#admin.dumpStart(leaseSeconds, opId);
  }

  dumpNext(_callerBuild: string, cursor: unknown, maxBytes?: number) {
    return this.#admin.dumpNext(cursor, maxBytes);
  }

  dumpFinish(_callerBuild: string, cursor: unknown, abort?: boolean) {
    return this.#admin.dumpFinish(cursor, abort);
  }

  dumpAbort(_callerBuild: string, opId: string) {
    return this.#admin.dumpAbort(opId);
  }

  catalog(_callerBuild: string) {
    return this.#admin.catalog();
  }

  // The scheduled backup's bookkeeping (platform/backup-state.ts). Like the dump flag it is not data, so any caller
  // build and any Store state (maintenance, a dump or an import) may use it. The runner lease is taken and checked
  // inside each transaction, at the time the caller passes.
  async backupState(_callerBuild: string) {
    await this.#kernel.state();
    return readBackupState(this.ctx.storage.sql);
  }

  // Refused while a verified import is unpublished: the scheduled backup starts only once the instance is published
  // (an operator's rescue dump is not affected), checked in the transaction that takes the runner lease.
  async backupClaim(_callerBuild: string, runner: string, now: number, leaseMs: number) {
    await this.#kernel.state();
    return this.#backupTx((sql) =>
      readFlags(sql).unpublished !== null
        ? ({ ok: false, code: "unpublished" } as const)
        : claimBackup(sql, runner, now, leaseMs),
    );
  }

  async backupSave(
    _callerBuild: string,
    runner: string,
    now: number,
    leaseMs: number,
    state: unknown,
    release: boolean,
    pruneTo: string | null,
  ) {
    await this.#kernel.state();
    return this.#backupTx((sql) => saveBackup(sql, runner, now, leaseMs, state, release, pruneTo));
  }

  // Completes the backup's dump and records the originals it references in one transaction, while its freeze holds.
  async backupFinishDump(
    _callerBuild: string,
    runner: string,
    now: number,
    run: string,
    destination: string,
    opId: string,
    cursor: unknown,
  ) {
    let required = 0;
    const finished = await this.#admin.dumpFinish(cursor, false, {
      opId,
      within: (sql) => {
        const captured = captureMedia(sql, runner, now, run, destination);
        if (!captured.ok) {
          return { ok: false, code: captured.code, message: `backup ${captured.code}` };
        }
        required = captured.required;
        return null;
      },
    });
    return finished.ok ? { ...finished, required } : finished;
  }

  async backupMedia(_callerBuild: string, run: string, after: string | null, limit: number, pendingOnly: boolean) {
    await this.#kernel.state();
    return mediaPage(this.ctx.storage.sql, run, after, limit, pendingOnly);
  }

  async backupRecord(_callerBuild: string, runner: string, now: number, source: string, record: MediaCopyRecord) {
    await this.#kernel.state();
    return this.#backupTx((sql) => recordMedia(sql, runner, now, source, record));
  }

  async backupCoverage(_callerBuild: string, run: string) {
    await this.#kernel.state();
    return mediaCoverage(this.ctx.storage.sql, run);
  }

  #backupTx<T>(fn: (sql: SqlStorage) => T): T {
    return this.ctx.storage.transactionSync(() => fn(this.ctx.storage.sql));
  }

  // Import and configuration mutations name their authority; the Store checks it where it writes (store-admin.ts).
  // An import replaces the data the streams were judged by: every socket closes (1012), and clients reconnect once it
  // is published.
  async importBegin(callerBuild: string, authority: ImportAuthority, header: unknown) {
    const result = await this.#admin.importBegin(callerBuild, authority, header);
    if (result.ok) {
      this.#streams.closeAll(1012, "service restart");
    }
    return result;
  }

  importChunk(callerBuild: string, authority: ImportAuthority, id: string, seq: number, bytes: Uint8Array) {
    return this.#admin.importChunk(callerBuild, authority, id, seq, bytes);
  }

  importFinish(callerBuild: string, authority: ImportAuthority, id: string, trailer: unknown) {
    return this.#admin.importFinish(callerBuild, authority, id, trailer);
  }

  importVerify(callerBuild: string, authority: ImportAuthority, id: string) {
    return this.#admin.importVerify(callerBuild, authority, id);
  }

  importProgress(_callerBuild: string, authority: ImportAuthority, id?: string) {
    return this.#admin.importProgress(authority, id);
  }

  importReset(callerBuild: string, authority: ImportAuthority, id?: string, abandonStale?: boolean) {
    return this.#admin.importReset(callerBuild, authority, id, abandonStale);
  }

  config(_callerBuild: string) {
    return this.#admin.config();
  }

  // The cutover's publication mark, rollback journal and reset (store-admin.ts, docs/cutover-runbook.md).
  cutoverStatus(callerBuild: string) {
    return this.#admin.cutoverStatus(callerBuild);
  }

  publish(callerBuild: string, authority: ImportAuthority) {
    return this.#admin.publish(callerBuild, authority);
  }

  journalSpool(
    callerBuild: string,
    entry: { digest: string; spooledAt: number; record: Uint8Array },
    limits?: { entries?: number | undefined; bytes?: number | undefined },
  ) {
    return this.#admin.journalSpool(callerBuild, entry, limits);
  }

  handedOff(callerBuild: string, digest: string) {
    return this.#admin.handedOff(callerBuild, digest);
  }

  closeRollback(callerBuild: string, authority: ImportAuthority) {
    return this.#admin.closeRollback(callerBuild, authority);
  }

  drainLease(callerBuild: string, authority: ImportAuthority, request: { holder: string; release?: boolean }) {
    return this.#admin.drainLease(callerBuild, authority, request);
  }

  journalNext(callerBuild: string, authority: ImportAuthority, holder: string, skip?: string[]) {
    return this.#admin.journalNext(callerBuild, authority, holder, skip);
  }

  journalMark(
    callerBuild: string,
    authority: ImportAuthority,
    holder: string,
    id: string,
    state: "sending" | "done" | "unverified" | "no-recipient",
  ) {
    return this.#admin.journalMark(callerBuild, authority, holder, id, state);
  }

  journalFullStop(callerBuild: string, authority: ImportAuthority, holder: string, action: "record" | "check") {
    return this.#admin.journalFullStop(callerBuild, authority, holder, action);
  }

  journalDiscardKept(callerBuild: string, authority: ImportAuthority) {
    return this.#admin.journalDiscardKept(callerBuild, authority);
  }

  cutoverReset(callerBuild: string, authority: ImportAuthority) {
    return this.#admin.cutoverReset(callerBuild, authority);
  }

  setConfig(callerBuild: string, authority: ImportAuthority, values: unknown) {
    return this.#admin.setConfig(callerBuild, authority, values);
  }

  // Inbound activities: the Worker verifies and prepares, the Store authorizes and applies (domain/inbox.ts),
  // with its own clock beside the Worker's (StoreReceiveInput).

  async receiveActivity(callerBuild: string, input: inbox.ReceiveInput): Promise<inbox.ReceiveAnswer> {
    try {
      return await this.#kernel.execute(callerBuild, inbox.receiveActivity, input);
    } catch (error) {
      // Rolled back: a retryable refusal changes nothing (domain/remote-actors.ts, RetryLater).
      if (error instanceof remoteActors.RetryLater) {
        return inbox.retryResult(error);
      }
      throw error;
    }
  }

  // A round of the held handshakes (domain/handshake-replays.ts): at most HANDSHAKE_REPLAYS_PER_ROUND steps, each in
  // its own transaction; pending when a hold is still due after them.
  async runHandshakeReplays(callerBuild: string, input: OperationInput<typeof handshakeReplayStep>) {
    let delivers = false;
    for (let step = 0; step < HANDSHAKE_REPLAYS_PER_ROUND; step++) {
      const result = await this.#kernel.execute(callerBuild, handshakeReplayStep, input);
      delivers = delivers || result.delivers;
      if (result.done) {
        return { pending: false, delivers };
      }
    }
    return { pending: await this.#kernel.execute(callerBuild, handshakeReplaysDue, input), delivers };
  }

  // A round of the unlock acceptance jobs (domain/unlock-accepts.ts): at most UNLOCK_ACCEPTS_PER_ROUND steps, each in
  // its own transaction.
  async runUnlockAccepts(callerBuild: string, input: OperationInput<typeof unlockAcceptStep>) {
    let delivers = false;
    for (let step = 0; step < UNLOCK_ACCEPTS_PER_ROUND; step++) {
      const result = await this.#kernel.execute(callerBuild, unlockAcceptStep, input);
      delivers = delivers || result.delivers;
      if (result.done) {
        return { pending: false, delivers };
      }
    }
    return { pending: true, delivers };
  }

  // Remote media (domain/remote-media.ts): maintained, claimed, admitted and recorded by the cron's round
  // (federation/remote-media.ts), each at the Store's own time, so every safety window (LATE_PUT_MS after a claim)
  // is measured from a Store-recorded time. The maintenance reads the restore marker first (restoreMarkerKey).
  async maintainRemoteMedia(callerBuild: string, input: { cap: number; retentionDays: number }) {
    return this.#kernel.execute(callerBuild, remoteMedia.maintainRemoteMedia, {
      ...input,
      restoredAt: await this.#restoredAt(),
    });
  }

  // What an inbound request is judged on before it is verified (federation/inbox.ts processInbox), in one read, with
  // whether receiveActivity would be admitted now (refused: null, or the maintenance reason). Advisory: receiveActivity
  // is admitted and decides again in its own transaction.
  // While writes are refused, it hands over no fetch preparation, so no key leaves the Store for the request (OPS-8).
  async inboxGate(callerBuild: string, input: OperationInput<typeof inbox.inboxGate>) {
    const { output, refused } = await this.#kernel.executeProbing(callerBuild, inbox.inboxGate, input, "write");
    return { ...output, prefetch: refused === null ? output.prefetch : null, refused };
  }

  // The last good document saved for a federation GET (saveSnapshot): a rescue RPC like health(), for any caller
  // build and in every Store state.
  rescueSnapshot(_callerBuild: string, key: string) {
    return this.#kernel.readSnapshot(key);
  }

  // GET /api/v1/instance/activity: the JSON body, or null when the API is off, unless the token's owner is suspended
  // (instance-activity.ts).
  instanceActivity(
    callerBuild: string,
    input: { now: number; credential: Credential | null },
  ): Promise<Judged<string | null>> {
    return instanceActivity.answerInstanceActivity(this.#kernel, callerBuild, input);
  }

  // The cron's round (jobs/scheduled.ts): the due scheduled statuses, each published in its own transaction with one
  // of the object ids the Worker made. One that fails with an error is rolled back, then its attempt is recorded in a
  // transaction of its own (recordPublishFailure: retried later, dropped after the last attempt), and the round goes
  // on, so what keeps failing backs off and never holds back the others. A refusal of the first call (maintenance,
  // readonly) ends the round, and what is due waits for the next.
  async publishScheduled(callerBuild: string, input: { now: number; objectIds: string[] }) {
    const due = await this.#kernel.execute(callerBuild, scheduled.dueScheduled, {
      now: input.now,
      limit: input.objectIds.length,
    });
    const counts = { published: 0, dropped: 0, failed: 0, gone: 0 };
    for (const [i, id] of due.entries()) {
      try {
        const result = await this.#kernel.execute(callerBuild, scheduled.publishScheduled, {
          id,
          now: input.now,
          objectId: input.objectIds[i] ?? crypto.randomUUID(),
        });
        counts[result.status === "published" ? "published" : result.status === "dropped" ? "dropped" : "gone"]++;
      } catch (error) {
        counts.failed++;
        try {
          const failure = await this.#kernel.execute(callerBuild, scheduled.recordPublishFailure, {
            id,
            now: input.now,
          });
          console.error({ event: "kopje.scheduled.status.failed", id, recorded: true, failure, ...errorFields(error) });
        } catch (recordError) {
          console.error({ event: "kopje.scheduled.status.failed", id, recorded: false, ...errorFields(recordError) });
        }
      }
    }
    return counts;
  }

  // The media rebuild's lease, at the Store's own time like the rest of the rebuild (store-rpc.ts), after the restore
  // marker is read (restoreMarkerKey).
  async mediaRebuildLease(
    callerBuild: string,
    input: Omit<OperationInput<typeof mediaRebuild.rebuildLease>, "restoredAt">,
  ) {
    return this.#kernel.execute(callerBuild, mediaRebuild.rebuildLease, {
      ...input,
      restoredAt: await this.#restoredAt(),
    });
  }

  // The image path's start (startImagePath), the restore marker read only for a candidate.
  startTransforms(callerBuild: string, input: StartInput) {
    return startImagePath(this.#kernel, callerBuild, input, () => this.#restoredAt());
  }

  // The media processor's upload operations (domain/media-processing.ts, S1-S13), each at the Store's own time after the
  // restore marker is read (restoreMarkerKey), so K3 fences every reservation made at or before the last restore. A
  // write the Store refuses (maintenance, a dump, an import) answers `maintenance` and changes nothing (K1).
  takeAvSlot(callerBuild: string, input: AvInput<typeof mediaProcessing.takeAvSlot>) {
    return this.#avWrite(callerBuild, mediaProcessing.takeAvSlot, input);
  }

  releaseStaging(callerBuild: string, input: AvInput<typeof mediaProcessing.releaseStaging>) {
    return this.#avWrite(callerBuild, mediaProcessing.releaseStaging, input);
  }

  queueNormalize(callerBuild: string, input: AvInput<typeof mediaProcessing.queueNormalize>) {
    return this.#avWrite(callerBuild, mediaProcessing.queueNormalize, input);
  }

  startNormalize(callerBuild: string, input: AvInput<typeof mediaProcessing.startNormalize>) {
    return this.#avWrite(callerBuild, mediaProcessing.startNormalize, input);
  }

  confirmAvWrite(callerBuild: string, input: AvInput<typeof mediaProcessing.confirmAvWrite>) {
    return this.#avWrite(callerBuild, mediaProcessing.confirmAvWrite, input);
  }

  completeAvUpload(callerBuild: string, input: AvInput<typeof mediaProcessing.completeAvUpload>) {
    return this.#avWrite(callerBuild, mediaProcessing.completeAvUpload, input);
  }

  failNormalize(callerBuild: string, input: AvInput<typeof mediaProcessing.failNormalize>) {
    return this.#avWrite(callerBuild, mediaProcessing.failNormalize, input);
  }

  releaseAvSlot(callerBuild: string, input: AvInput<typeof mediaProcessing.releaseAvSlot>) {
    return this.#avWrite(callerBuild, mediaProcessing.releaseAvSlot, input);
  }

  async v1Outcome(callerBuild: string, input: AvInput<typeof mediaProcessing.v1Outcome>) {
    const restoredAt = await this.#restoredAt();
    return this.#kernel.execute(callerBuild, mediaProcessing.v1Outcome, { ...input, restoredAt });
  }

  // S10 decides with a write; while the Store refuses writes but admits reads it is a read that answers 200 for a
  // completed upload and `maintenance` otherwise, dooming nothing; a Store that refuses reads too answers
  // `maintenance`.
  async v1Final(callerBuild: string, input: AvInput<typeof mediaProcessing.v1Final>) {
    const decided = await this.#avWrite(callerBuild, mediaProcessing.v1Final, input);
    if (decided.status !== "maintenance") {
      return decided;
    }
    // The read takes no marker: its one answer besides `maintenance` is a completed upload, which K3 cannot change.
    return avRefusal(() => this.#kernel.execute(callerBuild, mediaProcessing.v1FinalRead, input));
  }

  // S11 as a Store call: a first pass without the marker (ownerRun's), so another account's upload, or one K3 cannot
  // act on, is answered without reading it; then as any media processing write.
  async deleteAvUpload(callerBuild: string, input: OwnerInput<typeof mediaProcessing.deleteAvUpload>) {
    const first = await avRefusal(() =>
      this.#kernel.executeQuiet(
        callerBuild,
        mediaProcessing.deleteAvUpload,
        { ...input, restoredAt: "unread" },
        asksMarker,
      ),
    );
    if (first.status === "ok" && asksMarker(first)) {
      const second = await this.#avWrite(callerBuild, mediaProcessing.deleteAvUpload, input);
      if (second.status === "ok" && typeof second.value !== "string") {
        throw new Error("S11 asked for the marker it was given");
      }
      return second;
    }
    return first;
  }

  // The owner's GET, PUT and DELETE /api/v1/media/:id (ownerRun): a refusal of the Store's (maintenance, a dump, an
  // import) is thrown as any operation's. The names are the ones these routes called before #1828, so a Worker of the
  // other build met during a deploy is refused as version-mismatch (503), not by a missing method; deleteMedia is also
  // a profile request's discard (mastodon/media.ts).
  getMedia(callerBuild: string, input: OwnerInput<typeof mediaProcessing.ownerMedia>) {
    return ownerRun(this.#kernel, callerBuild, mediaProcessing.ownerMedia, input, () => this.#restoredAt());
  }

  updateMedia(callerBuild: string, input: OwnerInput<typeof mediaProcessing.updateOwnerMedia>) {
    return ownerRun(this.#kernel, callerBuild, mediaProcessing.updateOwnerMedia, input, () => this.#restoredAt());
  }

  deleteMedia(callerBuild: string, input: OwnerInput<typeof mediaProcessing.deleteOwnerMedia>) {
    return ownerRun(this.#kernel, callerBuild, mediaProcessing.deleteOwnerMedia, input, () => this.#restoredAt());
  }

  mediaDispatchRound(callerBuild: string) {
    return this.#avWrite(callerBuild, mediaProcessing.mediaDispatchRound, {});
  }

  incomingSweepClaim(callerBuild: string) {
    return this.#avWrite(callerBuild, mediaProcessing.incomingSweepClaim, undefined);
  }

  incomingClassify(callerBuild: string, input: AvInput<typeof mediaProcessing.incomingClassify>) {
    return this.#avWrite(callerBuild, mediaProcessing.incomingClassify, input);
  }

  incomingSwept(callerBuild: string, input: AvInput<typeof mediaProcessing.incomingSwept>) {
    return this.#avWrite(callerBuild, mediaProcessing.incomingSwept, input);
  }

  // The restore marker, read once per call in its three states (platform/restore-marker.ts): every reader goes through
  // here, and the operation decides where an unknown one refuses it.
  #restoredAt(): Promise<Restore> {
    return readRestore(this.env.MEDIA, restoreMarkerKey(this.ctx.id.toString()));
  }

  // Runs a media processing operation with the restore marker, a refusal in AV_MAINTENANCE answered `maintenance` (K1).
  // An unknown marker refuses, as transient, only an operation whose answer or write K3 decides (restoreTime).
  async #avWrite<O>(
    callerBuild: string,
    operation: StoreOperation<never, O>,
    input: unknown,
  ): Promise<O | AvMaintenance> {
    const restoredAt = await this.#restoredAt();
    return avRefusal(() =>
      this.#kernel.execute(callerBuild, operation as StoreOperation<unknown, O>, {
        ...(input as object | undefined),
        restoredAt,
      }),
    );
  }

  // Search with resolve=true, before any network work and as the first read after the host check's domain read
  // (app.ts, WEB-6; inbox.ts resolutionGate): the credential, then whether writes are refused (the maintenance reason,
  // decided in the same transaction, after which nothing is read: no key leaves the Store and nothing is fetched,
  // OPS-8), then the domain and the first request's preparation.
  resolutionGate(callerBuild: string, input: Omit<OperationInput<typeof inbox.resolutionGate>, "refused">) {
    return this.#kernel.executeDeciding(callerBuild, inbox.resolutionGate, input, "write");
  }

  // The look-up's step before it fetches: checkCredential, and whether a write would be admitted now (refused: null,
  // or the maintenance reason), so a Store that refuses writes is answered before any network work (engineering.md).
  // Advisory: resolveInteraction is admitted and authorized again in its own transaction.
  async checkWritableCredential(callerBuild: string, input: Credential) {
    const { output, refused } = await this.#kernel.executeProbing(callerBuild, checkCredential, input, "write");
    return { auth: output, refused };
  }

  override async alarm(): Promise<void> {
    await this.#kernel.upgrade();
  }
}
