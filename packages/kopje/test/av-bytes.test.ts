import { describe, expect, it } from "vitest";

import { MAX_MEDIA_BYTES } from "../src/jobs/backup";
import {
  AV_OUTPUT_LIMIT,
  AUDIO_DURATION_LIMIT,
  AUDIO_SAMPLE_LIMIT,
  avVerifier,
  AvRefusal,
  type AvRule,
  type AvType,
  FRAME_RATE_LIMIT,
  MOOV_LIMIT,
  OUTPUT_LADDER,
  OUTPUT_LONG_EDGE,
  OUTPUT_SHORT_EDGE,
  RUNG_SLACK_MS,
  sniffAvUpload,
  STILL_LONG_EDGE,
  STILL_OUTPUT_LIMIT,
  VIDEO_DURATION_LIMIT,
  VIDEO_SAMPLE_LIMIT,
  verifyMp3,
  verifyMp4,
  verifyStill,
} from "../src/platform/av-bytes";
import {
  avFixture,
  avManifest,
  box,
  chunked,
  concat,
  editMoov,
  find,
  patch,
  refreshXing,
  repeatedMp3,
  setBody,
  sps,
  syntheticMp4,
  topBoxes,
  u16,
  u32,
  verifyBytes,
  verifyStream,
  withSps,
  xingLayout,
} from "./av-helpers";
import {
  PNG_ICC as PNG_ICC_BASE64,
  PNG_PLAIN as PNG_PLAIN_BASE64,
  PNG_WITH_GPS as PNG_GPS_BASE64,
} from "./fixtures/images";

// The output verifier (src/platform/av-bytes.ts, design #1828 4.10; MEDIA-3, RES-2): the shipped image's
// outputs (test/fixtures/av/, scripts/av-fixtures.sh) are accepted with their facts, and each rule refuses a copy of
// one of them changed in one field (or, where a rule needs a coherent file, a synthetic one) by its own code.

const MIB = 1024 * 1024;

const png = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const PNG_PLAIN = png(PNG_PLAIN_BASE64);
const PNG_ICC = png(PNG_ICC_BASE64);
const PNG_WITH_GPS = png(PNG_GPS_BASE64);

async function rule(type: AvType, bytes: Uint8Array, options: Parameters<typeof verifyBytes>[2] = {}) {
  const v = await verifyBytes(type, bytes, options);
  return v.ok ? "accepted" : v.rule;
}

function u32At(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
}

describe("the output limits", () => {
  it("keep AV_OUTPUT_LIMIT below what the backup copies, and the moov and still within the output", () => {
    expect(AV_OUTPUT_LIMIT).toBeLessThan(MAX_MEDIA_BYTES);
    expect(AV_OUTPUT_LIMIT).toBe(63 * MIB);
    expect(STILL_OUTPUT_LIMIT).toBe(2 * MIB);
    expect(MOOV_LIMIT).toBe(4 * MIB);
    expect(MOOV_LIMIT).toBeLessThan(AV_OUTPUT_LIMIT);
    expect([VIDEO_DURATION_LIMIT, AUDIO_DURATION_LIMIT, VIDEO_SAMPLE_LIMIT]).toEqual([600, 1200, 36_000]);
    expect([FRAME_RATE_LIMIT, OUTPUT_LONG_EDGE, OUTPUT_SHORT_EDGE, STILL_LONG_EDGE]).toEqual([60, 1920, 1080, 640]);
    // At the frame rate cap the sample cap is the duration limit's: no file within both can hold more samples.
    expect(VIDEO_SAMPLE_LIMIT).toBe(VIDEO_DURATION_LIMIT * FRAME_RATE_LIMIT);
  });
});

