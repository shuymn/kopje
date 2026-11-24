import { env } from "cloudflare:workers";
import { vi } from "vitest";

import type { AvFacts, Failure } from "../src/domain/media-processing";
import { restoreMarkerKey } from "../src/platform/media-files";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { community } from "./status-helpers";

// The world of the media processing tests (domain/media-processing.ts): a Store with alice and bob, the Store's clock
// faked (Date in the Durable Object, which the kernel reads at each call), and the upload operations called through
// the Store's own methods, as the route and the processor will call them.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const T0 = NOW;

export const ACTIVE = { binding: true, budget: 10, build: BUILD };

export type AvWorld = Awaited<ReturnType<typeof avWorld>>;

// Sets the Store's clock (and this isolate's Date) to `ms`.
export function clock(ms: number): void {
  vi.setSystemTime(ms);
}

export async function avWorld() {
  const h = await community(["alice", "bob"], "read write");
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(T0);
  const credentialOf = async (name: "alice" | "bob") => ({
    tokenHash: await sha256Hex(h.users[name].token),
    scope: "write:media" as const,
    now: NOW,
  });
  const alice = await credentialOf("alice");
  const bob = await credentialOf("bob");
  await passProbe(h.store);
  return { h, store: h.store, alice, bob };
}

let tokens = 0;

// A file token of the server's form (FILE_TOKEN).
export function fileToken(): string {
  return `tok${String(++tokens).padStart(4, "0")}${"x".repeat(36)}${crypto.randomUUID().slice(0, 8)}`;
}

export type Up = { id: string; token: string };

// A reservation of alice's (reserveMedia) at the Store's time `at`, which becomes its created_at.
export async function reserve(w: AvWorld, at = Date.now(), who: "alice" | "bob" = "alice"): Promise<Up> {
  clock(at);
  const token = fileToken();
  const reserved = await w.store.reserveMedia(BUILD, {
    credential: who === "alice" ? w.alice : w.bob,
    token,
    monthlyTransforms: { instance: 1_000_000, account: 1_000_000 },
    avCandidate: { build: BUILD },
    now: at,
  });
  if (reserved.status !== "ok" || reserved.value.status !== "ok") {
    throw new Error(`not reserved: ${JSON.stringify(reserved)}`);
  }
  return { id: reserved.value.id, token };
}

// A passed probe of the normalize profile for `build` (the claim and its result through the Store).
export async function passProbe(store: StoreStub, build = BUILD, imagesVerified = true): Promise<void> {
  const claimed = await store.claimMediaProbe(BUILD, { profile: "normalize@standard-4", build, due: false });
  if (claimed.status !== "claimed") {
    throw new Error(`not claimed: ${claimed.status}`);
  }
  await store.recordMediaProbeResult(BUILD, {
    profile: "normalize@standard-4",
    claim: claimed.claim,
    outcome: "pass",
    imagesVerified,
    imageTag: null,
  });
}

