import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { run as cliRun } from "../cli/lib/main.js";
import { Db } from "../src/db/sql";
import { chargeUploadJob } from "../src/domain/media";
import { REBUILD_LEASE_MS, REBUILD_SETTLE_MS } from "../src/domain/media-rebuild";
import { stillActivationProbe } from "../src/mastodon/media-activation";
import {
  MAX_BUILDS_PER_CALL,
  REBUILD_CALL_BUDGET_MS,
  rebuildMedia,
  type RebuildStep,
} from "../src/mastodon/media-rebuild";
import { MAX_AV_BUILDS_PER_CALL, PROBE_RETRY_MS, REBUILD_AV_MS } from "../src/mastodon/media-rebuild-av";
import type { StillMaker, StillOutcome } from "../src/platform/media-transcoder";
import type { StoreStub } from "../src/platform/store-client";
import { MEDIA_META_BYTES } from "../src/platform/stored-bounds";
import { randomToken } from "../src/security/tokens";
import { type AccessTeam, adminTeam, setTeamAccess } from "./access-helpers";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { avFixture, concat } from "./av-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { BUILD, deferred, migratedStore } from "./helpers";
import { pngOf } from "./local-emoji-helpers";
import { bytes, TestCodec } from "./media-helpers";
import { ACCESS, dumpViaRpc, memoryIO } from "./ops-helpers";
import { type PlannedStatement, plannedSql } from "./read-helpers";
import { encodeWebp } from "./webp-fixtures";

// kopje-admin media-rebuild of video and audio rows (#1828 design 4.16, P25; MEDIA-2's rebuild steps): `full` from the
// original through the output verifier, a video's `small` adopted or made by the media processor (a fake StillMaker
// here; the Durable Object side is test/media-processor.test.ts), the fallback, `--stills`, the still probe, and
// interruptions and lease loss with one call held at an explicit await while another commits.

const ACCOUNT = "110000000000000001";
const ORIGIN = "https://kopje.test";
let nextId = 0;
let team: AccessTeam;

beforeEach(async () => {
  team = await adminTeam();
});

function mediaId(): string {
  return String(130_000_000_000_000_000n + BigInt(++nextId));
}

async function setup(): Promise<StoreStub> {
  const store = await migratedStore();
  await setTeamAccess(store, team);
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
      ACCOUNT,
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('maintenance', ?)",
      JSON.stringify({ mode: "readonly", at: Date.now() - REBUILD_SETTLE_MS - 60_000 }),
    );
  });
  return store;
}

type AvRow = { id: string; token: string; original: Uint8Array };

// A restored video or audio row: its original in R2, none of its files, its meta and blurhash as the backup's dump had
// them.
async function addAv(
  store: StoreStub,
  kind: "video" | "audio",
  options: {
    original?: Uint8Array;
    preview?: boolean;
    small?: { width: number; height: number };
    blurhash?: string;
    // The stored meta as given, in place of the one made here.
    meta?: string;
  } = {},
): Promise<AvRow> {
  const id = mediaId();
  const token = randomToken();
  const original = options.original ?? (await avFixture(kind === "video" ? "r1-av.mp4" : "mp3.mp3"));
  const type = kind === "video" ? "video/mp4" : "audio/mpeg";
  const preview = kind === "video" && options.preview !== false;
  const small = options.small ?? { width: 320, height: 180 };
  const meta =
    kind === "video"
      ? {
          original: { width: 640, height: 360, frame_rate: "30/1", duration: 2, bitrate: 1000 },
          ...(preview ? { small } : {}),
        }
      : { original: { duration: 2, bitrate: 128_000 } };
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta, blurhash,
				processed)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      id,
      ACCOUNT,
      kind,
      `${ORIGIN}/media/${token}/full.${kind === "video" ? "mp4" : "mp3"}`,
      preview ? `${ORIGIN}/media/${token}/small.webp` : null,
      token,
      type,
      options.meta ?? JSON.stringify(meta),
      options.blurhash ?? null,
    );
  });
  await env.MEDIA.put(`originals/${id}`, original);
  return { id, token, original };
}

// A complete local image row whose files are missing, as test/media-rebuild.test.ts addRow makes one, under `id` (the
// caller's, so the candidates' order is the caller's).
async function addImage(store: StoreStub, id: string): Promise<{ id: string; token: string }> {
  const token = randomToken();
  await sql(
    store,
    `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta, processed)
			VALUES (?, ?, 'image', ?, ?, ?, 'image/png', '{"original":{"width":1,"height":1}}', 1)`,
    id,
    ACCOUNT,
    `${ORIGIN}/media/${token}/full.png`,
    `${ORIGIN}/media/${token}/small.png`,
    token,
  );
  await env.MEDIA.put(`originals/${id}`, bytes(PNG_PLAIN));
  return { id, token };
}

type Stored = { preview_url: string | null; meta: Record<string, unknown>; blurhash: string | null };

async function rowOf(store: StoreStub, id: string): Promise<Stored> {
  const [row] = await sql<{ preview_url: string | null; meta: string; blurhash: string | null }>(
    store,
    "SELECT preview_url, meta, blurhash FROM media_attachments WHERE id = ?",
    id,
  );
  return { ...row!, meta: JSON.parse(row!.meta) as Record<string, unknown> };
}

async function stateValue(store: StoreStub, prefix: string): Promise<string[]> {
  const rows = await sql<{ name: string; value: string }>(
    store,
    "SELECT name, value FROM kopje_state WHERE substr(name, 1, ?) = ? ORDER BY name",
    prefix.length,
    prefix,
  );
  return rows.map((r) => r.value);
}

async function bytesOf(key: string): Promise<Uint8Array | null> {
  const object = await env.MEDIA.get(key);
  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}

const STILL = await pngOf(320, 180);