describe("the shipped image's outputs", () => {
  it("are accepted, in any chunking, with the manifest's SHA-256 and every byte passed through", async () => {
    const manifest = await avManifest();
    expect(manifest.map((f) => f.name).toSorted()).toEqual(
      [
        "aac.mp3",
        "cap-44k.mp4",
        "cap-48k.mp4",
        "flac.mp3",
        "hlg.mp4",
        "m4a.mp3",
        "mp3.mp3",
        "ogg.mp3",
        "opus.mp3",
        "pq.mp4",
        "r1-32k.mp4",
        "r1-av.mp4",
        "r1-silent.mp4",
        "r2-av.mp4",
        "r2-silent.mp4",
        "r3-av.mp4",
        "r3-silent.mp4",
        "rotated.mp4",
        "vfr.mp4",
        "wav.mp3",
      ].toSorted(),
    );
    for (const f of manifest) {
      const bytes = await avFixture(f.name);
      const type = f.kind === "video" ? "video/mp4" : "audio/mpeg";
      for (const chunk of [3, 4093, bytes.length]) {
        const v = await verifyBytes(type, bytes, { chunk });
        expect(v.ok ? v.facts.sha256 : v.rule, `${f.name} in ${chunk}-byte chunks`).toBe(f.sha256);
        expect(v.passed).toBe(bytes.length);
      }
    }
  });

  it("give the facts of their tables", async () => {
    const facts = async (name: string) => {
      const v = await verifyBytes(name.endsWith(".mp4") ? "video/mp4" : "audio/mpeg", await avFixture(name));
      if (!v.ok) {
        throw new Error(`${name}: ${v.rule}`);
      }
      const { sha256: _sha, ...rest } = v.facts;
      return rest;
    };
    expect(await facts("r1-av.mp4")).toMatchObject({
      kind: "video",
      width: 160,
      height: 90,
      frameRate: "60/1",
      duration: 4,
      audio: true,
    });
    // The second rung's cap: a 60 fps source at 30 fps.
    expect(await facts("r2-av.mp4")).toMatchObject({ width: 64, height: 36, frameRate: "30/1", audio: true });
    expect(await facts("r3-silent.mp4")).toMatchObject({ width: 32, height: 18, frameRate: "10/1", duration: 301 });
    // Rotation applied to the pixels.
    expect(await facts("rotated.mp4")).toMatchObject({ width: 90, height: 160 });
    const r1 = await facts("r1-av.mp4");
    expect(r1.bitrate).toBe(Math.floor((r1.bytes * 8) / r1.duration));
    expect(await facts("m4a.mp3")).toMatchObject({ kind: "audio", sampleRate: 44_100, channels: 1 });
    // The FLAC's headers state no rate (the header probe reads 0), so it counts as unknown: 48 kHz.
    expect(await facts("flac.mp3")).toMatchObject({ sampleRate: 48_000, channels: 2 });
    // An 8 kHz WAV, resampled to 48 kHz.
    expect(await facts("wav.mp3")).toMatchObject({ sampleRate: 48_000 });
    // The presented samples: 116 MPEG-1 frames after the Xing frame, 1152 samples each, less the LAME tag's delay and
    // padding, which leaves the input's 3 s.
    expect((await facts("m4a.mp3")).duration).toBe(3);
    // A raw ADTS AAC source: its priming is decoded too, which leaves a padding over one frame in the LAME tag.
    const adts = await avFixture("aac.mp3");
    const { lame } = xingLayout(adts);
    expect((((adts[lame + 22] ?? 0) & 0xf) << 8) | (adts[lame + 23] ?? 0)).toBeGreaterThan(1152);
    expect(await facts("aac.mp3")).toMatchObject({ kind: "audio", sampleRate: 44_100 });
    // At the limit (#1828 A7): the AAC track holds its priming past 600 s, which is not presented.
    expect(await facts("cap-44k.mp4")).toMatchObject({ duration: 600, audio: true });
    expect(await facts("cap-48k.mp4")).toMatchObject({ duration: 600, audio: true });
  });

  it("pass through the verifier's stream unchanged and error it at a refusal", async () => {
    const bytes = await avFixture("r1-silent.mp4");
    const v = avVerifier("video/mp4", bytes.length);
    const out: Uint8Array[] = [];
    await chunked(bytes, 1000)
      .pipeThrough(v.stream)
      .pipeTo(new WritableStream<Uint8Array>({ write: (c: Uint8Array) => void out.push(c) }));
    expect(concat(...out)).toEqual(bytes);
    expect((await v.verdict).ok).toBe(true);

    const broken = patch(bytes, topBoxes(bytes)[2]?.[1] ?? 0, u32(12));
    const refused = avVerifier("video/mp4", broken.length);
    const piped = await chunked(broken, 1000)
      .pipeThrough(refused.stream)
      .pipeTo(new WritableStream())
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(piped).toBeInstanceOf(AvRefusal);
    expect(await refused.verdict).toEqual({ ok: false, rule: "free" });
  });

  it("refuses a source that fails before its end", async () => {
    const bytes = await avFixture("r1-silent.mp4");
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("connection lost"));
          return;
        }
        sent = true;
        controller.enqueue(bytes.slice(0, 5000));
      },
    });
    expect(await verifyMp4(failing, bytes.length)).toEqual({ ok: false, rule: "length" });
    expect((await verifyMp4(chunked(bytes, 4096), bytes.length)).ok).toBe(true);
    const mp3 = await avFixture("m4a.mp3");
    expect((await verifyMp3(chunked(mp3, 4096), mp3.length)).ok).toBe(true);
  });

  it("keeps an editor round trip acceptable, so each mutation below changes only its field", async () => {
    const file = await avFixture("r1-av.mp4");
    expect(editMoov(file, () => {})).toEqual(file);
    expect(await rule("audio/mpeg", refreshXing(await avFixture("m4a.mp3")))).toBe("accepted");
  });

  it("accept a tkhd one tick over its edit list, as the muxer rounds a jittered AAC track", async () => {
    // The audio track is the longest here, so mvhd follows it.
    const file = editMoov(await avFixture("r1-av.mp4"), (m) => {
      for (const [path, at] of [
        ["trak#1/tkhd", 20],
        ["mvhd", 16],
      ] as const) {
        const node = find(m, path);
        setBody(node, at, u32(u32At(node.body as Uint8Array, at) + 1));
      }
    });
    expect(await rule("video/mp4", file)).toBe("accepted");
  });
});

type Mutation = { name: string; rule: AvRule; make: () => Promise<Uint8Array>; length?: (n: number) => number };

const mp4 = async (edit: (moov: Parameters<Parameters<typeof editMoov>[1]>[0]) => void, name = "r1-av.mp4") =>
  editMoov(await avFixture(name), edit);

// The byte offset of a top-level box.
const top = (file: Uint8Array, type: string, index = 0) =>
  topBoxes(file).filter(([t]) => t === type)[index]?.[1] ?? Number.NaN;

