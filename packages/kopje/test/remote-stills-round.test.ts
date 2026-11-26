import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { healthReport } from "../src/app/health";
import { PROBE_RETRY_MS, probeName } from "../src/domain/media-probes";
import { LATE_PUT_MS, recordRemoteMedia, remoteMediaOrphans, type StillsActivation } from "../src/domain/remote-media";
import { STILL_LEASE_MS } from "../src/domain/remote-media-stills";
import {
  REMOTE_STILL_CALL_MS,
  remoteStillsRound,
  type RemoteStillsDeps,
  STILL_PUT_GRANT_MS,
} from "../src/jobs/remote-stills";
import { remoteStillsDeps, scheduledRemoteStills } from "../src/jobs/scheduled";
import { STILL_CALL_MS } from "../src/media-processor";
import { readConfig } from "../src/platform/config";
import { remoteMediaPath, restoreMarkerKey } from "../src/platform/media-files";
import type { StillMaker, StillOutcome } from "../src/platform/media-transcoder";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { harness } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { BUILD } from "./helpers";
import { TestCodec } from "./media-helpers";
import { stillPng } from "./media-job-helpers";
import { gate } from "./media-processing-helpers";
import { mp4 } from "./remote-media-fixtures";
import { claimWith, fence, mediaWorld, type MediaWorld } from "./remote-media-helpers";

// The remote stills' round (#1828 PR5-2; jobs/remote-stills.ts) over the production Store: a fake StillMaker answers as
// the processor's object would, TestCodec stands in for Images, and the media bucket is the real one. Each case states
// the disposition of 1.4 of the PR5 plan (retry or park, the lease, the infrastructure failure) from the Store's rows.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
});

afterEach(() => {
  vi.useRealTimers();
});

const CAP = 4 * 1024 * 1024 * 1024;
const STILLS: StillsActivation = { binding: true, budget: 5, build: BUILD };

let tokens = 0;
const token = () => `${(++tokens).toString(16).padStart(8, "0")}${"b".repeat(32)}`;
let videos = 0;

function at(w: MediaWorld, ms: number): void {
  w.clock.now = ms;
  vi.setSystemTime(ms);
}

async function passStill(w: MediaWorld, ok = true): Promise<void> {
  await sql(
    w.t.store,
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
    probeName("record", "still@standard-1"),
    JSON.stringify({ version: BUILD, imageTag: null, at: Date.now(), ok, ...(ok ? { imagesVerified: true } : {}) }),
  );
}

// A remote video's attachment cached with stills active: its still queued, due now.
async function video(w: MediaWorld) {
  const n = ++videos;
  const account = await w.remote({ avatar: null });
  const url = `https://files.example/rv/${n}.mp4`;
  const { media } = await w.attach(account.id, url, { type: "video" });
  const claimed = await claimWith(w, token, 8);
  const claim = claimed.claims.find((c) => c.kind === "attachment")!;
  expect(
    await w.op(recordRemoteMedia, {
      ...fence(claim),
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
    }),
  ).toEqual({ held: true });
  return { account: account.id, media, token: claim.token, slot: claim.slot };
}

type StillRow = {
  state: string;
  claims: number;
  due_at: number | null;
  claimed_at: number | null;
  attempt: string | null;
  outcome: string | null;
  still_charge: number;
};
const stillOf = async (w: MediaWorld, t: string) =>
  (await sql<StillRow>(w.t.store, "SELECT * FROM remote_media_stills WHERE token = ?", t))[0];
const leaseOf = async (w: MediaWorld) => {
  const [row] = await sql<{ value: string }>(
    w.t.store,
    "SELECT value FROM kopje_state WHERE name = 'remote_still_lease'",
  );
  return row === undefined ? null : (JSON.parse(row.value) as { holder: string; until: number });
};
const infraFailure = async (w: MediaWorld) =>
  (
    await sql<{ value: string }>(
      w.t.store,
      "SELECT value FROM kopje_state WHERE name = ?",
      probeName("failure", "still@standard-1"),
    )
  ).length > 0;

