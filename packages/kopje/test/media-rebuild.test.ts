import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

import { run } from "../cli/lib/main.js";
import { REBUILD_LEASE_MS, REBUILD_PAGE, REBUILD_SETTLE_MS, SCAN_WINDOW } from "../src/domain/media-rebuild";
import { handleScheduled } from "../src/jobs/scheduled";
import { sweepMedia } from "../src/mastodon/media";
import { MAX_BUILDS_PER_CALL, REBUILD_CALL_BUDGET_MS, rebuildMedia } from "../src/mastodon/media-rebuild";
import { imageBlurhash } from "../src/platform/blurhash";
import { EMOJI_IMAGE_LIMIT, EMOJI_PREVIEW_LIMIT } from "../src/platform/emoji-image";
import { type EncodeOptions, IMAGE_SIZE_LIMIT, RGBA_MIN_CALL_MS } from "../src/platform/images";
import { restoreMarkerKey } from "../src/platform/media-files";
import type { StoreStub } from "../src/platform/store-client";
import { toStoreUnavailable } from "../src/platform/store-errors";
import { admitFlags, type OperatorGate } from "../src/platform/store-flags";
import { randomToken } from "../src/security/tokens";
import { type AccessTeam, adminClaims, adminHarness, adminTeam, serviceClaims, setTeamAccess } from "./access-helpers";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { ANIMATED_WEBP, JPEG_ORIENTATION_6, PNG_PLAIN, WIDE_PNG } from "./fixtures/images";
import { BUILD, completeSetup, deferred, holdingMarker, migratedStore, rejectionOf } from "./helpers";
import { pngOf, pngOfBytes } from "./local-emoji-helpers";
import { atStoreTime, bytes, framesKeepingCodec, recordRgba, TestCodec } from "./media-helpers";
import {
  ACCESS,
  ADMIN_AUD,
  ADMIN_EMAIL,
  beginImport,
  dumpViaRpc,
  ensureAdmin,
  importViaRpc,
  memoryIO,
  seedStore,
} from "./ops-helpers";

// kopje-admin media-rebuild (mastodon/media-rebuild.ts): served files made again from the originals of restored or moved
// media, MEDIA-2/MEDIA-3, and its narrow exemption from the operator gate (OPS-8).

declare module "vitest" {
  export interface ProvidedContext {
    cutoverImages: { dump: string; originals: Record<string, string> };
  }
}

let team: AccessTeam;

beforeEach(async () => {
  team = await adminTeam();
});

const ACCOUNT = "110000000000000001";
let nextId = 0;

function mediaId(): string {
  return String(120_000_000_000_000_000n + BigInt(++nextId));
}

type Row = { id: string; token: string };

// The Store's readonly maintenance, begun long enough ago for a rebuild to write.
async function settledMaintenance(store: StoreStub): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('maintenance', ?)",
      JSON.stringify({ mode: "readonly", at: Date.now() - REBUILD_SETTLE_MS - 60_000 }),
    );
  });
}

async function setup(
  options: { codec?: TestCodec; env?: Record<string, unknown>; store?: StoreStub; held?: boolean } = {},
) {
  const store = options.store ?? (await migratedStore());
  await setTeamAccess(store, team);
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO accounts (id, uri, username) VALUES (?, 'https://kopje.test/ap/users/alice', 'alice')",
      ACCOUNT,
    );
  });
  if (options.held !== false) {
    await settledMaintenance(store);
  }
  const codec = options.codec ?? new TestCodec();
  const h = adminHarness(store, team, { MAINTENANCE: "readonly", ...options.env }, undefined, () => codec);
  return { ...h, store, codec };
}

// A complete local media row, as a restore or `convert --images` leaves it: URLs, type and a meta that may be wrong.
async function addRow(
  store: StoreStub,
  options: { contentType?: string; original?: Uint8Array | null; files?: boolean; gcAt?: string | null } = {},
): Promise<Row> {
  const id = mediaId();
  const token = randomToken();
  const contentType = options.contentType ?? "image/png";
  const extension = contentType === "image/png" ? "png" : "webp";
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta,
				processed, gc_at)
			VALUES (?, ?, 'image', ?, ?, ?, ?, '{"original":{"width":1,"height":1},"small":{"width":1,"height":1}}', 1, ?)`,
      id,
      ACCOUNT,
      `https://kopje.test/media/${token}/full.${extension}`,
      `https://kopje.test/media/${token}/small.${extension}`,
      token,
      contentType,
      options.gcAt ?? null,
    );
  });
  if (options.original !== null) {
    await env.MEDIA.put(`originals/${id}`, options.original ?? bytes(PNG_PLAIN));
  }
  if (options.files === true) {
    for (const variant of ["full", "small"]) {
      await env.MEDIA.put(`files/${token}/${variant}`, bytes(PNG_PLAIN), { httpMetadata: { contentType } });
    }
  }
  return { id, token };
}

async function meta(store: StoreStub, id: string): Promise<unknown> {
  return runInDurableObject(
    store,
    (_instance, state) =>
      JSON.parse(
        state.storage.sql.exec<{ meta: string }>("SELECT meta FROM media_attachments WHERE id = ?", id).one().meta,
      ) as unknown,
  );
}

async function transforms(store: StoreStub): Promise<number> {
  return runInDurableObject(store, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM kopje_state WHERE name LIKE 'images_transforms:%'")
      .toArray()[0];
    return Number(row?.value ?? "0");
  });
}

async function files(row: Row): Promise<boolean[]> {
  return Promise.all(["full", "small"].map(async (v) => (await env.MEDIA.head(`files/${row.token}/${v}`)) !== null));
}

async function blurhashOf(store: StoreStub, id: string) {
  return runInDurableObject(
    store,
    (_instance, state) =>
      state.storage.sql
        .exec<{ blurhash: string | null }>("SELECT blurhash FROM media_attachments WHERE id = ?", id)
        .one().blurhash,
  );
}

async function setBlurhash(store: StoreStub, id: string, blurhash: string): Promise<void> {
  await sql(store, "UPDATE media_attachments SET blurhash = ? WHERE id = ?", blurhash, id);
}

// A blurhash as an earlier upload stored it (4 × 4, 36 characters).
const SEEDED = "U5D]o8-;9F00_3t7IUM{00RjoM-;00Rj%MWB";

const leaseRow = (store: StoreStub) =>
  runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{ value: string }>("SELECT value FROM kopje_state WHERE name = 'media_rebuild_lease'")
      .toArray()
      .map((row) => JSON.parse(row.value) as { holder: string; until: number }),
  );

type Step = {
  counts: Record<string, number>;
  problems: { id: string; outcome: string; detail?: string }[];
  done: boolean;
  next: string | null;
  stopped: string | null;
};