const MP4_MUTATIONS: Mutation[] = [
  {
    name: "an audio stts declaring more samples than AUDIO_SAMPLE_LIMIT",
    rule: "sample_cap",
    make: () => mp4((m) => setBody(find(m, "trak#1/mdia/minf/stbl/stts"), 8, u32(AUDIO_SAMPLE_LIMIT + 1))),
  },
  {
    name: "a fixed stsz size whose samples outgrow the mdat",
    rule: "sample_count",
    make: () =>
      mp4((m) => {
        const stbl = find(m, "trak/mdia/minf/stbl");
        const count = u32At(find(stbl, "stsz").body as Uint8Array, 8);
        stbl.children = (stbl.children ?? []).map((c) =>
          c.type === "stsz" ? box("stsz", [...u32(0), ...u32(0x100000), ...u32(count)]) : c,
        );
      }),
  },
  {
    name: "a byte after the mdat",
    rule: "top_level",
    make: async () => concat(await avFixture("r1-av.mp4"), new Uint8Array(8)),
  },
  {
    name: "a second ftyp first",
    rule: "top_level",
    make: async () => {
      const f = await avFixture("r1-av.mp4");
      return concat(f.slice(0, 32), f.slice(0, 32), f.slice(32));
    },
  },
  {
    name: "another compatible brand",
    rule: "ftyp",
    make: async () => patch(await avFixture("r1-av.mp4"), 28, [0x6d, 0x70, 0x34, 0x32]),
  },
  {
    name: "a moov over MOOV_LIMIT",
    rule: "moov_size",
    make: async () => patch(await avFixture("r1-av.mp4"), 32, u32(MOOV_LIMIT + 1)),
  },
  {
    name: "a free box with a payload",
    rule: "free",
    make: async () => {
      const f = await avFixture("r1-av.mp4");
      return patch(f, top(f, "free"), u32(12));
    },
  },
  {
    name: "the free box before the moov",
    rule: "free",
    make: async () => {
      const f = await avFixture("r1-av.mp4");
      const free = top(f, "free");
      return concat(f.slice(0, 32), f.slice(free, free + 8), f.slice(32, free), f.slice(free + 8));
    },
  },
  {
    name: "a box overrunning the moov",
    rule: "malformed",
    make: async () => patch(await avFixture("r1-av.mp4"), 40, u32(0x7fffffff)),
  },
  {
    name: "a udta in the moov (ffmpeg's empty ilst)",
    rule: "box",
    make: () => mp4((m) => m.children?.push(box("udta", [...u32(8), 0x69, 0x6c, 0x73, 0x74]))),
  },
  {
    name: "an sdtp in the video's stbl",
    rule: "box",
    make: () => mp4((m) => find(m, "trak/mdia/minf/stbl").children?.push(box("sdtp", [0, 0, 0, 0]))),
  },
  {
    name: "a third track",
    rule: "tracks",
    make: () => mp4((m) => m.children?.push(find(m, "trak#1"))),
  },
  { name: "mvhd timescale 600", rule: "mvhd", make: () => mp4((m) => setBody(find(m, "mvhd"), 12, u32(600))) },
  { name: "mvhd creation time", rule: "mvhd", make: () => mp4((m) => setBody(find(m, "mvhd"), 4, u32(1))) },
  { name: "mvhd next track id", rule: "mvhd", make: () => mp4((m) => setBody(find(m, "mvhd"), 96, u32(9))) },
  { name: "tkhd flags 1", rule: "tkhd", make: () => mp4((m) => setBody(find(m, "trak/tkhd"), 0, u32(1))) },
  {
    name: "the video in alternate group 1",
    rule: "tkhd",
    make: () => mp4((m) => setBody(find(m, "trak/tkhd"), 34, u16(1))),
  },
  { name: "a tkhd matrix rotated", rule: "tkhd", make: () => mp4((m) => setBody(find(m, "trak/tkhd"), 40, u32(0))) },
  {
    name: "tkhd width off the SPS",
    rule: "tkhd",
    make: () => mp4((m) => setBody(find(m, "trak/tkhd"), 76, u32(161 * 0x10000))),
  },
  {
    name: "mdhd language eng",
    rule: "mdhd",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/mdhd"), 20, u16(0x15c7))),
  },
  {
    name: "hdlr name changed",
    rule: "hdlr",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/hdlr"), 35, [0x78])),
  },
  {
    name: "vmhd graphics mode",
    rule: "vmhd",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/vmhd"), 4, u16(1))),
  },
  {
    name: "smhd balance",
    rule: "smhd",
    make: () => mp4((m) => setBody(find(m, "trak#1/mdia/minf/smhd"), 4, u16(0x100))),
  },
  {
    name: "a dref entry not self-contained",
    rule: "dref",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/dinf/dref"), 16, u32(0))),
  },
  {
    name: "two sample entries declared",
    rule: "stsd",
    make: () =>
      mp4((m) => {
        find(m, "trak/mdia/minf/stbl/stsd").head.set(u32(2), 4);
      }),
  },
  {
    name: "a compressor name",
    rule: "avc1",
    make: () => mp4((m) => find(m, "trak/mdia/minf/stbl/stsd/avc1").head.set([5, 0x4c, 0x61, 0x76, 0x63], 42)),
  },
  {
    name: "a btrt in avc1",
    rule: "box",
    make: () => mp4((m) => find(m, "trak/mdia/minf/stbl/stsd/avc1").children?.push(box("btrt", new Uint8Array(12)))),
  },
  {
    name: "2-byte NAL lengths",
    rule: "avcC",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsd/avc1/avcC"), 4, [0xfd])),
  },
  {
    name: "an SPS of Main profile",
    rule: "sps",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsd/avc1/avcC"), 9, [77])),
  },
  {
    name: "an SPS of full range",
    rule: "sps",
    make: async () => withSps(await avFixture("r1-av.mp4"), sps({ widthMbs: 10, heightMbs: 6, fullRange: 1 }), 160, 96),
  },
  {
    name: "an SPS with BT.2020 primaries",
    rule: "sps",
    make: async () => withSps(await avFixture("r1-av.mp4"), sps({ widthMbs: 10, heightMbs: 6, primaries: 9 }), 160, 96),
  },
  {
    name: "an SPS with HRD parameters",
    rule: "sps",
    make: async () => withSps(await avFixture("r1-av.mp4"), sps({ widthMbs: 10, heightMbs: 6, hrd: true }), 160, 96),
  },
  {
    name: "an SPS with non-square pixels",
    rule: "sps",
    make: async () => withSps(await avFixture("r1-av.mp4"), sps({ widthMbs: 10, heightMbs: 6, aspect: 2 }), 160, 96),
  },
  {
    name: "an SPS with data after its stop bit",
    rule: "sps",
    make: async () =>
      withSps(await avFixture("r1-av.mp4"), concat(sps({ widthMbs: 10, heightMbs: 6 }), Uint8Array.of(0x80)), 160, 96),
  },
  {
    name: "a PPS that is not a PPS",
    rule: "pps",
    make: () =>
      mp4((m) => {
        const avcC = find(m, "trak/mdia/minf/stbl/stsd/avc1/avcC").body as Uint8Array;
        const spsLength = (avcC[6] ?? 0) * 256 + (avcC[7] ?? 0);
        avcC[8 + spsLength + 3] = 0x69;
      }),
  },
  {
    name: "a video edit past x264's reorder delay (three frames)",
    rule: "elst",
    make: () =>
      mp4((m) => {
        // Every composition offset one frame (256 ticks) later, and the edit with them: only the delay changes.
        const ctts = find(m, "trak/mdia/minf/stbl/ctts");
        const body = ctts.body as Uint8Array;
        for (let i = 0; i < u32At(body, 4); i++) {
          setBody(ctts, 12 + i * 8, u32(u32At(body, 12 + i * 8) + 256));
        }
        const elst = find(m, "trak/edts/elst");
        setBody(elst, 12, u32(u32At(elst.body as Uint8Array, 12) + 256));
      }),
  },
  {
    name: "1936x1088, past the top rung",
    rule: "geometry",
    make: async () =>
      withSps(await avFixture("r1-av.mp4"), sps({ widthMbs: 121, heightMbs: 68, level: 40 }), 1936, 1088),
  },
  {
    name: "colr full range",
    rule: "colr",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsd/avc1/colr"), 10, [0x80])),
  },
  {
    name: "colr BT.2020 primaries",
    rule: "colr",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsd/avc1/colr"), 4, u16(9))),
  },
  {
    name: "pasp 4:3",
    rule: "pasp",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsd/avc1/pasp"), 0, u32(4))),
  },
  {
    name: "mp4a mono",
    rule: "mp4a",
    make: () => mp4((m) => find(m, "trak#1/mdia/minf/stbl/stsd/mp4a").head.set(u16(1), 16)),
  },
  {
    name: "esds average bitrate one over the track's",
    rule: "esds",
    make: () =>
      mp4((m) => {
        const esds = find(m, "trak#1/mdia/minf/stbl/stsd/mp4a/esds");
        setBody(esds, 26, u32(u32At(esds.body as Uint8Array, 26) + 1));
      }),
  },
  {
    name: "esds maximum bitrate 256 kb/s",
    rule: "esds",
    make: () => mp4((m) => setBody(find(m, "trak#1/mdia/minf/stbl/stsd/mp4a/esds"), 22, u32(256_000))),
  },
  {
    name: "an HE-AAC AudioSpecificConfig",
    rule: "esds",
    make: () => mp4((m) => setBody(find(m, "trak#1/mdia/minf/stbl/stsd/mp4a/esds"), 35, [0x29])),
  },
  {
    name: "sbgp short of the samples",
    rule: "sample_group",
    make: () =>
      mp4((m) => {
        const sbgp = find(m, "trak#1/mdia/minf/stbl/sbgp");
        setBody(sbgp, 12, u32(u32At(sbgp.body as Uint8Array, 12) - 1));
      }),
  },
  {
    name: "sgpd roll distance -2",
    rule: "sample_group",
    make: () => mp4((m) => setBody(find(m, "trak#1/mdia/minf/stbl/sgpd"), 16, u16(0xfffe))),
  },
  {
    name: "an edit at rate 2",
    rule: "elst",
    make: () => mp4((m) => setBody(find(m, "trak/edts/elst"), 16, u32(0x20000))),
  },
  {
    name: "two media edits",
    rule: "elst",
    make: () =>
      mp4((m) => {
        const elst = find(m, "trak/edts/elst");
        const body = elst.body as Uint8Array;
        elst.body = concat(body, body.slice(8, 20));
        elst.body.set(u32(2), 4);
      }),
  },
  // The sample timeline: stts against mdhd, for each track.
  {
    name: "video mdhd duration one tick over its samples",
    rule: "sample_time",
    make: () =>
      mp4((m) => {
        const mdhd = find(m, "trak/mdia/mdhd");
        setBody(mdhd, 16, u32(u32At(mdhd.body as Uint8Array, 16) + 1));
      }),
  },
  {
    name: "audio stts one tick longer",
    rule: "sample_time",
    make: () =>
      mp4((m) => {
        const stts = find(m, "trak#1/mdia/minf/stbl/stts");
        setBody(stts, 12, u32(u32At(stts.body as Uint8Array, 12) + 1));
      }),
  },
  // The presentation timeline: elst against the composition span, tkhd against elst, mvhd against tkhd.
  {
    // mvhd following it, so only the edit list refuses it.
    name: "an audio tkhd two ticks over its edit list",
    rule: "presentation",
    make: () =>
      mp4((m) => {
        for (const [path, at] of [
          ["trak#1/tkhd", 20],
          ["mvhd", 16],
        ] as const) {
          const node = find(m, path);
          setBody(node, at, u32(u32At(node.body as Uint8Array, at) + 2));
        }
      }),
  },
  {
    name: "an audio tkhd one tick under its edit list",
    rule: "presentation",
    make: () =>
      mp4((m) => {
        const tkhd = find(m, "trak#1/tkhd");
        setBody(tkhd, 20, u32(u32At(tkhd.body as Uint8Array, 20) - 1));
      }),
  },
  {
    name: "mvhd duration off the longest tkhd",
    rule: "presentation",
    make: () =>
      mp4((m) => {
        const mvhd = find(m, "mvhd");
        setBody(mvhd, 16, u32(u32At(mvhd.body as Uint8Array, 16) + 1));
      }),
  },
  {
    name: "a video edit before its first composition time",
    rule: "elst",
    make: () => mp4((m) => setBody(find(m, "trak/edts/elst"), 12, u32(0))),
  },
  {
    name: "a video edit after its first composition time",
    rule: "elst",
    make: () =>
      mp4((m) => {
        const elst = find(m, "trak/edts/elst");
        setBody(elst, 12, u32(u32At(elst.body as Uint8Array, 12) + 1));
      }),
  },
  {
    name: "an audio edit past one AAC frame of priming (2049 samples)",
    rule: "elst",
    make: () => mp4((m) => setBody(find(m, "trak#1/edts/elst"), 12, u32(2049))),
  },
  {
    // At exactly the limit, one sample of the AAC priming more presented (#1828 A7).
    name: "an audio track presenting one sample past VIDEO_DURATION_LIMIT",
    rule: "duration_limit",
    make: () =>
      mp4((m) => {
        const elst = find(m, "trak#1/edts/elst");
        setBody(elst, 12, u32(u32At(elst.body as Uint8Array, 12) - 1));
      }, "cap-44k.mp4"),
  },
  {
    name: "a video track one tick past VIDEO_DURATION_LIMIT (elst, tkhd and mvhd agreeing)",
    rule: "duration_limit",
    make: () =>
      mp4((m) => {
        for (const [path, at] of [
          ["trak/edts/elst", 8],
          ["trak/tkhd", 20],
          ["mvhd", 16],
        ] as const) {
          const node = find(m, path);
          setBody(node, at, u32(u32At(node.body as Uint8Array, at) + 1));
        }
      }, "cap-44k.mp4"),
  },
  {
    name: "an edit past the samples (elst, tkhd and mvhd agreeing)",
    rule: "presentation",
    make: () =>
      mp4((m) => {
        for (const [path, at] of [
          ["trak/edts/elst", 8],
          ["trak/tkhd", 20],
          ["mvhd", 16],
        ] as const) {
          const node = find(m, path);
          setBody(node, at, u32(u32At(node.body as Uint8Array, at) + 100));
        }
      }),
  },
  {
    name: "a video mdhd over VIDEO_DURATION_LIMIT (a timescale of 15)",
    rule: "duration_limit",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/mdhd"), 12, u32(15))),
  },
  {
    name: "stsz declaring one sample more",
    rule: "sample_count",
    make: () =>
      mp4((m) => {
        const stsz = find(m, "trak/mdia/minf/stbl/stsz");
        setBody(stsz, 8, u32(u32At(stsz.body as Uint8Array, 8) + 1));
      }),
  },
  {
    name: "the first sync sample not the first sample",
    rule: "sync_samples",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stss"), 8, u32(2))),
  },
  {
    name: "a chunk of another sample description",
    rule: "chunks",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stsc"), 16, u32(2))),
  },
  {
    name: "a chunk offset past the file",
    rule: "chunk_offset",
    make: () => mp4((m) => setBody(find(m, "trak/mdia/minf/stbl/stco"), 8, u32(0x7fffffff))),
  },
  {
    name: "a gap before the first sample",
    rule: "tiling",
    make: () =>
      mp4((m) => {
        const stco = find(m, "trak/mdia/minf/stbl/stco");
        setBody(stco, 8, u32(u32At(stco.body as Uint8Array, 8) + 1));
      }),
  },
  {
    name: "an SEI where a slice should be",
    rule: "nal",
    make: async () => {
      const f = await avFixture("r1-av.mp4");
      return patch(f, top(f, "mdat") + 8 + 4, [0x06]);
    },
  },
  {
    name: "a NAL unit longer than its sample",
    rule: "nal",
    make: async () => {
      const f = await avFixture("r1-av.mp4");
      return patch(f, top(f, "mdat") + 8, u32(0x7fffff));
    },
  },
];