// A still maker whose remote() answers `answer`, recording its calls.
function maker(answer: (token: string, attempt: string) => StillOutcome | Promise<StillOutcome>) {
  const calls: { token: string; attempt: string; ms: number }[] = [];
  const stills: StillMaker = {
    still: () => Promise.reject(new Error("no rebuild still in the round")),
    probe: () => Promise.reject(new Error("no probe in the round")),
    remote: async (t, attempt, ms) => {
      calls.push({ token: t, attempt, ms });
      return answer(t, attempt);
    },
    probeInput: new Uint8Array(),
  };
  return { stills, calls };
}

const made = async (): Promise<StillOutcome> => ({ ok: true, png: await stillPng(), image: "media@sha256:test" });

// The media bucket, its puts recorded (`before` runs ahead of each).
function recordingBucket(before?: (key: string) => Promise<void>) {
  const puts: { key: string; type: string | undefined }[] = [];
  const bucket = {
    put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
      await before?.(key);
      puts.push({ key, type: (options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType });
      return env.MEDIA.put(key, value, options);
    },
  };
  return { puts, bucket };
}

// The Store with `hooks` run after the named calls answer, and every call counted.
function storeWith(store: StoreStub, hooks: Record<string, (answer: unknown) => Promise<void> | void> = {}) {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== "function" || typeof name !== "string") {
        return value;
      }
      return async (...args: unknown[]) => {
        calls.push(name);
        const answer: unknown = await Reflect.apply(value as (...a: unknown[]) => Promise<unknown>, target, args);
        await hooks[name]?.(answer);
        return answer;
      };
    },
  });
  return { store: proxy, calls };
}

function deps(w: MediaWorld, stills: StillMaker | null, extra: Partial<RemoteStillsDeps> = {}): RemoteStillsDeps {
  return {
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
  };
}

describe("the round makes, checks, puts and records one still (P20a, P20c, P22, P-ISO)", () => {
  it("puts the WebP at remote/<token>/s<attempt> as image/webp after its admission, and the route serves it", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const { stills, calls } = maker(made);
    const { puts, bucket } = recordingBucket();
    const codec = new TestCodec();
    const round = await remoteStillsRound(deps(w, stills, { bucket, images: codec }));
    expect(round).toMatchObject({ status: "recorded", token: v.token });
    const attempt = (round as { attempt: string }).attempt;
    // One container call on the claim's token and attempt, within the processor's own bound.
    expect(calls).toEqual([{ token: v.token, attempt, ms: REMOTE_STILL_CALL_MS }]);
    expect(REMOTE_STILL_CALL_MS).toBe(STILL_CALL_MS);
    expect(puts).toEqual([{ key: `remote/${v.token}/s${attempt}`, type: "image/webp" }]);
    // Two Images transformations (the WebP and its RGBA) and one metadata call (the WebP's info), none charged to the
    // Images budgets (P20c, P22).
    expect(codec.encodeCalls.map((call) => call.format)).toEqual(["image/webp", "rgba"]);
    expect(codec.infoCalls).toBe(1);
    expect(await sql(w.t.store, "SELECT name FROM kopje_state WHERE name LIKE '%transform%'")).toEqual([]);
    expect(await sql(w.t.store, "SELECT value FROM kopje_state WHERE name LIKE 'media_still_jobs:%'")).toEqual([
      { value: "1" },
    ]);
    expect(await stillOf(w, v.token)).toMatchObject({ state: "stored", attempt, claims: 1 });
    expect(await leaseOf(w)).toBeNull();
    const [slot] = await sql<{ still_key: string; still_ext: string }>(
      w.t.store,
      "SELECT still_key, still_ext FROM remote_media WHERE id = ?",
      v.slot,
    );
    expect(slot).toEqual({ still_key: `s${attempt}`, still_ext: "webp" });
    // Served through the real route, GET and HEAD.
    const app = harness(w.t.store, { MAINTENANCE: "readonly", MEDIA: env.MEDIA });
    const path = remoteMediaPath(v.token, `s${attempt}`, "image/webp");
    expect(path).toBe(`/media/r/${v.token}/s${attempt}.webp`);
    const got = await app.request(path);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/webp");
    expect((await got.arrayBuffer()).byteLength).toBe((round as { bytes: number }).bytes);
    const head = await app.request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/webp");
  });

  it("records the still without a blurhash when only Images' RGBA output fails", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const codec = new TestCodec();
    codec.failRgba = 9500;
    const round = await remoteStillsRound(deps(w, maker(made).stills, { images: codec }));
    expect(round).toMatchObject({ status: "recorded" });
    const [slot] = await sql<{ still_blurhash: string | null }>(
      w.t.store,
      "SELECT still_blurhash FROM remote_media WHERE id = ?",
      v.slot,
    );
    expect(slot!.still_blurhash).toBeNull();
  });
});

