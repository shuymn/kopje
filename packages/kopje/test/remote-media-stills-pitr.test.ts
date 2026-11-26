import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectSql } from "../src/db/columns";
import { probeName } from "../src/domain/media-probes";
import {
  LATE_PUT_MS,
  maintainRemoteMedia,
  recordRemoteMediaValidation,
  remoteMediaOrphans,
  REMOTE_SETTLE_MS,
  VALIDATION_FAILURES,
} from "../src/domain/remote-media";
import { type MediaRow, presentMedia } from "../src/domain/status-presenter";
import { STATUS_MEDIA_COLUMN_MAP } from "../src/domain/status-rows";
import { remoteStillsRound, type RemoteStillsDeps } from "../src/jobs/remote-stills";
import { type RemoteVariant, remoteMediaPath, restoreMarkerKey } from "../src/platform/media-files";
import type { StillMaker } from "../src/platform/media-transcoder";
import { sql } from "./api-helpers";
import { harness } from "./app-helpers";
import { BUILD } from "./helpers";
import { TestCodec } from "./media-helpers";
import { stillPng } from "./media-job-helpers";
import { mp4 } from "./remote-media-fixtures";
import { bucketWith, mediaWorld, type MediaWorld } from "./remote-media-helpers";

// PITR validation of remote stills (#1828 PR5-2, P-PITR2; domain/remote-media.ts validationBatch and
// recordRemoteMediaValidation, federation/remote-media.ts validate): a still is headed only where a stored row names
// it, each variant reported present, missing or unknown, the result applied only for the batch of the restore the
// marker and the walk both name; a named still missing, or unknown VALIDATION_FAILURES times, takes the still-only
// reset, the video kept. The restores are the tables put back as a bookmark held them and the marker written.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
});

afterEach(() => {
  vi.useRealTimers();
});

const CAP = 4 * 1024 * 1024 * 1024;
const VARS = { MEDIA_PROCESSOR: {}, MEDIA_STILL_MONTHLY_JOBS: "5" };
let videos = 0;

function at(w: MediaWorld, ms: number): void {
  w.clock.now = ms;
  vi.setSystemTime(ms);
}

const stills: StillMaker = {
  still: () => Promise.reject(new Error("unused")),
  probe: () => Promise.reject(new Error("unused")),
  remote: async () => ({ ok: true, png: await stillPng(), image: null }),
  probeInput: new Uint8Array(),
};

const stillsRound = (w: MediaWorld, extra: Partial<RemoteStillsDeps> = {}) =>
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

// A remote video the real round caches with stills active, and (`record`) its still made and recorded by the stills'
// round: the token, the slot, the attempt and the named still's key.
async function cachedVideo(w: MediaWorld, record = true) {
  await sql(
    w.t.store,
    "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)",
    probeName("record", "still@standard-1"),
    JSON.stringify({ version: BUILD, imageTag: null, at: Date.now(), ok: true, imagesVerified: true }),
  );
  const author = await w.remote({ avatar: null });
  const url = `https://files.example/p/${++videos}.mp4`;
  const { media } = await w.attach(author.id, url, { type: "video" });
  const file = mp4({ mdat: 1000 });
  w.serve(url, file, { "content-length": String(file.length) });
  expect(await w.round({}, VARS)).toMatchObject({ stored: 1 });
  const [object] = (await w.objects()).filter((o) => o.kind === "attachment").slice(-1);
  const token = object!.token;
  const [slot] = await sql<{ id: number }>(w.t.store, "SELECT id FROM remote_media WHERE token = ?", token);
  const charge = object!.charge;
  if (!record) {
    return { media, token, slot: String(slot!.id), charge, attempt: null, key: null };
  }
  const made = await stillsRound(w);
  expect(made).toMatchObject({ status: "recorded", token });
  const attempt = (made as { attempt: string }).attempt;
  return { media, token, slot: String(slot!.id), charge, attempt, key: `remote/${token}/s${attempt}` };
}

const stillRow = async (w: MediaWorld, token: string) =>
  (
    await sql<{ state: string; claims: number; due_at: number | null; attempt: string | null; still_charge: number }>(
      w.t.store,
      "SELECT state, claims, due_at, attempt, still_charge FROM remote_media_stills WHERE token = ?",
      token,
    )
  )[0];