describe("an MP4 changed in one field", () => {
  for (const m of MP4_MUTATIONS) {
    it(`is refused: ${m.name} (${m.rule})`, async () => {
      expect(await rule("video/mp4", await m.make())).toBe(m.rule);
    });
  }

  it("is refused for a length other than its Content-Length, or over AV_OUTPUT_LIMIT", async () => {
    const f = await avFixture("r1-silent.mp4");
    // Fewer bytes than declared; more (the last refused as it arrives).
    expect(await rule("video/mp4", f.slice(0, -1), { contentLength: f.length })).toBe("length");
    expect(await rule("video/mp4", concat(f, Uint8Array.of(0)), { contentLength: f.length })).toBe("length");
    // A declared length the mdat does not reach is the top level's: the mdat must end the file.
    expect(await rule("video/mp4", f, { contentLength: f.length + 1 })).toBe("top_level");
    expect(await rule("video/mp4", f, { contentLength: 0 })).toBe("length");
    expect(await rule("video/mp4", f, { contentLength: AV_OUTPUT_LIMIT + 1 })).toBe("over_limit");
  });

  it("is refused when shorter than the plan by more than a second or 10 %", async () => {
    const f = await avFixture("r1-av.mp4");
    expect(await rule("video/mp4", f, { expectedDuration: 4.4 })).toBe("accepted");
    expect(await rule("video/mp4", f, { expectedDuration: 4.5 })).toBe("short_output");
    expect(await rule("video/mp4", f, { expectedDuration: 6 })).toBe("short_output");
    const long = await avFixture("r3-silent.mp4");
    expect(await rule("video/mp4", long, { expectedDuration: 301.9 })).toBe("accepted");
    expect(await rule("video/mp4", long, { expectedDuration: 302.1 })).toBe("short_output");
  });
});