describe("each outcome of the PR5 plan's 1.4 (P19c, design 4.14)", () => {
  const failed = (failure: string, extra: Partial<Extract<StillOutcome, { ok: false }>> = {}): StillOutcome => ({
    ok: false,
    failure,
    image: null,
    ...extra,
  });
  // [case, the container's answer, outcome, infrastructure failure, lease kept]
  const cases: [string, () => Promise<StillOutcome> | StillOutcome, "retry" | "park", boolean, boolean][] = [
    ["an input refusal", () => failed("still:no_video", { input: "no_video" }), "park", false, false],
    ["500 still_failed (r3 L2)", () => failed("still:still_failed"), "park", false, false],
    ["operation-deadline: cut after the input drained", () => failed("operation-deadline"), "park", false, false],
    ["input-deadline: cut before the input drained", () => failed("input-deadline"), "retry", false, false],
    ["input-missing", () => failed("input-missing"), "retry", false, false],
    ["readiness", () => failed("ready"), "retry", true, false],
    ["route evidence", () => failed("still:404", { evidence: "route" }), "retry", true, false],
    ["500 internal (a death or the server's kill)", () => failed("still:internal"), "retry", false, false],
    ["a lost connection", () => failed("operation"), "retry", false, false],
    ["busy before any start", () => failed("busy"), "retry", false, false],
    ["an unconfirmed destroy", () => failed("destroy", { pending: true }), "retry", false, true],
    ["no answer over the RPC", () => failed("unavailable"), "retry", false, true],
    ["a PNG verifyStill refuses", () => ({ ok: true, png: new Uint8Array(64), image: null }), "park", true, false],
  ];
  it.each(cases)("%s", async (_name, answer, outcome, infrastructure, kept) => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const codec = new TestCodec();
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(deps(w, maker(answer).stills, { bucket, images: codec }));
    expect(round).toMatchObject({
      status: "failed",
      disposition: { outcome, infrastructure, keepLease: kept },
      settled: { status: "settled", outcome },
    });
    const attempt = (round as { attempt: string }).attempt;
    expect(await stillOf(w, v.token)).toMatchObject({
      outcome,
      still_charge: 0,
      due_at: outcome === "park" ? null : expect.any(Number),
    });
    expect(await infraFailure(w)).toBe(infrastructure);
    expect((await leaseOf(w))?.holder ?? null).toBe(kept ? attempt : null);
    expect(puts).toEqual([]);
    if (_name === "a PNG verifyStill refuses") {
      // MEDIA-9: a refused PNG reaches no Images call.
      expect(codec.encodeCalls).toEqual([]);
    }
  });

  it.each([
    ["9422 (spent)", 9422, false],
    ["a failure of the service", 9500, false],
    ["a refusal of the verified PNG as input", 9412, true],
  ] as const)("parks a still whose WebP Images fails with %s, with no put", async (_name, code, infrastructure) => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const codec = new TestCodec();
    codec.failEncode = code;
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(deps(w, maker(made).stills, { bucket, images: codec }));
    expect(round).toMatchObject({ status: "failed", disposition: { outcome: "park", infrastructure } });
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "park", due_at: null, still_charge: 0 });
    expect(await infraFailure(w)).toBe(infrastructure);
    expect(puts).toEqual([]);
  });

  // MEDIA-6 (P20e): Images' WebP that stillWebpSize refuses (here: past STILL_LONG_EDGE) is never put.
  it("parks a WebP that stillWebpSize refuses, with no put", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const codec = new TestCodec();
    // Images' WebP answered at the PNG's own edges, past the still's long edge.
    codec.encodeResponder = (options) => (options.format === "image/webp" ? WIDE_WEBP : null);
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(deps(w, maker(made).stills, { bucket, images: codec }));
    expect(round).toMatchObject({ status: "failed", disposition: { outcome: "park", infrastructure: false } });
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "park" });
    expect(puts).toEqual([]);
  });

  it("settles a retry when R2 refuses a timely put, the lease released", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const bucket = { put: () => Promise.reject(new Error("R2 refused the put")) };
    const round = await remoteStillsRound(deps(w, maker(made).stills, { bucket }));
    expect(round).toMatchObject({
      status: "failed",
      disposition: { outcome: "retry", reason: "put", keepLease: false },
      settled: { status: "settled", outcome: "retry" },
    });
    expect(await stillOf(w, v.token)).toMatchObject({ state: "queued", outcome: "retry", still_charge: 0 });
    expect(await leaseOf(w)).toBeNull();
  });

  it("answers unconfirmed when the record's reply is lost, the committed record kept", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const lost = storeWith(w.t.store, {
      recordRemoteStill: () => {
        throw new Error("the reply was lost");
      },
    });
    const round = await remoteStillsRound(deps(w, maker(made).stills, { store: lost.store }));
    expect(round).toMatchObject({ status: "unconfirmed", token: v.token });
    const attempt = (round as { attempt: string }).attempt;
    expect(lost.calls).not.toContain("failRemoteStill");
    expect(await stillOf(w, v.token)).toMatchObject({ state: "stored", attempt });
    expect(await sql(w.t.store, "SELECT still_key FROM remote_media WHERE id = ?", v.slot)).toEqual([
      { still_key: `s${attempt}` },
    ]);
  });
});

