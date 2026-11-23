// Byte-level checks of video and audio (#1828; MEDIA-3, MEDIA-4, RES-2):
//   - sniffAvUpload: the provisional kind of an upload from its signature (design 4.7 step 2), never from the client's
//     Content-Type or file name. The verified output corrects it.
//   - avVerifier, verifyMp4, verifyMp3: the media processor's output, read once as a stream. Every container field is
//     fixed, bounded or derived from the tables and checked, so a file is published only as the shipped image writes
//     it. Written apart from the container's own code (container/server/mp4strip.go): only an independent walker found
//     what ffmpeg leaves behind.
//   - verifyStill: the processor's PNG still.
//
// The verifier is a TransformStream that passes the bytes through unchanged and settles `verdict` at the end of the
// stream, or errors the stream at the first refusal, so a caller can tee the same bytes into an R2 multipart upload and
// complete it only after an accepting verdict. Memory is bounded: an MP4's moov (at most MOOV_LIMIT bytes, before the
// mdat, as +faststart writes it), the tables derived from it, the first MP3 frame and a few header bytes; the rest is
// walked as it passes. Work is linear: sample payloads are skipped by their lengths, only NAL headers and MP3 frame
// headers are read, and the SHA-256 runs in the same pass.
//
// MP4 (the shipped image's H.264/AAC output, design 4.10, as the image writes it at ffmpeg n9.0.2):
//   top level  ftyp, moov, one empty 8-byte free, mdat, nothing after.
//   moov       mvhd, one avc1 video track and at most one mp4a track. trak: tkhd, edts/elst, mdia/{mdhd, hdlr,
//              minf/{vmhd|smhd, dinf/dref, stbl}}. stbl: stsd, stts, stss, ctts, stsc, stsz, stco|co64, and on the
//              audio track only sgpd/sbgp of type roll.
//   fields     mvhd version 0, times 0, timescale 1000, rate 1, volume 1, identity matrix; tkhd flags 3, times 0,
//              layer 0, alternate group 0 (video) or 1 (audio) and volume 0 or 1 as the muxer writes them per kind,
//              identity matrix, the SPS's dimensions; mdhd times 0, language und; hdlr VideoHandler/SoundHandler; one
//              self-contained url; avc1 with avcC, colr (nclx BT.709 limited range) and pasp 1:1 and nothing else, no
//              compressor name; avcC High, level <= 4.2, one SPS and one PPS, both parsed to their trailing bits; mp4a
//              stereo 16-bit 44.1 or 48 kHz with an esds whose descriptors are fixed but for the bitrates, the average
//              derived from the track (as the muxer computes it) and the maximum the larger of a ladder's audio rate
//              and that average.
//   durations  each track's stts sums to its mdhd duration; one media edit (after at most one empty edit) inside the
//              track's composition span, starting at video's first composition time (at most REORDER_FRAMES of its
//              longest sample duration) and after at most one AAC frame of audio priming; tkhd = the edit list's total (or one tick more, rounding); mvhd = the longest tkhd;
//              mvhd, every tkhd and every track's presented samples (mdhd less the media edit's media time) within
//              VIDEO_DURATION_LIMIT.
//   tables     equal sample counts; at most VIDEO_SAMPLE_LIMIT video samples; chunk offsets inside the mdat, the
//              samples tiling it exactly; frame rate and geometry within the caps of the ladder's rung for mvhd's
//              duration (OUTPUT_LADDER, with RUNG_SLACK_MS).
//   payload    each video sample is length-prefixed NAL units of types 1 and 5 filling it. AAC and MP3 frame data are
//              not parsed (design section 6, residual 1).
// MP3: no ID3v2, ID3v1, APE, Lyrics3 or VBRI; a first Xing/Info frame whose LAME fields are fixed or derived (its frame
// and byte counts, the TOC as the muxer computes it, the music length and both CRCs; the delay 576 and a padding under
// two frames), with the encoder string exactly "Lavf"; then MPEG-1 or MPEG-2 Layer III frames of the Xing frame's
// version and sample rate and of one channel mode (the Xing frame's is stereo for stereo or joint stereo frames, mono
// for mono) ending at EOF, whose samples less that delay and padding are at most AUDIO_DURATION_LIMIT.

import { ascii, MALFORMED, retainedMetadata, walkPng } from "./image-bytes";

const MIB = 1024 * 1024;

// Output limits (design 4.11). AV_OUTPUT_LIMIT stays below the backup's MAX_MEDIA_BYTES (test/av-bytes.test.ts).
export const AV_OUTPUT_LIMIT = 63 * MIB;
export const STILL_OUTPUT_LIMIT = 2 * MIB;
export const MOOV_LIMIT = 4 * MIB;
// Seconds.
export const VIDEO_DURATION_LIMIT = 600;
export const AUDIO_DURATION_LIMIT = 20 * 60;
// Mastodon 4.7.5's frame limit (app/models/media_attachment.rb), which the encoder also caps.
export const VIDEO_SAMPLE_LIMIT = 36_000;
// An AAC track's priming: at most one frame (#1828 A7).
const AAC_PRIMING_LIMIT = 2048;
// An AAC track's samples (1024 each at at most 48 kHz) within VIDEO_DURATION_LIMIT, its priming besides, and one more
// for a last frame the rounding splits.
export const AUDIO_SAMPLE_LIMIT = Math.ceil((VIDEO_DURATION_LIMIT * 48_000 + AAC_PRIMING_LIMIT) / 1024) + 1;
// The output ladder's top rung (container/server/plan.go): its frame rate and geometry bound every rung's.
export const FRAME_RATE_LIMIT = 60;
export const OUTPUT_LONG_EDGE = 1920;
export const OUTPUT_SHORT_EDGE = 1080;
// plan.go's ladder: the first rung whose duration takes the output's gives its caps. plan.go picks it by the source's
// duration, which the output may run past by a 30 fps frame and an AAC frame (at 44.1 kHz): RUNG_SLACK_MS, that
// rounded up to 100 ms, lets an output that long still take its source's rung.
export const OUTPUT_LADDER = [
  { durationMs: 120_000, longEdge: OUTPUT_LONG_EDGE, shortEdge: OUTPUT_SHORT_EDGE, fps: FRAME_RATE_LIMIT },
  { durationMs: 300_000, longEdge: 1280, shortEdge: 720, fps: 30 },
  { durationMs: VIDEO_DURATION_LIMIT * 1000, longEdge: 854, shortEdge: 480, fps: 30 },
] as const;
export const RUNG_SLACK_MS = Math.ceil((1000 / 30 + (1024 * 1000) / 44_100) / 100) * 100;
// x264's reorder delay at the pinned veryfast preset (3 B-frames, normal B-pyramid): the frames the first composition
// time may follow the first decode time by, so a video edit's media time.
const REORDER_FRAMES = 2;
export const STILL_LONG_EDGE = 640;
// The ladder's AAC bitrates (plan.go), the only maxima an esds may state.
const AAC_BITRATES: ReadonlySet<number> = new Set([128_000, 192_000]);
const AAC_RATES: ReadonlySet<number> = new Set([44_100, 48_000]);
const MOVIE_TIMESCALE = 1000;
const AVC_LEVEL_LIMIT = 42;
const HIGH_PROFILE = 100;

// Each rule of design 4.10 has its code. "length" and "over_limit" apply to every kind.
export type AvRule =
  | "length"
  | "over_limit"
  | "short_output"
  | "top_level"
  | "ftyp"
  | "moov_size"
  | "free"
  | "malformed"
  | "box"
  | "tracks"
  | "mvhd"
  | "tkhd"
  | "mdhd"
  | "hdlr"
  | "vmhd"
  | "smhd"
  | "dref"
  | "stsd"
  | "avc1"
  | "avcC"
  | "sps"
  | "pps"
  | "geometry"
  | "colr"
  | "pasp"
  | "mp4a"
  | "esds"
  | "sample_group"
  | "elst"
  | "sample_time"
  | "presentation"
  | "duration_limit"
  | "sample_count"
  | "sample_cap"
  | "sync_samples"
  | "chunks"
  | "chunk_offset"
  | "tiling"
  | "frame_rate"
  | "nal"
  | "id3v2"
  | "id3v1"
  | "ape"
  | "lyrics3"
  | "vbri"
  | "xing"
  | "mp3_frame"
  | "mp3_stream";

type VideoFacts = {
  kind: "video";
  width: number;
  height: number;
  // Mastodon's meta.original.frame_rate: "<num>/<den>", reduced.
  frameRate: string;
  // Seconds, from mvhd.
  duration: number;
  // Bits per second over the whole file.
  bitrate: number;
  bytes: number;
  sha256: string;
  audio: boolean;
};