describe("a synthetic MP4", () => {
  const verify = async (shape: Parameters<typeof syntheticMp4>[1], template?: Uint8Array) => {
    const s = syntheticMp4(template ?? (await avFixture("r1-silent.mp4")), shape);
    const v = await verifyStream("video/mp4", s.stream(), s.length);
    return v.ok ? "accepted" : v.rule;
  };

  it("is accepted at the limits and refused past them", async () => {
    // 15360 ticks a second: 512 is 30 fps, 256 is 60 fps.
    expect(await verify({ samples: 30, size: 64, delta: 512 })).toBe("accepted");
    expect(await verify({ samples: 30, size: 64, delta: 256 })).toBe("accepted");
    // 61 fps.
    expect(await verify({ samples: 30, size: 64, delta: 256, timescale: 61 * 256 })).toBe("frame_rate");
    // 600 s at 30 fps, then 600.5 s: the mvhd, tkhd and edit list agreeing.
    expect(await verify({ samples: 18_000, size: 6, delta: 512 })).toBe("accepted");
    expect(await verify({ samples: 18_015, size: 6, delta: 512 })).toBe("duration_limit");
    // 36,001 samples at 61 fps (590 s): the sample cap before the frame rate.
    expect(await verify({ samples: 36_001, size: 6, delta: 256, timescale: 61 * 256 })).toBe("sample_cap");
  });

  it("is held to the caps of the ladder's rung for its duration, RUNG_SLACK_MS past the rung's", async () => {
    expect(OUTPUT_LADDER.map((r) => [r.durationMs, r.longEdge, r.shortEdge, r.fps])).toEqual([
      [120_000, 1920, 1080, 60],
      [300_000, 1280, 720, 30],
      [600_000, 854, 480, 30],
    ]);
    expect(RUNG_SLACK_MS).toBe(100);
    // 60 fps (7206 samples of 256 ticks) is 120,100 ms, the top rung's; 59.8 fps (7178 of 257) is 120,101 ms, past it.
    expect(await verify({ samples: 7206, size: 6, delta: 256 })).toBe("accepted");
    expect(await verify({ samples: 7178, size: 6, delta: 257 })).toBe("frame_rate");
    // 1280x720 at 30 fps: 300,100 ms (9003 samples of 512) is the second rung's; 300,101 ms (8968 of 514) the third's.
    const hd = withSps(await avFixture("r1-silent.mp4"), sps({ widthMbs: 80, heightMbs: 45, level: 40 }), 1280, 720);
    expect(await verify({ samples: 9003, size: 6, delta: 512 }, hd)).toBe("accepted");
    expect(await verify({ samples: 8968, size: 6, delta: 514 }, hd)).toBe("geometry");
  });

  it("is refused at a small moov declaring a huge sample count, before its tables are expanded", async () => {
    const template = await avFixture("r1-silent.mp4");
    // Four million one-tick 8-byte samples of one stsz size: the moov stays small, the tables would not.
    const s = syntheticMp4(template, { samples: 4_000_000, size: 8, delta: 1, fixed: true });
    expect(s.head.length).toBeLessThan(4096);
    const v = await verifyStream("video/mp4", s.stream(65_536), s.length);
    expect(v).toMatchObject({ ok: false, rule: "sample_cap" });
    expect(v.peakHeld).toBeLessThan(65_536 + s.head.length);
  });

  // RES-2: what the verifier holds depends on the moov, not on the mdat it streams.
  it("is walked holding the same bytes whatever the mdat's size", async () => {
    const template = await avFixture("r1-silent.mp4");
    const held = async (size: number) => {
      const s = syntheticMp4(template, { samples: 10, size, delta: 512 });
      const v = await verifyStream("video/mp4", s.stream(65_536), s.length);
      expect(v.ok, `${size}-byte samples`).toBe(true);
      expect(v.passed).toBe(s.length);
      // The head is ftyp (32 bytes), moov, free (8) and the mdat's header (8).
      return { peak: v.peakHeld, length: s.length, moov: s.head.length - 48 };
    };
    const small = await held(100 * 1024);
    const large = await held(6 * MIB);
    expect(large.length).toBeGreaterThan(60 * MIB);
    expect(large.peak).toBe(small.peak);
    // The moov, a box header, each sample's size and kind in file order (five bytes a sample) and the parser's
    // temporaries: the track's sizes and offsets (twelve bytes a sample) and its one stts run (two 8-byte numbers).
    expect(large.peak).toBe(large.moov + 8 + 10 * 5 + 10 * 12 + 2 * 8);
    console.log({ heldBytes: large.peak, moovBytes: large.moov, smallFile: small.length, largeFile: large.length });
  });
});

