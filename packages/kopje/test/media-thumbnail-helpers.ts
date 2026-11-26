import { env } from "cloudflare:workers";

import { sweepMedia } from "../src/mastodon/media";
import { fileKey, originalKey } from "../src/platform/media-files";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { BUILD } from "./helpers";
import { type AvWorld, fileToken, imageCompletion, type Up } from "./media-processing-helpers";

// Custom thumbnails of video and audio uploads (#1828 PR6, domain/media-thumbnails.ts), as the Store's operations make
// and link them: a thumbnail is an image upload (reserveMedia, completeMedia), linked by updateOwnerMedia or S3.

export const BUDGETS = { instance: 1_000_000, account: 1_000_000 };
// A thumbnail's preview geometry and blurhash, unlike the video still's (media-processing-helpers.ts VIDEO).
export const THUMB_SMALL = { width: 320, height: 240 };
export const THUMB_BLURHASH = "L6PZfSi_.AyE_3t7t7R**0o#DgR4";

// A completed image upload of `who`'s, reserved and completed at the Store's current time.
export async function imageChild(w: AvWorld, who: "alice" | "bob" = "alice", blurhash: string | null = THUMB_BLURHASH) {
  const credential = who === "alice" ? w.alice : w.bob;
  const token = fileToken();
  const reserved = await w.store.reserveMedia(BUILD, {
    credential,
    token,
    monthlyTransforms: BUDGETS,
    now: Date.now(),
  });
  if (reserved.status !== "ok" || reserved.value.status !== "ok") {
    throw new Error(`not reserved: ${JSON.stringify(reserved)}`);
  }
  const { id } = reserved.value;
  const done = await w.store.completeMedia(BUILD, {
    ...imageCompletion(w, id),
    credential,
    original: { width: 1024, height: 768 },
    small: THUMB_SMALL,
    blurhash,
  });
  if (done.status !== "ok" || done.value === null) {
    throw new Error(`not completed: ${JSON.stringify(done)}`);
  }
  return { id, token };
}

// PUT /api/v1/media/:id's Store call with a thumbnail (or null), by `who`.
export async function updateThumbnail(
  w: AvWorld,
  parent: Up,
  thumbnail: Up | null,
  who: "alice" | "bob" = "alice",
  changes: { description?: string } = {},
) {
  const answer = await w.store.updateMedia(BUILD, {
    credential: who === "alice" ? w.alice : w.bob,
    id: parent.id,
    changes,
    thumbnail: thumbnail === null ? null : { id: thumbnail.id, token: thumbnail.token },
  });
  if (answer.status !== "ok") {
    throw new Error(`not authorized: ${JSON.stringify(answer)}`);
  }
  return answer.value;
}

export type ChildRow = {
  thumbnail_of: string | null;
  gc_at: string | null;
  url: string;
  preview_url: string | null;
  processed: number;
};

export async function childRow(store: StoreStub, id: string): Promise<ChildRow | undefined> {
  const [row] = await sql<ChildRow>(
    store,
    "SELECT thumbnail_of, gc_at, url, preview_url, processed FROM media_attachments WHERE id = ?",
    id,
  );
  return row;
}

// The R2 objects of an upload: its original and served files.
export async function putObjects(up: Up): Promise<void> {
  for (const key of [originalKey(up.id), fileKey(up.token, "full"), fileKey(up.token, "small")]) {
    await env.MEDIA.put(key, new Uint8Array([1, 2, 3]));
  }
}

// Which of an upload's original and served files R2 holds.
export async function objects(up: Up): Promise<{ original: boolean; full: boolean; small: boolean }> {
  const has = async (key: string) => (await env.MEDIA.head(key)) !== null;
  return {
    original: await has(originalKey(up.id)),
    full: await has(fileKey(up.token, "full")),
    small: await has(fileKey(up.token, "small")),
  };
}

// One sweep run (mastodon/media.ts sweepMedia: the release, then one batch).
export function sweep(store: StoreStub): Promise<number> {
  return sweepMedia(env, { build: () => BUILD, store: () => store });
}