type AudioFacts = {
  kind: "audio";
  duration: number;
  bitrate: number;
  bytes: number;
  sha256: string;
  sampleRate: number;
  channels: 1 | 2;
};

export type AvVerdict<F = VideoFacts | AudioFacts> = { ok: true; facts: F } | { ok: false; rule: AvRule };

export type AvVerifyOptions = {
  // The duration the container planned (the Worker passes it on): an output shorter by more than a second or by more
  // than 10 % is refused (short_output).
  expectedDuration?: number;
};

export type AvType = "video/mp4" | "audio/mpeg";

export class AvRefusal extends Error {
  constructor(readonly rule: AvRule) {
    super(`media output refused: ${rule}`);
  }
}

// The SHA-256 of the stream, fed in the same pass.
function digestStreamHasher(): { write(chunk: Uint8Array): Promise<void>; digest(): Promise<ArrayBuffer> } {
  const stream = new crypto.DigestStream("SHA-256");
  const writer = stream.getWriter();
  return {
    write: (chunk) => writer.write(chunk),
    digest: async () => {
      await writer.close();
      return stream.digest;
    },
  };
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What a byte walker reports: null to go on, or a refusal.
type WalkedFacts = Omit<VideoFacts, "sha256"> | Omit<AudioFacts, "sha256">;

interface Walker<F extends WalkedFacts> {
  push(chunk: Uint8Array): AvRule | null;
  end(): AvRule | F;
  // The most bytes it held at once (buffers and tables), for the held-bytes witness.
  peak(): number;
}

// The verifier of one output: a TransformStream passing the bytes through, `verdict` settling at its end or at the
// first refusal (which also errors the stream). `peakHeld` is the most the walker held at once.
export function avVerifier(
  type: AvType,
  contentLength: number,
  options: AvVerifyOptions = {},
): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  verdict: Promise<AvVerdict>;
  // Settles an unsettled verdict as a refusal (length): for a caller whose source failed before the stream ended.
  abort: () => void;
  peakHeld: () => number;
} {
  let settle: (verdict: AvVerdict) => void = () => {};
  const verdict = new Promise<AvVerdict>((resolve) => {
    settle = resolve;
  });
  let peak = 0;
  let read = 0;
  let done = false;
  const valid = Number.isSafeInteger(contentLength) && contentLength > 0;
  const walker: Walker<WalkedFacts> | null = !valid
    ? null
    : type === "video/mp4"
      ? new Mp4Walker(contentLength)
      : new Mp3Walker(contentLength);
  const hasher = digestStreamHasher();
  const refuse = (rule: AvRule, controller: TransformStreamDefaultController<Uint8Array>) => {
    done = true;
    settle({ ok: false, rule });
    controller.error(new AvRefusal(rule));
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      if (walker === null) {
        refuse(valid ? "length" : contentLength > AV_OUTPUT_LIMIT ? "over_limit" : "length", controller);
      } else if (contentLength > AV_OUTPUT_LIMIT) {
        refuse("over_limit", controller);
      }
    },
    async transform(chunk, controller) {
      if (done || walker === null) {
        return;
      }
      read += chunk.byteLength;
      if (read > AV_OUTPUT_LIMIT) {
        return refuse("over_limit", controller);
      }
      if (read > contentLength) {
        return refuse("length", controller);
      }
      const rule = walker.push(chunk);
      peak = walker.peak();
      if (rule !== null) {
        return refuse(rule, controller);
      }
      await hasher.write(chunk);
      controller.enqueue(chunk);
    },
    async flush(controller) {
      if (done || walker === null) {
        return;
      }
      if (read !== contentLength) {
        return refuse("length", controller);
      }
      const facts = walker.end();
      if (typeof facts === "string") {
        return refuse(facts, controller);
      }
      const expected = options.expectedDuration;
      if (expected !== undefined && (expected - facts.duration > 1 || expected - facts.duration > expected * 0.1)) {
        return refuse("short_output", controller);
      }
      done = true;
      settle({ ok: true, facts: { ...facts, sha256: hex(await hasher.digest()) } });
    },
  });
  const abort = () => {
    if (!done) {
      done = true;
      settle({ ok: false, rule: "length" });
    }
  };
  return { stream, verdict, abort, peakHeld: () => peak };
}

async function verifyBody(
  type: AvType,
  body: ReadableStream<Uint8Array>,
  contentLength: number,
  options?: AvVerifyOptions,
): Promise<AvVerdict> {
  const { stream, verdict, abort } = avVerifier(type, contentLength, options);
  // A refusal errors the pipe and the verdict carries its rule; a source that fails first is refused as length.
  await body.pipeThrough(stream).pipeTo(new WritableStream<Uint8Array>()).catch(abort);
  return verdict;
}

export function verifyMp4(
  body: ReadableStream<Uint8Array>,
  contentLength: number,
  options?: AvVerifyOptions,
): Promise<AvVerdict> {
  return verifyBody("video/mp4", body, contentLength, options);
}

export function verifyMp3(
  body: ReadableStream<Uint8Array>,
  contentLength: number,
  options?: AvVerifyOptions,
): Promise<AvVerdict> {
  return verifyBody("audio/mpeg", body, contentLength, options);
}

// ---- The still (design 4.10 "Still")

export type StillRefusal = "over_limit" | "malformed" | "metadata" | "geometry";

// The processor's PNG still: at most STILL_OUTPUT_LIMIT bytes, a whole PNG, no metadata but colour, long edge at most
// STILL_LONG_EDGE. null when it passes.
export function verifyStill(bytes: Uint8Array): StillRefusal | null {
  if (bytes.byteLength === 0 || bytes.byteLength > STILL_OUTPUT_LIMIT) {
    return bytes.byteLength === 0 ? "malformed" : "over_limit";
  }
  let size: { width: number; height: number } | null = null;
  const walked = walkPng(bytes, (type, start, length) => {
    if (type === "IHDR" && length === 13 && size === null) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
      size = { width: view.getUint32(0), height: view.getUint32(4) };
    }
    return undefined;
  });
  if (walked === MALFORMED || size === null) {
    return "malformed";
  }
  if (retainedMetadata(bytes, "image/png") !== null) {
    return "metadata";
  }
  const { width, height } = size;
  return width === 0 || height === 0 || Math.max(width, height) > STILL_LONG_EDGE ? "geometry" : null;
}

// ---- The upload's signature (design 4.7 step 2)

export type AvKind = "video" | "audio";

// ISO-BMFF major brands of audio-only files (M4A, M4B, and 3GPP's audio brand); any other ISO-BMFF is video.
const AUDIO_BRANDS: ReadonlySet<string> = new Set(["M4A ", "M4B ", "M4P ", "3ga4"]);

// The provisional kind of an upload's first bytes, or null when no accepted signature matches. Video: ISO-BMFF (but
// the audio brands), Matroska/WebM and Ogg; audio: those brands, MP3 (an ID3v2 tag or a Layer III frame header), FLAC,
// WAV and ADTS AAC.
export function sniffAvUpload(bytes: Uint8Array): AvKind | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    return AUDIO_BRANDS.has(ascii(bytes, 8, 4)) ? "audio" : "video";
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) {
    return "video";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "OggS") {
    return "video";
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === "fLaC") {
    return "audio";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
    return "audio";
  }
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") {
    return "audio";
  }
  if (at(0) === 0xff && (at(1) & 0xe0) === 0xe0) {
    const layer = (at(1) >> 1) & 3;
    const version = (at(1) >> 3) & 3;
    // ADTS: MPEG-4 or MPEG-2 AAC, layer 0. MP3: Layer III (1) of a known version.
    if (layer === 0 && (at(1) & 0xf6) === 0xf0) {
      return "audio";
    }
    if (layer === 1 && version !== 1) {
      return "audio";
    }
  }
  return null;
}

// ---- MP4

type Box = { type: string; start: number; end: number };

function fail(rule: AvRule): never {
  throw new AvRefusal(rule);
}

function check(ok: boolean, rule: AvRule): void {
  if (!ok) {
    fail(rule);
  }
}

// The child boxes of moov's range start..end, with 32-bit sizes only (the muxer writes no other inside moov).
function children(b: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let i = start;
  while (i < end) {
    check(end - i >= 8, "malformed");
    const size = view.getUint32(i);
    check(size >= 8 && i + size <= end, "malformed");
    out.push({ type: ascii(b, i + 4, 4), start: i + 8, end: i + size });
    i += size;
  }
  return out;
}