const mp3 = async (name = "m4a.mp3") => avFixture(name);

// The LAME tag's padding (12 bits after the delay's 12), set and the CRCs refreshed.
function withPadding(file: Uint8Array, padding: number): Uint8Array {
  const { lame } = xingLayout(file);
  return refreshXing(patch(file, lame + 22, [((file[lame + 22] ?? 0) & 0xf0) | (padding >> 8), padding & 0xff]));
}

// The byte offset of the n-th frame after the Xing frame.
function frameAt(file: Uint8Array, n: number): number {
  let at = xingLayout(file).frame;
  for (let i = 0; i < n; i++) {
    const h = u32At(file, at);
    const mpeg1 = ((h >>> 19) & 3) === 3;
    const rates = mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000];
    const kbps =
      (mpeg1
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
      )[(h >>> 12) & 15] ?? 0;
    at += Math.floor(((mpeg1 ? 144000 : 72000) * kbps) / (rates[(h >>> 10) & 3] ?? 1)) + ((h >>> 9) & 1);
  }
  return at;
}

const MP3_MUTATIONS: Mutation[] = [
  {
    name: "an ID3v2 tag first",
    rule: "id3v2",
    make: async () => concat(Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0), await mp3()),
  },
  {
    name: "an ID3v1 tag last",
    rule: "id3v1",
    make: async () => refreshXing(concat(await mp3(), Uint8Array.of(0x54, 0x41, 0x47), new Uint8Array(125))),
  },
  {
    name: "an APE tag last",
    rule: "ape",
    make: async () => refreshXing(concat(await mp3(), new TextEncoder().encode("APETAGEX"), new Uint8Array(24))),
  },
  {
    name: "a Lyrics3 tag last",
    rule: "lyrics3",
    make: async () => refreshXing(concat(await mp3(), new TextEncoder().encode("LYRICSBEGINKOPJELYRICS200"))),
  },
  {
    // Where an encoder writes VBRI (36 bytes in): the stereo fixture's Xing tag.
    name: "a VBRI header",
    rule: "vbri",
    make: async () => refreshXing(patch(await mp3("flac.mp3"), 36, [0x56, 0x42, 0x52, 0x49])),
  },
  {
    name: "a LAME delay other than 576",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      const { lame } = xingLayout(f);
      return refreshXing(patch(f, lame + 21, [(577 >> 4) & 0xff, ((577 & 0xf) << 4) | ((f[lame + 22] ?? 0) & 0xf)]));
    },
  },
  {
    name: "a padding of two frames (2304 samples)",
    rule: "xing",
    make: async () => withPadding(await mp3(), 2304),
  },
  {
    // One frame of 1152 samples, all of them the delay and padding: nothing presented.
    name: "a delay and padding covering every sample",
    rule: "xing",
    make: async () => withPadding(repeatedMp3(await mp3(), 1), 576),
  },
  {
    name: "LAME's encoder string",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      return refreshXing(patch(f, xingLayout(f).lame, [...new TextEncoder().encode("LAME3.100")]));
    },
  },
  {
    name: "a TOC entry off the muxer's",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      const at = xingLayout(f).xing + 16 + 50;
      return refreshXing(patch(f, at, [(f[at] ?? 0) + 1]));
    },
  },
  {
    name: "a frame count off the stream's",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      const at = xingLayout(f).xing + 8;
      return refreshXing(patch(f, at, u32(u32At(f, at) + 1)));
    },
  },
  {
    name: "a music CRC off the stream's",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      return refreshXing(f, 0x1234);
    },
  },
  {
    name: "a tag CRC off the tag's",
    rule: "xing",
    make: async () => {
      const f = await mp3();
      const at = xingLayout(f).lame + 34;
      return patch(f, at, u16((((f[at] ?? 0) << 8) | (f[at + 1] ?? 0)) ^ 1));
    },
  },
  {
    name: "a broken frame header",
    rule: "mp3_frame",
    make: async () => {
      const f = await mp3();
      return refreshXing(patch(f, frameAt(f, 5), [0x00]));
    },
  },
  {
    name: "a frame with the private bit",
    rule: "mp3_frame",
    make: async () => {
      const f = await mp3();
      const at = frameAt(f, 5) + 2;
      return refreshXing(patch(f, at, [(f[at] ?? 0) | 1]));
    },
  },
  {
    name: "a frame of another sample rate",
    rule: "mp3_stream",
    make: async () => {
      const f = await mp3();
      const at = frameAt(f, 5) + 2;
      return refreshXing(patch(f, at, [((f[at] ?? 0) & 0xf3) | 0x04]));
    },
  },
  {
    name: "a stereo frame among mono ones",
    rule: "mp3_stream",
    make: async () => {
      const f = await mp3();
      const at = frameAt(f, 5) + 3;
      return refreshXing(patch(f, at, [(f[at] ?? 0) & 0x3f]));
    },
  },
];