// A still WebP of 1000x10, past STILL_LONG_EDGE (640): a VP8L bitstream header with those edges.
const WIDE_WEBP = (() => {
  const width = 1000 - 1;
  const height = 10 - 1;
  const vp8l = new Uint8Array([
    0x2f,
    width & 0xff,
    ((width >> 8) & 0x3f) | ((height & 0x03) << 6),
    (height >> 2) & 0xff,
    (height >> 10) & 0x0f,
    0,
  ]);
  const chunk = new Uint8Array(8 + vp8l.length);
  chunk.set(new TextEncoder().encode("VP8L"), 0);
  new DataView(chunk.buffer).setUint32(4, vp8l.length, true);
  chunk.set(vp8l, 8);
  const out = new Uint8Array(12 + chunk.length);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + chunk.length, true);
  out.set(new TextEncoder().encode("WEBP"), 8);
  out.set(chunk, 12);
  return out;
})();

describe("put admission (P19d, W-S7, W-S10)", () => {
  // The extraction held while the change happens: admission refuses, so nothing is put, and the attempt is retried.
  it.each([
    ["reject_media on the author's domain", "reject"],
    ["an icon of the attachment's own", "icon"],
    ["readonly maintenance", "maintenance"],
    ["a restore", "restore"],
  ] as const)("puts nothing when %s comes during the extraction", async (_name, change) => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const markerKey = restoreMarkerKey(w.t.store.id.toString());
    const { stills } = maker(async () => {
      if (change === "reject") {
        const [author] = await sql<{ domain: string }>(
          w.t.store,
          "SELECT domain FROM accounts WHERE id = ?",
          v.account,
        );
        await blockDomain(w.t.store, author!.domain, "noop", { rejectMedia: true });
      } else if (change === "icon") {
        await sql(
          w.t.store,
          "UPDATE media_attachments SET preview_url = ? WHERE id = ?",
          "https://files.example/i.png",
          v.media,
        );
      } else if (change === "maintenance") {
        await gate(w.t.store, "maintenance", true);
      } else {
        await env.MEDIA.put(markerKey, JSON.stringify({ at: Date.now() }));
      }
      return made();
    });
    const { puts, bucket } = recordingBucket();
    try {
      const round = await remoteStillsRound(deps(w, stills, { bucket }));
      expect(round).toMatchObject({ status: "failed", disposition: { outcome: "retry", reason: "admission" } });
      expect(puts).toEqual([]);
      expect(await stillOf(w, v.token)).toMatchObject({ state: "queued" });
    } finally {
      await env.MEDIA.delete(markerKey);
    }
  });

  it("puts nothing on a grant whose answer came past STILL_PUT_GRANT_MS", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    const late = storeWith(w.t.store, {
      admitRemoteStill: () => void vi.setSystemTime(Date.now() + STILL_PUT_GRANT_MS + 1),
    });
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(deps(w, maker(made).stills, { bucket, store: late.store }));
    expect(late.calls).toContain("admitRemoteStill");
    expect(round).toMatchObject({ status: "failed", disposition: { reason: "admission" } });
    expect(puts).toEqual([]);
  });

  it("puts nothing when the grant expires during the last check before the put", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    const edge = storeWith(w.t.store, {
      admitRemoteStill: () => void vi.setSystemTime(Date.now() + STILL_PUT_GRANT_MS),
    });
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(
      deps(w, maker(made).stills, {
        bucket,
        store: edge.store,
        maintenance: () => {
          vi.setSystemTime(Date.now() + 1);
          return false;
        },
      }),
    );
    expect(edge.calls).toContain("admitRemoteStill");
    expect(round).toMatchObject({ status: "failed", disposition: { reason: "admission" } });
    expect(puts).toEqual([]);
  });

  it("puts nothing on a timely grant when the env's maintenance is set before the put", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    let maintenance = false;
    const granted = storeWith(w.t.store, { admitRemoteStill: () => void (maintenance = true) });
    const { puts, bucket } = recordingBucket();
    const round = await remoteStillsRound(
      deps(w, maker(made).stills, { bucket, store: granted.store, maintenance: () => maintenance }),
    );
    expect(granted.calls).toContain("admitRemoteStill");
    expect(round).toMatchObject({ status: "failed", disposition: { reason: "admission" } });
    expect(puts).toEqual([]);
  });

  // The cron's recheck reads the invocation's env snapshot through the config reader (remoteStillsDeps): an env in
  // maintenance refuses the put after a timely grant.
  it("puts nothing after a timely grant when the invocation's env snapshot is in maintenance", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    await video(w);
    const { puts, bucket } = recordingBucket();
    const cron = (maintenance: string) =>
      remoteStillsDeps(
        { ...env, MEDIA: bucket, MEDIA_STILL_MONTHLY_JOBS: "5", MAINTENANCE: maintenance } as unknown as Env,
        {
          build: () => BUILD,
          store: () => w.t.store,
          stills: () => maker(made).stills,
          images: () => new TestCodec(),
          now: () => Date.now(),
        },
      )!;
    expect(await remoteStillsRound(cron("readonly"))).toMatchObject({
      status: "failed",
      disposition: { reason: "admission" },
    });
    expect(puts).toEqual([]);
    // The guarded branch: the same env out of maintenance puts.
    expect(await remoteStillsRound(cron("off"))).toMatchObject({ status: "recorded" });
    expect(puts).toHaveLength(1);
  });

  // r3 L1: a timely grant then a Store-only gate change (reject_media) with the env unchanged: the put happens, its
  // record is refused, and its key, which no row names, is swept past its bound.
  it("puts after a timely grant when only the Store's gate changed, refuses the record, and the sweep takes the key", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const { puts, bucket } = recordingBucket(async () => {
      const [author] = await sql<{ domain: string }>(w.t.store, "SELECT domain FROM accounts WHERE id = ?", v.account);
      await blockDomain(w.t.store, author!.domain, "noop", { rejectMedia: true });
    });
    const round = await remoteStillsRound(deps(w, maker(made).stills, { bucket }));
    expect(round).toMatchObject({ status: "failed", disposition: { reason: "record", outcome: "retry" } });
    const attempt = (round as { attempt: string }).attempt;
    const key = `remote/${v.token}/s${attempt}`;
    expect(puts).toEqual([{ key, type: "image/webp" }]);
    const [slot] = await sql<{ still_key: string | null }>(
      w.t.store,
      "SELECT still_key FROM remote_media WHERE id = ?",
      v.slot,
    );
    expect(slot!.still_key).toBeNull();
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "retry", still_charge: 0 });
    const uploaded = (await env.MEDIA.head(key))!.uploaded.getTime();
    const sweep = (now: number) => w.op(remoteMediaOrphans, { keys: [{ key, uploaded }], cursor: null, now });
    expect(await sweep(uploaded + LATE_PUT_MS)).toEqual({ orphans: [] });
    expect(await sweep(uploaded + LATE_PUT_MS + 1)).toEqual({ orphans: [key] });
  });
});