// The children, which must be exactly `allowed` in that order, optional ones (ending in "?") possibly absent.
function exactly(b: Uint8Array, view: DataView, parent: Box, allowed: string[]): Map<string, Box> {
  const found = children(b, view, parent.start, parent.end);
  const out = new Map<string, Box>();
  let k = 0;
  for (const name of allowed) {
    const optional = name.endsWith("?");
    const types = (optional ? name.slice(0, -1) : name).split("|");
    const box = found[k];
    if (box !== undefined && types.includes(box.type)) {
      out.set(types.length > 1 ? types.join("|") : box.type, box);
      out.set(box.type, box);
      k++;
    } else {
      check(optional, "box");
    }
  }
  check(k === found.length, "box");
  return out;
}

function zero(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (b[i] !== 0) {
      return false;
    }
  }
  return true;
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function identity(view: DataView, at: number): boolean {
  return IDENTITY.every((v, i) => view.getUint32(at + i * 4) === v);
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

type Track = {
  video: boolean;
  id: number;
  tkhdDuration: number;
  timescale: number;
  mediaDuration: number;
  // The media edit's media time: the samples before it are not presented (AAC's priming, x264's reorder delay).
  mediaTime: number;
  samples: number;
  sizes: Uint32Array;
  offsets: Float64Array; // each sample's file offset
  // The bytes its tables held while parsed.
  held: number;
  minDelta: number;
  singleDelta: number | null;
  width: number;
  height: number;
};

type Mp4Layout = {
  mdatStart: number;
  // Where the last sample ends: the mdat's end, which must be the file's (checked at the mdat's header).
  samplesEnd: number;
  // The samples in file order: their sizes and whether each is video.
  sizes: Uint32Array;
  video: Uint8Array;
  facts: Omit<VideoFacts, "sha256" | "bytes" | "bitrate">;
  durationMs: number;
  // The bytes parseMoov's temporaries held at once: every track's tables and these.
  parsed: number;
};

// Exp-Golomb and fixed-width reads over an RBSP, bounded: a code of more than 31 leading zeros is refused.
class Bits {
  private bit = 0;
  constructor(
    private readonly bytes: Uint8Array,
    private readonly rule: AvRule,
  ) {}
  get position(): number {
    return this.bit;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      check(this.bit < this.bytes.length * 8, this.rule);
      v = v * 2 + (((this.bytes[this.bit >> 3] ?? 0) >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      check(zeros <= 31, this.rule);
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
  // The position of the RBSP's stop bit: the last 1 bit, which must be in the last byte.
  stopBit(): number {
    const last = this.bytes[this.bytes.length - 1] ?? 0;
    check(last !== 0, this.rule);
    let i = 7;
    while (((last >> (7 - i)) & 1) === 0) {
      i--;
    }
    return (this.bytes.length - 1) * 8 + i;
  }
  // The parse ended exactly at the stop bit.
  trailing(): void {
    check(this.bit === this.stopBit(), this.rule);
  }
}

// A NAL unit's RBSP: its payload after the header byte with emulation prevention bytes removed.
function rbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const byte = nal[i] ?? 0;
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out.push(byte);
  }
  return Uint8Array.from(out);
}

type Sps = { width: number; height: number; constraints: number; level: number };

// The SPS of the avcC (ITU-T H.264 7.3.2.1.1, E.1.1): High profile 4:2:0 8-bit progressive, no scaling matrices, the
// colour description BT.709 limited range, square pixels if stated, no HRD or picture timing, read to its trailing
// bits.
function parseSps(nal: Uint8Array): Sps {
  check(nal.length >= 4 && ((nal[0] ?? 0) & 0x9f) === 0x07 && ((nal[0] ?? 0) & 0x60) !== 0, "sps");
  const r = new Bits(rbsp(nal), "sps");
  check(r.u(8) === HIGH_PROFILE, "sps");
  const constraints = r.u(8);
  const level = r.u(8);
  check(level <= AVC_LEVEL_LIMIT, "sps");
  check(r.ue() === 0, "sps"); // seq_parameter_set_id
  check(r.ue() === 1, "sps"); // chroma_format_idc 4:2:0
  check(r.ue() === 0 && r.ue() === 0, "sps"); // 8-bit luma and chroma
  check(r.u(1) === 0 && r.u(1) === 0, "sps"); // no transform bypass, no scaling matrix
  check(r.ue() <= 12, "sps"); // log2_max_frame_num_minus4
  const pocType = r.ue();
  check(pocType === 0 || pocType === 2, "sps");
  if (pocType === 0) {
    check(r.ue() <= 12, "sps");
  }
  check(r.ue() <= 16, "sps"); // max_num_ref_frames
  check(r.u(1) === 0, "sps"); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMbs = r.ue() + 1;
  check(widthMbs <= 512 && heightMbs <= 512, "sps");
  check(r.u(1) === 1, "sps"); // frame_mbs_only_flag
  r.u(1); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.u(1) === 1) {
    crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  }
  const [left = 0, right = 0, top = 0, bottom = 0] = crop;
  const width = widthMbs * 16 - 2 * (left + right);
  const height = heightMbs * 16 - 2 * (top + bottom);
  check(width > 0 && height > 0, "sps");
  check(r.u(1) === 1, "sps"); // vui_parameters_present_flag: the colour description is required
  if (r.u(1) === 1) {
    const idc = r.u(8);
    if (idc === 255) {
      check(r.u(16) === 1 && r.u(16) === 1, "sps");
    } else {
      check(idc === 1, "sps");
    }
  }
  check(r.u(1) === 0, "sps"); // overscan_info_present_flag
  check(r.u(1) === 1, "sps"); // video_signal_type_present_flag
  r.u(3); // video_format
  check(r.u(1) === 0, "sps"); // limited range
  check(r.u(1) === 1 && r.u(8) === 1 && r.u(8) === 1 && r.u(8) === 1, "sps"); // BT.709 primaries, transfer, matrix
  if (r.u(1) === 1) {
    check(r.ue() <= 5 && r.ue() <= 5, "sps");
  }
  if (r.u(1) === 1) {
    const units = r.u(32);
    const scale = r.u(32);
    check(units > 0 && scale > 0 && scale <= 2 * FRAME_RATE_LIMIT * units, "sps");
    r.u(1);
  }
  check(r.u(1) === 0 && r.u(1) === 0, "sps"); // no NAL or VCL HRD
  check(r.u(1) === 0, "sps"); // pic_struct_present_flag
  if (r.u(1) === 1) {
    r.u(1);
    check(r.ue() <= 16 && r.ue() <= 16 && r.ue() <= 16 && r.ue() <= 16, "sps");
    check(r.ue() <= 16 && r.ue() <= 16, "sps");
  }
  r.trailing();
  return { width, height, constraints, level };
}

// The PPS (7.3.2.2): one slice group, no redundant pictures, no scaling matrices, read to its trailing bits.
function parsePps(nal: Uint8Array): void {
  check(nal.length >= 2 && ((nal[0] ?? 0) & 0x9f) === 0x08 && ((nal[0] ?? 0) & 0x60) !== 0, "pps");
  const r = new Bits(rbsp(nal), "pps");
  check(r.ue() === 0 && r.ue() === 0, "pps"); // pic and seq parameter set ids
  r.u(1); // entropy_coding_mode_flag
  check(r.u(1) === 0, "pps"); // bottom_field_pic_order_in_frame_present_flag
  check(r.ue() === 0, "pps"); // num_slice_groups_minus1
  check(r.ue() <= 31 && r.ue() <= 31, "pps");
  r.u(1);
  check(r.u(2) <= 2, "pps"); // weighted_bipred_idc
  const qp = r.se();
  const qs = r.se();
  const chroma = r.se();
  check(qp >= -26 && qp <= 25 && qs >= -26 && qs <= 25 && chroma >= -12 && chroma <= 12, "pps");
  r.u(1);
  r.u(1);
  check(r.u(1) === 0, "pps"); // redundant_pic_cnt_present_flag
  if (r.position < r.stopBit()) {
    r.u(1); // transform_8x8_mode_flag
    check(r.u(1) === 0, "pps"); // pic_scaling_matrix_present_flag
    const second = r.se();
    check(second >= -12 && second <= 12, "pps");
  }
  r.trailing();
}

function fullBox(view: DataView, box: Box, version: number, flags: number, rule: AvRule): void {
  check(box.end - box.start >= 4 && view.getUint32(box.start) === version * 2 ** 24 + flags, rule);
}

// The AudioSpecificConfig the AAC encoder writes: AAC-LC, the rate's index, two channels, then the explicit
// backward-compatible signal of no SBR.
function audioSpecificConfig(rate: number): number[] {
  const index = rate === 48_000 ? 3 : 4;
  return [0x10 | (index >> 1), ((index & 1) << 7) | (2 << 3), 0x56, 0xe5, 0x00];
}

function parseMoov(b: Uint8Array, moovStart: number, moovEnd: number, fileEnd: number): Mp4Layout {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // Offsets inside `b` are relative to moov's first byte; the mdat follows moov, the free box and its own header.
  const base = moovStart;
  const mdatStart = moovEnd + 8 + 8;
  const top = children(b, view, 8, b.length);
  check(top[0]?.type === "mvhd" && top.slice(1).every((t) => t.type === "trak") && top.length >= 2, "box");
  const mvhd = top[0] as Box;
  // mvhd: version 0, no times, timescale 1000, rate 1, volume 1, reserved zero, identity matrix, pre_defined zero.
  check(mvhd.end - mvhd.start === 100, "mvhd");
  fullBox(view, mvhd, 0, 0, "mvhd");
  const m = mvhd.start;
  check(view.getUint32(m + 4) === 0 && view.getUint32(m + 8) === 0, "mvhd");
  check(view.getUint32(m + 12) === MOVIE_TIMESCALE, "mvhd");
  const movieDuration = view.getUint32(m + 16);
  check(view.getUint32(m + 20) === 0x10000 && view.getUint16(m + 24) === 0x100, "mvhd");
  check(zero(b, m + 26, m + 36) && identity(view, m + 36) && zero(b, m + 72, m + 96), "mvhd");
  const traks = top.slice(1);
  check(traks.length <= 2, "tracks");
  check(view.getUint32(m + 96) === traks.length + 1, "mvhd");

  const tracks = traks.map((trak, index) => parseTrak(b, view, trak, index + 1, base, mdatStart, fileEnd));
  check(tracks[0]?.video === true && tracks.slice(1).every((t) => !t.video), "tracks");
  const video = tracks[0] as Track;

  // Durations: the presentation timeline (tkhd from the edit list, checked in parseTrak) gives mvhd, the longest
  // tkhd; the limit holds on mvhd, so on every tkhd, and on every track's presented samples, those after its media
  // edit's media time (#1828 A7: an AAC track at exactly the limit holds its priming besides).
  check(movieDuration === Math.max(...tracks.map((t) => t.tkhdDuration)), "presentation");
  check(movieDuration > 0 && movieDuration <= VIDEO_DURATION_LIMIT * MOVIE_TIMESCALE, "duration_limit");
  for (const t of tracks) {
    check(t.mediaDuration - t.mediaTime <= VIDEO_DURATION_LIMIT * t.timescale, "duration_limit");
  }
  // The caps of the rung for this duration (the last rung takes every duration within the limit, checked above).
  const rung = OUTPUT_LADDER.find((r) => movieDuration <= r.durationMs + RUNG_SLACK_MS) ?? OUTPUT_LADDER[2];
  check(video.minDelta * rung.fps >= video.timescale, "frame_rate");
  check(
    Math.max(video.width, video.height) <= rung.longEdge && Math.min(video.width, video.height) <= rung.shortEdge,
    "geometry",
  );

  // The samples of all tracks in file order tile the mdat exactly: each track's offsets increase, and merged they
  // follow one another from the mdat's first byte to the file's end.
  const total = tracks.reduce((n, t) => n + t.samples, 0);
  const sizes = new Uint32Array(total);
  const kinds = new Uint8Array(total);
  const cursor = tracks.map(() => 0);
  let at = mdatStart;
  for (let k = 0; k < total; k++) {
    const next = tracks.findIndex((t, i) => (cursor[i] ?? 0) < t.samples && t.offsets[cursor[i] ?? 0] === at);
    check(next >= 0, "tiling");
    const t = tracks[next] as Track;
    const i = cursor[next] ?? 0;
    sizes[k] = t.sizes[i] ?? 0;
    kinds[k] = t.video ? 1 : 0;
    at += t.sizes[i] ?? 0;
    cursor[next] = i + 1;
  }

  const g = video.singleDelta === null ? 1 : gcd(video.timescale, video.singleDelta);
  const frameRate =
    video.singleDelta === null
      ? (() => {
          const num = video.samples * video.timescale;
          const d = gcd(num, video.mediaDuration);
          return `${num / d}/${video.mediaDuration / d}`;
        })()
      : `${video.timescale / g}/${video.singleDelta / g}`;
  return {
    mdatStart,
    samplesEnd: at,
    sizes,
    video: kinds,
    durationMs: movieDuration,
    parsed: tracks.reduce((n, t) => n + t.held, sizes.byteLength + kinds.byteLength),
    facts: {
      kind: "video",
      width: video.width,
      height: video.height,
      frameRate,
      duration: movieDuration / MOVIE_TIMESCALE,
      audio: tracks.length === 2,
    },
  };
}

function parseTrak(
  b: Uint8Array,
  view: DataView,
  trak: Box,
  id: number,
  base: number,
  mdatStart: number,
  fileEnd: number,
): Track {
  const parts = exactly(b, view, trak, ["tkhd", "edts?", "mdia"]);
  const mdia = exactly(b, view, parts.get("mdia") as Box, ["mdhd", "hdlr", "minf"]);

  // hdlr: the kind, and the muxer's exact name.
  const hdlr = mdia.get("hdlr") as Box;
  fullBox(view, hdlr, 0, 0, "hdlr");
  const handler = ascii(b, hdlr.start + 8, 4);
  check(handler === "vide" || handler === "soun", "hdlr");
  const video = handler === "vide";
  const name = video ? "VideoHandler\0" : "SoundHandler\0";
  check(
    hdlr.end - hdlr.start === 24 + name.length &&
      view.getUint32(hdlr.start + 4) === 0 &&
      zero(b, hdlr.start + 12, hdlr.start + 24) &&
      ascii(b, hdlr.start + 24, name.length) === name,
    "hdlr",
  );

  // tkhd: flags 3 (enabled, in movie), no times, the track's id, layer 0, the alternate group and volume the muxer
  // writes for the kind (0 and 0 for video, 1 and 1.0 for audio), identity matrix.
  const tkhd = parts.get("tkhd") as Box;
  const t = tkhd.start;
  check(tkhd.end - t === 84, "tkhd");
  fullBox(view, tkhd, 0, 3, "tkhd");
  check(view.getUint32(t + 4) === 0 && view.getUint32(t + 8) === 0 && view.getUint32(t + 12) === id, "tkhd");
  check(view.getUint32(t + 16) === 0 && zero(b, t + 24, t + 32), "tkhd");
  const tkhdDuration = view.getUint32(t + 20);
  check(view.getUint16(t + 32) === 0 && view.getUint16(t + 34) === (video ? 0 : 1), "tkhd");
  check(view.getUint16(t + 36) === (video ? 0 : 0x100) && view.getUint16(t + 38) === 0, "tkhd");
  check(identity(view, t + 40), "tkhd");
  const tkhdWidth = view.getUint32(t + 76);
  const tkhdHeight = view.getUint32(t + 80);

  // mdhd: version 0, no times, a timescale, language und.
  const mdhd = mdia.get("mdhd") as Box;
  check(mdhd.end - mdhd.start === 24, "mdhd");
  fullBox(view, mdhd, 0, 0, "mdhd");
  const h = mdhd.start;
  check(view.getUint32(h + 4) === 0 && view.getUint32(h + 8) === 0, "mdhd");
  const timescale = view.getUint32(h + 12);
  const mediaDuration = view.getUint32(h + 16);
  check(timescale > 0 && view.getUint16(h + 20) === 0x55c4 && view.getUint16(h + 22) === 0, "mdhd");

  const minf = exactly(b, view, mdia.get("minf") as Box, [video ? "vmhd" : "smhd", "dinf", "stbl"]);
  if (video) {
    const vmhd = minf.get("vmhd") as Box;
    check(vmhd.end - vmhd.start === 12, "vmhd");
    fullBox(view, vmhd, 0, 1, "vmhd");
    check(zero(b, vmhd.start + 4, vmhd.end), "vmhd");
  } else {
    const smhd = minf.get("smhd") as Box;
    check(smhd.end - smhd.start === 8, "smhd");
    fullBox(view, smhd, 0, 0, "smhd");
    check(zero(b, smhd.start + 4, smhd.end), "smhd");
  }
  const dinf = exactly(b, view, minf.get("dinf") as Box, ["dref"]);
  const dref = dinf.get("dref") as Box;
  check(dref.end - dref.start === 20, "dref");
  fullBox(view, dref, 0, 0, "dref");
  const d = dref.start;
  check(view.getUint32(d + 4) === 1 && view.getUint32(d + 8) === 12 && ascii(b, d + 12, 4) === "url ", "dref");
  check(view.getUint32(d + 16) === 1, "dref");

  const stbl = exactly(
    b,
    view,
    minf.get("stbl") as Box,
    video
      ? ["stsd", "stts", "stss?", "ctts?", "stsc", "stsz", "stco|co64"]
      : ["stsd", "stts", "stsc", "stsz", "stco|co64", "sgpd?", "sbgp?"],
  );

  // stsd: one sample entry of the kind's codec.
  const stsd = stbl.get("stsd") as Box;
  fullBox(view, stsd, 0, 0, "stsd");
  check(view.getUint32(stsd.start + 4) === 1, "stsd");
  const entries = children(b, view, stsd.start + 8, stsd.end);
  check(entries.length === 1 && entries[0]?.type === (video ? "avc1" : "mp4a"), "stsd");
  const entry = entries[0] as Box;
  let width = 0;
  let height = 0;
  if (video) {
    const sps = parseAvc1(b, view, entry);
    width = sps.width;
    height = sps.height;
    check(tkhdWidth === width * 0x10000 && tkhdHeight === height * 0x10000, "tkhd");
  } else {
    check(tkhdWidth === 0 && tkhdHeight === 0, "tkhd");
  }

  // stts: the sample time.
  const stts = stbl.get("stts") as Box;
  fullBox(view, stts, 0, 0, "sample_count");
  const sttsEntries = view.getUint32(stts.start + 4);
  check(stts.end - stts.start === 8 + sttsEntries * 8 && sttsEntries > 0, "sample_count");
  let samples = 0;
  let sampleTime = 0;
  let minDelta = Number.POSITIVE_INFINITY;
  let maxDelta = 0;
  const deltas: number[] = [];
  for (let i = 0; i < sttsEntries; i++) {
    const count = view.getUint32(stts.start + 8 + i * 8);
    const delta = view.getUint32(stts.start + 12 + i * 8);
    check(count > 0 && delta > 0, "sample_time");
    samples += count;
    // Bounded before any table is expanded to the count.
    check(samples <= (video ? VIDEO_SAMPLE_LIMIT : AUDIO_SAMPLE_LIMIT), "sample_cap");
    sampleTime += count * delta;
    minDelta = Math.min(minDelta, delta);
    maxDelta = Math.max(maxDelta, delta);
    deltas.push(count, delta);
  }
  check(sampleTime === mediaDuration, "sample_time");

  // stsz: one size per sample, or one size for all (the muxer writes that when every sample has it).
  const stsz = stbl.get("stsz") as Box;
  fullBox(view, stsz, 0, 0, "sample_count");
  const fixedSize = view.getUint32(stsz.start + 4);
  check(view.getUint32(stsz.start + 8) === samples, "sample_count");
  check(stsz.end - stsz.start === (fixedSize === 0 ? 12 + samples * 4 : 12), "sample_count");
  // A size for all samples states their total, which the mdat must hold.
  check(fixedSize * samples <= fileEnd - mdatStart, "sample_count");
  const sizes = new Uint32Array(samples);
  for (let i = 0; i < samples; i++) {
    sizes[i] = fixedSize === 0 ? view.getUint32(stsz.start + 12 + i * 4) : fixedSize;
    check((sizes[i] ?? 0) > 0, "sample_count");
  }

  // ctts: composition offsets, one per sample (version 0: unsigned).
  const ctts = video ? stbl.get("ctts") : undefined;
  let compStart = 0;
  let compEnd = mediaDuration;
  if (ctts !== undefined) {
    fullBox(view, ctts, 0, 0, "sample_count");
    const n = view.getUint32(ctts.start + 4);
    check(ctts.end - ctts.start === 8 + n * 8, "sample_count");
    compStart = Number.POSITIVE_INFINITY;
    compEnd = 0;
    // The composition span: each sample's decode time plus its offset, through its duration; stts and ctts runs are
    // walked together.
    let sample = 0;
    let dts = 0;
    let run = 0;
    let runLeft = deltas[0] ?? 0;
    for (let i = 0; i < n; i++) {
      const count = view.getUint32(ctts.start + 8 + i * 8);
      const offset = view.getUint32(ctts.start + 12 + i * 8);
      check(count > 0 && sample + count <= samples, "sample_count");
      for (let k = 0; k < count; k++) {
        if (runLeft === 0) {
          run++;
          runLeft = deltas[run * 2] ?? 0;
        }
        const delta = deltas[run * 2 + 1] ?? 0;
        compStart = Math.min(compStart, dts + offset);
        compEnd = Math.max(compEnd, dts + offset + delta);
        dts += delta;
        runLeft--;
        sample++;
      }
    }
    check(sample === samples, "sample_count");
  }

  // stss: increasing sync sample numbers, the first sample among them.
  const stss = video ? stbl.get("stss") : undefined;
  if (stss !== undefined) {
    fullBox(view, stss, 0, 0, "sync_samples");
    const n = view.getUint32(stss.start + 4);
    check(stss.end - stss.start === 8 + n * 4 && n > 0, "sync_samples");
    let last = 0;
    for (let i = 0; i < n; i++) {
      const s = view.getUint32(stss.start + 8 + i * 4);
      check(s > last && s <= samples && (i > 0 || s === 1), "sync_samples");
      last = s;
    }
  }

  // stsc and stco/co64: chunks and their samples, every offset inside the mdat.
  const stsc = stbl.get("stsc") as Box;
  fullBox(view, stsc, 0, 0, "chunks");
  const runs = view.getUint32(stsc.start + 4);
  check(stsc.end - stsc.start === 8 + runs * 12 && runs > 0, "chunks");
  const co = (stbl.get("stco") ?? stbl.get("co64")) as Box;
  const wide = stbl.has("co64");
  fullBox(view, co, 0, 0, "chunks");
  const chunks = view.getUint32(co.start + 4);
  check(co.end - co.start === 8 + chunks * (wide ? 8 : 4) && chunks > 0, "chunks");
  const offsets = new Float64Array(samples);
  let sample = 0;
  let previousFirst = 0;
  for (let r = 0; r < runs; r++) {
    const first = view.getUint32(stsc.start + 8 + r * 12);
    const perChunk = view.getUint32(stsc.start + 12 + r * 12);
    check(first === (r === 0 ? 1 : first) && first > previousFirst && first <= chunks, "chunks");
    check(perChunk > 0 && view.getUint32(stsc.start + 16 + r * 12) === 1, "chunks");
    previousFirst = first;
    const nextFirst = r + 1 < runs ? view.getUint32(stsc.start + 20 + r * 12) : chunks + 1;
    check(nextFirst > first && nextFirst <= chunks + 1, "chunks");
    for (let c = first; c < nextFirst; c++) {
      const i = co.start + 8 + (c - 1) * (wide ? 8 : 4);
      let offset = wide ? Number(view.getBigUint64(i)) : view.getUint32(i);
      check(offset >= mdatStart && offset < fileEnd, "chunk_offset");
      for (let k = 0; k < perChunk; k++) {
        check(sample < samples, "sample_count");
        offsets[sample] = offset;
        offset += sizes[sample] ?? 0;
        check(offset <= fileEnd, "chunk_offset");
        check(sample === 0 || (offsets[sample] ?? 0) > (offsets[sample - 1] ?? 0), "tiling");
        sample++;
      }
    }
  }
  check(sample === samples, "sample_count");

  // sgpd/sbgp: only the AAC roll group the muxer writes, covering every sample.
  if (!video) {
    const sgpd = stbl.get("sgpd");
    const sbgp = stbl.get("sbgp");
    check((sgpd === undefined) === (sbgp === undefined), "sample_group");
    if (sgpd !== undefined && sbgp !== undefined) {
      check(sgpd.end - sgpd.start === 18 && view.getUint32(sgpd.start) === 0x01000000, "sample_group");
      check(ascii(b, sgpd.start + 4, 4) === "roll" && view.getUint32(sgpd.start + 8) === 2, "sample_group");
      check(view.getUint32(sgpd.start + 12) === 1 && view.getInt16(sgpd.start + 16) === -1, "sample_group");
      check(sbgp.end - sbgp.start === 20 && view.getUint32(sbgp.start) === 0, "sample_group");
      check(ascii(b, sbgp.start + 4, 4) === "roll" && view.getUint32(sbgp.start + 8) === 1, "sample_group");
      check(view.getUint32(sbgp.start + 12) === samples && view.getUint32(sbgp.start + 16) === 1, "sample_group");
    }
    const audio = parseMp4a(b, view, entry, id, timescale);
    // The esds's average bitrate is derived from the track, as the muxer computes it.
    const bytes = sizes.reduce((n, s) => n + s, 0);
    check(audio.average === Math.floor((bytes * 8 * timescale) / mediaDuration), "esds");
  }

  // The edit list: at most one empty edit, first, then one media edit at rate 1 inside the composition span; tkhd's
  // duration is their total, or one tick more: the muxer rounds the track's duration up and a media edit's span may
  // round down (an AAC track whose timestamps follow a source's jitter).
  const edts = parts.get("edts");
  let presented = 0;
  let skipped = 0;
  if (edts === undefined) {
    check(compStart === 0 && compEnd === mediaDuration, "elst");
    presented = Math.round((mediaDuration * MOVIE_TIMESCALE) / timescale);
  } else {
    const list = exactly(b, view, edts, ["elst"]);
    const elst = list.get("elst") as Box;
    fullBox(view, elst, 0, 0, "elst");
    const n = view.getUint32(elst.start + 4);
    check((n === 1 || n === 2) && elst.end - elst.start === 8 + n * 12, "elst");
    for (let i = 0; i < n; i++) {
      const at = elst.start + 8 + i * 12;
      const span = view.getUint32(at);
      const mediaTime = view.getInt32(at + 4);
      check(view.getUint32(at + 8) === 0x10000, "elst");
      presented += span;
      if (i < n - 1) {
        check(mediaTime === -1 && span > 0, "elst");
        continue;
      }
      check(mediaTime >= 0, "elst");
      // What the image writes (#1828 A7): video starts at its first composition time, the encoder's reorder delay of
      // at most REORDER_FRAMES; audio skips at most one AAC frame of priming.
      check(
        video ? mediaTime === compStart && mediaTime <= REORDER_FRAMES * maxDelta : mediaTime <= AAC_PRIMING_LIMIT,
        "elst",
      );
      skipped = mediaTime;
      // In the media timescale, within one movie tick of rounding.
      check(mediaTime >= compStart, "presentation");
      check((span - 1) * timescale <= (compEnd - mediaTime) * MOVIE_TIMESCALE, "presentation");
    }
  }
  check(tkhdDuration === presented || tkhdDuration === presented + 1, "presentation");

  return {
    video,
    id,
    tkhdDuration,
    timescale,
    mediaDuration,
    mediaTime: skipped,
    samples,
    sizes,
    offsets,
    // The stts runs as numbers (8 bytes each) besides the two tables.
    held: sizes.byteLength + offsets.byteLength + deltas.length * 8,
    minDelta,
    singleDelta: sttsEntries === 1 ? minDelta : null,
    width,
    height,
  };
}

function parseAvc1(b: Uint8Array, view: DataView, entry: Box): Sps {
  const e = entry.start;
  check(entry.end - e >= 78, "avc1");
  // Reserved, data reference 1, pre-defined, the dimensions, 72 dpi, one frame, no compressor name, depth 24.
  check(zero(b, e, e + 6) && view.getUint16(e + 6) === 1 && zero(b, e + 8, e + 24), "avc1");
  const width = view.getUint16(e + 24);
  const height = view.getUint16(e + 26);
  check(view.getUint32(e + 28) === 0x480000 && view.getUint32(e + 32) === 0x480000, "avc1");
  check(view.getUint32(e + 36) === 0 && view.getUint16(e + 40) === 1 && zero(b, e + 42, e + 74), "avc1");
  check(view.getUint16(e + 74) === 0x18 && view.getInt16(e + 76) === -1, "avc1");
  const boxes = exactly(b, view, { type: "avc1", start: e + 78, end: entry.end }, ["avcC", "colr", "pasp"]);

  // avcC: version 1, High, level, 4-byte lengths, one SPS, one PPS, the High profile's 4:2:0 8-bit extension.
  const avcC = boxes.get("avcC") as Box;
  const a = avcC.start;
  const len = avcC.end - a;
  check(len >= 11 && b[a] === 1 && b[a + 1] === HIGH_PROFILE, "avcC");
  check(b[a + 4] === 0xff && b[a + 5] === 0xe1, "avcC");
  const spsLength = view.getUint16(a + 6);
  check(a + 8 + spsLength + 3 <= avcC.end, "avcC");
  const sps = parseSps(b.subarray(a + 8, a + 8 + spsLength));
  check(b[a + 2] === sps.constraints && b[a + 3] === sps.level, "avcC");
  const p = a + 8 + spsLength;
  check(b[p] === 1, "avcC");
  const ppsLength = view.getUint16(p + 1);
  check(p + 3 + ppsLength + 4 === avcC.end, "avcC");
  parsePps(b.subarray(p + 3, p + 3 + ppsLength));
  const x = p + 3 + ppsLength;
  check(b[x] === 0xfd && b[x + 1] === 0xf8 && b[x + 2] === 0xf8 && b[x + 3] === 0, "avcC");
  check(width === sps.width && height === sps.height, "avc1");

  // colr: nclx, BT.709 primaries, transfer and matrix, limited range.
  const colr = boxes.get("colr") as Box;
  check(colr.end - colr.start === 11 && ascii(b, colr.start, 4) === "nclx", "colr");
  check(view.getUint16(colr.start + 4) === 1 && view.getUint16(colr.start + 6) === 1, "colr");
  check(view.getUint16(colr.start + 8) === 1 && b[colr.start + 10] === 0, "colr");

  // pasp: square pixels.
  const pasp = boxes.get("pasp") as Box;
  check(
    pasp.end - pasp.start === 8 && view.getUint32(pasp.start) === 1 && view.getUint32(pasp.start + 4) === 1,
    "pasp",
  );
  return sps;
}

function parseMp4a(b: Uint8Array, view: DataView, entry: Box, id: number, timescale: number): { average: number } {
  const e = entry.start;
  check(entry.end - e === 28 + 54, "mp4a");
  // Reserved, data reference 1, version 0, stereo, 16 bits, the track's sample rate (44.1 or 48 kHz).
  check(zero(b, e, e + 6) && view.getUint16(e + 6) === 1 && zero(b, e + 8, e + 16), "mp4a");
  check(view.getUint16(e + 16) === 2 && view.getUint16(e + 18) === 16 && view.getUint32(e + 20) === 0, "mp4a");
  const rate = view.getUint32(e + 24) / 0x10000;
  check(AAC_RATES.has(rate) && rate === timescale, "mp4a");
  const boxes = exactly(b, view, { type: "mp4a", start: e + 28, end: entry.end }, ["esds"]);
  const esds = boxes.get("esds") as Box;
  const s = esds.start;
  fullBox(view, esds, 0, 0, "esds");
  // ES_Descriptor (the track's id), DecoderConfigDescriptor (AAC, audio stream, no buffer size), the
  // AudioSpecificConfig, SLConfigDescriptor (predefined 2); every size written in four bytes as the muxer does.
  const fixed = [
    [s + 4, [0x03, 0x80, 0x80, 0x80, 0x25, id >> 8, id & 0xff, 0x00]],
    [s + 12, [0x04, 0x80, 0x80, 0x80, 0x17, 0x40, 0x15, 0, 0, 0]],
    [s + 30, [0x05, 0x80, 0x80, 0x80, 0x05, ...audioSpecificConfig(rate)]],
    [s + 40, [0x06, 0x80, 0x80, 0x80, 0x01, 0x02]],
  ] as const;
  for (const [at, bytes] of fixed) {
    check(
      bytes.every((v, i) => b[at + i] === v),
      "esds",
    );
  }
  const maximum = view.getUint32(s + 22);
  const average = view.getUint32(s + 26);
  // The muxer states the larger of the encoder's nominal rate (one of the ladder's) and the track's average.
  check(
    [...AAC_BITRATES].some((nominal) => maximum === Math.max(nominal, average)),
    "esds",
  );
  return { average };
}

// The MP4 walk: the top-level boxes as they arrive, the moov buffered and parsed, then the mdat's samples.
class Mp4Walker implements Walker<Omit<VideoFacts, "sha256">> {
  private offset = 0;
  private readonly header = new Uint8Array(8);
  private headerHave = 0;
  private stage = 0; // 0 ftyp, 1 moov, 2 free, 3 mdat
  private body: Uint8Array | null = null;
  private bodyHave = 0;
  private bodyStart = 0;
  private moovStart = 0;
  private layout: Mp4Layout | null = null;
  private inMdat = false;
  // The sample walk.
  private sample = 0;
  private sampleLeft = 0;
  private lengthHave = 0;
  private lengthValue = 0;
  private nalLeft = 0;
  private needNalHeader = false;

  constructor(private readonly contentLength: number) {}

  private most = 0;

  // Notes what is held now: the header, a box being buffered and the sample tables.
  private note(): void {
    const held =
      this.header.byteLength +
      (this.body?.byteLength ?? 0) +
      (this.layout === null ? 0 : this.layout.sizes.byteLength + this.layout.video.byteLength);
    this.most = Math.max(this.most, held);
  }

  peak(): number {
    return this.most;
  }

  push(chunk: Uint8Array): AvRule | null {
    try {
      let i = 0;
      while (i < chunk.length) {
        i += this.inMdat ? this.mdat(chunk, i) : this.box(chunk, i);
      }
      return null;
    } catch (error) {
      if (error instanceof AvRefusal) {
        return error.rule;
      }
      throw error;
    }
  }

  // Top-level box headers and the bodies of ftyp and moov.
  private box(chunk: Uint8Array, i: number): number {
    if (this.body !== null) {
      const n = Math.min(chunk.length - i, this.body.length - this.bodyHave);
      this.body.set(chunk.subarray(i, i + n), this.bodyHave);
      this.bodyHave += n;
      this.offset += n;
      if (this.bodyHave === this.body.length) {
        this.boxDone();
      }
      return n;
    }
    const n = Math.min(chunk.length - i, 8 - this.headerHave);
    this.header.set(chunk.subarray(i, i + n), this.headerHave);
    this.headerHave += n;
    this.offset += n;
    if (this.headerHave === 8) {
      this.headerHave = 0;
      this.headerDone();
    }
    return n;
  }

  private headerDone(): void {
    const view = new DataView(this.header.buffer);
    const size = view.getUint32(0);
    const type = ascii(this.header, 4, 4);
    const start = this.offset - 8;
    const expected = ["ftyp", "moov", "free", "mdat"][this.stage];
    if (type === "free" && this.stage !== 2) {
      fail("free");
    }
    check(type === expected && size >= 8, "top_level");
    switch (this.stage) {
      case 0:
        check(start === 0 && size <= 64, "ftyp");
        break;
      case 1:
        check(size <= MOOV_LIMIT, "moov_size");
        this.moovStart = start;
        break;
      case 2:
        check(size === 8, "free");
        this.stage = 3;
        return;
      case 3:
        check(size === this.contentLength - start && this.layout?.mdatStart === this.offset, "top_level");
        check(this.layout?.samplesEnd === this.contentLength, "tiling");
        this.inMdat = true;
        this.stage = 4;
        return;
    }
    check(start + size <= this.contentLength, "top_level");
    this.body = new Uint8Array(size);
    this.note();
    this.body.set(this.header, 0);
    this.bodyHave = 8;
    this.bodyStart = start;
    if (size === 8) {
      this.boxDone();
    }
  }

  private boxDone(): void {
    const body = this.body as Uint8Array;
    this.body = null;
    if (this.stage === 0) {
      // ftyp: major brand isom, minor 512, compatible isom, iso2, avc1, mp41: what the muxer writes for H.264/AAC.
      const brands = ascii(body, 8, 4) + new DataView(body.buffer).getUint32(12) + ascii(body, 16, body.length - 16);
      check(body.length === 32 && brands === "isom512isomiso2avc1mp41", "ftyp");
      this.stage = 1;
      return;
    }
    this.layout = parseMoov(body, this.bodyStart, this.bodyStart + body.length, this.contentLength);
    // The moov and parseMoov's temporaries at once, as it builds them.
    this.most = Math.max(this.most, this.header.byteLength + body.byteLength + this.layout.parsed);
    this.stage = 2;
  }

  // The mdat's bytes: each video sample's NAL units by their 4-byte lengths, audio samples skipped.
  private mdat(chunk: Uint8Array, i: number): number {
    const layout = this.layout as Mp4Layout;
    if (this.sampleLeft === 0) {
      check(this.sample < layout.sizes.length, "tiling");
      this.sampleLeft = layout.sizes[this.sample] ?? 0;
      this.lengthHave = 0;
      this.nalLeft = 0;
      this.needNalHeader = false;
    }
    const isVideo = layout.video[this.sample] === 1;
    let n: number;
    if (!isVideo) {
      n = Math.min(chunk.length - i, this.sampleLeft);
    } else if (this.nalLeft > 0) {
      n = Math.min(chunk.length - i, this.nalLeft);
      this.nalLeft -= n;
    } else if (this.needNalHeader) {
      // forbidden_zero_bit 0; a non-IDR (1) or IDR (5) slice, an IDR one referenced.
      const header = chunk[i] ?? 0;
      const type = header & 0x1f;
      check((header & 0x80) === 0 && (type === 1 || (type === 5 && (header & 0x60) !== 0)), "nal");
      this.needNalHeader = false;
      this.nalLeft = this.lengthValue - 1;
      n = 1;
    } else {
      // The NAL unit's 4-byte length, possibly split across chunks; the unit must fit in what is left of the sample.
      this.lengthValue = (this.lengthHave === 0 ? 0 : this.lengthValue * 256) + (chunk[i] ?? 0);
      this.lengthHave++;
      n = 1;
      if (this.lengthHave === 4) {
        check(this.lengthValue >= 1 && this.lengthValue <= this.sampleLeft - 1, "nal");
        this.lengthHave = 0;
        this.needNalHeader = true;
      }
    }
    this.sampleLeft -= n;
    this.offset += n;
    if (this.sampleLeft === 0) {
      check(!isVideo || (this.lengthHave === 0 && !this.needNalHeader && this.nalLeft === 0), "nal");
      this.sample++;
    }
    return n;
  }

  end(): AvRule | Omit<VideoFacts, "sha256"> {
    const layout = this.layout;
    if (layout === null || !this.inMdat || this.offset !== this.contentLength) {
      return "top_level";
    }
    if (this.sample !== layout.sizes.length || this.sampleLeft !== 0) {
      return "tiling";
    }
    return {
      ...layout.facts,
      bytes: this.contentLength,
      bitrate: Math.floor((this.contentLength * 8 * MOVIE_TIMESCALE) / layout.durationMs),
    };
  }
}

// ---- MP3

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MP3_RATES = { 1: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000] } as const;
// The largest Layer III frame (MPEG-1, 320 kb/s at 32 kHz, padded).
const MP3_FRAME_LIMIT = 1441;
const XING_TOC = 100;
const XING_BAGS = 400;
// The LAME tag's CRC covers the frame's first 190 bytes (LAME's tag layout).
const LAME_CRC_SPAN = 190;
// LAME's encoder delay as the muxer records it, and the padding it may record: under two frames (#1828 A7; an ADTS
// AAC source, whose priming is decoded, gives more than one).
const LAME_DELAY = 576;
const LAME_PADDING_LIMIT = 2 * 1152;