describe("an MP3 changed in one field", () => {
  for (const m of MP3_MUTATIONS) {
    it(`is refused: ${m.name} (${m.rule})`, async () => {
      expect(await rule("audio/mpeg", await m.make())).toBe(m.rule);
    });
  }

  it("is refused past AUDIO_DURATION_LIMIT and accepted at it, counting the presented samples", async () => {
    const f = await mp3();
    // 44.1 kHz MPEG-1, 1152 samples a frame: 45,938 frames less the delay 576 and a padding of 0 present exactly
    // 1200 s (#1828 A7); one sample more padding presents less, one frame more is over.
    const frames = (AUDIO_DURATION_LIMIT * 44_100 + 576) / 1152;
    expect(frames).toBe(45_938);
    const atLimit = withPadding(repeatedMp3(f, frames), 0);
    const facts = await verifyBytes("audio/mpeg", atLimit);
    expect(facts.ok && facts.facts.duration).toBe(AUDIO_DURATION_LIMIT);
    expect(await rule("audio/mpeg", withPadding(repeatedMp3(f, frames + 1), 1151))).toBe("duration_limit");
  });

  it("is refused for a length other than its Content-Length, or over AV_OUTPUT_LIMIT", async () => {
    const f = await mp3();
    expect(await rule("audio/mpeg", f, { contentLength: f.length + 1 })).toBe("xing");
    expect(await rule("audio/mpeg", f.slice(0, -1), { contentLength: f.length })).toBe("length");
    expect(await rule("audio/mpeg", f, { contentLength: f.length - 1 })).toBe("length");
    expect(await rule("audio/mpeg", f, { contentLength: AV_OUTPUT_LIMIT + 1 })).toBe("over_limit");
    expect(await rule("audio/mpeg", f, { expectedDuration: 5 })).toBe("short_output");
  });
});

