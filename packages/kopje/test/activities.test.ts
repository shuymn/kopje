import { afterEach, describe, expect, it, vi } from "vitest";

import { documentFacts } from "../src/domain/status-presenter";
import { DOCUMENT_DIMENSION_MAX } from "../src/platform/document-dimension";
import { sql } from "./api-helpers";
import { convertToVideo, imageUpload, postAs } from "./av-posting-helpers";
import avMeta from "./fixtures/mastodon-4.7.5-av-meta.json";
import { AUDIO, avWorld, clock, completed, SECOND, T0 } from "./media-processing-helpers";
import { outbound, remoteAccount, remoteFollows } from "./status-helpers";

// A local attachment's Document in the Note (#1828 P16, #1565; activities.ts attachmentsOf): its width, height and
// duration as ISO 8601, whatever its type, as ActivityPub::NoteSerializer's MediaAttachmentSerializer writes them, from
// the meta stored (status-presenter.ts documentFacts).

afterEach(() => {
  vi.useRealTimers();
});

describe("a playable file's Document (P16)", () => {
  it("writes Mastodon's width, height and duration for the fixture's video and audio meta", () => {
    expect(documentFacts(JSON.stringify(avMeta.video.meta), null, 0)).toEqual(avMeta.video.document);
    expect(documentFacts(JSON.stringify(avMeta.audio.meta), null, 0)).toEqual(avMeta.audio.document);
  });

  it("writes a whole number of seconds as Ruby's Float does, and any other to the millisecond in decimal", () => {
    const of = (duration: unknown) => documentFacts(JSON.stringify({ original: { duration } }), null, 0);
    expect([
      of(8),
      of(0.5),
      of(29.963854166666668),
      of(1.0005),
      of(1199.9996),
      of(1e-4),
      of(1 / 48_000),
      of(1200),
    ]).toEqual([
      { duration: "PT8.0S" },
      { duration: "PT0.5S" },
      { duration: "PT29.964S" },
      { duration: "PT1.001S" },
      { duration: "PT1200.0S" },
      // The verifier's shortest (down to one sample at 48 kHz) round to zero: never an exponent, never negative.
      { duration: "PT0.0S" },
      { duration: "PT0.0S" },
      { duration: "PT1200.0S" },
    ]);
    // Past what the verifier produces either way, or not a positive number: left out.
    expect([of(1 / 48_001), of(1200.5), of(0), of(-1), of("8")]).toEqual([{}, {}, {}, {}, {}]);
  });

  // C4.4 (#1565): each fact on its own, a dimension only as a whole number from 1 to DOCUMENT_DIMENSION_MAX, which is
  // what Kopje's receiver reads; no stored value throws.
  it("writes a width and a height each where stored, as whole pixels up to DOCUMENT_DIMENSION_MAX", () => {
    const of = (original: unknown) => documentFacts(JSON.stringify({ original }), null, 0);
    expect([
      of({ width: 640 }),
      of({ height: 360 }),
      of({ width: 65_536, height: 1 }),
      of({ width: DOCUMENT_DIMENSION_MAX, height: DOCUMENT_DIMENSION_MAX }),
    ]).toEqual([
      { width: 640 },
      { height: 360 },
      { width: 65_536, height: 1 },
      { width: DOCUMENT_DIMENSION_MAX, height: DOCUMENT_DIMENSION_MAX },
    ]);
    expect(
      ["640", 0, 1.5, 640.5, DOCUMENT_DIMENSION_MAX + 1, -640, 0.0000012345678901234567].map((width) =>
        of({ width, height: 480 }),
      ),
    ).toEqual(Array.from({ length: 7 }, () => ({ height: 480 })));
    // 1e400 reads as Infinity.
    expect(documentFacts('{"original":{"width":1e400,"height":480}}', null, 0)).toEqual({ height: 480 });
    for (const meta of [null, "[]", '"x"', "3", "not json", '{"original":3}', '{"original":[640,480]}', "{}"]) {
      expect(documentFacts(meta, null, 0)).toEqual({});
    }
  });

  // C4.2's rule (#1565): the focus is written as [x, y] exactly when the row shows one (focus_x read as
  // MEDIA_COLUMN_MAP.focus_x, NULL otherwise), beside the meta's facts.
  it("writes the focalPoint as [x, y] when a focus is shown, 0,0 included", () => {
    expect(documentFacts(null, 0.5, -0.25)).toEqual({ focalPoint: [0.5, -0.25] });
    expect(documentFacts(null, 0, 0)).toEqual({ focalPoint: [0, 0] });
    expect(documentFacts(null, null, 0)).toEqual({});
    expect(documentFacts(JSON.stringify({ original: { width: 10, height: 10 } }), -1, 1)).toEqual({
      width: 10,
      height: 10,
      focalPoint: [-1, 1],
    });
  });

  // An audio file's duration is stored as computed (samples / rate, as ffprobe's float in Mastodon); the Note writes
  // it in milliseconds, as Fedify's parse (Temporal) takes at most nine fractional digits.
  it("serves a status with an audio file whose stored duration has many fractional digits", async () => {
    const w = await avWorld();
    const audio = await completed(w, { facts: { ...AUDIO, duration: 29.963854166666668 } });
    clock(T0 + 5 * SECOND);
    const posted = await postAs(w, { status: "a song", media_ids: [audio.id] });
    expect(posted.status).toBe(200);
    const { uri } = posted.body as { uri: string };
    const response = await w.h.request(new URL(uri).pathname, { headers: { accept: "application/activity+json" } });
    expect(response.status).toBe(200);
    const note = await response.json<{ attachment: { duration?: string }[] }>();
    expect(note.attachment.map((a) => a.duration)).toEqual(["PT29.964S"]);
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