const slotStill = async (w: MediaWorld, slot: string) =>
  (
    await sql<{ token: string | null; still_key: string | null; still_ext: string | null }>(
      w.t.store,
      "SELECT token, still_key, still_ext FROM remote_media WHERE id = ?",
      slot,
    )
  )[0];

// A PITR bookmark of the tables these cases read, and the restore to it: the tables put back and the marker written.
type Bookmark = Record<string, Record<string, SqlStorageValue>[]>;
const REWOUND = ["remote_media", "remote_media_objects", "remote_media_stills", "remote_media_usage", "kopje_state"];

async function bookmark(w: MediaWorld): Promise<Bookmark> {
  const taken: Bookmark = {};
  for (const table of REWOUND) {
    taken[table] = await sql(w.t.store, `SELECT * FROM ${table}`);
  }
  return taken;
}

async function restoreTo(w: MediaWorld, taken: Bookmark): Promise<number> {
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
  return mark(w);
}

// The restore marker at the Store's time.
async function mark(w: MediaWorld): Promise<number> {
  const restoredAt = Date.now();
  await env.MEDIA.put(restoreMarkerKey(w.t.store.id.toString()), JSON.stringify({ at: restoredAt }));
  return restoredAt;
}

const unmark = (w: MediaWorld) => env.MEDIA.delete(restoreMarkerKey(w.t.store.id.toString()));

const served = async (w: MediaWorld, token: string, variant: RemoteVariant, type: string) =>
  (
    await harness(w.t.store, { MAINTENANCE: "readonly", MEDIA: env.MEDIA }).request(
      remoteMediaPath(token, variant, type),
    )
  ).status;

// The attachment as the Mastodon API presents it.
const ORIGIN = "https://kopje.test";
const presented = async (w: MediaWorld, media: string) => {
  const [row] = await sql<MediaRow>(
    w.t.store,
    `SELECT ${selectSql(STATUS_MEDIA_COLUMN_MAP)} FROM media_attachments m WHERE m.id = ?`,
    media,
  );
  return presentMedia({ ...row!, description: row!.description ?? "" }, ORIGIN);
};

// After the restore's settle period, validation reaches the token: the API advertises the restored still until then
// and the poster after the still-only reset, the video kept and served, the row queued again with its claims back to
// 0, the charge totals exact; once claims resume, a new still is made under a new URL.
async function expectStillReset(w: MediaWorld, v: Awaited<ReturnType<typeof cachedVideo>>, restoredAt: number) {
  const video = `${ORIGIN}/media/r/${v.token}/full.mp4`;
  const restored = `${ORIGIN}/media/r/${v.token}/s${v.attempt}.webp`;
  expect(await presented(w, v.media)).toMatchObject({ url: video, preview_url: restored });
  at(w, restoredAt + REMOTE_SETTLE_MS);
  expect((await w.round({}, VARS)).validated).toBe(1);
  expect(await slotStill(w, v.slot)).toEqual({ token: v.token, still_key: null, still_ext: null });
  expect(await stillRow(w, v.token)).toEqual({
    state: "queued",
    claims: 0,
    due_at: restoredAt + REMOTE_SETTLE_MS,
    attempt: null,
    still_charge: 0,
  });
  // The object's charge is its file's again: the still's released.
  expect(await w.objects()).toMatchObject([{ token: v.token, state: "stored", charge: v.charge }]);
  expect(await served(w, v.token, "full", "video/mp4")).toBe(200);
  expect(await presented(w, v.media)).toMatchObject({ url: video, preview_url: `${ORIGIN}/assets/video-poster.png` });
  await w.exact();
  // Claims wait for the walk to end (remote_media_validated_at), which the next maintenance records.
  expect(await stillsRound(w)).toEqual({ status: "unclaimed", claim: { status: "restoring" } });
  expect((await w.round({}, VARS)).validated).toBe(0);
  const again = await stillsRound(w);
  expect(again).toMatchObject({ status: "recorded", token: v.token });
  expect((again as { attempt: string }).attempt).not.toBe(v.attempt);
}