describe("media rebuild (MEDIA-2, MEDIA-3)", () => {
  it("makes both files of rows that lack them and corrects meta to the real output sizes", async () => {
    const h = await setup();
    const wide = await addRow(h.store, { original: bytes(WIDE_PNG) });
    const rotated = await addRow(h.store, { contentType: "image/webp", original: bytes(JPEG_ORIENTATION_6) });
    const response = await h.post(adminClaims(), "/admin/media/rebuild");
    expect(response.status).toBe(200);
    const step = await response.json<Step>();
    expect(step).toMatchObject({ done: true, stopped: null, problems: [] });
    expect(step.counts).toMatchObject({ built: 2, "skipped-existing": 0 });
    expect(await files(wide)).toEqual([true, true]);
    expect(await meta(h.store, wide.id)).toEqual({
      original: { width: 3840, height: 960 },
      small: { width: 640, height: 160 },
    });
    // The served file is re-encoded (no metadata) and meta has its real, rotated, dimensions.
    const served = await h.request(`/media/${rotated.token}/full.webp`);
    expect(served.headers.get("content-type")).toBe("image/webp");
    const info = await h.codec.real.info(new Uint8Array(await served.arrayBuffer()));
    expect(await meta(h.store, rotated.id)).toMatchObject({ original: { width: info.width, height: info.height } });
    expect((await h.request(`/media/${wide.token}/small.png`)).status).toBe(200);
    // Charged as uploads are: three transformations each.
    expect(await transforms(h.store)).toBe(6);
  });

  it("records an animated served file in meta, and leaves the accounts as they were", async () => {
    const h = await setup({ codec: framesKeepingCodec() });
    const animated = await addRow(h.store, { contentType: "image/webp", original: bytes(ANIMATED_WEBP) });
    const still = await addRow(h.store);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE accounts SET avatar_url = (SELECT url FROM media_attachments WHERE id = ?) WHERE id = ?`,
        animated.id,
        ACCOUNT,
      );
    });
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step.counts).toMatchObject({ built: 2 });
    expect(await meta(h.store, animated.id)).toEqual({
      original: { width: 8, height: 6 },
      small: { width: 8, height: 6 },
      animated: true,
    });
    expect(await meta(h.store, still.id)).not.toHaveProperty("animated");
    expect(
      await runInDurableObject(h.store, (_instance, state) =>
        state.storage.sql.exec("SELECT avatar_static_url, header_static_url FROM accounts WHERE id = ?", ACCOUNT).one(),
      ),
    ).toEqual({ avatar_static_url: null, header_static_url: null });
  });

  it("skips rows whose files exist, so a second run changes nothing", async () => {
    const h = await setup();
    const existing = await addRow(h.store, { files: true });
    const missing = await addRow(h.store);
    const first = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(first.counts).toMatchObject({ built: 1, "skipped-existing": 1 });
    expect(await meta(h.store, existing.id)).toMatchObject({ original: { width: 1, height: 1 } });
    const calls = h.codec.calls;
    const second = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(second.counts).toMatchObject({ built: 0, "skipped-existing": 2 });
    expect(h.codec.calls).toBe(calls);
    expect(await files(missing)).toEqual([true, true]);
  });

  it("leaves out remote, doomed and unfinished rows", async () => {
    const h = await setup();
    const doomed = await addRow(h.store, { gcAt: new Date(NOW - 1000).toISOString() });
    const unfinished = await addRow(h.store);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("UPDATE media_attachments SET processed = 0, url = '' WHERE id = ?", unfinished.id);
    });
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO media_attachments (id, account_id, type, url) VALUES (?, ?, 'image', 'https://remote.test/a.png')`,
        mediaId(),
        ACCOUNT,
      );
    });
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step.counts).toMatchObject({ built: 0, "skipped-existing": 0, "original-missing": 0 });
    expect(await files(doomed)).toEqual([false, false]);
    expect(await files(unfinished)).toEqual([false, false]);
  });

  // G6-4 (#1828 PR6 T13): after an import into a bucket holding only originals, a video's current thumbnail is an image
  // row like any other, and its files are remade; a replaced one (url '') is not, and its URLs stay gone.
  it("remakes a current thumbnail's files, not a replaced one's, and a second run changes nothing", async () => {
    const h = await setup();
    const parent = mediaId();
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, processed)
			VALUES (?, ?, 'video', 'https://kopje.test/media/v/full.mp4', ?, 'video/mp4', 1)`,
      parent,
      ACCOUNT,
      randomToken(),
    );
    const current = await addRow(h.store);
    const replaced = await addRow(h.store);
    await sql(h.store, "UPDATE media_attachments SET thumbnail_of = ? WHERE id = ?", parent, current.id);
    await sql(
      h.store,
      "UPDATE media_attachments SET thumbnail_of = ?, url = '', gc_at = ? WHERE id = ?",
      parent,
      new Date(NOW + 86_400_000).toISOString(),
      replaced.id,
    );
    const first = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(first.problems.filter((p) => p.id !== parent)).toEqual([]);
    expect(await files(current)).toEqual([true, true]);
    expect(await files(replaced)).toEqual([false, false]);
    expect((await h.request(`/media/${current.token}/small.png`)).status).toBe(200);
    expect((await h.request(`/media/${replaced.token}/small.png`)).status).toBe(404);
    const calls = h.codec.calls;
    const second = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(second.counts).toMatchObject({ built: 0 });
    expect(h.codec.calls).toBe(calls);
  });

  it("reports a missing original and a type mismatch, and builds the rest", async () => {
    const h = await setup();
    const missing = await addRow(h.store, { original: null });
    // The row says WebP, but a PNG original is served as PNG: its URLs would be wrong, so it is not rebuilt.
    const mismatch = await addRow(h.store, { contentType: "image/webp", original: bytes(PNG_PLAIN) });
    const good = await addRow(h.store);
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step.counts).toMatchObject({ built: 1, "original-missing": 1, "type-mismatch": 1 });
    expect(step.problems).toEqual([
      { id: missing.id, outcome: "original-missing" },
      { id: mismatch.id, outcome: "type-mismatch", detail: "image/png is served as image/png" },
    ]);
    expect(await files(missing)).toEqual([false, false]);
    expect(await files(mismatch)).toEqual([false, false]);
    expect(await meta(h.store, mismatch.id)).toMatchObject({ original: { width: 1, height: 1 } });
    expect(await files(good)).toEqual([true, true]);
    // Only the good row was charged.
    expect(await transforms(h.store)).toBe(3);
  });

  it("stops on the Images quota (9422) and on the monthly budget, leaving the row for the next run", async () => {
    const codec = new TestCodec();
    codec.failEncode = 9422;
    const h = await setup({ codec });
    const row = await addRow(h.store);
    const quota = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(quota).toMatchObject({ stopped: "quota", done: false, next: null });
    expect(await files(row)).toEqual([false, false]);

    const budget = await setup({ env: { IMAGES_MONTHLY_TRANSFORMS: "1" } });
    const unbuilt = await addRow(budget.store);
    const spent = await (await budget.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(spent).toMatchObject({ stopped: "budget", done: false });
    expect(budget.codec.calls).toBe(0);
    expect(await files(unbuilt)).toEqual([false, false]);
  });

  it("looks at bounded pages and builds a bounded number per call, resuming after `next`", async () => {
    const h = await setup();
    const rows: Row[] = [];
    for (let i = 0; i < MAX_BUILDS_PER_CALL + REBUILD_PAGE + 2; i++) {
      rows.push(await addRow(h.store, { files: i >= MAX_BUILDS_PER_CALL + 1 }));
    }
    const first = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(first.counts).toMatchObject({ built: MAX_BUILDS_PER_CALL });
    expect(first).toMatchObject({ done: false, next: rows[MAX_BUILDS_PER_CALL - 1]?.id });
    const second = await (await h.post(adminClaims(), "/admin/media/rebuild", { after: first.next })).json<Step>();
    expect(second.counts).toMatchObject({ built: 1, "skipped-existing": REBUILD_PAGE - 1 });
    expect(second).toMatchObject({ done: false, next: rows[MAX_BUILDS_PER_CALL + REBUILD_PAGE - 1]?.id });
    const third = await (await h.post(adminClaims(), "/admin/media/rebuild", { after: second.next })).json<Step>();
    expect(third).toMatchObject({ done: true, counts: { "skipped-existing": 2 } });
    for (const row of rows) {
      expect(await files(row)).toEqual([true, true]);
    }
  });

  it("stops starting rows past the call's time budget after one build, and resumes after next", async () => {
    const h = await setup();
    const rows: Row[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(await addRow(h.store));
    }
    let clock = NOW;
    // Each build takes 70 seconds of the call's clock, counted once its last file is written.
    const puts = new Map<string, number>();
    const bucket = {
      head: (key: string) => env.MEDIA.head(key),
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        const put = await env.MEDIA.put(key, value, options);
        if (key.endsWith("/small")) {
          puts.set(key, (puts.get(key) ?? 0) + 1);
          clock += 70_000;
        }
        return put;
      },
    } as unknown as R2Bucket;
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const call = (after: string | null) =>
      rebuildMedia(
        {
          build: BUILD,
          store: h.store,
          bucket,
          images: new TestCodec(),
          now: () => clock,
          authority: admin,
          monthlyTransforms: 100,
          holder: "budgeted",
        },
        { after, dryRun: false },
      );
    expect(REBUILD_CALL_BUDGET_MS).toBe(120_000);
    // 70 seconds after the first build the budget is not spent; 140 seconds after the second it is.
    const first = await call(null);
    expect(first).toMatchObject({ ok: true, done: false, stopped: null, next: rows[1]?.id, counts: { built: 2 } });
    expect(await files(rows[2]!)).toEqual([false, false]);
    const second = await call(first.ok ? first.next : null);
    expect(second).toMatchObject({ ok: true, done: false, stopped: null, next: rows[3]?.id, counts: { built: 2 } });
    const third = await call(second.ok ? second.next : null);
    expect(third).toMatchObject({ ok: true, done: true, stopped: null, counts: { built: 1 } });
    for (const row of rows) {
      expect(await files(row)).toEqual([true, true]);
      expect(puts.get(`files/${row.token}/small`)).toBe(1);
    }
  });

  it("builds one row even when the budget passed before it", async () => {
    const h = await setup();
    const rows = [await addRow(h.store), await addRow(h.store)];
    let clock = NOW;
    // The listing answers 130 seconds into the call, past REBUILD_CALL_BUDGET_MS.
    const store = new Proxy(h.store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildCandidates"
          ? async (...args: Parameters<StoreStub["mediaRebuildCandidates"]>) => {
              const answer = await target.mediaRebuildCandidates(...args);
              clock += 130_000;
              return answer;
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const step = await rebuildMedia(
      {
        build: BUILD,
        store,
        bucket: env.MEDIA,
        images: new TestCodec(),
        now: () => clock,
        authority: { ...ACCESS, teamDomain: team.teamDomain },
        monthlyTransforms: 100,
        holder: "late",
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ ok: true, done: false, stopped: null, next: rows[0]?.id, counts: { built: 1 } });
    expect(await files(rows[0]!)).toEqual([true, true]);
    expect(await files(rows[1]!)).toEqual([false, false]);
  });

  it("ends the call at the time budget after a slow failed attempt, its cursor past it, and builds the next row next", async () => {
    const h = await setup();
    const failed = await addRow(h.store);
    const second = await addRow(h.store);
    let clock = NOW;
    const codec = new TestCodec();
    // The first row's info() answers past REBUILD_CALL_BUDGET_MS, and as no image: a failed attempt, which is handled.
    vi.spyOn(codec, "info").mockImplementationOnce(() => {
      clock += REBUILD_CALL_BUDGET_MS + 10_000;
      return Promise.resolve({ format: "image/svg+xml" });
    });
    const call = (after: string | null) =>
      rebuildMedia(
        {
          build: BUILD,
          store: h.store,
          bucket: env.MEDIA,
          images: codec,
          now: () => clock,
          authority: { ...ACCESS, teamDomain: team.teamDomain },
          monthlyTransforms: 100,
        },
        { after, dryRun: false },
      );
    const first = await call(null);
    expect(first).toMatchObject({ done: false, stopped: null, next: failed.id, counts: { failed: 1, built: 0 } });
    expect(await files(second)).toEqual([false, false]);
    const next = await call(failed.id);
    expect(next).toMatchObject({ done: true, next: second.id, counts: { built: 1 } });
    expect(await files(second)).toEqual([true, true]);
  });

  it("looks at no further row once the budget is spent: no lease renewal, R2 head or info() for it", async () => {
    const h = await setup();
    const rows = [await addRow(h.store), await addRow(h.store)];
    let clock = NOW;
    const heads: string[] = [];
    const renewals: string[] = [];
    const codec = new TestCodec();
    // The lease and info() calls made by the time the first row's last file is written.
    let atCutoff = -1;
    let infoAtCutoff = -1;
    const bucket = {
      head: (key: string) => {
        heads.push(key);
        return env.MEDIA.head(key);
      },
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        const put = await env.MEDIA.put(key, value, options);
        if (key.endsWith("/small")) {
          clock += REBUILD_CALL_BUDGET_MS;
          atCutoff = renewals.length;
          infoAtCutoff = codec.infoCalls;
        }
        return put;
      },
    } as unknown as R2Bucket;
    const store = new Proxy(h.store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildLease"
          ? async (...args: Parameters<StoreStub["mediaRebuildLease"]>) => {
              renewals.push(args[1].release ? "release" : "renew");
              return target.mediaRebuildLease(...args);
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const step = await rebuildMedia(
      {
        build: BUILD,
        store,
        bucket,
        images: codec,
        now: () => clock,
        authority: { ...ACCESS, teamDomain: team.teamDomain },
        monthlyTransforms: 100,
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ done: false, stopped: null, next: rows[0]!.id, counts: { built: 1 } });
    expect(heads.filter((key) => key.includes(rows[1]!.token))).toEqual([]);
    expect(infoAtCutoff).toBeGreaterThan(0);
    expect(codec.infoCalls).toBe(infoAtCutoff);
    // After the first row's last write, only the release: the second row's turn renews nothing.
    expect(atCutoff).toBeGreaterThan(0);
    expect(renewals.slice(atCutoff)).toEqual(["release"]);
  });

  it("records the blurhash of the rebuilt preview's RGBA, charged as an upload's three transformations", async () => {
    const codec = new TestCodec();
    const seen = recordRgba(codec);
    const h = await setup({ codec });
    const row = await addRow(h.store, { original: bytes(WIDE_PNG) });
    expect(await blurhashOf(h.store, row.id)).toBeNull();
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step).toMatchObject({ done: true, stopped: null, counts: { built: 1 } });
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
    const hash = imageBlurhash({ data: new Uint8ClampedArray(seen[0]!.buffer), width: 640, height: 160 });
    expect(hash).toMatch(/^U.{35}$/);
    expect(await blurhashOf(h.store, row.id)).toBe(hash);
    expect(await transforms(h.store)).toBe(3);
  });

  it("keeps the stored blurhash when the RGBA output fails, and builds the row", async () => {
    const codec = new TestCodec();
    codec.failRgba = 9520;
    const h = await setup({ codec });
    const row = await addRow(h.store);
    await setBlurhash(h.store, row.id, SEEDED);
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step).toMatchObject({ done: true, stopped: null, counts: { built: 1 } });
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
    expect(await files(row)).toEqual([true, true]);
    expect(await blurhashOf(h.store, row.id)).toBe(SEEDED);
  });

  it("leaves the blurhash of a remote row and of a row whose files exist as it is", async () => {
    const h = await setup();
    const existing = await addRow(h.store, { files: true });
    await setBlurhash(h.store, existing.id, SEEDED);
    const remote = mediaId();
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO media_attachments (id, account_id, type, url, blurhash)
				VALUES (?, ?, 'image', 'https://remote.test/a.png', ?)`,
        remote,
        ACCOUNT,
        SEEDED,
      );
    });
    const built = await addRow(h.store);
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    // The row between them was reached and built.
    expect(step.counts).toMatchObject({ built: 1, "skipped-existing": 1 });
    expect(await files(built)).toEqual([true, true]);
    expect(await blurhashOf(h.store, existing.id)).toBe(SEEDED);
    expect(await blurhashOf(h.store, remote)).toBe(SEEDED);
  });

  it("builds a row whose RGBA output answers 9422 and stops before charging the next", async () => {
    const codec = new TestCodec();
    codec.failRgba = 9422;
    const h = await setup({ codec });
    const first = await addRow(h.store);
    await setBlurhash(h.store, first.id, SEEDED);
    const second = await addRow(h.store);
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step).toMatchObject({ stopped: "quota", done: false, next: first.id, counts: { built: 1 } });
    expect(await files(first)).toEqual([true, true]);
    expect(await blurhashOf(h.store, first.id)).toBe(SEEDED);
    expect(await files(second)).toEqual([false, false]);
    expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
    expect(await transforms(h.store)).toBe(3);
    // The next call starts at the second row.
    codec.failRgba = null;
    const next = await (await h.post(adminClaims(), "/admin/media/rebuild", { after: step.next })).json<Step>();
    expect(next).toMatchObject({ stopped: null, done: true, counts: { built: 1 } });
    expect(await files(second)).toEqual([true, true]);
  });

  it.each(["output", "read"] as const)(
    "gives up the row at its deadline when the RGBA %s stalls, cancelling the read and keeping the lease",
    async (stall) => {
      const h = await setup();
      const row = await addRow(h.store);
      await setBlurhash(h.store, row.id, SEEDED);
      const codec = new TestCodec();
      codec.stallRgba = stall;
      let clock = NOW;
      const encode = codec.encode.bind(codec);
      codec.encode = async (input: Uint8Array, options: EncodeOptions) => {
        const output = await encode(input, options);
        if (options.still === true) {
          // Once the preview is made, just past RGBA_MIN_CALL_MS is left of the row's deadline (the renewed lease
          // less its margin).
          clock = NOW + REBUILD_LEASE_MS - 60_000 - RGBA_MIN_CALL_MS - 300;
        }
        return output;
      };
      const admin = { ...ACCESS, teamDomain: team.teamDomain };
      const step = await rebuildMedia(
        {
          build: BUILD,
          store: h.store,
          bucket: env.MEDIA,
          images: codec,
          now: () => clock,
          authority: admin,
          monthlyTransforms: 100,
          holder: "stalled",
        },
        { after: null, dryRun: false },
      );
      expect(step).toMatchObject({ ok: true, stopped: "deadline", done: false, next: null });
      expect(codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png", "rgba"]);
      expect(codec.rgbaCancelled).toBe(stall === "read" ? 1 : 0);
      expect(await files(row)).toEqual([false, false]);
      expect(await blurhashOf(h.store, row.id)).toBe(SEEDED);
      expect((await leaseRow(h.store))[0]?.holder).toBe("stalled");
    },
    30_000,
  );

  it("dry run reports without charging, encoding or writing", async () => {
    const h = await setup();
    const row = await addRow(h.store);
    await addRow(h.store, { original: null });
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild", { dryRun: true })).json<Step>();
    expect(step.counts).toMatchObject({ "would-build": 1, built: 0, "original-missing": 1 });
    // The image-only answer: no video or audio row, no `fallback`.
    expect(Object.keys(step.counts).toSorted()).toEqual([
      "built",
      "failed",
      "gone",
      "original-missing",
      "skipped-existing",
      "type-mismatch",
      "would-build",
    ]);
    expect(h.codec.calls).toBe(0);
    expect(await transforms(h.store)).toBe(0);
    expect(await files(row)).toEqual([false, false]);
  });
});