describe("the round's bounds (P-RND, G1, RES-6)", () => {
  it("makes no Store call without the binding or with a budget of 0, from the cron too", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    const counted = storeWith(w.t.store);
    expect(await remoteStillsRound(deps(w, null, { store: counted.store }))).toEqual({ status: "off" });
    expect(await remoteStillsRound(deps(w, maker(made).stills, { store: counted.store, budget: 0 }))).toEqual({
      status: "off",
    });
    const cron = (stills: StillMaker | null, budget: string) =>
      scheduledRemoteStills({ ...env, MEDIA_STILL_MONTHLY_JOBS: budget } as Env, {
        build: () => BUILD,
        store: () => counted.store,
        stills: () => stills,
        images: () => new TestCodec(),
        now: () => Date.now(),
      });
    await cron(null, "5");
    await cron(maker(made).stills, "0");
    expect(counted.calls).toEqual([]);
    // The guarded branch: with both, the cron claims.
    await cron(maker(made).stills, "5");
    expect(counted.calls[0]).toBe("claimRemoteStill");
  });

  // The claim committed and its reply lost: the round starts nothing, and the claim recovers as after a round that
  // died after it (W-S2): the lease lapses and the row is due again LATE_PUT_MS after its claim.
  it("starts nothing when the claim's reply is lost, and the next claim after its retry time records", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    const lost = storeWith(w.t.store, {
      claimRemoteStill: () => {
        throw new Error("the reply was lost");
      },
    });
    const { stills, calls } = maker(made);
    const { puts, bucket } = recordingBucket();
    await expect(remoteStillsRound(deps(w, stills, { store: lost.store, bucket }))).rejects.toThrow("lost");
    expect(lost.calls).toEqual(["claimRemoteStill"]);
    expect(calls).toEqual([]);
    expect(puts).toEqual([]);
    expect(await stillOf(w, v.token)).toMatchObject({ state: "queued", claims: 1 });
    const start = Date.now();
    at(w, start + STILL_LEASE_MS);
    expect(await remoteStillsRound(deps(w, stills))).toEqual({
      status: "unclaimed",
      claim: { status: "idle", reason: "none" },
    });
    at(w, start + LATE_PUT_MS);
    expect(await remoteStillsRound(deps(w, stills))).toMatchObject({ status: "recorded", token: v.token });
    expect(await stillOf(w, v.token)).toMatchObject({ state: "stored", claims: 2 });
  });

  it("claims one still a tick", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    await video(w);
    const { stills, calls } = maker(made);
    await remoteStillsRound(deps(w, stills));
    expect(calls).toHaveLength(1);
    expect(
      await sql(w.t.store, "SELECT count(*) AS n FROM remote_media_stills WHERE state = 'queued' AND claims = 0"),
    ).toEqual([{ n: 1 }]);
  });

  // A still answered past its call's bound (STILL_CALL_MS and its way back) is not used: whether the container
  // stopped is not known, so the lease is kept and the attempt retried, nothing put.
  it("gives up a still answered past its call's bound, keeping the lease and putting nothing", async () => {
    const w = await mediaWorld();
    await passStill(w);
    const v = await video(w);
    let skew = 0;
    const { puts, bucket } = recordingBucket();
    const { stills } = maker(async () => {
      skew = REMOTE_STILL_CALL_MS + 5_000;
      return made();
    });
    const round = await remoteStillsRound(deps(w, stills, { bucket, now: () => Date.now() + skew }));
    expect(round).toMatchObject({
      status: "failed",
      disposition: { reason: "unavailable", keepLease: true, outcome: "retry" },
      settled: { status: "settled" },
    });
    expect(puts).toEqual([]);
    expect((await leaseOf(w))?.holder).toBe((round as { attempt: string }).attempt);
    expect(await stillOf(w, v.token)).toMatchObject({ outcome: "retry", still_charge: 0 });
  });
});