// A StillMaker that answers STILL (or `answer`) and records its calls; `hold` makes a still wait for its gate.
function maker(options: { answer?: StillOutcome; probe?: StillOutcome; onStill?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const stills: StillMaker = {
    async still(key) {
      calls.push(`still ${key}`);
      await options.onStill?.();
      return options.answer ?? { ok: true, png: STILL, image: "media@sha256:test" };
    },
    async probe(key) {
      calls.push(`probe ${key}`);
      // The copy of the probe clip is there while the probe reads it.
      expect(await bytesOf(key)).toEqual(stills.probeInput);
      return options.probe ?? { ok: true, png: STILL, image: "media@sha256:test" };
    },
    remote: () => Promise.reject(new Error("no remote still in the rebuild")),
    probeInput: new Uint8Array([1, 2, 3, 4]),
  };
  return { stills, calls };
}

// The media bucket, every write recorded; `afterPut` runs once a put has landed, `onHead` before each head.
function recordingBucket(afterPut?: (key: string) => Promise<void>, onHead?: (key: string) => void) {
  const writes: string[] = [];
  const bucket = {
    head: (key: string) => {
      onHead?.(key);
      return env.MEDIA.head(key);
    },
    get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
    delete: async (keys: string | string[]) => {
      writes.push(`delete ${String(keys)}`);
      return env.MEDIA.delete(keys);
    },
    put: async (key: string, value: ReadableStream | Uint8Array, options?: R2PutOptions) => {
      writes.push(`put ${key}`);
      const put = await env.MEDIA.put(key, value, options);
      await afterPut?.(key);
      return put;
    },
  } as unknown as R2Bucket;
  return { bucket, writes };
}

type RunOptions = {
  stills?: StillMaker | null;
  bucket?: R2Bucket;
  codec?: TestCodec;
  uploads?: number;
  transforms?: number;
  publish?: boolean;
  after?: string | null;
  holder?: string;
  now?: () => number;
  heartbeatMs?: number;
};

function run(store: StoreStub, options: RunOptions = {}): Promise<RebuildStep> {
  return rebuildMedia(
    {
      build: BUILD,
      store,
      bucket: options.bucket ?? env.MEDIA,
      images: options.codec ?? new TestCodec(),
      now: options.now ?? (() => NOW),
      authority: { ...ACCESS, teamDomain: team.teamDomain },
      monthlyTransforms: options.transforms ?? 100,
      monthlyUploads: options.uploads ?? 10,
      stills: options.stills === undefined ? maker().stills : options.stills,
      ...(options.holder === undefined ? {} : { holder: options.holder }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    },
    { after: options.after ?? null, dryRun: false, stills: options.publish === true },
  );
}

// Moves the probe's recorded verdict and attempt `ms` into the past.
async function ageProbe(store: StoreStub, ms: number): Promise<void> {
  await sql(
    store,
    `UPDATE kopje_state SET value = json_set(value, '$.at', json_extract(value, '$.at') - ?)
			WHERE name IN ('media_probe:still@standard-1', 'media_probe_attempt:still@standard-1')`,
    ms,
  );
}

const counters = (store: StoreStub) =>
  Promise.all([stateValue(store, "images_transforms:"), stateValue(store, "media_upload_jobs:")]);

// What a finished video row is: its full the original, byte for byte, and its still recorded from the small's
// metadata, which equals the object's own geometry.
async function expectStill(store: StoreStub, row: AvRow): Promise<{ width: string; height: string; blurhash: string }> {
  expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
  const small = await env.MEDIA.head(`files/${row.token}/small`);
  expect(small).not.toBeNull();
  const metadata = small!.customMetadata as { width: string; height: string; blurhash: string };
  const stored = await rowOf(store, row.id);
  expect(stored.meta.small).toEqual({ width: Number(metadata.width), height: Number(metadata.height) });
  expect(stored.blurhash ?? "").toBe(metadata.blurhash);
  expect(stored.preview_url).toBe(`${ORIGIN}/media/${row.token}/small.webp`);
  return metadata;
}

describe("media rebuild of video and audio rows (#1828 P25)", () => {
  it("rebuilds a video row from its original, probing the still profile first, and a second run changes nothing", async () => {
    const store = await setup();
    const row = await addAv(store, "video", { blurhash: "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB" });
    const made = maker();
    const first = await run(store, { stills: made.stills });
    expect(first).toMatchObject({ ok: true, stopped: null, done: true, counts: { built: 1 }, problems: [] });
    expect(made.calls).toEqual([
      expect.stringMatching(/^probe incoming\/probe-[0-9a-f]{32}$/),
      `still originals/${row.id}`,
    ]);
    // The probe's copy is gone, and its record names this build.
    expect((await env.MEDIA.list({ prefix: "incoming/" })).objects).toEqual([]);
    expect((await stateValue(store, "media_probe:")).map((v) => JSON.parse(v) as unknown)).toEqual([
      { version: BUILD, imageTag: "media@sha256:test", at: expect.any(Number), ok: true, imagesVerified: true },
    ]);
    const metadata = await expectStill(store, row);
    expect(metadata).toMatchObject({ width: "320", height: "180" });
    // Charged as an upload's preview, and one upload unit for the container.
    expect(await counters(store)).toEqual([["3"], ["1"]]);

    const again = maker();
    const recording = recordingBucket();
    const second = await run(store, { stills: again.stills, bucket: recording.bucket });
    expect(second).toMatchObject({ ok: true, done: true, counts: { built: 0, "skipped-existing": 1 } });
    expect(again.calls).toEqual([]);
    expect(recording.writes).toEqual([]);
    expect(await counters(store)).toEqual([["3"], ["1"]]);
  });

  it("copies an audio row's file and makes no still", async () => {
    const store = await setup();
    const row = await addAv(store, "audio");
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 }, problems: [] });
    expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
    expect(made.calls).toEqual([]);
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { "skipped-existing": 1, built: 0 } });
  });

  it.each([
    ["", false],
    [", its body ending in an empty chunk", true],
  ])(
    "publishes nothing the verifier refuses: a file refused at its end never reaches R2%s",
    async (_name, emptyTail) => {
      const store = await setup();
      // The last byte of the last frame's audio changed: frame data is not parsed, so only the Xing frame's music CRC,
      // checked once the stream has ended, refuses it.
      const tagged = (await avFixture("mp3.mp3")).slice();
      tagged[tagged.length - 1]! ^= 0xff;
      const row = await addAv(store, "audio", { original: tagged });
      // R2 as a known-length upload behaves: committed once all its bytes arrived, whatever follows.
      let committed: Uint8Array | null = null;
      const bucket = {
        ...recordingBucket().bucket,
        head: (key: string) => env.MEDIA.head(key),
        get: async (key: string, options?: R2GetOptions) => {
          const object = await env.MEDIA.get(key, options);
          if (object === null || !emptyTail) {
            return object;
          }
          // The same bytes, then one empty chunk before the end.
          const body = object.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              flush(controller) {
                controller.enqueue(new Uint8Array(0));
              },
            }),
          );
          return { size: object.size, body };
        },
        put: async (key: string, value: ReadableStream<Uint8Array>) => {
          const reader = value.getReader();
          const parts: Uint8Array[] = [];
          let read = 0;
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) {
              break;
            }
            parts.push(chunk);
            read += chunk.byteLength;
            if (read === tagged.byteLength) {
              committed = concat(...parts);
              await env.MEDIA.put(key, committed);
            }
          }
          return null;
        },
      } as unknown as R2Bucket;
      const step = await run(store, { bucket });
      expect(step).toMatchObject({ ok: true, counts: { failed: 1, built: 0 } });
      expect((step as { problems: unknown[] }).problems).toEqual([
        { id: row.id, outcome: "failed", detail: "verify:xing" },
      ]);
      expect(committed).toBeNull();
      expect(await env.MEDIA.head(`files/${row.token}/full`)).toBeNull();
    },
  );

  it("reports a missing original and a video whose original is not an MP4, and writes nothing", async () => {
    const store = await setup();
    const missing = await addAv(store, "audio");
    await env.MEDIA.delete(`originals/${missing.id}`);
    const step = await run(store);
    expect(step).toMatchObject({ counts: { "original-missing": 1 } });
    const wrong = await addAv(store, "video", { original: await avFixture("mp3.mp3") });
    const next = await run(store, { after: missing.id });
    expect((next as { problems: unknown[] }).problems).toEqual([
      { id: wrong.id, outcome: "failed", detail: "verify:top_level" },
    ]);
    expect(await env.MEDIA.head(`files/${wrong.token}/full`)).toBeNull();
  });

  it("falls back without the processor, keeps it on a plain rebuild, and --stills publishes the still after it exists", async () => {
    const store = await setup();
    const row = await addAv(store, "video", { blurhash: "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB" });
    expect(await run(store, { stills: null })).toMatchObject({ counts: { fallback: 1, built: 0 } });
    expect(await rowOf(store, row.id)).toMatchObject({ preview_url: null, blurhash: null });
    expect((await rowOf(store, row.id)).meta).not.toHaveProperty("small");
    expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
    expect(await counters(store)).toEqual([[], []]);
    // Terminal for a plain rebuild, even with the processor now bound.
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { "skipped-existing": 1 } });
    expect(made.calls).toEqual([]);
    // --stills: interrupted right after the still's put, the row is not published yet.
    const interrupted = recordingBucket((key) =>
      key.endsWith("/small") ? Promise.reject(new Error("the Worker died")) : Promise.resolve(),
    );
    await expect(run(store, { publish: true, bucket: interrupted.bucket })).rejects.toThrow("the Worker died");
    expect(await rowOf(store, row.id)).toMatchObject({ preview_url: null });
    // The next --stills adopts that still and publishes it with the object's metadata, in one Store call.
    const resumed = maker();
    expect(await run(store, { publish: true, stills: resumed.stills })).toMatchObject({ counts: { built: 1 } });
    expect(resumed.calls).toEqual([]);
    await expectStill(store, row);
    expect(await run(store, { publish: true })).toMatchObject({ counts: { "skipped-existing": 1 } });
  });

  it.each([
    [
      "a probe whose container shows the build does not speak the protocol",
      { probe: { ok: false, failure: "route", image: null, evidence: "route" } as StillOutcome },
      {},
    ],
    [
      "a still of which the container found no frame",
      { answer: { ok: false, failure: "still:no_frame", image: null, input: "no_frame" } as StillOutcome },
      {},
    ],
    [
      "a still whose input the container refused",
      { answer: { ok: false, failure: "still:pixels", image: null, input: "pixels" } as StillOutcome },
      {},
    ],
    [
      "a still that is not a clean PNG",
      { answer: { ok: true, png: new Uint8Array(8), image: null } as StillOutcome },
      {},
    ],
    ["no upload unit left", {}, { uploads: 0 }],
  ])("falls back on %s", async (_name, answers, budgets) => {
    const store = await setup();
    const row = await addAv(store, "video");
    const made = maker(answers);
    // The cursor moves past the row: the call goes on.
    expect(await run(store, { stills: made.stills, ...budgets })).toMatchObject({
      counts: { fallback: 1 },
      stopped: null,
      done: true,
    });
    expect(await rowOf(store, row.id)).toMatchObject({ preview_url: null, blurhash: null });
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
    expect((await env.MEDIA.list({ prefix: "incoming/" })).objects).toEqual([]);
  });

  it("probes once per build: a pass is not probed again, a failure only after PROBE_RETRY_MS", async () => {
    const store = await setup();
    const first = await addAv(store, "video");
    const failing = maker({ probe: { ok: false, failure: "route", image: null, evidence: "route" } });
    expect(await run(store, { stills: failing.stills })).toMatchObject({ counts: { fallback: 1 } });
    expect(JSON.parse((await stateValue(store, "media_probe:"))[0]!)).toMatchObject({ ok: false, version: BUILD });
    // Within the cooldown a failed probe is not run again, however many calls come: the rows fall back.
    const second = await addAv(store, "video");
    const cooling = maker();
    expect(await run(store, { stills: cooling.stills, after: first.id })).toMatchObject({ counts: { fallback: 1 } });
    expect(cooling.calls).toEqual([]);
    expect(await counters(store)).toEqual([[], []]);
    // Once it is PROBE_RETRY_MS old, the next call probes again.
    await ageProbe(store, PROBE_RETRY_MS);
    const third = await addAv(store, "video");
    const passing = maker();
    expect(await run(store, { stills: passing.stills, after: second.id })).toMatchObject({ counts: { built: 1 } });
    expect(passing.calls.filter((c) => c.startsWith("probe"))).toHaveLength(1);
    // A pass for this build is not probed again.
    const fourth = await addAv(store, "video");
    const later = maker();
    await run(store, { stills: later.stills, after: third.id });
    expect(later.calls).toEqual([`still originals/${fourth.id}`]);
  });

  const failing = (answer: StillOutcome) => ({ answer });
  const probing = (probe: StillOutcome) => ({ probe });
  const failure = (code: string): StillOutcome => ({ ok: false, failure: code, image: null });
  // A codec whose RGBA output (only) fails with `code`.
  const rgbaFailing = (code: number) => {
    const codec = new TestCodec();
    codec.failRgba = code;
    return codec;
  };
  // A codec whose WebP encode fails with `code` (the probe's Images step comes first).
  const encodeFailing = (code: number) => {
    const codec = new TestCodec();
    codec.failEncode = code;
    return codec;
  };
  it.each([
    ["the still answers busy", failing(failure("busy")), null, "retry"],
    ["the processor is unavailable", failing(failure("unavailable")), null, "retry"],
    ["the probe answers busy", probing(failure("busy")), null, "retry"],
    ["the container answers internal (500)", failing(failure("still:internal")), null, "retry"],
    ["the container times out (504)", failing(failure("still:timeout")), null, "retry"],
    ["the still's container is not ready", failing(failure("ready")), null, "retry"],
    ["the probe's container is not ready", probing(failure("ready")), null, "retry"],
    ["the probe's Images step fails as a service", {}, () => encodeFailing(9500), "retry"],
    ["only the RGBA output is refused for quota", {}, () => rgbaFailing(9422), "quota"],
    ["only the RGBA output fails as a service", {}, () => rgbaFailing(9500), "retry"],
  ] as const)(
    "stops when %s, keeps the row's preview and its full, writes nothing, and the next call makes the still",
    async (_name, answers, codec, stopped) => {
      const store = await setup();
      const row = await addAv(store, "video", { blurhash: "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB" });
      const before = await rowOf(store, row.id);
      const recording = recordingBucket();
      const step = await run(store, {
        stills: maker(answers).stills,
        bucket: recording.bucket,
        ...(codec === null ? {} : { codec: codec() }),
      });
      expect(step).toMatchObject({
        ok: true,
        stopped,
        done: false,
        next: null,
        counts: { built: 0 },
      });
      expect((step as { counts: Record<string, number> }).counts.fallback).toBeUndefined();
      expect(await rowOf(store, row.id)).toEqual(before);
      expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
      // Only `full` and the probe's own copy were written.
      expect(recording.writes.filter((w) => !w.includes("incoming/probe-"))).toEqual([`put files/${row.token}/full`]);
      // No verdict is recorded for the processor's state.
      if ("probe" in answers || codec !== null) {
        expect(
          (await stateValue(store, "media_probe:")).map((v) => (JSON.parse(v) as { ok: boolean }).ok),
        ).not.toContain(false);
      }
      // The processor recovers: the next call starts at that row and makes its still (once a probe that reached no
      // verdict is an hour old).
      await ageProbe(store, PROBE_RETRY_MS);
      const recovered = maker();
      expect(await run(store, { stills: recovered.stills })).toMatchObject({ counts: { built: 1 }, stopped: null });
      expect(recovered.calls.at(-1)).toBe(`still originals/${row.id}`);
      await expectStill(store, row);
    },
  );

  it("stops on Images' quota for the still and for the probe, keeping the row as it was", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    const codec = new TestCodec();
    codec.failEncode = 9422;
    expect(await run(store, { codec })).toMatchObject({ stopped: "quota", next: null });
    // The probe's Images step refused for quota: a pass Images did not verify (the probe's one classifier).
    expect((await stateValue(store, "media_probe:")).map((v) => JSON.parse(v) as unknown)).toEqual([
      { version: BUILD, imageTag: "media@sha256:test", at: expect.any(Number), ok: true, imagesVerified: false },
    ]);
    expect(await rowOf(store, row.id)).toEqual(before);
    // With the probe passed, the still's own Images step.
    await sql(
      store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('media_probe:still@standard-1', ?)",
      JSON.stringify({ version: BUILD, imageTag: null, at: Date.now(), ok: true }),
    );
    expect(await run(store, { codec })).toMatchObject({ stopped: "quota", next: null });
    expect(await rowOf(store, row.id)).toEqual(before);
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
  });

  it("keeps the lease when the still's container teardown is still pending", async () => {
    const store = await setup();
    await addAv(store, "video");
    const pending = maker({ answer: { ok: false, failure: "destroy", image: null, pending: true } });
    expect(await run(store, { stills: pending.stills, holder: "torn" })).toMatchObject({ stopped: "deadline" });
    const [lease] = await stateValue(store, "media_rebuild_lease");
    expect(JSON.parse(lease!)).toMatchObject({ holder: "torn" });
  });

  // A meta of `bytes` once meta.small of one-digit edges is set in it, as SQLite serializes it.
  const metaOf = (bytes: number) => {
    const pad = "x".repeat(bytes - JSON.stringify({ pad: "", small: { width: 0, height: 0 } }).length);
    return JSON.stringify({ pad });
  };

  it.each([
    ["an array", "[]", true],
    ["an array, and no processor bound", "[]", false],
    ["an object with no room for any still", metaOf(MEDIA_META_BYTES + 1), true],
  ])(
    "writes the verified full of a video row whose meta is %s, and gives it the poster",
    async (_name, meta, bound) => {
      const store = await setup();
      const row = await addAv(store, "video", { meta });
      const made = maker();
      const recording = recordingBucket();
      const step = await run(store, { stills: bound ? made.stills : null, bucket: recording.bucket });
      expect(step).toMatchObject({ ok: true, stopped: null, counts: { fallback: 1 }, problems: [] });
      expect(made.calls).toEqual([]);
      expect(recording.writes).toEqual([`put files/${row.token}/full`]);
      expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
      const [stored] = await sql<{ meta: string; preview_url: string | null }>(
        store,
        "SELECT meta, preview_url FROM media_attachments WHERE id = ?",
        row.id,
      );
      expect(stored).toEqual({ meta, preview_url: null });
      expect(await counters(store)).toEqual([[], []]);
    },
  );

  it("records a still the meta has room for, and gives the poster when its own edges leave none", async () => {
    // Room for two further digits: a 32×18 still fits, a 320×180 one does not.
    const meta = metaOf(MEDIA_META_BYTES - 2);
    const store = await setup();
    const fits = await addAv(store, "video", { meta });
    const small = maker({ answer: { ok: true, png: await pngOf(32, 18), image: null } });
    expect(await run(store, { stills: small.stills })).toMatchObject({ counts: { built: 1 } });
    expect((await rowOf(store, fits.id)).meta).toMatchObject({ small: { width: 32, height: 18 } });
    const tight = await addAv(store, "video", { meta });
    const wide = maker();
    const recording = recordingBucket();
    expect(await run(store, { stills: wide.stills, bucket: recording.bucket, after: fits.id })).toMatchObject({
      counts: { fallback: 1 },
    });
    expect(wide.calls).toEqual([`still originals/${tight.id}`]);
    expect(recording.writes).toEqual([`put files/${tight.token}/full`]);
    expect(await rowOf(store, tight.id)).toMatchObject({ preview_url: null, blurhash: null });
    // An existing small is held to the same room: not adopted, not put again, left as it is.
    const adopted = await addAv(store, "video", { meta });
    await env.MEDIA.put(`files/${adopted.token}/full`, adopted.original);
    const webp = await new TestCodec().real.encode(STILL, { format: "image/webp", still: true });
    await env.MEDIA.put(`files/${adopted.token}/small`, webp);
    const left = recordingBucket();
    expect(await run(store, { bucket: left.bucket, after: tight.id })).toMatchObject({ counts: { fallback: 1 } });
    expect(left.writes).toEqual([]);
    expect(await bytesOf(`files/${adopted.token}/small`)).toEqual(webp);
    expect(await rowOf(store, adopted.id)).toMatchObject({ preview_url: null });
  });

  it("gives the poster to a row whose meta grew past taking the still while it was made, not as a row that went", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const grown = metaOf(MEDIA_META_BYTES);
    const made = maker({
      onStill: async () => {
        await sql(store, "UPDATE media_attachments SET meta = ? WHERE id = ?", grown, row.id);
      },
    });
    const step = await run(store, { stills: made.stills });
    expect(step).toMatchObject({ counts: { fallback: 1 }, problems: [] });
    expect((step as { counts: Record<string, number> }).counts.gone ?? 0).toBe(0);
    expect(await rowOf(store, row.id)).toMatchObject({ preview_url: null, blurhash: null, meta: JSON.parse(grown) });
  });

  it("writes no small Images made past STILL_LONG_EDGE or after the row's end, and stops", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    await sql(
      store,
      "INSERT INTO kopje_state (name, value) VALUES ('media_probe:still@standard-1', ?)",
      JSON.stringify({ version: BUILD, imageTag: null, at: Date.now(), ok: true }),
    );
    const wide = await encodeWebp(700, 100, { fill: "flat" });
    const codec = new TestCodec();
    codec.encodeResponder = (options) => (options.format === "image/webp" ? wide : null);
    expect(await run(store, { codec })).toMatchObject({ stopped: "retry", next: null });
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();

    // An encode that answers once the row's time is spent: nothing more is asked of Images, nothing written.
    let clock = NOW;
    const late = new TestCodec();
    late.encodeResponder = () => {
      clock = NOW + REBUILD_AV_MS + 1;
      return null;
    };
    expect(await run(store, { codec: late, now: () => clock })).toMatchObject({ stopped: "deadline" });
    expect(late.encodeCalls).toHaveLength(1);
    expect(late.infoCalls).toBe(0);
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
  });

  it("probes at most once an hour while attempts reach no verdict, and stops the calls in between", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    const codec = new TestCodec();
    // A failure of the service: no verdict.
    codec.failEncode = 9500;
    const first = maker();
    expect(await run(store, { stills: first.stills, codec, transforms: 0, uploads: 0 })).toMatchObject({
      stopped: "retry",
    });
    expect(first.calls.filter((c) => c.startsWith("probe"))).toHaveLength(1);
    const encodes = codec.encodeCalls.length;
    // The next calls within the hour start no container and ask nothing of Images.
    for (let i = 0; i < 2; i++) {
      const again = maker();
      expect(await run(store, { stills: again.stills, codec, transforms: 0, uploads: 0 })).toMatchObject({
        stopped: "retry",
        next: null,
      });
      expect(again.calls).toEqual([]);
    }
    expect(codec.encodeCalls).toHaveLength(encodes);
    expect(await rowOf(store, row.id)).toEqual(before);
    await ageProbe(store, PROBE_RETRY_MS);
    const later = maker();
    await run(store, { stills: later.stills, codec });
    expect(later.calls.filter((c) => c.startsWith("probe"))).toHaveLength(1);
  });

  it("lets a new attempt that reaches no verdict stand over an older failure: the calls in its hour stop", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    // A failure for this build, older than the cooldown.
    await sql(
      store,
      "INSERT INTO kopje_state (name, value) VALUES ('media_probe:still@standard-1', ?), ('media_probe_attempt:still@standard-1', ?)",
      JSON.stringify({ version: BUILD, imageTag: null, at: Date.now() - PROBE_RETRY_MS - 1, ok: false }),
      JSON.stringify({ version: BUILD, at: Date.now() - PROBE_RETRY_MS - 1 }),
    );
    const busy = maker({ probe: { ok: false, failure: "busy", image: null } });
    expect(await run(store, { stills: busy.stills })).toMatchObject({ stopped: "retry", next: null });
    expect(busy.calls.filter((c) => c.startsWith("probe"))).toHaveLength(1);
    // Within the new attempt's hour, the old failure does not give the row the poster.
    const again = maker();
    expect(await run(store, { stills: again.stills })).toMatchObject({ stopped: "retry", next: null });
    expect(again.calls).toEqual([]);
    expect(await rowOf(store, row.id)).toEqual(before);
  });

  it.each([
    ["not JSON", "{", "{"],
    [
      "dated after the Store's time",
      JSON.stringify({ version: BUILD, imageTag: null, at: Number.MAX_SAFE_INTEGER, ok: false }),
      JSON.stringify({ version: BUILD, at: Number.MAX_SAFE_INTEGER }),
    ],
  ])("probes again over a stored verdict and attempt %s", async (_name, record, attempt) => {
    const store = await setup();
    await addAv(store, "video");
    await sql(
      store,
      "INSERT INTO kopje_state (name, value) VALUES ('media_probe:still@standard-1', ?), ('media_probe_attempt:still@standard-1', ?)",
      record,
      attempt,
    );
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 } });
    expect(made.calls.filter((c) => c.startsWith("probe"))).toHaveLength(1);
  });

  it("records no image tag past its bound, reads an out-of-bounds record as none, and never dumps the record", async () => {
    const store = await setup();
    const huge = "a".repeat(200_000);
    const made = maker({ probe: { ok: true, png: STILL, image: huge } });
    await addAv(store, "video");
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 } });
    const [stored] = await stateValue(store, "media_probe:");
    expect(JSON.parse(stored!)).toMatchObject({ version: BUILD, imageTag: null, ok: true });
    const { text } = await dumpViaRpc(store);
    expect(text).not.toContain("media_probe");

    // A stored record past its bounds is no record: the next video row probes again, once its attempt is an hour old.
    await ageProbe(store, PROBE_RETRY_MS);
    await sql(
      store,
      "UPDATE kopje_state SET value = ? WHERE name = 'media_probe:still@standard-1'",
      JSON.stringify({ version: BUILD, imageTag: huge, at: Date.now(), ok: true }),
    );
    await addAv(store, "video");
    const again = maker();
    await run(store, { stills: again.stills });
    expect(again.calls[0]).toMatch(/^probe /);
  });

  it("prunes the upload counters by a range of kopje_state's key, with stale statistics and many state rows", async () => {
    const store = await setup();
    await sql(store, "ANALYZE");
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 10000 - 1)
			INSERT INTO kopje_state (name, value) SELECT 'unrelated:' || i, '1' FROM n`,
    );
    for (const month of ["2025-11", "2026-03", "2026-04", "2026-05"]) {
      await sql(store, "INSERT INTO kopje_state (name, value) VALUES (?, '7')", `media_upload_jobs:${month}`);
    }
    const now = Date.parse("2026-05-10T00:00:00Z");
    const plans = await runInDurableObject(store, (_instance, state) => {
      const planned: PlannedStatement[] = [];
      expect(chargeUploadJob(new Db(plannedSql(state.storage.sql, /^DELETE FROM kopje_state/, planned)), 10, now)).toBe(
        true,
      );
      return planned;
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan.join(" | ")).toMatch(
      /^SEARCH kopje_state USING (INDEX \w+|PRIMARY KEY) \(name>\? AND name<\?\)$/,
    );
    const left = await sql<{ name: string; value: string }>(
      store,
      "SELECT name, value FROM kopje_state WHERE name > 'media_upload_jobs:' AND name < 'media_upload_jobs;' ORDER BY name",
    );
    expect(left).toEqual([
      { name: "media_upload_jobs:2026-04", value: "7" },
      { name: "media_upload_jobs:2026-05", value: "8" },
    ]);
  }, 60_000);

  it("kopje-admin media-rebuild exits 3 when a call stops for a retry", async () => {
    const out: string[] = [];
    const code = await cliRun({
      argv: ["media-rebuild"],
      env: {
        KOPJE_ADMIN_URL: "https://admin.kopje.test",
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
      },
      io: memoryIO(),
      stdout: { write: (text: string) => void out.push(text), isTTY: false },
      stderr: { write: () => {}, isTTY: false },
      fetch: () =>
        Promise.resolve(
          Response.json({ ok: true, counts: { built: 0 }, problems: [], done: false, next: null, stopped: "retry" }),
        ),
    });
    expect(code).toBe(3);
    expect(JSON.parse(out.join(""))).toMatchObject({ stopped: "retry", "quota-stopped": false });
  });

  it(`builds at most ${MAX_AV_BUILDS_PER_CALL} video or audio row a call and resumes by the cursor`, async () => {
    expect(MAX_AV_BUILDS_PER_CALL).toBeLessThanOrEqual(MAX_BUILDS_PER_CALL);
    const store = await setup();
    const first = await addAv(store, "audio");
    const second = await addAv(store, "video");
    const step = await run(store);
    expect(step).toMatchObject({ ok: true, done: false, next: first.id, counts: { built: 1 } });
    expect(await env.MEDIA.head(`files/${second.token}/full`)).toBeNull();
    expect(await run(store, { after: (step as { next: string }).next })).toMatchObject({
      done: true,
      counts: { built: 1 },
    });
    await expectStill(store, second);
  });

  // A video or audio row's attempt, built or a video's fallback (its file copied, its preview cleared), counts for
  // REBUILD_CALL_BUDGET_MS: past it, the image row after it is not looked at.
  it.each([
    ["an audio row built", "audio", { built: 1 }],
    ["a video's fallback", "video", { fallback: 1 }],
  ] as const)("ends the call at the time budget after %s", async (_label, kind, counts) => {
    const store = await setup();
    const av = await addAv(store, kind);
    const image = await addImage(store, mediaId());
    let clock = NOW;
    const heads: string[] = [];
    const { bucket } = recordingBucket(
      (key) => {
        if (key === `files/${av.token}/full`) {
          clock += REBUILD_CALL_BUDGET_MS;
        }
        return Promise.resolve();
      },
      (key) => heads.push(key),
    );
    const step = await run(store, { bucket, now: () => clock, ...(kind === "video" ? { stills: null } : {}) });
    expect(step).toMatchObject({ ok: true, done: false, stopped: null, next: av.id, counts });
    expect(heads.filter((key) => key.includes(image.token))).toEqual([]);
    expect(await env.MEDIA.head(`files/${image.token}/full`)).toBeNull();
  });

  it("starts no video or audio row past the time budget after an image row", async () => {
    const store = await setup();
    const image = await addImage(store, mediaId());
    const av = await addAv(store, "audio");
    let clock = NOW;
    const heads: string[] = [];
    const { bucket } = recordingBucket(
      (key) => {
        if (key === `files/${image.token}/small`) {
          clock += REBUILD_CALL_BUDGET_MS;
        }
        return Promise.resolve();
      },
      (key) => heads.push(key),
    );
    const step = await run(store, { bucket, now: () => clock });
    expect(step).toMatchObject({ ok: true, done: false, stopped: null, next: image.id, counts: { built: 1 } });
    expect(heads.filter((key) => key.includes(av.token))).toEqual([]);
    expect(await env.MEDIA.head(`files/${av.token}/full`)).toBeNull();
  });

  it("gives up the still at the row's deadline and keeps the lease", async () => {
    const store = await setup();
    await addAv(store, "video");
    let clock = NOW;
    const stills: StillMaker = {
      ...maker().stills,
      // The probe takes all but 50 ms of the row's time; the still then never answers.
      probe: () => {
        clock = NOW + REBUILD_AV_MS - 50;
        return Promise.resolve({ ok: true, png: STILL, image: null });
      },
      still: () => new Promise(() => {}),
    };
    const step = await run(store, { stills, now: () => clock, holder: "slow" });
    expect(step).toMatchObject({ ok: true, stopped: "deadline", done: false });
    const [lease] = await stateValue(store, "media_rebuild_lease");
    expect(JSON.parse(lease!)).toMatchObject({ holder: "slow" });
  });
});

describe("media rebuild of video rows: interruptions and lease loss (#1828 P25)", () => {
  // Takes the rebuild lease from whoever holds it, as its expiry would.
  async function takeLease(store: StoreStub, holder: string): Promise<void> {
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('media_rebuild_lease', ?)",
        JSON.stringify({ holder, until: Date.now() + REBUILD_LEASE_MS }),
      );
    });
  }

  function gate() {
    const opened = deferred();
    const arrived = deferred();
    return { open: opened.resolve, opened: opened.promise, reached: arrived.resolve, arrived: arrived.promise };
  }

  it("a call that loses its lease after `full`, held at the still, writes nothing once the next call finished the row", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const held = gate();
    const first = maker({
      onStill: async () => {
        held.reached();
        await held.opened;
      },
    });
    const writes = recordingBucket();
    const running = run(store, { stills: first.stills, bucket: writes.bucket, holder: "first" });
    await held.arrived;
    // Interrupted after `full`: the file is there, the still is not.
    expect(await bytesOf(`files/${row.token}/full`)).toEqual(row.original);
    expect(await env.MEDIA.head(`files/${row.token}/small`)).toBeNull();
    await takeLease(store, "second");
    const second = maker();
    const resumed = recordingBucket();
    expect(await run(store, { stills: second.stills, bucket: resumed.bucket, holder: "second" })).toMatchObject({
      counts: { built: 1 },
    });
    // It resumed at the still: `full` was not written again.
    expect(resumed.writes.filter((w) => w.endsWith("/full"))).toEqual([]);
    const settled = await expectStill(store, row);
    // The second call released the lease when it ended; a third holds it while the first resumes.
    await takeLease(store, "third");
    held.open();
    expect(await running).toMatchObject({ ok: true, stopped: "lease-overrun" });
    // The first call started no write after it lost the lease.
    expect(writes.writes.filter((w) => w.endsWith("/small"))).toEqual([]);
    expect(await expectStill(store, row)).toEqual(settled);
  });

  it("a call held right after its still's put loses the lease; the next adopts that still and the first records nothing", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const held = gate();
    const writes = recordingBucket(async (key) => {
      if (key.endsWith("/small")) {
        held.reached();
        await held.opened;
      }
    });
    const running = run(store, { bucket: writes.bucket, holder: "first" });
    await held.arrived;
    // The row still has its restored meta.small and blurhash; the small written by the held call has its own.
    await sql(
      store,
      "UPDATE media_attachments SET blurhash = ? WHERE id = ?",
      "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB",
      row.id,
    );
    await takeLease(store, "second");
    const second = maker();
    const counted = await counters(store);
    expect(await run(store, { stills: second.stills, holder: "second" })).toMatchObject({ counts: { built: 1 } });
    // Adopted, not made again, nothing charged: the object's metadata is recorded.
    expect(second.calls).toEqual([]);
    expect(await counters(store)).toEqual(counted);
    const adopted = await expectStill(store, row);
    await takeLease(store, "third");
    held.open();
    expect(await running).toMatchObject({ ok: false, code: "rebuild-lease-lost" });
    expect(await expectStill(store, row)).toEqual(adopted);
  });

  // A renewal sent while one write is pending may still be unanswered when the next write is confirmed: its failure
  // must stop that write (a race present before #1828 too).
  it("starts no further write once a heartbeat that was in flight at the confirmation fails", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    let writing = false;
    let heldHeartbeat = false;
    const heartbeat = deferred<never>();
    heartbeat.promise.catch(() => {});
    const proxied = new Proxy(store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildLease"
          ? (...args: Parameters<StoreStub["mediaRebuildLease"]>) => {
              if (writing && !heldHeartbeat) {
                heldHeartbeat = true;
                return heartbeat.promise;
              }
              return target.mediaRebuildLease(...args);
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const recorded = recordingBucket();
    const writes = recorded.writes;
    const bucket = {
      ...recorded.bucket,
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        writes.push(`put ${key}`);
        // The first put stays pending until a heartbeat was sent (and held).
        writing = true;
        await vi.waitFor(() => expect(heldHeartbeat).toBe(true));
        writing = false;
        return env.MEDIA.put(key, value, options);
      },
    };
    const running = run(proxied, { bucket, heartbeatMs: 5 });
    await vi.waitFor(() => expect(heldHeartbeat).toBe(true));
    // The put has settled and the call goes on to its next write while that heartbeat is still unanswered.
    await new Promise((resolve) => setTimeout(resolve, 200));
    heartbeat.reject(new Error("renewal lost"));
    expect(await running).toMatchObject({ ok: true, stopped: "lease-overrun" });
    // The full file's put, during which the heartbeat was held; the probe copy's put never started.
    expect(writes).toEqual([`put files/${row.token}/full`]);
  });

  it("converges when an earlier holder's still put lands over the small a later call recorded", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    expect(await run(store)).toMatchObject({ counts: { built: 1 } });
    // The write of a call whose lease ended while it was pending lands last, with its own still and metadata.
    const stale = await new TestCodec().real.encode(await pngOf(32, 18), { format: "image/webp", still: true });
    await env.MEDIA.put(`files/${row.token}/small`, stale, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { width: "32", height: "18", blurhash: "" },
    });
    // The next call sees the object's metadata differ from the row, adopts the object as it is, and records it.
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 } });
    expect(made.calls).toEqual([]);
    expect(await bytesOf(`files/${row.token}/small`)).toEqual(stale);
    await expectStill(store, row);
    expect((await rowOf(store, row.id)).meta).toMatchObject({ small: { width: 32, height: 18 } });
    expect(await run(store)).toMatchObject({ counts: { "skipped-existing": 1 } });
  });

  it("a restored row whose preview metadata predates the small an interrupted rebuild wrote ends with the object's", async () => {
    const store = await setup();
    const row = await addAv(store, "video", {
      small: { width: 1, height: 1 },
      blurhash: "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB",
    });
    // An earlier rebuild wrote both files, then died before the Store recorded the still; the restore kept the old meta.
    await env.MEDIA.put(`files/${row.token}/full`, row.original);
    const webp = await new TestCodec().real.encode(STILL, { format: "image/webp", still: true });
    await env.MEDIA.put(`files/${row.token}/small`, webp, {
      customMetadata: { width: "320", height: "180", blurhash: "" },
    });
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 } });
    expect(made.calls).toEqual([]);
    expect(await rowOf(store, row.id)).toMatchObject({ meta: { small: { width: 320, height: 180 } }, blurhash: null });
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { "skipped-existing": 1 } });
  });

  it.each([
    [9422, "quota"],
    [9500, "retry"],
  ] as const)(
    "stops before putting an adopted small again when its RGBA output fails with %i",
    async (code, stopped) => {
      const store = await setup();
      const row = await addAv(store, "video", { small: { width: 1, height: 1 } });
      await env.MEDIA.put(`files/${row.token}/full`, row.original);
      const webp = await new TestCodec().real.encode(STILL, { format: "image/webp", still: true });
      await env.MEDIA.put(`files/${row.token}/small`, webp);
      const before = await rowOf(store, row.id);
      const codec = new TestCodec();
      codec.failRgba = code;
      const recording = recordingBucket();
      expect(await run(store, { codec, bucket: recording.bucket })).toMatchObject({ stopped, next: null });
      expect(recording.writes).toEqual([]);
      expect((await env.MEDIA.head(`files/${row.token}/small`))!.customMetadata).toEqual({});
      expect(await rowOf(store, row.id)).toEqual(before);
    },
  );

  it("adopts a small with no metadata after recomputing its blurhash, writing its metadata, and never adopts an invalid one", async () => {
    const store = await setup();
    const row = await addAv(store, "video", { small: { width: 1, height: 1 } });
    await env.MEDIA.put(`files/${row.token}/full`, row.original);
    const webp = await new TestCodec().real.encode(STILL, { format: "image/webp", still: true });
    await env.MEDIA.put(`files/${row.token}/small`, webp);
    expect(await run(store)).toMatchObject({ counts: { built: 1 } });
    const metadata = await expectStill(store, row);
    expect(metadata.blurhash).not.toBe("");
    expect(await bytesOf(`files/${row.token}/small`)).toEqual(webp);
    expect(await counters(store)).toEqual([["3"], []]);
    // A small that is not a clean still WebP is reported and left as it is.
    const bad = await addAv(store, "video", { small: { width: 1, height: 1 } });
    await env.MEDIA.put(`files/${bad.token}/full`, bad.original);
    await env.MEDIA.put(`files/${bad.token}/small`, STILL);
    expect(await run(store, { after: row.id })).toMatchObject({
      problems: [{ id: bad.id, outcome: "failed", detail: "small-invalid" }],
    });
    expect(await bytesOf(`files/${bad.token}/small`)).toEqual(STILL);
  });
});

// The rebuild's still probe and the generic one share one claim, cooldown and classifier (#1828 PR5 W-P, P-RBQ): each
// case through the real entry points, the rebuild in readonly maintenance and the generic claim outside it.
describe("the still probe's one claim, shared with the generic probe (W-P, P-RBQ)", () => {
  const STILL = "still@standard-1" as const;
  const maintenance = async (store: StoreStub, on: boolean) => {
    if (on) {
      await sql(
        store,
        "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('maintenance', ?)",
        JSON.stringify({ mode: "readonly", at: Date.now() - REBUILD_SETTLE_MS - 60_000 }),
      );
    } else {
      await sql(store, "DELETE FROM kopje_state WHERE name = 'maintenance'");
    }
  };
  const records = (store: StoreStub) => store.mediaProbeRecords(BUILD, { profile: STILL });
  const claimGeneric = async (store: StoreStub, due = false) => {
    await maintenance(store, false);
    const claimed = await store.claimMediaProbe(BUILD, { profile: STILL, build: BUILD, due });
    await maintenance(store, true);
    return claimed;
  };
  const probes = (calls: string[]) => calls.filter((c) => c.startsWith("probe"));

  it("refuses the generic record whose claim the rebuild's replaced (1)", async () => {
    const store = await setup();
    await addAv(store, "video");
    const generic = await claimGeneric(store);
    expect(generic.status).toBe("claimed");
    // The generic claim is past PROBE_CLAIM_MS (its request ended): the rebuild claims, probes and records.
    await ageProbe(store, 5 * 60 * 1000);
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ counts: { built: 1 } });
    expect(probes(made.calls)).toHaveLength(1);
    await maintenance(store, false);
    expect(
      await store.recordMediaProbeResult(BUILD, {
        profile: STILL,
        claim: (generic as { claim: string }).claim,
        outcome: "fail",
        imagesVerified: false,
        imageTag: null,
      }),
    ).toEqual({ status: "stale" });
    expect((await records(store)).record).toMatchObject({ ok: true, imagesVerified: true });
  });

  it("cools the generic claim down PROBE_RETRY_MS after the rebuild's failure (2) or no verdict (3)", async () => {
    for (const [answers, codec] of [
      [{ probe: { ok: false, failure: "route", image: null, evidence: "route" } as StillOutcome }, null],
      [{}, 9500],
    ] as const) {
      const store = await setup();
      await addAv(store, "video");
      const c = new TestCodec();
      c.failEncode = codec;
      await run(store, { stills: maker(answers).stills, codec: c });
      const { attempt } = await records(store);
      expect(attempt).toMatchObject({ result: codec === null ? "fail" : "no-verdict" });
      expect(await claimGeneric(store, true)).toEqual({ status: "cooldown", retryAt: attempt!.at + PROBE_RETRY_MS });
      // The rebuild waits the same hour: no container, no Images call.
      const again = maker();
      await run(store, { stills: again.stills, codec: c });
      expect(probes(again.calls)).toEqual([]);
    }
  });

  it("stops at an unfinished generic claim younger than PROBE_CLAIM_MS before calling the processor (4)", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    expect((await claimGeneric(store)).status).toBe("claimed");
    const made = maker();
    expect(await run(store, { stills: made.stills })).toMatchObject({ stopped: "retry", next: null });
    expect(made.calls).toEqual([]);
    expect(await rowOf(store, row.id)).toEqual(before);
  });

  it("skips its probe over a generic verified pass (5), and probes over a stored failure, clearing it (6)", async () => {
    const store = await setup();
    await addAv(store, "video");
    const claimed = await claimGeneric(store);
    await maintenance(store, false);
    await store.recordMediaProbeResult(BUILD, {
      profile: STILL,
      claim: (claimed as { claim: string }).claim,
      outcome: "pass",
      imagesVerified: true,
      imageTag: null,
    });
    await maintenance(store, true);
    const skipped = maker();
    await run(store, { stills: skipped.stills });
    expect(probes(skipped.calls)).toEqual([]);
    // An infrastructure failure for the build after the pass: the rebuild probes once the hour is over, and its pass
    // clears the failure.
    await maintenance(store, false);
    await store.recordMediaInfrastructureFailure(BUILD, { profile: STILL, build: BUILD });
    await maintenance(store, true);
    await ageProbe(store, PROBE_RETRY_MS);
    await addAv(store, "video");
    const probing = maker();
    await run(store, { stills: probing.stills });
    expect(probes(probing.calls)).toHaveLength(1);
    expect(await records(store)).toMatchObject({ record: { ok: true, imagesVerified: true }, failure: null });
  });

  it("records no result for a probe object that answers busy, holding the profile PROBE_CLAIM_MS only (7)", async () => {
    const store = await setup();
    await addAv(store, "video");
    const busy = maker({ probe: { ok: false, failure: "busy", image: null } });
    expect(await run(store, { stills: busy.stills })).toMatchObject({ stopped: "retry" });
    const { attempt, record } = await records(store);
    expect(attempt).not.toHaveProperty("result");
    expect(record).toBeNull();
    expect(await claimGeneric(store)).toEqual({ status: "cooldown", retryAt: attempt!.at + 5 * 60 * 1000 });
    await ageProbe(store, 5 * 60 * 1000);
    expect((await claimGeneric(store)).status).toBe("claimed");
  });

  // (7), the other direction (#1828 PR5-2): the generic still probe (the probe round's and the CLI's,
  // stillActivationProbe) meets the probe object busy, its rebuild-held stop not yet confirmed: no result, the profile
  // held PROBE_CLAIM_MS only, then the rebuild claims and probes.
  it("records no generic result for a probe object the rebuild left busy, holding the profile PROBE_CLAIM_MS (7)", async () => {
    const store = await setup();
    await addAv(store, "video");
    await maintenance(store, false);
    const busy = maker({ probe: { ok: false, failure: "busy", image: null } });
    const probed = await stillActivationProbe(
      { build: BUILD, store, bucket: env.MEDIA, stills: busy.stills, images: new TestCodec(), now: () => Date.now() },
      true,
    );
    expect(probed).toMatchObject({ status: "not_started", verdict: { outcome: "no-verdict", reason: "busy" } });
    expect(probes(busy.calls)).toHaveLength(1);
    const { attempt, record } = await records(store);
    expect(attempt).not.toHaveProperty("result");
    expect(record).toBeNull();
    await maintenance(store, true);
    const cooled = maker();
    await run(store, { stills: cooled.stills });
    expect(probes(cooled.calls)).toEqual([]);
    await ageProbe(store, 5 * 60 * 1000);
    const after = maker();
    expect(await run(store, { stills: after.stills })).toMatchObject({ counts: { built: 1 } });
    expect(probes(after.calls)).toHaveLength(1);
  });

  // (7) once for an unpublished import, which has no settle period: the rebuild's probe meets the object busy and
  // records no result.
  it("records no rebuild result for a busy probe object in an unpublished import (7)", async () => {
    const store = await setup();
    await addAv(store, "video");
    await maintenance(store, false);
    await sql(
      store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('unpublished', ?)",
      JSON.stringify({ at: NOW, import: "i" }),
    );
    const busy = maker({ probe: { ok: false, failure: "busy", image: null } });
    expect(await run(store, { stills: busy.stills })).toMatchObject({ stopped: "retry" });
    expect(probes(busy.calls)).toHaveLength(1);
    const { attempt, record } = await records(store);
    expect(attempt).not.toHaveProperty("result");
    expect(record).toBeNull();
  });

  it("takes no verdict older than its last claim for the claim's cooldown", async () => {
    const store = await setup();
    await addAv(store, "video");
    await run(store, { stills: maker().stills });
    // An infrastructure failure after the pass makes the profile due; the rebuild's probe then meets a busy probe
    // object and records nothing, so the verified pass before it does not stand for that claim.
    await maintenance(store, false);
    await store.recordMediaInfrastructureFailure(BUILD, { profile: STILL, build: BUILD });
    await maintenance(store, true);
    await ageProbe(store, PROBE_RETRY_MS);
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    const busy = maker({ probe: { ok: false, failure: "busy", image: null } });
    expect(await run(store, { stills: busy.stills })).toMatchObject({ stopped: "retry" });
    expect(probes(busy.calls)).toHaveLength(1);
    const cooled = maker();
    expect(await run(store, { stills: cooled.stills })).toMatchObject({ stopped: "retry" });
    expect(cooled.calls).toEqual([]);
    expect(await rowOf(store, row.id)).toEqual(before);
  });

  it("classifies Images' own bad output as no verdict and 9422 as an unverified pass (8)", async () => {
    const store = await setup();
    await addAv(store, "video");
    const bad = new TestCodec();
    bad.encodeResult = new Uint8Array([1, 2, 3, 4]);
    expect(await run(store, { stills: maker().stills, codec: bad })).toMatchObject({ stopped: "retry" });
    expect(await records(store)).toMatchObject({ record: null, attempt: { result: "no-verdict" } });
    await ageProbe(store, PROBE_RETRY_MS);
    const quota = new TestCodec();
    quota.failEncode = 9422;
    expect(await run(store, { stills: maker().stills, codec: quota })).toMatchObject({ stopped: "quota" });
    expect(await records(store)).toMatchObject({
      record: { ok: true, imagesVerified: false },
      attempt: { result: "pass" },
    });
  });

  it("charges nothing and starts no still while the current pass is unverified (P-RBQ)", async () => {
    const store = await setup();
    const row = await addAv(store, "video");
    const before = await rowOf(store, row.id);
    const quota = new TestCodec();
    quota.failEncode = 9422;
    const first = maker();
    expect(await run(store, { stills: first.stills, codec: quota })).toMatchObject({ stopped: "quota", next: null });
    expect(first.calls).toEqual([expect.stringMatching(/^probe /)]);
    expect(await records(store)).toMatchObject({ record: { ok: true, imagesVerified: false } });
    const second = maker();
    expect(await run(store, { stills: second.stills })).toMatchObject({ stopped: "quota", next: null });
    expect(second.calls).toEqual([]);
    expect(await counters(store)).toEqual([[], []]);
    expect(await rowOf(store, row.id)).toEqual(before);
    // Due again after PROBE_RETRY_MS: a verified pass lets the rebuild go on.
    await ageProbe(store, PROBE_RETRY_MS);
    const later = maker();
    expect(await run(store, { stills: later.stills })).toMatchObject({ counts: { built: 1 } });
    expect(probes(later.calls)).toHaveLength(1);
  });
});