describe("validation of named stills after a restore (P-PITR2, W-S9)", () => {
  it("resets a restored stored still whose key is missing, keeping the video cached and served", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    await env.MEDIA.delete(v.key!);
    const restoredAt = await mark(w);
    try {
      await expectStillReset(w, v, restoredAt);
    } finally {
      await unmark(w);
    }
  });

  // r4 M5c and P21b: the reset releases the still's charge through the ledger, usage and an audit already past the
  // token, and clears every still field of the slot, its blurhash included.
  it("releases the still's charge through an audit past its token, and clears the slot's still and blurhash", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    expect(await sql(w.t.store, "SELECT still_blurhash FROM remote_media WHERE id = ?", v.slot)).not.toEqual([
      { still_blurhash: null },
    ]);
    const restoredAt = await mark(w);
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt, cap: CAP, retentionDays: 14 });
      const [sums] = await sql<{ bytes: number; doomed: number }>(
        w.t.store,
        `SELECT coalesce(sum(charge), 0) AS bytes,
					coalesce(sum(CASE state WHEN 'doomed' THEN charge ELSE 0 END), 0) AS doomed FROM remote_media_objects`,
      );
      await sql(
        w.t.store,
        "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('remote_media_audit', ?)",
        JSON.stringify({ cursor: "z".repeat(64), ...sums }),
      );
      const answer = await w.op(recordRemoteMediaValidation, {
        restore: restoredAt,
        restoredAt,
        results: [
          {
            token: v.token,
            heads: [
              { variant: "full", head: "present" },
              { variant: `s${v.attempt}`, head: "missing" },
            ],
          },
        ],
        now: Date.now(),
      });
      expect(answer).toEqual({ status: "recorded", reset: 0, stills: 1 });
      expect(
        await sql(w.t.store, "SELECT still_key, still_ext, still_blurhash FROM remote_media WHERE id = ?", v.slot),
      ).toEqual([{ still_key: null, still_ext: null, still_blurhash: null }]);
      await w.exact();
      const done = await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt: null, cap: CAP, retentionDays: 14 });
      expect(done.drift).toBeNull();
    } finally {
      await unmark(w);
    }
  });

  it("resets a still whose heads fail VALIDATION_FAILURES times with `full` present, and keeps `full`", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const restoredAt = await mark(w);
    const failing = bucketWith({
      head: (key, real) => (key === v.key ? Promise.reject(new Error("head failed")) : real()),
    });
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      for (let n = 1; n < VALIDATION_FAILURES; n++) {
        expect((await w.round({ bucket: () => failing }, VARS)).validated).toBe(0);
        expect(await slotStill(w, v.slot)).toMatchObject({ still_key: `s${v.attempt}` });
      }
      expect((await w.round({ bucket: () => failing }, VARS)).validated).toBe(0);
      expect(await slotStill(w, v.slot)).toEqual({ token: v.token, still_key: null, still_ext: null });
      expect(await stillRow(w, v.token)).toMatchObject({ state: "queued", claims: 0 });
      expect(await env.MEDIA.head(`remote/${v.token}/full`)).not.toBeNull();
      expect(await w.objects()).toMatchObject([{ token: v.token, state: "stored" }]);
      await w.exact();
    } finally {
      await unmark(w);
    }
  });

  it("counts a named still's head failures apart: they never spend the allowance of `full`", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const restoredAt = await mark(w);
    const full = `remote/${v.token}/full`;
    let failing = v.key!;
    const bucket = bucketWith({
      head: (key, real) => (key === failing ? Promise.reject(new Error("head failed")) : real()),
    });
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      for (let n = 1; n < VALIDATION_FAILURES; n++) {
        expect((await w.round({ bucket: () => bucket }, VARS)).validated).toBe(0);
      }
      failing = full;
      for (let n = 1; n < VALIDATION_FAILURES; n++) {
        expect((await w.round({ bucket: () => bucket }, VARS)).validated).toBe(0);
        expect(await w.objects()).toMatchObject([{ token: v.token, state: "stored" }]);
      }
      // The VALIDATION_FAILURES-th failure of `full` itself dooms the object.
      expect((await w.round({ bucket: () => bucket }, VARS)).validated).toBe(0);
      expect((await w.objects()).find((o) => o.token === v.token)).toMatchObject({ state: "doomed" });
    } finally {
      await unmark(w);
    }
  });

  it("heads no still for a row that names none, and the sweep deletes a forgotten key past its bound", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w, false);
    // A still a restore forgot: its key in R2, no row naming it.
    const forgotten = `remote/${v.token}/s${"c".repeat(32)}`;
    await env.MEDIA.put(forgotten, new Uint8Array([1]));
    const uploaded = (await env.MEDIA.head(forgotten))!.uploaded.getTime();
    const restoredAt = await mark(w);
    const heads: string[] = [];
    const recording = bucketWith({ head: (key, real) => (heads.push(key), real()) });
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      expect((await w.round({ bucket: () => recording }, { MEDIA_STILL_MONTHLY_JOBS: "0" })).validated).toBe(1);
      expect(heads).toEqual([`remote/${v.token}/full`]);
      const sweep = (now: number) =>
        w.op(remoteMediaOrphans, { keys: [{ key: forgotten, uploaded }], cursor: null, now });
      expect(await sweep(uploaded + LATE_PUT_MS)).toEqual({ orphans: [] });
      expect(await sweep(uploaded + LATE_PUT_MS + 1)).toEqual({ orphans: [forgotten] });
    } finally {
      await unmark(w);
    }
  });

  it("validates the named still beside `full` in the batch, and keeps it when present", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const restoredAt = await mark(w);
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      const batch = await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt, cap: CAP, retentionDays: 14 });
      expect(batch.validation).toEqual([{ token: v.token, keys: [`remote/${v.token}/full`, v.key] }]);
      expect(batch.validationRestore).toBe(restoredAt);
      const answer = await w.op(recordRemoteMediaValidation, {
        restore: restoredAt,
        restoredAt,
        results: [
          {
            token: v.token,
            heads: [
              { variant: "full", head: "present" },
              { variant: `s${v.attempt}`, head: "present" },
            ],
          },
        ],
        now: Date.now(),
      });
      expect(answer).toEqual({ status: "recorded", reset: 0, stills: 0 });
      expect(await slotStill(w, v.slot)).toMatchObject({ still_key: `s${v.attempt}` });
    } finally {
      await unmark(w);
    }
  });

  // A result of restore A's batch delivered after restore B rewound the walk to A's cursor: the walk's restore is A,
  // the marker's B, so nothing applies. Through the Store's RPC, which reads the marker itself.
  it("applies nothing from an earlier restore's batch once the marker names a later one", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const a = await mark(w);
    try {
      at(w, a + REMOTE_SETTLE_MS);
      const batch = await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt: a, cap: CAP, retentionDays: 14 });
      expect(batch.validationRestore).toBe(a);
      const input = {
        restore: a,
        results: [
          {
            token: v.token,
            heads: [
              { variant: "full", head: "present" as const },
              { variant: `s${v.attempt}`, head: "missing" as const },
            ],
          },
        ],
      };
      at(w, Date.now() + 1);
      await mark(w);
      expect(await w.t.store.recordRemoteMediaValidation(BUILD, input)).toEqual({ status: "stale" });
      expect(await slotStill(w, v.slot)).toMatchObject({ still_key: `s${v.attempt}` });
      expect(await stillRow(w, v.token)).toMatchObject({ state: "stored", attempt: v.attempt });
      // The guarded branch: the same result under A's marker resets the still.
      await env.MEDIA.put(restoreMarkerKey(w.t.store.id.toString()), JSON.stringify({ at: a }));
      expect(await w.t.store.recordRemoteMediaValidation(BUILD, input)).toEqual({
        status: "recorded",
        reset: 0,
        stills: 1,
      });
    } finally {
      await unmark(w);
    }
  });

  // r4 M5b: an old still result naming attempt k while the token's stored row names a later attempt, marker and cursor
  // valid: the reset's attempt fence holds.
  it("resets nothing for a result naming an attempt the stored row no longer names", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const later = "d".repeat(32);
    await sql(w.t.store, "UPDATE remote_media_stills SET attempt = ? WHERE token = ?", later, v.token);
    await sql(w.t.store, "UPDATE remote_media SET still_key = ? WHERE id = ?", `s${later}`, v.slot);
    const restoredAt = await mark(w);
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt, cap: CAP, retentionDays: 14 });
      const answer = await w.op(recordRemoteMediaValidation, {
        restore: restoredAt,
        restoredAt,
        results: [
          {
            token: v.token,
            heads: [
              { variant: "full", head: "present" },
              { variant: `s${v.attempt}`, head: "missing" },
            ],
          },
        ],
        now: Date.now(),
      });
      expect(answer).toEqual({ status: "recorded", reset: 0, stills: 0 });
      expect(await stillRow(w, v.token)).toMatchObject({ state: "stored", attempt: later });
      expect(await slotStill(w, v.slot)).toMatchObject({ still_key: `s${later}` });
    } finally {
      await unmark(w);
    }
  });
});

