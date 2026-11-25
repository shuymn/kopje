import { afterEach, describe, expect, it, vi } from "vitest";

import { sql } from "./api-helpers";
import {
  convertToVideo,
  IMAGES_AND_VIDEO,
  imageReservation,
  imageUpload,
  NOT_READY,
  notFound,
  postAs,
} from "./av-posting-helpers";
import { avWorld, type AvWorld, clock, completed, queued, reserve, SECOND, T0 } from "./media-processing-helpers";
import { posting } from "./status-helpers";

// An edit's media under the posting rules for video and audio (#1828 P10, decision C9): an edit whose set of media is
// new is held to them; one that keeps the set the status shows keeps today's outcome, so a status the cutover converted
// with a video among images stays editable.

afterEach(() => {
  vi.useRealTimers();
});

function edit(w: AvWorld, id: string, body: Record<string, unknown>) {
  return posting(w.h, w.h.users.alice.token, body, { method: "PUT", path: `/api/v1/statuses/${id}` });
}

// A status of alice's holding a video among two images, as the cutover converts one (the video made one after the post).
async function convertedStatus(w: AvWorld): Promise<{ id: string; media: string[] }> {
  const media = [await imageUpload(w), await imageUpload(w), await imageUpload(w)];
  const posted = await postAs(w, { status: "converted", media_ids: media });
  expect(posted.status).toBe(200);
  await convertToVideo(w, media[1]!);
  return { id: (posted.body as { id: string }).id, media };
}

describe("an edit's media (P10)", () => {
  it("keeps a converted set unchanged, reordered or with only its text changed", async () => {
    const w = await avWorld();
    clock(T0 + SECOND);
    const status = await convertedStatus(w);
    expect(await edit(w, status.id, { status: "edited", media_ids: status.media })).toMatchObject({
      status: 200,
      body: { content: "<p>edited</p>", media_attachments: [{}, { type: "video" }, {}] },
    });
    const reordered = status.media.toReversed();
    expect(await edit(w, status.id, { status: "again", media_ids: reordered })).toMatchObject({
      status: 200,
      body: { media_attachments: reordered.map((id) => ({ id })) },
    });
  });

  it("refuses a converted set made new: an image added, or one dropped while the video stays among others", async () => {
    const w = await avWorld();
    clock(T0 + SECOND);
    const status = await convertedStatus(w);
    const added = await imageUpload(w);
    expect(await edit(w, status.id, { status: "x", media_ids: [...status.media.slice(0, 3), added] })).toEqual({
      status: 422,
      body: IMAGES_AND_VIDEO,
    });
    expect(await edit(w, status.id, { status: "x", media_ids: status.media.slice(1) })).toEqual({
      status: 422,
      body: IMAGES_AND_VIDEO,
    });
    // The status is as it was.
    expect(
      await sql(
        w.store,
        "SELECT id FROM media_attachments WHERE status_id = ? AND shown = 1 ORDER BY position",
        status.id,
      ),
    ).toEqual(status.media.map((id) => ({ id })));
    // The video alone is a set Mastodon takes.
    expect(await edit(w, status.id, { status: "x", media_ids: [status.media[1]] })).toMatchObject({ status: 200 });
  });

  it("refuses an upload still processing with not_ready, and finds neither an old image reservation nor bob's", async () => {
    const w = await avWorld();
    const pending = await queued(w);
    const reservation = await imageReservation(w);
    const bobs = await queued(w, { up: await reserve(w, T0, "bob") });
    clock(T0 + 5 * SECOND);
    const posted = await postAs(w, { status: "plain" });
    const id = (posted.body as { id: string }).id;
    expect(await edit(w, id, { status: "x", media_ids: [pending.id] })).toEqual({ status: 422, body: NOT_READY });
    for (const other of [reservation, bobs.id]) {
      expect(await edit(w, id, { status: "x", media_ids: [other] })).toEqual(notFound(other));
    }
  });

  it("adds a completed video to a status without media", async () => {
    const w = await avWorld();
    const video = await completed(w);
    clock(T0 + 5 * SECOND);
    const posted = await postAs(w, { status: "plain" });
    expect(
      await edit(w, (posted.body as { id: string }).id, { status: "with a video", media_ids: [video.id] }),
    ).toMatchObject({ status: 200, body: { media_attachments: [{ id: video.id, type: "video" }] } });
  });
});