describe("the lease (P-LEASE, W-S1, W-S13)", () => {
  it("keeps the lease past the next tick after a lost answer, then claims once it expires", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await video(w);
    const second = await video(w);
    const lost = await remoteStillsRound(
      deps(w, maker(() => ({ ok: false, failure: "unavailable", image: null })).stills),
    );
    expect(lost).toMatchObject({ status: "failed", disposition: { keepLease: true } });
    const start = Date.now();
    at(w, start + 5 * 60 * 1000);
    const { stills, calls } = maker(made);
    expect(await remoteStillsRound(deps(w, stills))).toEqual({
      status: "unclaimed",
      claim: { status: "idle", reason: "leased" },
    });
    expect(calls).toEqual([]);
    at(w, start + STILL_LEASE_MS);
    expect(await remoteStillsRound(deps(w, stills))).toMatchObject({ status: "recorded", token: second.token });
  });
});

describe("an infrastructure failure makes the probe due; a failed probe stops claims (P-INF)", () => {
  it("records the failure, health notes it, the probe is claimable after its cooldown, and a fail stops claims", async () => {
    const w = await mediaWorld();
    const t0 = Date.now();
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
    await video(w);
    await video(w);
    at(w, t0 + 1000);
    const bad = await remoteStillsRound(
      deps(w, maker(() => ({ ok: true, png: new Uint8Array(64), image: null })).stills),
    );
    expect(bad).toMatchObject({ disposition: { infrastructure: true } });
    const config = readConfig({ ...env, MEDIA_STILL_MONTHLY_JOBS: "5" });
    const health = await healthReport(BUILD, config, () => w.t.store, { mediaProcessor: { binding: true } });
    expect(health.checks.mediaProcessor).toMatchObject({ ok: true, state: "ready", infrastructureFailure: true });
    const due = () => w.t.store.claimMediaProbe(BUILD, { profile: "still@standard-1", build: BUILD, due: true });
    expect(await due()).toMatchObject({ status: "cooldown" });
    at(w, t0 + PROBE_RETRY_MS);
    const again = await due();
    expect(again.status).toBe("claimed");
    await w.t.store.recordMediaProbeResult(BUILD, {
      profile: "still@standard-1",
      claim: (again as { claim: string }).claim,
      outcome: "fail",
      imagesVerified: false,
      imageTag: null,
    });
    expect(await remoteStillsRound(deps(w, maker(made).stills))).toEqual({
      status: "unclaimed",
      claim: { status: "idle", reason: "inactive" },
    });
  });
});