// A stale attempt's failed head counts toward neither allowance: the walk moves past the token.
describe("a stale attempt's result", () => {
  it("counts nothing for a failed head of an attempt the stored row no longer names, and the walk moves on", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const later = "d".repeat(32);
    await sql(w.t.store, "UPDATE remote_media_stills SET attempt = ? WHERE token = ?", later, v.token);
    await sql(w.t.store, "UPDATE remote_media SET still_key = ? WHERE id = ?", `s${later}`, v.slot);
    const restoredAt = await mark(w);
    try {
      at(w, restoredAt + REMOTE_SETTLE_MS);
      await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt, cap: CAP, retentionDays: 14 });
      const answer = await w.op(recordRemoteMediaValidation, {
        restore: restoredAt,
        restoredAt,
        results: [
          {
            token: v.token,
            heads: [
              { variant: "full", head: "present" },
              { variant: `s${v.attempt}`, head: "unknown" },
            ],
          },
        ],
        now: Date.now(),
      });
      expect(answer).toEqual({ status: "recorded", reset: 0, stills: 0 });
      const next = await w.op(maintainRemoteMedia, { now: Date.now(), restoredAt, cap: CAP, retentionDays: 14 });
      expect(next.validation).toEqual([]);
      expect(await stillRow(w, v.token)).toMatchObject({ state: "stored", attempt: later });
    } finally {
      await unmark(w);
    }
  });
});