describe("media rebuild and the operator gate (OPS-8)", () => {
  it("admits only the rebuild in readonly maintenance and while unpublished; never during an import or a dump", () => {
    const readonly = gate({ maintenance: true });
    const unpublished = gate({ unpublished: true });
    for (const held of [readonly, unpublished]) {
      expect(() => admitFlags(held, "media-rebuild", NOW)).not.toThrow();
      expect(() => admitFlags(held, "write", NOW)).toThrow("kopje-maintenance: ");
    }
    expect(() => admitFlags(gate({ import: true }), "media-rebuild", NOW)).toThrow(/import-in-progress/);
    const dump = gate({ dump: { leaseUntil: NOW + 60_000 } });
    expect(() => admitFlags(dump, "media-rebuild", NOW)).toThrow(/dump-in-progress/);
  });

  it("rebuilds in a Store that is unpublished or in readonly maintenance, where other writes stay refused", async () => {
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('unpublished', ?)",
        JSON.stringify({ at: NOW, import: "i" }),
      );
    });
    const unpublished = await addRow(h.store, { original: bytes(WIDE_PNG) });
    expect((await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>()).counts.built).toBe(1);
    expect(await meta(h.store, unpublished.id)).toMatchObject({ original: { width: 3840, height: 960 } });
    const refused = await rejectionOf(h.store.expiredMedia(BUILD, { limit: 1 }));
    expect(toStoreUnavailable(refused)?.reason).toBe("unpublished");

    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM kopje_state WHERE name = 'unpublished'");
    });
    await settledMaintenance(h.store);
    const readonly = await addRow(h.store);
    expect((await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>()).counts.built).toBe(1);
    expect(await files(readonly)).toEqual([true, true]);
    const stillRefused = await rejectionOf(h.store.expiredMedia(BUILD, { limit: 1 }));
    expect(toStoreUnavailable(stillRefused)?.reason).toBe("maintenance");
  });

  it("is refused while a dump holds the Store", async () => {
    const h = await setup();
    await addRow(h.store);
    expect((await h.store.dumpStart(BUILD)).ok).toBe(true);
    const response = await h.post(adminClaims(), "/admin/media/rebuild");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "dump-in-progress" });
  });
});

