import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeName } from "../src/domain/media-probes";
import {
  dropAttachmentFiles,
  LATE_PUT_MS,
  maintainRemoteMedia,
  recordRemoteMedia,
  remoteMediaOrphans,
  type StillsActivation,
} from "../src/domain/remote-media";
import { STILL_LEASE_MS } from "../src/domain/remote-media-stills";
import { remoteStillsRound, type RemoteStillsDeps } from "../src/jobs/remote-stills";
import type { RemoteStillMaker, StillOutcome } from "../src/platform/media-transcoder";
import { sql } from "./api-helpers";
import { BUILD, deferred } from "./helpers";
import { TestCodec } from "./media-helpers";
import { stillPng } from "./media-job-helpers";
import { gate } from "./media-processing-helpers";
import { bucketWith, claimWith, fence, mediaWorld, type MediaWorld } from "./remote-media-helpers";

// The remote stills' windows (#1828 PR5 plan, section 4) through the production round and Store, each actor held at an
// explicit gate while the other commits, the safety checks asserted after every step: the ledger, usage and audit
// agree (w.exact), a live object's charge is its file's plus its row's still_charge, and a slot names a still only when
// its key holds a WebP the round put.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
});

afterEach(() => {
  vi.useRealTimers();
});

const CAP = 4 * 1024 * 1024 * 1024;
const STILLS: StillsActivation = { binding: true, budget: 5, build: BUILD };
const FILE = 1000;
let tokens = 0;
const token = () => `${(++tokens).toString(16).padStart(8, "0")}${"c".repeat(32)}`;
let videos = 0;

function at(w: MediaWorld, ms: number): void {
  w.clock.now = ms;
  vi.setSystemTime(ms);
}

async function video(w: MediaWorld) {
  await sql(
    w.t.store,
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
    probeName("record", "still@standard-1"),
    JSON.stringify({ version: BUILD, imageTag: null, at: Date.now(), ok: true, imagesVerified: true }),
  );
  const account = await w.remote({ avatar: null });
  const { media } = await w.attach(account.id, `https://files.example/iv/${++videos}.mp4`, { type: "video" });
  const claim = (await claimWith(w, token, 8)).claims.find((c) => c.kind === "attachment")!;
  await w.op(recordRemoteMedia, {
    ...fence(claim),
    now: w.clock.now,
    outcome: {
      kind: "stored",
      contentType: "video/mp4",
      stillType: null,
      bytes: FILE,
      hosts: ["files.example"],
      category: "video",
    },
    stills: STILLS,
  });
  return { media, token: claim.token, slot: claim.slot };
}

// A still maker whose remote() waits for `gate` (when given) before answering a PNG, or answers `answer`.
function maker(options: { gate?: Promise<void>; answer?: StillOutcome; entered?: () => void } = {}) {
  const calls: string[] = [];
  const stills: RemoteStillMaker = {
    remote: async (_t, attempt) => {
      calls.push(attempt);
      options.entered?.();
      await options.gate;
      return options.answer ?? { ok: true, png: await stillPng(), image: null };
    },
  };
  return { stills, calls };
}

const round = (w: MediaWorld, stills: RemoteStillMaker, extra: Partial<RemoteStillsDeps> = {}) =>
  remoteStillsRound({
    build: BUILD,
    store: w.t.store,
    bucket: env.MEDIA,
    stills,
    images: new TestCodec(),
    budget: 5,
    cap: CAP,
    maintenance: () => false,
    now: () => Date.now(),
    ...extra,
  });

// The safety checks after a step.
async function safe(w: MediaWorld): Promise<void> {
  await w.exact();
  const live = await sql<{ token: string; charge: number; still_charge: number | null }>(
    w.t.store,
    `SELECT o.token, o.charge, st.still_charge FROM remote_media_objects o
			LEFT JOIN remote_media_stills st ON st.token = o.token WHERE o.state = 'stored'`,
  );
  for (const object of live) {
    expect(object.charge, object.token).toBe(FILE + (object.still_charge ?? 0));
  }
  const named = await sql<{ token: string; still_key: string }>(
    w.t.store,
    "SELECT token, still_key FROM remote_media WHERE still_key IS NOT NULL",
  );
  for (const slot of named) {
    const head = await env.MEDIA.head(`remote/${slot.token}/${slot.still_key}`);
    expect(head?.httpMetadata?.contentType, slot.still_key).toBe("image/webp");
  }
}

const stillOf = async (w: MediaWorld, t: string) =>
  (
    await sql<{ state: string; claims: number; attempt: string | null; outcome: string | null; due_at: number | null }>(
      w.t.store,
      "SELECT state, claims, attempt, outcome, due_at FROM remote_media_stills WHERE token = ?",
      t,
    )
  )[0];