export const VIDEO: AvFacts = {
  kind: "video",
  contentType: "video/mp4",
  bytes: 1_000_000,
  duration: 8,
  bitrate: 1_000_000,
  width: 1280,
  height: 720,
  frameRate: "30/1",
  preview: { width: 640, height: 360, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
};

export const AUDIO: AvFacts = {
  kind: "audio",
  contentType: "audio/mpeg",
  bytes: 320_000,
  duration: 10,
  bitrate: 256_000,
  preview: null,
};

export type Staged = Up & { stagedAt: number; v1: boolean };
export type Queued = Staged & { teardownId: string };
export type Started = Queued & { startId: string; invocation: string };

// The phases an upload is built to through the Store's operations, at fixed Store times: reserved at T0, staged at
// T0 + 1 s (v2: staged_until T0 + 1 s + STAGING_MS; v1 with V1_LEFT: reply_by T0 + 121 s, staged_until T0 + 119 s),
// queued at T0 + 2 s (v2: deadline_at T0 + 2 s + V2_PROCESS_MS; v1: T0 + 119 s), started at T0 + 3 s, completed or
// failed at T0 + 4 s.
export const V1_LEFT = 120 * SECOND;

export async function staged(w: AvWorld, options: { v1?: boolean; at?: number; up?: Up } = {}): Promise<Staged> {
  const up = options.up ?? (await reserve(w, T0));
  clock(options.at ?? T0 + SECOND);
  const taken = await w.store.takeAvSlot(BUILD, {
    id: up.id,
    token: up.token,
    kind: "video",
    v1Left: options.v1 === true ? V1_LEFT : null,
    activation: ACTIVE,
  });
  if (taken.status !== "taken") {
    throw new Error(`not taken: ${taken.status}`);
  }
  return { ...up, stagedAt: taken.stagedAt, v1: options.v1 === true };
}

export const TEXT = { description: "a clip", focus: { x: 0.25, y: -0.5 } };

// S3 for the upload `up` under the staging identity `stagedAt`: 2 MB of input and TEXT, on the active path.
export function queue(w: AvWorld, up: Up, stagedAt: number) {
  return w.store.queueNormalize(BUILD, {
    id: up.id,
    token: up.token,
    stagedAt,
    bytes: 2_000_000,
    text: TEXT,
    activation: ACTIVE,
  });
}

// completeMedia's input for alice's upload `id`: a 10 × 10 WebP, no description or focus.
export function imageCompletion(w: AvWorld, id: string) {
  return {
    credential: w.alice,
    id,
    contentType: "image/webp",
    original: { width: 10, height: 10 },
    small: { width: 10, height: 10 },
    animated: false,
    blurhash: null,
    description: "",
    focus: undefined,
  };
}

export async function queued(w: AvWorld, options: { v1?: boolean; up?: Up } = {}): Promise<Queued> {
  const up = await staged(w, options);
  clock(T0 + 2 * SECOND);
  const answer = await queue(w, up, up.stagedAt);
  if (answer.status !== "queued") {
    throw new Error(`not queued: ${JSON.stringify(answer)}`);
  }
  return { ...up, teardownId: answer.teardownId };
}

export async function started(w: AvWorld, options: { v1?: boolean; up?: Up } = {}): Promise<Started> {
  const up = await queued(w, options);
  clock(T0 + 3 * SECOND);
  const invocation = `inv-${crypto.randomUUID()}`;
  const answer = await w.store.startNormalize(BUILD, { id: up.id, token: up.token, invocation });
  if (answer.status !== "started") {
    throw new Error(`not started: ${JSON.stringify(answer)}`);
  }
  return { ...up, startId: answer.startId, invocation };
}

export async function completed(w: AvWorld, options: { v1?: boolean; facts?: AvFacts } = {}): Promise<Started> {
  const up = await started(w, options);
  clock(T0 + 4 * SECOND);
  const done = await w.store.completeAvUpload(BUILD, {
    id: up.id,
    token: up.token,
    startId: up.startId,
    facts: options.facts ?? VIDEO,
  });
  if (done.status !== "done") {
    throw new Error(`not completed: ${done.status}`);
  }
  return up;
}

export async function failed(w: AvWorld, cause: Failure, options: { v1?: boolean } = {}): Promise<Started> {
  const up = await started(w, options);
  if (cause === "deadline" || cause === "restored") {
    await sql(w.store, "UPDATE media_processing SET state = 'failed', failure = ? WHERE media_id = ?", cause, up.id);
    return up;
  }
  clock(T0 + 4 * SECOND);
  const answer = await w.store.failNormalize(BUILD, { id: up.id, startId: up.startId, cause });
  if (answer.status !== "recorded") {
    throw new Error(`not failed: ${answer.status}`);
  }
  return up;
}

// What the Store holds of an upload: its processing row, slot and attachment.
export type Held = {
  row: { state: string; failure: string | null; dispatched_at: number | null; deadline_at: number | null } | null;
  slot: { phase: string; held_until: number; teardown_id: string | null; granted_at: number | null } | null;
  att: { processed: number; url: string; gc_at: string | null; type: string } | null;
};

export async function held(store: StoreStub, id: string): Promise<Held> {
  const [row] = await sql<NonNullable<Held["row"]>>(
    store,
    "SELECT state, failure, dispatched_at, deadline_at FROM media_processing WHERE media_id = ?",
    id,
  );
  const [slot] = await sql<NonNullable<Held["slot"]>>(
    store,
    "SELECT phase, held_until, teardown_id, granted_at FROM media_av_slots WHERE media_id = ?",
    id,
  );
  const [att] = await sql<NonNullable<Held["att"]>>(
    store,
    "SELECT processed, url, gc_at, type FROM media_attachments WHERE id = ?",
    id,
  );
  return { row: row ?? null, slot: slot ?? null, att: att ?? null };
}

export async function charged(store: StoreStub, at = Date.now()): Promise<number> {
  const [row] = await sql<{ value: string }>(
    store,
    "SELECT value FROM kopje_state WHERE name = ?",
    `media_upload_jobs:${new Date(at).toISOString().slice(0, 7)}`,
  );
  return Number(row?.value ?? "0");
}

// The operator gates that refuse a write (store-flags.ts), set as their records.
export const GATES = {
  maintenance: JSON.stringify({ at: T0 }),
  dump: JSON.stringify({ leaseUntil: T0 + 100 * 24 * HOUR }),
  import: JSON.stringify({ id: "import-1" }),
  unpublished: JSON.stringify({ at: T0, import: "import-1" }),
} as const;

export async function gate(store: StoreStub, name: keyof typeof GATES, on: boolean): Promise<void> {
  if (on) {
    await sql(store, "INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, GATES[name]);
  } else {
    await sql(store, "DELETE FROM kopje_state WHERE name = ?", name);
  }
}

// A PITR bookmark of the tables a restore rewinds that these tests read, and the restore to it: the tables put back as
// they were and the restore marker written at the Store's time `at`, as pitrToBookmark records it.
type Bookmark = Record<string, Record<string, SqlStorageValue>[]>;
const REWOUND = ["media_av_slots", "media_processing", "media_attachments", "kopje_state"] as const;

export async function bookmark(store: StoreStub): Promise<Bookmark> {
  const taken: Bookmark = {};
  for (const table of REWOUND) {
    taken[table] = await sql(store, `SELECT * FROM ${table}`);
  }
  return taken;
}

export async function restore(store: StoreStub, taken: Bookmark, at: number): Promise<void> {
  for (const table of REWOUND) {
    await sql(store, `DELETE FROM ${table}`);
  }
  for (const table of REWOUND.toReversed()) {
    for (const row of taken[table] ?? []) {
      const columns = Object.keys(row);
      await sql(
        store,
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((c) => row[c] ?? null),
      );
    }
  }
  await env.MEDIA.put(restoreMarkerKey(store.id.toString()), JSON.stringify({ at }));
}

export async function forgetRestore(store: StoreStub): Promise<void> {
  await env.MEDIA.delete(restoreMarkerKey(store.id.toString()));
}