describe("media rebuild authorization", () => {
  it("is for the Access admin only: not anonymous, another identity, the import token or a session", async () => {
    const token = "import-token-0123456789abcdef0123456789";
    const h = await setup({ env: { IMPORT_TOKEN: token } });
    const row = await addRow(h.store);
    const post = (headers: Record<string, string>) =>
      h.request("/admin/media/rebuild", { method: "POST", headers, body: "{}" });
    expect((await post({})).status).toBe(401);
    expect((await post({ "Kopje-Import-Token": token })).status).toBe(403);
    expect((await post({ "Kopje-Import-Session": "A".repeat(43) })).status).toBe(403);
    expect((await h.post({ email: "someone@kopje.test" }, "/admin/media/rebuild")).status).toBe(403);
    expect(await files(row)).toEqual([false, false]);
    expect((await h.post(serviceClaims(), "/admin/media/rebuild")).status).toBe(200);
    expect(await files(row)).toEqual([true, true]);
  });

  it("releases a lease while the restore marker holds no time, and refuses to renew one (code review r3)", async () => {
    const h = await setup();
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const first = await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" });
    expect(first).toMatchObject({ status: "ok", generation: 1 });
    const key = restoreMarkerKey(h.store.id.toString());
    await env.MEDIA.put(key, "{}");
    try {
      const renewed = rejectionOf(h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h", generation: 1 }));
      expect(toStoreUnavailable(await renewed)?.reason).toBe("transient");
      expect(
        await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h", generation: 1, release: true }),
      ).toEqual({ status: "released" });
    } finally {
      await env.MEDIA.delete(key);
    }
    // The released lease is free at once for another holder.
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "next" })).toMatchObject({
      status: "ok",
    });
  });

  it("releases a lease while the marker read is held, and answers an active restore without the marker (code review r4)", async () => {
    const h = await setup();
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" })).toMatchObject({ status: "ok" });
    expect(
      await holdingMarker<unknown>(h.store, () =>
        h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h", generation: 1, release: true }),
      ),
    ).toEqual({ answer: { status: "released" }, reads: 0 });
    expect(await leaseRow(h.store)).toEqual([expect.objectContaining({ holder: "h", until: 0 })]);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('pitr_restoring', ?)",
        JSON.stringify({ at: Date.now() }),
      );
    });
    const key = restoreMarkerKey(h.store.id.toString());
    await env.MEDIA.put(key, "{}");
    try {
      expect(await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "next" })).toEqual({
        status: "restoring",
      });
    } finally {
      await env.MEDIA.delete(key);
    }
  });

  it("answers needs-readonly without the marker when neither flag is set (code review r5)", async () => {
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const take = () => h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" });
    expect(await holdingMarker<unknown>(h.store, take)).toEqual({ answer: { status: "needs-readonly" }, reads: 0 });
    const key = restoreMarkerKey(h.store.id.toString());
    await env.MEDIA.put(key, "{}");
    try {
      expect(await take()).toEqual({ status: "needs-readonly" });
    } finally {
      await env.MEDIA.delete(key);
    }
  });

  it("has the Store check the admin again where it writes", async () => {
    const h = await setup();
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" })).toMatchObject({ status: "ok" });
    const charge = (authority: Parameters<StoreStub["chargeMediaRebuild"]>[1]["authority"]) =>
      h.store.chargeMediaRebuild(BUILD, { authority, holder: "h", id: "1", limit: 100 });
    expect(
      await h.store.mediaRebuildLease(BUILD, {
        authority: { kind: "import-token" },
        holder: "x",
      }),
    ).toMatchObject({ status: "denied" });
    expect(await charge({ kind: "import-token" })).toMatchObject({ status: "denied" });
    expect(await charge({ ...ACCESS, teamDomain: team.teamDomain, aud: "another-app" })).toMatchObject({
      status: "denied",
    });
    expect(await charge({ ...ACCESS, teamDomain: team.teamDomain, email: "someone@kopje.test" })).toMatchObject({
      status: "denied",
    });
    expect(await charge(admin)).toEqual({ status: "ok" });
    expect(await transforms(h.store)).toBe(3);
    // Only the lease's holder writes.
    expect(await h.store.chargeMediaRebuild(BUILD, { authority: admin, holder: "other", id: "1", limit: 100 })).toEqual(
      {
        status: "lease-lost",
      },
    );
  });
});