type FrameHeader = {
  version: 1 | 2;
  rate: number;
  mode: number;
  length: number;
  samples: number;
};

// A Layer III frame header with the bits the encoder writes fixed: no CRC, private and copyright bits 0, no emphasis,
// and the original bit as written: 0 on the muxer's Xing frame, 1 on LAME's frames. null when it is not one.
function frameHeader(h: number, original: 0 | 1): FrameHeader | null {
  if (h >>> 21 !== 0x7ff) {
    return null;
  }
  const versionBits = (h >>> 19) & 3;
  const layer = (h >>> 17) & 3;
  if ((versionBits !== 3 && versionBits !== 2) || layer !== 1 || ((h >>> 16) & 1) !== 1) {
    return null;
  }
  const version = versionBits === 3 ? 1 : 2;
  const bitrate = MP3_BITRATES[version][(h >>> 12) & 15];
  const rate = MP3_RATES[version][(h >>> 10) & 3];
  if (bitrate === undefined || bitrate === 0 || rate === undefined) {
    return null;
  }
  // private (bit 8), copyright (3), original (2), emphasis (1-0).
  if ((h & 0x10f) !== original << 2) {
    return null;
  }
  const padding = (h >>> 9) & 1;
  const length = Math.floor(((version === 1 ? 144_000 : 72_000) * bitrate) / rate) + padding;
  return { version, rate, mode: (h >>> 6) & 3, length, samples: version === 1 ? 1152 : 576 };
}