describe("the remote stills' windows (PR5 plan, section 4)", () => {
  it("W-S1: a tick overlapping a round in flight claims nothing while the lease is live", async () => {
    const w = await mediaWorld();
    const a = await video(w);
    await video(w);
    const held = deferred();
    const entered = deferred();
    const first = round(w, maker({ gate: held.promise, entered: entered.resolve }).stills);
    await entered.promise;
    await safe(w);
    const overlap = maker();
    expect(await round(w, overlap.stills)).toEqual({
      status: "unclaimed",
      claim: { status: "idle", reason: "leased" },
    });
    expect(overlap.calls).toEqual([]);
    held.resolve();
    expect(await first).toMatchObject({ status: "recorded", token: a.token });
    await safe(w);
  });

  it("W-S2: a round that dies after its claim: the lease expires and the next claim replaces its reservation", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    const died = maker({ answer: { ok: false, failure: "unavailable", image: null } });
    // The claim alone, as a round that died right after it leaves it.
    const claimed = await w.t.store.claimRemoteStill(BUILD, { ...STILLS, cap: CAP });
    expect(claimed).toMatchObject({ status: "claimed", claims: 1 });
    await safe(w);
    const start = Date.now();
    at(w, start + STILL_LEASE_MS);
    expect(await round(w, died.stills)).toEqual({ status: "unclaimed", claim: { status: "idle", reason: "none" } });
    at(w, start + LATE_PUT_MS);
    const next = await round(w, maker().stills);
    expect(next).toMatchObject({ status: "recorded", token: v.token });
    expect(await stillOf(w, v.token)).toMatchObject({ state: "stored", claims: 2 });
    await safe(w);
  });

  it("W-S3: attempt k's put landing after attempt k+1 began is unnamed, refused, and swept", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    const putHeld = deferred();
    const putEntered = deferred();
    let landed: string | null = null;
    const k = round(w, maker().stills, {
      bucket: bucketWith({
        put: async (key, real) => {
          putEntered.resolve();
          await putHeld.promise;
          landed = key;
          return real();
        },
      }),
    });
    await putEntered.promise;
    const start = Date.now();
    // k's round is held past its lease and its row's retry time: attempt k+1 claims and records.
    at(w, start + LATE_PUT_MS);
    const next = await round(w, maker().stills);
    expect(next).toMatchObject({ status: "recorded" });
    await safe(w);
    // k's put lands now; its round gave the put up and, past its own end, settles nothing (a failure of k would be
    // stale: k+1 is the row's attempt).
    putHeld.resolve();
    expect(await k).toMatchObject({ status: "failed", disposition: { reason: "put" }, settled: null });
    expect(await stillOf(w, v.token)).toMatchObject({
      state: "stored",
      attempt: (next as { attempt: string }).attempt,
    });
    expect(landed).not.toBeNull();
    expect(landed).not.toBe(`remote/${v.token}/s${(next as { attempt: string }).attempt}`);
    await safe(w);
    const uploaded = Date.now();
    const sweep = (now: number) => w.op(remoteMediaOrphans, { keys: [{ key: landed!, uploaded }], cursor: null, now });
    expect(await sweep(uploaded + LATE_PUT_MS)).toEqual({ orphans: [] });
    expect(await sweep(uploaded + LATE_PUT_MS + 1)).toEqual({ orphans: [landed] });
  });

  it("W-S5: a doom while a still is claimed: refused at admission, the deletion due at claimed_at + LATE_PUT_MS", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    const held = deferred();
    const entered = deferred();
    const doomed = round(w, maker({ gate: held.promise, entered: entered.resolve }).stills);
    await entered.promise;
    const claimedAt = Date.now();
    await w.db((d) => dropAttachmentFiles(d, v.media, Date.now()));
    held.resolve();
    expect(await doomed).toMatchObject({
      status: "failed",
      disposition: { reason: "admission" },
      settled: { status: "doomed" },
    });
    expect(await w.objects()).toMatchObject([{ token: v.token, state: "doomed", due_at: claimedAt + LATE_PUT_MS }]);
    await w.exact();
    at(w, claimedAt + LATE_PUT_MS);
    const maintained = await w.op(maintainRemoteMedia, {
      now: Date.now(),
      restoredAt: null,
      cap: CAP,
      retentionDays: 14,
    });
    expect(maintained.deletions.flat()).toEqual([{ token: v.token, keys: [`remote/${v.token}/full`] }]);
  });

  it("W-S10: a dump beginning mid-still refuses the admission: nothing is put", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    const puts: string[] = [];
    const { stills } = maker();
    const dumped = await round(w, stills, {
      store: new Proxy(w.t.store, {
        get(target, name, receiver) {
          const value: unknown = Reflect.get(target, name, receiver);
          if (name === "admitRemoteStill") {
            return async (...args: unknown[]) => {
              await gate(w.t.store, "dump", true);
              return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
            };
          }
          return value;
        },
      }),
      bucket: { put: (key: string) => (puts.push(key), Promise.resolve(null)) } as unknown as R2Bucket,
    });
    expect(dumped).toMatchObject({ status: "failed", disposition: { reason: "admission" } });
    expect(puts).toEqual([]);
    await gate(w.t.store, "dump", false);
    expect(await stillOf(w, v.token)).toMatchObject({ state: "queued", claims: 1 });
  });

  it("W-S11: disabled with one queued, the row stays as it was and is claimed once enabled again", async () => {
    const w = await mediaWorld();
    const v = await video(w);
    const before = await stillOf(w, v.token);
    const { stills, calls } = maker();
    expect(await round(w, stills, { budget: 0 })).toEqual({ status: "off" });
    expect(await round(w, null as unknown as RemoteStillMaker)).toEqual({ status: "off" });
    expect(calls).toEqual([]);
    expect(await stillOf(w, v.token)).toEqual(before);
    expect(await round(w, stills)).toMatchObject({ status: "recorded", token: v.token });
    await safe(w);
  });
});