// kopje-admin through the admin app, as the service token.
async function cli(h: Awaited<ReturnType<typeof setup>>, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("CF-Access-Client-Id");
    headers.delete("CF-Access-Client-Secret");
    return h.as(serviceClaims(), new URL(input).pathname, { ...init, headers });
  };
  const code = await run({
    argv,
    env: {
      KOPJE_ADMIN_URL: "https://admin.kopje.test",
      CF_ACCESS_CLIENT_ID: "id",
      CF_ACCESS_CLIENT_SECRET: "secret",
    },
    io: memoryIO(),
    stdout: { write: (text: string) => void out.push(text), isTTY: false },
    stderr: { write: (text: string) => void err.push(text), isTTY: false },
    fetch,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("kopje-admin media-rebuild", () => {
  it("runs to the end and exits 0, or 3 when rows need a decision or it stopped", async () => {
    const h = await setup();
    for (let i = 0; i < MAX_BUILDS_PER_CALL + 1; i++) {
      await addRow(h.store);
    }
    const dry = await cli(h, ["media-rebuild", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, "would-build": MAX_BUILDS_PER_CALL + 1, built: 0 });
    const done = await cli(h, ["media-rebuild"]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out)).toMatchObject({
      built: MAX_BUILDS_PER_CALL + 1,
      "skipped-existing": 0,
      "original-missing": 0,
      "type-mismatch": 0,
      "quota-stopped": false,
    });
    const missing = await addRow(h.store, { original: null });
    const decide = await cli(h, ["media-rebuild"]);
    expect(decide.code).toBe(3);
    expect(JSON.parse(decide.out)).toMatchObject({
      "skipped-existing": MAX_BUILDS_PER_CALL + 1,
      "original-missing": 1,
      problems: [{ id: missing.id, outcome: "original-missing" }],
    });
    h.codec.failEncode = 9422;
    await addRow(h.store);
    const stopped = await cli(h, ["media-rebuild"]);
    expect(stopped.code).toBe(3);
    expect(JSON.parse(stopped.out)).toMatchObject({ "quota-stopped": true, stopped: "quota" });
    expect(stopped.err).toContain("9422");
    expect((await cli(h, ["media-rebuild", "extra"])).code).toBe(2);
  });

  it("exits 3 and says how when the Store is not readonly", async () => {
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    await addRow(h.store);
    const refused = await cli(h, ["media-rebuild"]);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("kopje-admin maintenance on");
  });
});

describe("media rebuild: races, bounds and real conversions", () => {
  it("deletes the files it wrote for a row that went while it wrote them (MEDIA-2)", async () => {
    let release = () => {};
    let paused: () => void = () => {};
    const reachedPut = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The media bucket as the rebuild sees it: the first served file's write waits until the test releases it.
    const bucket = {
      head: (key: string) => env.MEDIA.head(key),
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        if (key.endsWith("/full")) {
          paused();
          await gate;
        }
        return env.MEDIA.put(key, value, options);
      },
    };
    const h = await setup({ env: { MEDIA: bucket } });
    await completeSetup(h.store);
    const row = await addRow(h.store);
    const running = h.post(adminClaims(), "/admin/media/rebuild");
    await reachedPut;
    // Nothing deletes media while the rebuild holds its lease: the sweep is refused.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE media_attachments SET gc_at = ? WHERE id = ?",
        new Date(NOW).toISOString(),
        row.id,
      );
    });
    expect(await atStoreTime(NOW + 1000, () => sweepMedia(env, { build: () => BUILD, store: () => h.store }))).toBe(0);
    // Defence in depth: should the row go anyway (here by hand), the files the rebuild writes are deleted again.
    await env.MEDIA.delete([`files/${row.token}/full`, `files/${row.token}/small`]);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM media_attachments WHERE id = ?", row.id);
    });
    release();
    const step = await (await running).json<Step>();
    expect(step.counts).toMatchObject({ built: 0, gone: 1 });
    expect(await files(row)).toEqual([false, false]);
  });

  it("scans a bounded window of rows per call, so rows it leaves out cost bounded work", async () => {
    const h = await setup();
    await runInDurableObject(h.store, (_instance, state) => {
      for (let i = 0; i < SCAN_WINDOW * 2 + 10; i++) {
        state.storage.sql.exec(
          "INSERT INTO media_attachments (id, account_id, type, url) VALUES (?, ?, 'image', 'https://remote.test/a.png')",
          mediaId(),
          ACCOUNT,
        );
      }
    });
    const row = await addRow(h.store);
    const steps: Step[] = [];
    let after: string | null = null;
    for (;;) {
      const step: Step = await (await h.post(adminClaims(), "/admin/media/rebuild", { after })).json();
      steps.push(step);
      if (step.done) {
        break;
      }
      expect(step.next).not.toBe(after);
      after = step.next;
    }
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.counts.built)).toEqual([0, 0, 1]);
    expect(await files(row)).toEqual([true, true]);
  });

  it("reports an original over 16 MiB as too large in a dry run as in a real run, without reading or charging it", async () => {
    const h = await setup();
    const large = new Uint8Array(IMAGE_SIZE_LIMIT + 1);
    large.set(bytes(PNG_PLAIN));
    const row = await addRow(h.store, { original: large });
    for (const dryRun of [true, false]) {
      const step = await (await h.post(adminClaims(), "/admin/media/rebuild", { dryRun })).json<Step>();
      expect(step.counts).toMatchObject({ "would-build": 0, built: 0, failed: 1 });
      expect(step.problems).toEqual([{ id: row.id, outcome: "failed", detail: "too_large" }]);
    }
    expect(h.codec.calls).toBe(0);
    expect(await transforms(h.store)).toBe(0);
  });

  it("serves the images of a real `convert --images` conversion once their originals are in R2, before publication", async () => {
    const { dump, originals } = inject("cutoverImages");
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const authority = { ...ACCESS, teamDomain: team.teamDomain, email: ADMIN_EMAIL, aud: ADMIN_AUD } as const;
    expect((await importViaRpc(store, dump, 16 * 1024, authority)).report).toMatchObject({ ok: true });
    expect(Object.keys(originals).length).toBeGreaterThan(0);
    for (const [id, base64] of Object.entries(originals)) {
      await env.MEDIA.put(`originals/${id}`, bytes(base64));
    }
    const h = adminHarness(store, team, {}, undefined, () => new TestCodec());
    const step = await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>();
    expect(step).toMatchObject({ done: true, stopped: null, problems: [] });
    expect(step.counts.built).toBe(Object.keys(originals).length);
    const rows = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ url: string; preview_url: string }>(
          "SELECT url, preview_url FROM media_attachments WHERE file_token IS NOT NULL",
        )
        .toArray(),
    );
    expect(rows).toHaveLength(Object.keys(originals).length);
    for (const row of rows) {
      for (const url of [row.url, row.preview_url]) {
        const served = await h.request(new URL(url).pathname);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/png");
      }
    }
    // Still unpublished: the rebuild was the only write let through.
    expect((await store.cutoverStatus(BUILD)).unpublished).toBe(true);
  });
});