// CRC-16/ARC (the muxer's AV_CRC_16_ANSI_LE), table-driven.
const CRC16 = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc16(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (const byte of bytes) {
    c = (c >>> 8) ^ (CRC16[(c ^ byte) & 0xff] ?? 0);
  }
  return c;
}

class Mp3Walker implements Walker<Omit<AudioFacts, "sha256">> {
  private offset = 0;
  private readonly first = new Uint8Array(MP3_FRAME_LIMIT);
  private firstHave = 0;
  private firstLength = 0;
  private readonly header = new Uint8Array(4);
  private headerHave = 0;
  private frameLeft = 0;
  private format: FrameHeader | null = null;
  private mode: number | undefined;
  private frames = 0;
  private samples = 0;
  private musicCrc = 0;
  // The Xing frame's statements, checked at the end: frames, bytes, the TOC and the music CRC.
  private xing: { frames: number; toc: Uint8Array; musicCrc: number; padding: number } | null = null;
  // The muxer's TOC positions (mp3enc.c's bags), simulated in constant memory.
  private readonly bags = new Float64Array(XING_BAGS);
  private bagPosition = 0;
  private want = 1;
  private seen = 0;
  private size = 0;

  constructor(private readonly contentLength: number) {}

  peak(): number {
    return this.first.byteLength + this.header.byteLength + this.bags.byteLength + XING_TOC;
  }