// The second accepted limitation of the PR5 plan's 1.6 (main's cached-URL exception, docs/threat-model.md): after a
// restore, a named still whose key is gone answers 404 until validation reaches its token, then the still-only reset.
describe("a named still lost across a restore (codex r4 H1)", () => {
  it("a sweep delete classified before a restore and landing after it: 404 until validation, then the reset", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const taken = await bookmark(w);
    // After the bookmark the still is unnamed (the walk deleted its row), and the sweep classifies its key.
    await sql(w.t.store, "DELETE FROM remote_media_stills WHERE token = ?", v.token);
    await sql(
      w.t.store,
      "UPDATE remote_media SET still_ext = NULL, still_key = NULL, still_blurhash = NULL WHERE id = ?",
      v.slot,
    );
    // As R2 lists it, on the Store's clock (the put landed at the record).
    const uploaded = Date.now();
    at(w, uploaded + LATE_PUT_MS + 1);
    const classified = await w.op(remoteMediaOrphans, {
      keys: [{ key: v.key!, uploaded }],
      cursor: null,
      now: Date.now(),
    });
    expect(classified.orphans).toEqual([v.key]);
    // The restore names the still again; the held delete lands during it.
    const restoredAt = await restoreTo(w, taken);
    await env.MEDIA.delete(classified.orphans);
    try {
      expect(await slotStill(w, v.slot)).toMatchObject({ still_key: `s${v.attempt}` });
      expect(await served(w, v.token, `s${v.attempt!}` as RemoteVariant, "image/webp")).toBe(404);
      await expectStillReset(w, v, restoredAt);
    } finally {
      await unmark(w);
    }
  });

  it("a restore to a bookmark naming a key swept earlier: 404 until validation, then the reset", async () => {
    const w = await mediaWorld();
    const v = await cachedVideo(w);
    const taken = await bookmark(w);
    await env.MEDIA.delete(v.key!);
    at(w, Date.now() + 60_000);
    const restoredAt = await restoreTo(w, taken);
    try {
      expect(await served(w, v.token, `s${v.attempt!}` as RemoteVariant, "image/webp")).toBe(404);
      await expectStillReset(w, v, restoredAt);
    } finally {
      await unmark(w);
    }
  });
});