describe("media rebuild only while nothing deletes media, one call at a time", () => {
  const lease = (
    store: StoreStub,
    holder: string,
    authority: Parameters<StoreStub["mediaRebuildLease"]>[1]["authority"],
  ) => store.mediaRebuildLease(BUILD, { authority, holder });
  it("is refused in a writable Store and under the env maintenance alone; a dry run runs anywhere", async () => {
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    const row = await addRow(h.store);
    const refused = await h.post(adminClaims(), "/admin/media/rebuild");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "rebuild-needs-readonly" });
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('published', ?)",
        JSON.stringify({ at: NOW }),
      );
    });
    expect((await h.post(adminClaims(), "/admin/media/rebuild")).status).toBe(409);
    // The env's maintenance has no start the Store records, so it is not enough.
    for (const mode of ["readonly", "full"]) {
      const held = adminHarness(h.store, team, { MAINTENANCE: mode }, undefined, () => new TestCodec());
      expect(await (await held.post(adminClaims(), "/admin/media/rebuild")).json()).toMatchObject({
        code: "rebuild-needs-readonly",
      });
    }
    expect(await files(row)).toEqual([false, false]);
    expect(await transforms(h.store)).toBe(0);
    expect((await h.post(adminClaims(), "/admin/media/rebuild", { dryRun: true })).status).toBe(200);
  });

  it("waits for maintenance to settle, and needs no wait after a verified import", async () => {
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    const row = await addRow(h.store);
    expect(await h.store.setMaintenance(BUILD, true)).toEqual({ maintenance: true });
    const settling = await h.post(adminClaims(), "/admin/media/rebuild");
    expect(settling.status).toBe(409);
    const body = await settling.json<{ code: string; readyAt: number }>();
    expect(body.code).toBe("rebuild-settling");
    expect(body.readyAt).toBeGreaterThan(Date.now() + REBUILD_SETTLE_MS - 60_000);
    // Entering maintenance again keeps when it began.
    await h.store.setMaintenance(BUILD, true);
    expect(await (await h.post(adminClaims(), "/admin/media/rebuild")).json()).toMatchObject({ readyAt: body.readyAt });
    await settledMaintenance(h.store);
    expect((await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>()).counts.built).toBe(1);
    expect(await files(row)).toEqual([true, true]);
  });

  it("runs only where delete_media, the sweep and reconciliation cannot delete media", async () => {
    // The Store's own states: the sweep's first Store call is refused, before any R2 delete.
    for (const flag of ["unpublished", "maintenance"] as const) {
      const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
      await completeSetup(h.store);
      const doomed = await addRow(h.store, { files: true, gcAt: new Date(NOW - 1000).toISOString() });
      await runInDurableObject(h.store, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO kopje_state (name, value) VALUES (?, ?)",
          flag,
          JSON.stringify(flag === "maintenance" ? { mode: "readonly", at: NOW } : { at: NOW, import: "i" }),
        );
      });
      const deps = { build: () => BUILD, now: () => NOW, store: () => h.store };
      expect(await sweepMedia(env, deps)).toBe(0);
      await handleScheduled(env, deps);
      expect(await files(doomed)).toEqual([true, true]);
      const reason = toStoreUnavailable(await rejectionOf(h.store.dueOrphans(BUILD)))?.reason;
      expect(reason).toBe(flag);
    }
    // The env's maintenance: the cron does nothing (API writes answer 503 at the gate, test/gate.test.ts).
    const h = await setup({ env: { MAINTENANCE: "off" }, held: false });
    await completeSetup(h.store);
    const doomed = await addRow(h.store, { files: true, gcAt: new Date(NOW - 1000).toISOString() });
    for (const mode of ["readonly", "full"]) {
      await handleScheduled({ ...env, MAINTENANCE: mode } as Env, {
        build: () => BUILD,
        now: () => NOW,
        store: () => h.store,
      });
    }
    expect(await files(doomed)).toEqual([true, true]);
  });

  it("refuses a second call while one holds the lease, and releases it after a call", async () => {
    const h = await setup();
    await addRow(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    expect(await lease(h.store, "other-call", admin)).toMatchObject({ status: "ok" });
    const busy = await h.post(adminClaims(), "/admin/media/rebuild");
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "rebuild-busy" });
    expect(await transforms(h.store)).toBe(0);
    await h.store.mediaRebuildLease(BUILD, {
      authority: admin,
      holder: "other-call",
      release: true,
    });
    expect((await (await h.post(adminClaims(), "/admin/media/rebuild")).json<Step>()).counts.built).toBe(1);
    // Released: kept with its generation and an end of 0, so no late renewal of it takes it back.
    expect(await leaseRow(h.store)).toEqual([expect.objectContaining({ until: 0 })]);
    expect(await lease(h.store, "next", admin)).toMatchObject({ status: "ok" });
  });

  it("keeps the lease until it expires when a step is given up at the deadline", async () => {
    const h = await setup();
    const row = await addRow(h.store);
    let clock = NOW;
    const bucket = {
      head: async (key: string) => {
        const head = await env.MEDIA.head(key);
        // The call has run past its deadline by the time R2 answers.
        clock = NOW + REBUILD_LEASE_MS;
        return head;
      },
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      put: (key: string, value: Uint8Array, options?: R2PutOptions) => env.MEDIA.put(key, value, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
    } as unknown as R2Bucket;
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const step = await rebuildMedia(
      {
        build: BUILD,
        store: h.store,
        bucket,
        images: new TestCodec(),
        now: () => clock,
        authority: admin,
        monthlyTransforms: 100,
        holder: "given-up",
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ ok: true, stopped: "deadline", done: false });
    expect(await files(row)).toEqual([false, false]);
    const [kept] = await leaseRow(h.store);
    expect(kept?.holder).toBe("given-up");
    expect(kept?.until).toBeGreaterThan(Date.now());
    expect(await lease(h.store, "next-call", admin)).toMatchObject({ status: "busy" });
  });

  it("fences imports, resets and publication while the lease is held, and is refused during an import", async () => {
    const source = await migratedStore();
    await seedStore(source);
    const { text } = await dumpViaRpc(source);
    const target = await migratedStore();
    await runInDurableObject(target, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('unpublished', ?)",
        JSON.stringify({ at: NOW, import: "i" }),
      );
    });
    const empty = await migratedStore();
    await settledMaintenance(empty);
    for (const s of [empty, target]) {
      await ensureAdmin(s);
      expect(await lease(s, "leased", ACCESS)).toMatchObject({ status: "ok" });
    }
    // A live lease refuses the begin of an import, publication and a cutover reset.
    const begun = await beginImport(empty, text).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(begun)).toContain("rebuild-in-progress");
    expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: false, code: "rebuild-in-progress" });
    expect(await target.cutoverReset(BUILD, ACCESS)).toMatchObject({ ok: false, code: "rebuild-in-progress" });
    await target.mediaRebuildLease(BUILD, {
      authority: ACCESS,
      holder: "leased",
      release: true,
    });
    expect(await target.publish(BUILD, ACCESS)).toMatchObject({ ok: true });

    // The reverse: while an import runs, no lease is taken (and so no rebuild runs).
    const importing = await migratedStore();
    await beginImport(importing, text);
    const refused = await rejectionOf(lease(importing, "during-import", ACCESS));
    expect(toStoreUnavailable(refused)?.reason).toBe("import-in-progress");
  });

  it("refuses leaving maintenance and every media-deleting write while the lease is live, whatever the flags", async () => {
    const h = await setup();
    await completeSetup(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    expect(await lease(h.store, "leased", admin)).toMatchObject({ status: "ok" });
    expect(await h.store.setMaintenance(BUILD, false)).toMatchObject({ ok: false, code: "rebuild-in-progress" });
    const response = await h.post(adminClaims(), "/admin/maintenance", { on: false });
    expect(response.status).toBe(409);
    // Even with the maintenance flag gone (as by hand), the media-deleting writes stay refused.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM kopje_state WHERE name = 'maintenance'");
    });
    const credential = { tokenHash: "0".repeat(64), scope: ["write:media"], now: NOW } as const;
    for (const call of [
      () => h.store.expiredMedia(BUILD, { limit: 1 }),
      () => h.store.purgeMedia(BUILD, { ids: [] }),
      () => h.store.dueOrphans(BUILD),
      () => h.store.forgetOrphans(BUILD, { tokens: [] }),
      () => h.store.releasedThumbnails(BUILD, {}),
      () => h.store.forgetThumbnailFiles(BUILD, { ids: [] }),
      // PUT's media update may retire a thumbnail, whose sweep deletes its files (#1828 PR6 T3d).
      () => h.store.updateMedia(BUILD, { credential, id: "1", changes: { description: "x" } }),
    ]) {
      expect(toStoreUnavailable(await rejectionOf(call()))?.reason).toBe("rebuild-in-progress");
    }
    // Other writes are not affected by the lease.
    expect(await h.store.sweepOAuth(BUILD, { now: NOW })).toBeDefined();
    await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "leased", release: true });
    expect(await h.store.expiredMedia(BUILD, { limit: 1 })).toEqual([]);
    expect(() => admitFlags(flagsWith({ until: NOW + 1 }), "media-delete", NOW)).toThrow(/rebuild-in-progress/);
    expect(() => admitFlags(flagsWith({ until: NOW }), "media-delete", NOW)).not.toThrow();
    expect(() => admitFlags(flagsWith({ until: NOW + 1 }), "write", NOW)).not.toThrow();
  });

  it("keeps its lease by the Store clock, whatever time a request carries", async () => {
    const h = await setup();
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    // A request time far in the past or future is not read: the lease is the Store's.
    const skewed = { authority: admin, holder: "skewed", now: 0 } as Parameters<StoreStub["mediaRebuildLease"]>[1];
    expect(await h.store.mediaRebuildLease(BUILD, skewed)).toMatchObject({
      status: "ok",
      remainingMs: REBUILD_LEASE_MS,
    });
    const [held] = await leaseRow(h.store);
    expect(held?.until).toBeGreaterThan(Date.now() + REBUILD_LEASE_MS - 60_000);
    const late = { authority: admin, holder: "skewed", id: "1", limit: 100, now: Date.now() + 10 * REBUILD_LEASE_MS };
    expect(await h.store.chargeMediaRebuild(BUILD, late as Parameters<StoreStub["chargeMediaRebuild"]>[1])).toEqual({
      status: "ok",
    });
    expect(await lease(h.store, "other", admin)).toMatchObject({ status: "busy" });
  });

  it("awaits a pending write past the deadline, renewing the lease meanwhile, and keeps it if renewal fails", async () => {
    const h = await setup();
    const row = await addRow(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    let release = () => {};
    let paused: () => void = () => {};
    const reachedPut = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clock = NOW;
    // The lease answers the call gets, its heartbeat's renewals included, so the test waits for them rather than for
    // a fixed time.
    const answers: string[] = [];
    const store = new Proxy(h.store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildLease"
          ? async (...args: Parameters<StoreStub["mediaRebuildLease"]>) => {
              const answer = await target.mediaRebuildLease(...args);
              answers.push(answer.status);
              return answer;
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const bucket = {
      head: (key: string) => env.MEDIA.head(key),
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        if (key.endsWith("/full")) {
          paused();
          await gate;
        }
        return env.MEDIA.put(key, value, options);
      },
    } as unknown as R2Bucket;
    const running = rebuildMedia(
      {
        build: BUILD,
        store,
        bucket,
        images: new TestCodec(),
        now: () => clock,
        authority: admin,
        monthlyTransforms: 100,
        holder: "writer",
        heartbeatMs: 10,
      },
      { after: null, dryRun: false },
    );
    await reachedPut;
    // The call is far past its deadline; the write is still awaited and the lease renewed.
    clock = NOW + 10 * REBUILD_LEASE_MS;
    const before = (await leaseRow(h.store))[0]?.until ?? 0;
    await vi.waitFor(async () => expect((await leaseRow(h.store))[0]?.until).toBeGreaterThan(before));
    expect(await lease(h.store, "other", admin)).toMatchObject({ status: "busy" });
    // The lease is taken from it (as if it had expired): renewal fails while the write is pending.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE kopje_state SET value = ? WHERE name = 'media_rebuild_lease'",
        JSON.stringify({ holder: "other", until: Date.now() + REBUILD_LEASE_MS }),
      );
    });
    // A renewal after the takeover is refused, so the call knows it lost the lease before the write settles.
    const taken = answers.length;
    await vi.waitFor(() => expect(answers.slice(taken)).toContain("lost"));
    release();
    const step = await running;
    expect(step).toMatchObject({ ok: true, stopped: "lease-overrun", done: false });
    // The write already started landed; none started after the lease was lost.
    expect(await files(row)).toEqual([true, false]);
    // Not released: the other holder keeps it.
    expect((await leaseRow(h.store))[0]?.holder).toBe("other");
  });

  it("answers a release of an earlier generation as released, and leaves the live one as it is", async () => {
    const h = await setup();
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const first = await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" });
    expect(first).toMatchObject({ status: "ok", generation: 1 });
    // That lease ends, and the same holder takes the next generation.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE kopje_state SET value = json_set(value, '$.until', 1) WHERE name = 'media_rebuild_lease'",
      );
    });
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h" })).toMatchObject({ generation: 2 });
    expect(
      await h.store.mediaRebuildLease(BUILD, { authority: admin, holder: "h", generation: 1, release: true }),
    ).toEqual({ status: "released" });
    expect(await leaseRow(h.store)).toEqual([expect.objectContaining({ holder: "h", generation: 2 })]);
    expect((await leaseRow(h.store))[0]!.until).toBeGreaterThan(Date.now());
  });

  // The store, with each lease call after the take held at `hold(n)` (n counts them from 1) before it reaches the Store.
  function holding(store: StoreStub, hold: (n: number) => Promise<void> | null) {
    let calls = 0;
    return new Proxy(store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildLease"
          ? async (...args: Parameters<StoreStub["mediaRebuildLease"]>) => {
              const n = calls++;
              const held = n === 0 ? null : hold(n);
              if (held !== null) {
                await held;
              }
              return target.mediaRebuildLease(...args);
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
  }

  it("keeps renewing under an image write while its first heartbeat hangs, so no other call takes the lease", async () => {
    const h = await setup();
    const row = await addRow(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const gate = deferred();
    let writing = false;
    let hung: number | null = null;
    // The first lease call while the full's put is pending (its first heartbeat) never reaches the Store.
    const store = holding(h.store, (n) => {
      if (writing && hung === null) {
        hung = n;
        return new Promise<void>(() => {});
      }
      return null;
    });
    const bucket = {
      head: (key: string) => env.MEDIA.head(key),
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        if (key.endsWith("/full")) {
          writing = true;
          await gate.promise;
        }
        return env.MEDIA.put(key, value, options);
      },
    } as unknown as R2Bucket;
    const running = rebuildMedia(
      {
        build: BUILD,
        store,
        bucket,
        images: new TestCodec(),
        now: () => Date.now(),
        authority: admin,
        monthlyTransforms: 100,
        holder: "writer",
        heartbeatMs: 10,
        heartbeatStallMs: 1_000,
      },
      { after: null, dryRun: false },
    );
    await vi.waitFor(() => expect(hung).not.toBeNull());
    // The lease nears its end while the first heartbeat hangs: the later ones renew it.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE kopje_state SET value = json_set(value, '$.until', ?) WHERE name = 'media_rebuild_lease'",
        Date.now() + 100,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await lease(h.store, "other", admin)).toMatchObject({ status: "busy" });
    gate.resolve();
    expect(await running).toMatchObject({ ok: true, stopped: null, counts: { built: 1 } });
    expect(await files(row)).toEqual([true, true]);
  });

  it("starts no write on a confirmation whose reply arrives once the lease may have ended", async () => {
    const h = await setup();
    const row = await addRow(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const order: string[] = [];
    const recording = (who: string) =>
      ({
        head: (key: string) => env.MEDIA.head(key),
        get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
        delete: (keys: string | string[]) => env.MEDIA.delete(keys),
        put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
          order.push(`${who} ${key.slice(key.lastIndexOf("/") + 1)}`);
          return env.MEDIA.put(key, value, options);
        },
      }) as unknown as R2Bucket;
    // A's third lease call, the confirmation of its first put (after the take and the row's renewal), is answered by
    // the Store at once; the reply reaches A only once `deliver` opens.
    const delivered = deferred();
    let held = false;
    let calls = 0;
    const store = new Proxy(h.store, {
      get: (target, property, receiver) =>
        property === "mediaRebuildLease"
          ? async (...args: Parameters<StoreStub["mediaRebuildLease"]>) => {
              const answer = await target.mediaRebuildLease(...args);
              if (++calls === 3) {
                held = true;
                await delivered.promise;
              }
              return answer;
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    let clock = Date.now();
    const a = rebuildMedia(
      {
        build: BUILD,
        store,
        bucket: recording("A"),
        images: new TestCodec(),
        now: () => clock,
        authority: admin,
        monthlyTransforms: 100,
        holder: "A",
      },
      { after: null, dryRun: false },
    );
    await vi.waitFor(() => expect(held).toBe(true));
    // A's lease ends (its clock and the Store's), and B takes the next generation and rebuilds the row.
    clock += REBUILD_LEASE_MS + 1;
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE kopje_state SET value = json_set(value, '$.until', 1) WHERE name = 'media_rebuild_lease'",
      );
    });
    await env.MEDIA.delete([`files/${row.token}/full`, `files/${row.token}/small`]);
    const b = await rebuildMedia(
      {
        build: BUILD,
        store: h.store,
        bucket: recording("B"),
        images: new TestCodec(),
        now: () => Date.now(),
        authority: admin,
        monthlyTransforms: 100,
        holder: "B",
      },
      { after: null, dryRun: false },
    );
    expect(b).toMatchObject({ ok: true, counts: { built: 1 } });
    delivered.resolve();
    expect(await a).toMatchObject({ ok: true, stopped: "lease-overrun" });
    expect(order).toEqual(["B full", "B small"]);
  });

  it("a heartbeat that reaches the Store after the call released the lease does not take it back", async () => {
    const h = await setup();
    await addRow(h.store);
    const admin = { ...ACCESS, teamDomain: team.teamDomain };
    const late = deferred();
    let writing = false;
    let delayed = false;
    let arrived = false;
    // The first heartbeat during the full's put is delayed past the call's end, then sent.
    const store = holding(h.store, () => {
      if (writing && !delayed) {
        delayed = true;
        return late.promise.then(() => {
          arrived = true;
        });
      }
      return null;
    });
    const bucket = {
      head: (key: string) => env.MEDIA.head(key),
      get: (key: string, options?: R2GetOptions) => env.MEDIA.get(key, options),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
      put: async (key: string, value: Uint8Array, options?: R2PutOptions) => {
        if (key.endsWith("/full")) {
          writing = true;
          await vi.waitFor(() => expect(delayed).toBe(true));
          writing = false;
        }
        return env.MEDIA.put(key, value, options);
      },
    } as unknown as R2Bucket;
    const step = await rebuildMedia(
      {
        build: BUILD,
        store,
        bucket,
        images: new TestCodec(),
        now: () => Date.now(),
        authority: admin,
        monthlyTransforms: 100,
        holder: "writer",
        heartbeatMs: 5,
        heartbeatStallMs: 50,
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ ok: true, counts: { built: 1 } });
    expect(await leaseRow(h.store)).toEqual([expect.objectContaining({ holder: "writer", until: 0 })]);
    late.resolve();
    await vi.waitFor(() => expect(arrived).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The late renewal named a released generation: nothing changed, and another call takes the lease.
    expect(await leaseRow(h.store)).toEqual([expect.objectContaining({ holder: "writer", until: 0 })]);
    expect(await lease(h.store, "other", admin)).toMatchObject({ status: "ok" });
  });
});