  push(chunk: Uint8Array): AvRule | null {
    try {
      let i = 0;
      while (i < chunk.length) {
        i += this.step(chunk, i);
      }
      return null;
    } catch (error) {
      if (error instanceof AvRefusal) {
        return error.rule;
      }
      throw error;
    }
  }

  private step(chunk: Uint8Array, i: number): number {
    if (this.xing === null) {
      return this.firstFrame(chunk, i);
    }
    if (this.frameLeft > 0) {
      const n = Math.min(chunk.length - i, this.frameLeft);
      this.musicCrc = crc16(this.musicCrc, chunk.subarray(i, i + n));
      this.frameLeft -= n;
      this.offset += n;
      return n;
    }
    this.header[this.headerHave] = chunk[i] ?? 0;
    this.headerHave++;
    this.offset++;
    if (this.headerHave === 4) {
      this.headerHave = 0;
      const start = this.offset - 4;
      const header = frameHeader(new DataView(this.header.buffer).getUint32(0), 1);
      if (header === null) {
        fail(this.tagAt(this.header));
      }
      const format = this.format as FrameHeader;
      // The first audio frame fixes the channel mode; the Xing frame states only mono (3) or stereo (0).
      this.mode ??= header.mode;
      check(
        header.version === format.version &&
          header.rate === format.rate &&
          header.mode === this.mode &&
          (format.mode === 3) === (header.mode === 3) &&
          (format.mode === 3 || format.mode === 0),
        "mp3_stream",
      );
      check(start + header.length <= this.contentLength, "mp3_frame");
      this.musicCrc = crc16(this.musicCrc, this.header);
      this.frameLeft = header.length - 4;
      this.frames++;
      this.samples += header.samples;
      this.addBag(header.length);
    }
    return 1;
  }