describe("the remote media round queues stills only when they are active (P18, D18)", () => {
  // A remote video the real round caches with `vars` in its env.
  async function cached(w: MediaWorld, vars: Record<string, unknown>) {
    const author = await w.remote({ avatar: null });
    const url = `https://files.example/rq/${++videos}.mp4`;
    await w.attach(author.id, url, { type: "video" });
    const file = mp4({ mdat: 1000 });
    w.serve(url, file, { "content-length": String(file.length) });
    expect(await w.round({}, vars)).toMatchObject({ claimed: 1, stored: 1 });
  }
  const rows = (w: MediaWorld) => sql(w.t.store, "SELECT state, claims FROM remote_media_stills");

  it("queues a still with the binding, a positive MEDIA_STILL_MONTHLY_JOBS and a pass for the build", async () => {
    const w = await mediaWorld();
    await passStill(w);
    await cached(w, { MEDIA_PROCESSOR: {}, MEDIA_STILL_MONTHLY_JOBS: "5" });
    expect(await rows(w)).toEqual([{ state: "queued", claims: 0 }]);
  });

  it.each([
    ["without the binding", { MEDIA_STILL_MONTHLY_JOBS: "5" }, true],
    ["with a budget of 0", { MEDIA_PROCESSOR: {} }, true],
    ["without a pass for the build", { MEDIA_PROCESSOR: {}, MEDIA_STILL_MONTHLY_JOBS: "5" }, false],
  ] as const)("queues none %s", async (_name, vars, pass) => {
    const w = await mediaWorld();
    if (pass) {
      await passStill(w);
    }
    await cached(w, vars);
    expect(await w.objects()).toMatchObject([{ state: "stored" }]);
    expect(await rows(w)).toEqual([]);
  });
});