describe("sniffAvUpload", () => {
  const bytes = (...parts: (string | number[])[]) =>
    concat(...parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : Uint8Array.from(p))));

  it("gives the provisional kind of each accepted signature, and null for any other", () => {
    const cases: [Uint8Array, "video" | "audio" | null][] = [
      [bytes([0, 0, 0, 32], "ftypisom", [0, 0, 2, 0]), "video"],
      [bytes([0, 0, 0, 32], "ftypqt  ", [0, 0, 2, 0]), "video"],
      [bytes([0, 0, 0, 32], "ftyp3gp4", [0, 0, 2, 0]), "video"],
      [bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 2, 0]), "audio"],
      [bytes([0, 0, 0, 32], "ftypM4B ", [0, 0, 2, 0]), "audio"],
      [bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), "video"],
      [bytes("OggS", [0, 2]), "video"],
      [bytes("fLaC", [0, 0, 0, 34]), "audio"],
      [bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "), "audio"],
      [bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), null],
      [bytes("ID3", [4, 0, 0, 0, 0, 0, 0]), "audio"],
      [bytes([0xff, 0xfb, 0x90, 0x64]), "audio"],
      [bytes([0xff, 0xf3, 0x90, 0x64]), "audio"],
      // ADTS (MPEG-4 and MPEG-2 AAC), not Layer III.
      [bytes([0xff, 0xf1, 0x50, 0x80]), "audio"],
      [bytes([0xff, 0xf9, 0x50, 0x80]), "audio"],
      // MPEG version "reserved", Layer I.
      [bytes([0xff, 0xeb, 0x90, 0x64]), null],
      [bytes([0xff, 0xff, 0x90, 0x64]), null],
      [bytes([0x89], "PNG\r\n\x1a\n"), null],
      [bytes([0xff, 0xd8, 0xff, 0xe0]), null],
      [bytes("<!DOCTYPE html>"), null],
      [new Uint8Array(), null],
    ];
    for (const [input, kind] of cases) {
      expect(sniffAvUpload(input), input.slice(0, 12).join(",")).toBe(kind);
    }
  });

  it("gives the shipped image's outputs their kinds", async () => {
    expect(sniffAvUpload(await avFixture("r1-av.mp4"))).toBe("video");
    expect(sniffAvUpload(await avFixture("m4a.mp3"))).toBe("audio");
  });
});

describe("verifyStill", () => {
  it("accepts a PNG within the limits and refuses metadata, size, a broken file and a long edge", () => {
    expect(verifyStill(PNG_PLAIN)).toBeNull();
    // A colour profile is kept.
    expect(verifyStill(PNG_ICC)).toBeNull();
    expect(verifyStill(PNG_WITH_GPS)).toBe("metadata");
    expect(verifyStill(PNG_PLAIN.slice(0, -4))).toBe("malformed");
    expect(verifyStill(new Uint8Array())).toBe("malformed");
    expect(verifyStill(new Uint8Array(STILL_OUTPUT_LIMIT + 1))).toBe("over_limit");
    const wide = PNG_PLAIN.slice();
    // IHDR's width (offset 16): 641.
    wide.set(u32(STILL_LONG_EDGE + 1), 16);
    expect(verifyStill(wide)).toBe("geometry");
    const edge = PNG_PLAIN.slice();
    edge.set(u32(STILL_LONG_EDGE), 16);
    expect(verifyStill(edge)).toBeNull();
  });
});