  // What follows the frames, when it is not a frame: a trailing tag, or a broken stream.
  private tagAt(bytes: Uint8Array): AvRule {
    const text = ascii(bytes, 0, 4);
    if (text.startsWith("TAG")) {
      return "id3v1";
    }
    if (text === "APET") {
      return "ape";
    }
    if (text === "LYRI") {
      return "lyrics3";
    }
    return text.startsWith("ID3") ? "id3v2" : "mp3_frame";
  }

  // mp3enc.c's mp3_xing_add_frame: every `want`-th frame's end, halved when the bags are full.
  private addBag(length: number): void {
    this.seen++;
    this.size += length;
    if (this.seen === this.want) {
      this.bags[this.bagPosition] = this.size;
      this.bagPosition++;
      if (this.bagPosition === XING_BAGS) {
        for (let i = 1; i < XING_BAGS; i += 2) {
          this.bags[i >> 1] = this.bags[i] ?? 0;
        }
        this.want *= 2;
        this.bagPosition = XING_BAGS / 2;
      }
      this.seen = 0;
    }
  }

  // The first frame: buffered whole (at most MP3_FRAME_LIMIT bytes) and checked as the Xing/Info frame.
  private firstFrame(chunk: Uint8Array, i: number): number {
    const want = this.firstLength === 0 ? 4 : this.firstLength;
    const n = Math.min(chunk.length - i, want - this.firstHave);
    this.first.set(chunk.subarray(i, i + n), this.firstHave);
    this.firstHave += n;
    this.offset += n;
    if (this.firstHave < want) {
      return n;
    }
    if (this.firstLength === 0) {
      if (ascii(this.first, 0, 3) === "ID3") {
        fail("id3v2");
      }
      const header = frameHeader(new DataView(this.first.buffer).getUint32(0), 0);
      check(header !== null, "mp3_frame");
      const format = header as FrameHeader;
      check(format.length <= this.contentLength, "mp3_frame");
      this.format = format;
      this.firstLength = format.length;
      return n;
    }
    this.checkXing();
    return n;
  }

