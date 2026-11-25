import { afterEach, describe, expect, it, vi } from "vitest";

import { type MediaRow, presentMedia } from "../src/domain/status-presenter";
import { VIDEO_POSTER } from "../src/platform/brand-assets";
import { bearer, json } from "./api-helpers";
import { postAs } from "./av-posting-helpers";
import avMeta from "./fixtures/mastodon-4.7.5-av-meta.json";
import { avWorld, clock, completed, SECOND, T0, VIDEO_NO_STILL } from "./media-processing-helpers";

// A playable attachment's meta as REST::MediaAttachmentSerializer shows it (#1828 P16, status-presenter.ts
// playableFacts): a video's original with its frame rate as Mastodon's string, duration and bitrate, its small only with
// a still, an audio file's original with its duration and bitrate; an image's as before. And one attachment without a
// still shown alike wherever its owner sees it.

afterEach(() => {
  vi.useRealTimers();
});

const ORIGIN = "https://kopje.test";

function row(type: string, meta: unknown): MediaRow {
  return {
    id: "100000000000000001",
    type,
    url: `${ORIGIN}/media/${"a".repeat(43)}/full.mp4`,
    preview_url: null,
    description: "",
    meta: typeof meta === "string" ? meta : JSON.stringify(meta),
    focus_x: null,
    focus_y: 0,
    blurhash: null,
    remote: 0,
    cached: null,
    cached_preview: null,
  };
}

describe("a playable file's meta (P16)", () => {
  it('adds Mastodon\'s video facts to the original Kopje shows (its size and aspect as before): its frame rate as the string "30/1", duration, bitrate, and its small', () => {
    const { original, small } = avMeta.video.meta;
    const shown = presentMedia(row("video", avMeta.video.meta), ORIGIN);
    expect(shown.meta).toEqual({
      original: { ...original, size: `${original.width}x${original.height}`, aspect: original.width / original.height },
      small,
    });
  });

  it("shows Mastodon's audio meta: its duration and bitrate, no size", () => {
    expect(presentMedia(row("audio", avMeta.audio.meta), ORIGIN).meta).toEqual(avMeta.audio.meta);
  });

  it("leaves out a fact of another kind, and keeps an image's meta as it was", () => {
    const odd = { original: { width: 4, height: 2, frame_rate: "30", duration: -1, bitrate: 1.5 } };
    expect(presentMedia(row("video", odd), ORIGIN).meta).toEqual({
      original: { width: 4, height: 2, size: "4x2", aspect: 2 },
    });
    expect(
      presentMedia(row("audio", { original: { frame_rate: 30, duration: "8", bitrate: "1000" } }), ORIGIN).meta,
    ).toBeNull();
    expect(presentMedia(row("image", avMeta.video.meta), ORIGIN).meta).toEqual({
      original: { width: 640, height: 480, size: "640x480", aspect: 640 / 480 },
      small: avMeta.video.meta.small,
    });
  });

  it("shows a playable file's dimensions only as positive integers within the stored bound, and its duration as the verifier's (code review r2 M2)", () => {
    const tiny = 0.0000012345678901234567;
    expect(
      presentMedia(
        row("video", {
          original: { width: tiny, height: 2, duration: 8 },
          small: { width: 65_536, height: 360 },
        }),
        ORIGIN,
      ).meta,
    ).toEqual({ original: { duration: 8 } });
    expect(presentMedia(row("video", { original: { width: 65_535, height: 1 } }), ORIGIN).meta).toEqual({
      original: { width: 65_535, height: 1, size: "65535x1", aspect: 65_535 },
    });
    // One sample at 48 kHz up to the audio limit; shorter or longer is not the verifier's.
    const duration = (d: number) => presentMedia(row("audio", { original: { duration: d } }), ORIGIN).meta;
    expect([duration(1 / 48_000), duration(1200), duration(1 / 48_001), duration(1200.5)]).toEqual([
      { original: { duration: 1 / 48_000 } },
      { original: { duration: 1200 } },
      null,
      null,
    ]);
    // An image's dimensions as before: any positive finite numbers.
    expect(presentMedia(row("image", { original: { width: tiny, height: 2 } }), ORIGIN).meta).toEqual({
      original: { width: tiny, height: 2, size: `${tiny}x2`, aspect: tiny / 2 },
    });
  });

  it("shows no meta for a stored meta that is not an object", () => {
    expect(presentMedia(row("video", "[1]"), ORIGIN).meta).toBeNull();
    expect(presentMedia(row("video", null), ORIGIN).meta).toBeNull();
  });
});

describe("a video without a still, wherever its owner sees it (P16)", () => {
  it("shows the same attachment, VIDEO_POSTER on the instance origin, in the owner's GET and PUT, the scheduled status and the status", async () => {
    const w = await avWorld();
    const up = await completed(w, { facts: VIDEO_NO_STILL });
    clock(T0 + 5 * SECOND);
    const request = (path: string, init: RequestInit = {}) =>
      w.h.request(path, bearer(w.h.users.alice.token, init)).then((r) => r.json<Record<string, unknown>>());
    const got = await request(`/api/v1/media/${up.id}`);
    const put = await request(`/api/v1/media/${up.id}`, json({ description: "a clip" }, { method: "PUT" }));
    const scheduled = await postAs(w, {
      status: "later",
      media_ids: [up.id],
      scheduled_at: new Date(T0 + 10 * 60 * SECOND).toISOString(),
    });
    const held = scheduled.body as { id: string; media_attachments: unknown[] };
    await request(`/api/v1/scheduled_statuses/${held.id}`, { method: "DELETE" });
    const posted = await postAs(w, { status: "now", media_ids: [up.id] });
    const status = posted.body as { media_attachments: unknown[] };

    expect(got).toMatchObject({
      type: "video",
      preview_url: `${new URL(got.url as string).origin}${VIDEO_POSTER}`,
      blurhash: null,
      meta: { original: { width: 1280, height: 720, frame_rate: "30/1", duration: 8, bitrate: 1_000_000 } },
    });
    expect(got.meta).not.toHaveProperty("small");
    expect([put, held.media_attachments[0], status.media_attachments[0]]).toEqual([got, got, got]);
  });
});
