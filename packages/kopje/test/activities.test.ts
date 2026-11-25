import { afterEach, describe, expect, it, vi } from "vitest";

import { playableDocumentFacts } from "../src/domain/status-presenter";
import { sql } from "./api-helpers";
import { convertToVideo, imageUpload, postAs } from "./av-posting-helpers";
import avMeta from "./fixtures/mastodon-4.7.5-av-meta.json";
import { AUDIO, avWorld, clock, completed, SECOND, T0 } from "./media-processing-helpers";
import { outbound, remoteAccount, remoteFollows } from "./status-helpers";

// A local video's or audio file's Document in the Note (#1828 P16, activities.ts attachmentsOf): its width and height
// (video) and its duration as ISO 8601, as ActivityPub::NoteSerializer's MediaAttachmentSerializer writes them, from
// the verified facts its completion stored (status-presenter.ts playableDocumentFacts); an image's Document as before.

afterEach(() => {
  vi.useRealTimers();
});

describe("a playable file's Document (P16)", () => {
  it("writes Mastodon's width, height and duration for the fixture's video and audio meta", () => {
    expect(playableDocumentFacts("video", JSON.stringify(avMeta.video.meta))).toEqual(avMeta.video.document);
    expect(playableDocumentFacts("audio", JSON.stringify(avMeta.audio.meta))).toEqual(avMeta.audio.document);
  });

  it("writes a whole number of seconds as Ruby's Float does, and leaves out what ISO 8601 cannot write", () => {
    const of = (duration: unknown) => playableDocumentFacts("audio", JSON.stringify({ original: { duration } }));
    expect([of(8), of(0.5), of(1e-4), of(1e16 - 2)]).toEqual([
      { duration: "PT8.0S" },
      { duration: "PT0.5S" },
      { duration: "PT0.0001S" },
      { duration: "PT9999999999999998.0S" },
    ]);
    expect([of(5e-5), of(1e16), of(0), of(-1), of("8")]).toEqual([{}, {}, {}, {}, {}]);
    // An image's and a gifv's stored facts are not written.
    expect(playableDocumentFacts("image", JSON.stringify(avMeta.video.meta))).toEqual({});
    expect(playableDocumentFacts("gifv", JSON.stringify(avMeta.video.meta))).toEqual({});
  });

  it("publishes a completed video's and audio file's facts in the Note, and an image's Document as before", async () => {
    const w = await avWorld();
    await remoteFollows(w.store, await remoteAccount(w.store, "fan"), w.h.users.alice.id);
    const video = await completed(w);
    clock(T0 + 5 * SECOND);
    expect((await postAs(w, { status: "a clip", media_ids: [video.id] })).status).toBe(200);
    const w2 = await avWorld();
    await remoteFollows(w2.store, await remoteAccount(w2.store, "fan"), w2.h.users.alice.id);
    const audio = await completed(w2, { facts: AUDIO });
    const image = await imageUpload(w2);
    clock(T0 + 5 * SECOND);
    expect((await postAs(w2, { status: "a song", media_ids: [audio.id] })).status).toBe(200);
    expect((await postAs(w2, { status: "a picture", media_ids: [image] })).status).toBe(200);

    const attachments = async (store: typeof w.store) =>
      (await outbound(store))
        .filter((o) => o.activity.type === "Create")
        .map((o) => (o.activity.object as { attachment: Record<string, unknown>[] }).attachment);
    expect(await attachments(w.store)).toEqual([
      [
        expect.objectContaining({
          type: "Document",
          mediaType: "video/mp4",
          width: 1280,
          height: 720,
          duration: "PT8.0S",
        }),
      ],
    ]);
    const [song, picture] = await attachments(w2.store);
    expect(song).toEqual([expect.objectContaining({ mediaType: "audio/mpeg", duration: "PT10.0S" })]);
    expect(song?.[0]).not.toHaveProperty("width");
    expect(picture).toEqual([
      { type: "Document", mediaType: "image/png", url: `https://kopje.test/media/${image}.png`, name: null },
    ]);
  });

  it("publishes a converted video's facts from the meta the cutover kept", async () => {
    const w = await avWorld();
    await remoteFollows(w.store, await remoteAccount(w.store, "fan"), w.h.users.alice.id);
    const id = await imageUpload(w);
    await convertToVideo(w, id);
    await sql(w.store, "UPDATE media_attachments SET url = 'https://kopje.test/media/x/full.mp4' WHERE id = ?", id);
    clock(T0 + 5 * SECOND);
    expect((await postAs(w, { status: "old", media_ids: [id] })).status).toBe(200);
    const [create] = await outbound(w.store);
    expect((create!.activity.object as { attachment: unknown[] }).attachment).toEqual([
      expect.objectContaining({ width: 640, height: 360, duration: "PT2.5S" }),
    ]);
  });
});