  private checkXing(): void {
    const format = this.format as FrameHeader;
    const b = this.first.subarray(0, this.firstLength);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const mono = format.mode === 3;
    const side = format.version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const x = 4 + side;
    if (b.length >= 40 && ascii(b, 36, 4) === "VBRI") {
      fail("vbri");
    }
    check(b.length >= x + 156, "xing");
    const tag = ascii(b, x, 4);
    check(zero(b, 4, x) && (tag === "Xing" || tag === "Info"), "xing");
    // Frames, bytes, TOC and quality (0 for the muxer).
    check(view.getUint32(x + 4) === 0x0f, "xing");
    const frames = view.getUint32(x + 8);
    check(view.getUint32(x + 12) === this.contentLength, "xing");
    const toc = b.slice(x + 16, x + 16 + XING_TOC);
    check(view.getUint32(x + 116) === 0, "xing");
    // The LAME tag as the muxer writes it under +bitexact: the encoder string "Lavf", no other information, LAME's
    // delay and a padding under two frames, the music length (the file's) and the two CRCs.
    const lame = x + 120;
    check(ascii(b, lame, 9) === "Lavf\0\0\0\0\0" && zero(b, lame + 9, lame + 21), "xing");
    const delayPadding = (view.getUint16(lame + 21) << 8) | (b[lame + 23] ?? 0);
    check(delayPadding >> 12 === LAME_DELAY && (delayPadding & 0xfff) < LAME_PADDING_LIMIT, "xing");
    check(zero(b, lame + 24, lame + 28) && view.getUint32(lame + 28) === this.contentLength, "xing");
    const musicCrc = view.getUint16(lame + 32);
    const tagCrc = view.getUint16(lame + 34);
    check(zero(b, lame + 36, b.length), "xing");
    const span = new Uint8Array(LAME_CRC_SPAN);
    span.set(b.subarray(0, Math.min(b.length, LAME_CRC_SPAN)));
    span[lame + 34] = 0;
    span[lame + 35] = 0;
    check(crc16(0, span) === tagCrc, "xing");
    this.xing = { frames, toc, musicCrc, padding: delayPadding & 0xfff };
    this.size = this.firstLength;
  }

  end(): AvRule | Omit<AudioFacts, "sha256"> {
    const xing = this.xing;
    const format = this.format;
    if (xing === null || format === null) {
      return this.firstLength === 0 ? "mp3_frame" : "xing";
    }
    if (this.headerHave !== 0 || this.frameLeft !== 0) {
      return this.headerHave !== 0 ? this.tagAt(this.header) : "mp3_frame";
    }
    if (this.frames === 0 || xing.frames !== this.frames || xing.musicCrc !== this.musicCrc) {
      return "xing";
    }
    // mp3enc.c's mp3_update_xing: toc[0] = 0, toc[i] = 256 x the bag at i/100 of the bags over the file's size.
    for (let i = 0; i < XING_TOC; i++) {
      const bag = this.bags[Math.floor((i * this.bagPosition) / XING_TOC)] ?? 0;
      const expected = i === 0 ? 0 : Math.min(255, Math.floor((256 * bag) / this.size));
      if (xing.toc[i] !== expected) {
        return "xing";
      }
    }
    // The presented samples: the audio frames' (the Info frame is none), less the delay and padding the LAME tag
    // records, which leave some (#1828 A7).
    const presented = this.samples - LAME_DELAY - xing.padding;
    if (presented <= 0) {
      return "xing";
    }
    const duration = presented / format.rate;
    if (duration > AUDIO_DURATION_LIMIT) {
      return "duration_limit";
    }
    return {
      kind: "audio",
      duration,
      bitrate: Math.floor((this.contentLength * 8) / duration),
      bytes: this.contentLength,
      sampleRate: format.rate,
      channels: this.mode === 3 ? 1 : 2,
    };
  }
}