describe("media rebuild and PITR", () => {
  const admin = () => ({ ...ACCESS, teamDomain: team.teamDomain });

  it("refuses a restore while the lease is live, and the lease while a restore is being scheduled", async () => {
    const h = await setup();
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "leased" })).toMatchObject({
      status: "ok",
    });
    const refused = await rejectionOf(h.store.pitrToBookmark(BUILD, "any-bookmark"));
    expect(toStoreUnavailable(refused)?.reason).toBe("rebuild-in-progress");
    await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "leased", release: true });

    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('pitr_restoring', ?)",
        JSON.stringify({ at: Date.now() }),
      );
    });
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "next" })).toEqual({
      status: "restoring",
    });
    expect(await (await h.post(adminClaims(), "/admin/media/rebuild")).json()).toMatchObject({ code: "rebuild-busy" });
  });

  it("counts the settle period again from a restore, also for an unpublished import", async () => {
    const h = await setup();
    // The restore is recorded outside the database before it is scheduled; Miniflare then fails to restore, which
    // leaves the record (conservatively) and removes the restoring mark.
    const failed = await rejectionOf(h.store.pitrToBookmark(BUILD, "any-bookmark"));
    expect(failed).toBeInstanceOf(Error);
    const marker = await env.MEDIA.get(`kopje/pitr-restored/${h.store.id.toString()}`);
    const restoredAt = (JSON.parse((await marker?.text()) ?? "{}") as { at: number }).at;
    expect(restoredAt).toBeGreaterThan(Date.now() - 60_000);
    // The maintenance began long before: it settles again from the restore.
    const settling = (await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "a" })) as {
      status: string;
      readyAt: number;
    };
    expect(settling).toEqual({ status: "settling", readyAt: restoredAt + REBUILD_SETTLE_MS });
    // An unpublished flag from before the restore is not ready either.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM kopje_state WHERE name = 'maintenance'");
      state.storage.sql.exec(
        "INSERT INTO kopje_state (name, value) VALUES ('unpublished', ?)",
        JSON.stringify({ at: restoredAt - 1000, import: "i" }),
      );
    });
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "a" })).toEqual({
      status: "needs-readonly",
    });
    // One verified after the restore is.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE kopje_state SET value = ? WHERE name = 'unpublished'",
        JSON.stringify({ at: Date.now(), import: "j" }),
      );
    });
    expect(await h.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "a" })).toMatchObject({ status: "ok" });
    // Another Store is unaffected by this one's restore.
    const other = await setup();
    expect(await other.store.mediaRebuildLease(BUILD, { authority: admin(), holder: "b" })).toMatchObject({
      status: "ok",
    });
  });
});

