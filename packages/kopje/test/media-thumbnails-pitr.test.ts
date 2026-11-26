import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REBUILD_SETTLE_MS } from "../src/domain/media-rebuild";
import { rebuildMedia } from "../src/mastodon/media-rebuild";
import { fileKey, originalKey } from "../src/platform/media-files";
import { PITR_WINDOW_MS } from "../src/platform/restore-marker";
import { adminTeam, setTeamAccess } from "./access-helpers";
import { sql } from "./api-helpers";
import { JPEG_ORIENTATION_6 } from "./fixtures/images";
import { BUILD } from "./helpers";
import { bytes, TestCodec } from "./media-helpers";
import { avWorld, type AvWorld, bookmark, clock, completed, restore, type Up } from "./media-processing-helpers";
import { imageChild, sweep, updateThumbnail } from "./media-thumbnail-helpers";
import { ACCESS } from "./ops-helpers";

// D26, G6-4p (#1828 PR6 T13p): a replaced thumbnail keeps its original for the point-in-time window, so a restore to a
// bookmark at which it was current gets it back: its original byte for byte, its served files (released by the sweep)
// remade by media-rebuild, and the restored parent shows it again. The restore is the Store's tables put back as the
// bookmark held them and the marker written (media-processing-helpers.ts bookmark, restore).

afterEach(() => {
  vi.useRealTimers();
});

// An image upload's original and served files in R2, the original a real image media-rebuild can decode.
async function stored(up: Up, original: Uint8Array): Promise<void> {
  await env.MEDIA.put(originalKey(up.id), original);
  for (const variant of ["full", "small"] as const) {
    await env.MEDIA.put(fileKey(up.token, variant), new Uint8Array([1, 2, 3]));
  }
}

async function served(w: AvWorld, up: Up): Promise<number> {
  return (await w.h.request(`/media/${up.token}/small.webp`)).status;
}

// The parent as its owner is shown it.
async function shown(w: AvWorld, id: string) {
  const answer = await w.store.getMedia(BUILD, { credential: w.alice, id });
  return answer.status === "ok" ? answer.value : answer;
}

describe("a point-in-time restore of a replaced thumbnail (T13p)", () => {
  it("keeps A's original through a replacement and a sweep, and media-rebuild remakes its preview", async () => {
    const w = await avWorld();
    const parent = await completed(w);
    const a = await imageChild(w);
    const original = bytes(JPEG_ORIENTATION_6);
    await stored(a, original);
    expect(await updateThumbnail(w, parent, a)).toMatchObject({ status: "ok" });
    const taken = await bookmark(w.store);
    const bookmarkAt = Date.now();

    // B replaces A, and the sweep (its release included) runs within the window, a minute after the bookmark (the
    // parent stays unattached, which its owner sees for DETACHED_GRACE_MS).
    const b = await imageChild(w);
    await stored(b, original);
    expect(await updateThumbnail(w, parent, b)).toMatchObject({ status: "ok" });
    clock(bookmarkAt + 60_000);
    await sweep(w.store);
    expect(await served(w, a)).toBe(404);

    // The restore, within PITR_WINDOW_MS of the bookmark.
    expect(Date.now() - bookmarkAt).toBeLessThan(PITR_WINDOW_MS);
    await restore(w.store, taken, Date.now());
    const kept = await env.MEDIA.get(originalKey(a.id));
    expect(kept).not.toBeNull();
    expect(new Uint8Array(await kept!.arrayBuffer())).toEqual(original);
    expect(await served(w, a)).toBe(404);

    // media-rebuild, in the Store's settled maintenance, once the restore has settled.
    clock(Date.now() + REBUILD_SETTLE_MS + 1000);
    const team = await adminTeam();
    await setTeamAccess(w.store, team);
    await sql(
      w.store,
      "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('maintenance', ?)",
      JSON.stringify({ mode: "readonly", at: 0 }),
    );
    const step = await rebuildMedia(
      {
        build: BUILD,
        store: w.store,
        bucket: env.MEDIA,
        images: new TestCodec(),
        now: () => Date.now(),
        authority: { ...ACCESS, teamDomain: team.teamDomain },
        monthlyTransforms: 100,
        monthlyUploads: 10,
        stills: null,
      },
      { after: null, dryRun: false },
    );
    expect(step).toMatchObject({ done: true });
    expect(await served(w, a)).toBe(200);
    const [row] = await sql<{ meta: string; blurhash: string | null; preview_url: string }>(
      w.store,
      "SELECT meta, blurhash, preview_url FROM media_attachments WHERE id = ?",
      a.id,
    );
    const small = (JSON.parse(row!.meta) as { small: { width: number; height: number } }).small;
    expect(await shown(w, parent.id)).toMatchObject({
      status: "ok",
      media: {
        preview_url: row!.preview_url,
        blurhash: row!.blurhash,
        meta: { small: { width: small.width, height: small.height } },
      },
    });
    expect(row!.preview_url).toContain(a.token);
  });
});