function gate(overrides: Partial<OperatorGate>): OperatorGate {
  return { maintenance: false, import: false, unpublished: false, dump: null, media_rebuild_lease: null, ...overrides };
}

function flagsWith(lease: { until: number }): OperatorGate {
  return gate({ media_rebuild_lease: lease });
}

// A custom emoji's image (migration 0055_local_custom_emojis) is held to the emoji limits of platform/emoji-image.ts
// by the rebuild too, each a per-row problem that retains the row and writes nothing (mastodon/media-rebuild.ts).
describe("media rebuild of custom emoji images", () => {
  async function emojiRow(store: StoreStub, options: Parameters<typeof addRow>[1] & { meta?: string } = {}) {
    const row = await addRow(store, options);
    await runInDurableObject(store, (_instance, state) => {
      if (options.meta !== undefined) {
        state.storage.sql.exec("UPDATE media_attachments SET meta = ? WHERE id = ?", options.meta, row.id);
      }
      state.storage.sql.exec(
        "INSERT INTO custom_emojis (id, shortcode, created_at) VALUES (?, ?, '2026-10-12T00:00:00.000Z')",
        row.id,
        `e${row.id}`,
      );
    });
    return row;
  }

  const rebuild = async (h: Awaited<ReturnType<typeof setup>>, body: unknown = {}) =>
    await (await h.post(adminClaims(), "/admin/media/rebuild", body)).json<Step>();

  it("builds the files of emoji restored from their originals, as an originals-only restore leaves them", async () => {
    const h = await setup();
    const emoji = await emojiRow(h.store, { original: await pngOf(32, 32) });
    const step = await rebuild(h);
    expect(step).toMatchObject({ done: true, problems: [] });
    expect(step.counts).toMatchObject({ built: 1 });
    // No RGBA (an emoji has no blurhash), and the emoji's two transformations.
    expect(h.codec.outputs.map((call) => call.options.format)).toEqual(["image/png", "image/png"]);
    expect(await transforms(h.store)).toBe(2);
    expect(await blurhashOf(h.store, emoji.id)).toBeNull();
    expect(await files(emoji)).toEqual([true, true]);
    expect(await meta(h.store, emoji.id)).toEqual({
      original: { width: 32, height: 32 },
      small: { width: 32, height: 32 },
    });
  });

  it("reports a rebuilt full image of 262,144 bytes before writing, keeping the charge, and builds an ordinary row", async () => {
    const codec = new TestCodec();
    codec.encodeResult = pngOfBytes(EMOJI_IMAGE_LIMIT, 1024, 60);
    const h = await setup({ codec });
    const emoji = await emojiRow(h.store);
    const ordinary = await addRow(h.store);
    const step = await rebuild(h);
    expect(step.problems).toEqual([{ id: emoji.id, outcome: "failed", detail: "emoji-output" }]);
    expect(step.counts).toMatchObject({ built: 1, failed: 1 });
    expect(await files(emoji)).toEqual([false, false]);
    expect(await files(ordinary)).toEqual([true, true]);
    // The emoji's two and the ordinary row's three.
    expect(await transforms(h.store)).toBe(5);
    expect(await sql(h.store, "SELECT id FROM custom_emojis WHERE id = ?", emoji.id)).toEqual([{ id: emoji.id }]);
  });

  it("reports existing files past their limits, full or small, deleting nothing, and rebuilds a missing variant", async () => {
    const h = await setup();
    const big = await emojiRow(h.store, { files: true });
    await env.MEDIA.put(`files/${big.token}/full`, new Uint8Array(EMOJI_IMAGE_LIMIT));
    const bigPreview = await emojiRow(h.store, { files: true });
    await env.MEDIA.put(`files/${bigPreview.token}/small`, new Uint8Array(EMOJI_PREVIEW_LIMIT + 1));
    const atPreview = await emojiRow(h.store, { files: true });
    await env.MEDIA.put(`files/${atPreview.token}/small`, new Uint8Array(EMOJI_PREVIEW_LIMIT));
    const noFull = await emojiRow(h.store, { files: true });
    await env.MEDIA.delete(`files/${noFull.token}/full`);
    const noSmall = await emojiRow(h.store, { files: true });
    await env.MEDIA.delete(`files/${noSmall.token}/small`);
    const step = await rebuild(h);
    expect(step.problems).toEqual([
      { id: big.id, outcome: "failed", detail: "emoji-too-large" },
      { id: bigPreview.id, outcome: "failed", detail: "emoji-too-large" },
    ]);
    expect(step.counts).toMatchObject({ built: 2, "skipped-existing": 1 });
    expect(await files(big)).toEqual([true, true]);
    expect(await files(noFull)).toEqual([true, true]);
    expect(await files(noSmall)).toEqual([true, true]);
  });

  it("reports an existing image whose actual edges pass 1,024 though its recorded ones do not, charging nothing", async () => {
    const h = await setup();
    const actual = await pngOf(2048, 2048);
    expect(actual.length).toBeLessThan(EMOJI_IMAGE_LIMIT);
    const emoji = await emojiRow(h.store, { files: true, meta: '{"original":{"width":64,"height":64}}' });
    await env.MEDIA.put(`files/${emoji.token}/full`, actual);
    const step = await rebuild(h);
    expect(step.problems).toEqual([{ id: emoji.id, outcome: "failed", detail: "emoji-actual" }]);
    expect(h.codec.encodeCalls).toEqual([]);
    expect(await transforms(h.store)).toBe(0);
    expect((await env.MEDIA.get(`files/${emoji.token}/full`))?.size).toBe(actual.length);
  });

  it("reports an original past the emoji input limits before charging; a corrupt first row does not stop the page", async () => {
    const h = await setup();
    const corrupt = await emojiRow(h.store, {
      original: new Uint8Array([...bytes(PNG_PLAIN).subarray(0, 16), 1, 2, 3]),
    });
    const large = await emojiRow(h.store, { original: pngOfBytes(EMOJI_IMAGE_LIMIT, 1024, 60) });
    const wide = await emojiRow(h.store, { original: await pngOf(1025, 1) });
    const jpeg = await emojiRow(h.store, { contentType: "image/webp", original: bytes(JPEG_ORIENTATION_6) });
    const good = await emojiRow(h.store);
    const step = await rebuild(h);
    expect(step.problems).toEqual(
      [corrupt, large, wide, jpeg].map((row) => ({ id: row.id, outcome: "failed", detail: "emoji-input" })),
    );
    expect(step).toMatchObject({ done: true, next: expect.any(String) });
    expect(step.counts).toMatchObject({ built: 1, failed: 4 });
    expect(await files(good)).toEqual([true, true]);
    expect(await transforms(h.store)).toBe(2);
    expect(await sql(h.store, "SELECT count(*) AS n FROM custom_emojis")).toEqual([{ n: 5 }]);
    expect((await cli(h, ["media-rebuild"])).code).toBe(3);
  });

  it("dry-runs emoji rows by size and signature only: no Images call, charge, write or lease", async () => {
    const h = await setup();
    await emojiRow(h.store);
    await emojiRow(h.store, { original: pngOfBytes(EMOJI_IMAGE_LIMIT, 1024, 60) });
    const existing = await emojiRow(h.store, { files: true });
    await env.MEDIA.put(`files/${existing.token}/full`, new Uint8Array(EMOJI_IMAGE_LIMIT));
    const step = await rebuild(h, { dryRun: true });
    expect(step.counts).toMatchObject({ "would-build": 1, failed: 2 });
    expect(h.codec.calls).toBe(0);
    expect(await transforms(h.store)).toBe(0);
    expect(await sql(h.store, "SELECT name FROM kopje_state WHERE name = 'media_rebuild_lease'")).toEqual([]);
  });
});
