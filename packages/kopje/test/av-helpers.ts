// Helpers for the output verifier's suites (src/platform/av-bytes.ts): the committed outputs of the shipped image
// (test/fixtures/av/, through the AV_FIXTURES binding), and the hand-built changes of the mutation tests (an MP4 box
// tree edited and written back with its chunk offsets moved, an SPS written from its fields, MP3 tails and synthetic
// MP3 streams with the muxer's Xing fields).
import { env } from "cloudflare:workers";

import { avVerifier, type AvType, type AvVerdict, type AvVerifyOptions } from "../src/platform/av-bytes";

const fixtures = (env as unknown as { AV_FIXTURES: Fetcher }).AV_FIXTURES;

export type AvFixture = { name: string; input: string; kind: "video" | "audio"; bytes: number; sha256: string };

export async function avManifest(): Promise<AvFixture[]> {
  return (await fixtures.fetch("http://fixtures/manifest.json")).json<AvFixture[]>();
}

export async function avFixture(name: string): Promise<Uint8Array> {
  const res = await fixtures.fetch(`http://fixtures/${name}`);
  if (!res.ok) {
    throw new Error(`no fixture ${name}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// A stream of `bytes` in pieces of `size`.
export function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    },
    { highWaterMark: 0 },
  );
}

export type Verified = AvVerdict & { peakHeld: number; passed: number };

// Runs the verifier over a stream, counting the bytes it passed through.
export async function verifyStream(
  type: AvType,
  stream: ReadableStream<Uint8Array>,
  contentLength: number,
  options?: AvVerifyOptions,
): Promise<Verified> {
  const v = avVerifier(type, contentLength, options);
  let passed = 0;
  await stream
    .pipeThrough(v.stream)
    .pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk: Uint8Array) {
          passed += chunk.byteLength;
        },
      }),
    )
    .catch(v.abort);
  return { ...(await v.verdict), peakHeld: v.peakHeld(), passed };
}

export function verifyBytes(
  type: AvType,
  bytes: Uint8Array,
  options: AvVerifyOptions & { chunk?: number; contentLength?: number } = {},
): Promise<Verified> {
  return verifyStream(type, chunked(bytes, options.chunk ?? 65_536), options.contentLength ?? bytes.length, options);
}

// ---- MP4 boxes

const CONTAINERS: Record<string, number> = {
  moov: 0,
  trak: 0,
  edts: 0,
  mdia: 0,
  minf: 0,
  dinf: 0,
  stbl: 0,
  stsd: 8,
  avc1: 78,
  mp4a: 28,
};

export type BoxNode = { type: string; head: Uint8Array; children?: BoxNode[]; body?: Uint8Array };

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function type4(b: Uint8Array, at: number): string {
  return String.fromCharCode(...b.subarray(at, at + 4));
}

function parseNodes(b: Uint8Array, start: number, end: number): BoxNode[] {
  const out: BoxNode[] = [];
  for (let i = start; i < end;) {
    const size = view(b).getUint32(i);
    const type = type4(b, i + 4);
    const skip = CONTAINERS[type];
    if (skip === undefined) {
      out.push({ type, head: new Uint8Array(), body: b.slice(i + 8, i + size) });
    } else {
      out.push({ type, head: b.slice(i + 8, i + 8 + skip), children: parseNodes(b, i + 8 + skip, i + size) });
    }
    i += size;
  }
  return out;
}

function writeNode(node: BoxNode): Uint8Array {
  const inner = node.children === undefined ? (node.body ?? new Uint8Array()) : concat(...node.children.map(writeNode));
  const out = new Uint8Array(8 + node.head.length + inner.length);
  view(out).setUint32(0, out.length);
  out.set(new TextEncoder().encode(node.type), 4);
  out.set(node.head, 8);
  out.set(inner, 8 + node.head.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The top-level boxes of a file: [type, offset, size].
export function topBoxes(b: Uint8Array): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (let i = 0; i < b.length;) {
    const size = view(b).getUint32(i);
    out.push([type4(b, i + 4), i, size]);
    i += size;
  }
  return out;
}

// Finds a box under moov by a path such as "trak/mdia/mdhd" ("trak#1" for the second trak).
export function find(moov: BoxNode, path: string): BoxNode {
  let node = moov;
  for (const part of path.split("/")) {
    const [type, index = "0"] = part.split("#");
    const found = (node.children ?? []).filter((c) => c.type === type)[Number(index)];
    if (found === undefined) {
      throw new Error(`no ${path}`);
    }
    node = found;
  }
  return node;
}

// Edits the moov of an MP4 and writes the file back, every chunk offset moved by the moov's change in size (unless
// `shift` is false: the edit set the offsets itself).
export function editMoov(file: Uint8Array, edit: (moov: BoxNode) => void, shift = true): Uint8Array {
  const top = topBoxes(file);
  const [, moovAt, moovSize] = top.find(([t]) => t === "moov") ?? ["", 0, 0];
  const [moov] = parseNodes(file, moovAt, moovAt + moovSize);
  if (moov === undefined) {
    throw new Error("no moov");
  }
  edit(moov);
  const delta = shift ? writeNode(moov).length - moovSize : 0;
  for (const trak of (moov.children ?? []).filter((c) => c.type === "trak")) {
    const co = find(trak, "mdia/minf/stbl").children?.find((c) => c.type === "stco");
    if (co?.body !== undefined) {
      const v = view(co.body);
      for (let i = 0; i < v.getUint32(4); i++) {
        v.setUint32(8 + i * 4, v.getUint32(8 + i * 4) + delta);
      }
    }
  }
  return concat(file.slice(0, moovAt), writeNode(moov), file.slice(moovAt + moovSize));
}

// A copy of `file` with `bytes` written at `at`.
export function patch(file: Uint8Array, at: number, bytes: number[]): Uint8Array {
  const out = file.slice();
  out.set(bytes, at);
  return out;
}

export function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

// Sets a box's body bytes at `at` (relative to the body, after any container head).
export function setBody(node: BoxNode, at: number, bytes: number[]): void {
  if (node.body === undefined) {
    throw new Error(`${node.type} is a container`);
  }
  node.body.set(bytes, at);
}

export function box(type: string, body: number[] | Uint8Array): BoxNode {
  return { type, head: new Uint8Array(), body: Uint8Array.from(body) };
}

// ---- SPS writer (H.264 7.3.2.1.1, the fields parseSps reads)

class BitWriter {
  private readonly bits: number[] = [];
  u(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(v / 2 ** i) % 2);
    }
    return this;
  }
  ue(v: number): this {
    const k = (v + 1).toString(2);
    return this.u(k.length - 1, 0).u(k.length, v + 1);
  }
  bytes(): Uint8Array {
    const bits = [...this.bits, 1];
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }
    const out = new Uint8Array(bits.length / 8);
    bits.forEach((bit, i) => {
      out[i >> 3] = (out[i >> 3] ?? 0) | (bit << (7 - (i & 7)));
    });
    return out;
  }
}

export type SpsFields = {
  profile?: number;
  level?: number;
  widthMbs: number;
  heightMbs: number;
  primaries?: number;
  fullRange?: number;
  aspect?: number;
  hrd?: boolean;
};

// An SPS NAL unit (header 0x67) with the fields given and x264's others; no emulation prevention is needed for the
// values the tests use.
export function sps(f: SpsFields): Uint8Array {
  const w = new BitWriter()
    .u(8, f.profile ?? 100)
    .u(8, 0)
    .u(8, f.level ?? 30)
    .ue(0)
    .ue(1)
    .ue(0)
    .ue(0)
    .u(1, 0)
    .u(1, 0)
    .ue(0)
    .ue(0)
    .ue(2)
    .ue(3)
    .u(1, 0)
    .ue(f.widthMbs - 1)
    .ue(f.heightMbs - 1)
    .u(1, 1)
    .u(1, 1)
    .u(1, 0)
    .u(1, 1);
  if (f.aspect === undefined) {
    w.u(1, 0);
  } else {
    w.u(1, 1).u(8, f.aspect);
  }
  w.u(1, 0)
    .u(1, 1)
    .u(3, 5)
    .u(1, f.fullRange ?? 0)
    .u(1, 1)
    .u(8, f.primaries ?? 1)
    .u(8, 1)
    .u(8, 1)
    .u(1, 0)
    .u(1, 1)
    .u(32, 1)
    .u(32, 60)
    .u(1, 0)
    .u(1, f.hrd === true ? 1 : 0);
  if (f.hrd === true) {
    w.ue(0).u(4, 0).u(4, 0).ue(0).ue(0).u(1, 0).u(5, 0).u(5, 0).u(5, 0).u(5, 0).u(1, 0);
  }
  w.u(1, 0).u(1, 0).u(1, 0);
  return concat(Uint8Array.of(0x67), w.bytes());
}

// Replaces the video track's SPS (in its avcC), with the avc1's and tkhd's dimensions set to `width` x `height`.
export function withSps(file: Uint8Array, nal: Uint8Array, width: number, height: number): Uint8Array {
  return editMoov(file, (moov) => {
    const avc1 = find(moov, "trak/mdia/minf/stbl/stsd/avc1");
    const avcC = find(avc1, "avcC");
    const old = avcC.body as Uint8Array;
    const oldLength = view(old).getUint16(6);
    // avcC: version, then the SPS's profile, constraints and level, the lengths' size and the SPS count.
    avcC.body = concat(
      Uint8Array.of(1, nal[1] ?? 0, nal[2] ?? 0, nal[3] ?? 0, 0xff, 0xe1, ...u16(nal.length)),
      nal,
      old.slice(8 + oldLength),
    );
    avc1.head.set([...u16(width), ...u16(height)], 24);
    const tkhd = find(moov, "trak/tkhd");
    setBody(tkhd, 76, [...u32(width * 0x10000), ...u32(height * 0x10000)]);
  });
}

// ---- Synthetic MP4

// A video-only MP4 from a silent fixture's moov: `samples` samples of `size` bytes, each one non-IDR slice NAL
// filling it, `delta` ticks apart at the track's timescale, in one chunk; `fixed` writes one stsz size for all. Its mdat is generated as it is read, so a
// large one is never held. Returns the stream factory and the length.
export function syntheticMp4(
  template: Uint8Array,
  shape: { samples: number; size: number; delta: number; timescale?: number; fixed?: boolean },
): { length: number; stream: (chunk?: number) => ReadableStream<Uint8Array>; head: Uint8Array } {
  const { samples, size, delta } = shape;
  let head = new Uint8Array();
  let mdatStart = 0;
  const build = (offset: number) => {
    const file = editMoov(
      template,
      (moov) => {
        const trak = find(moov, "trak");
        const stbl = find(trak, "mdia/minf/stbl");
        const mdhd = find(trak, "mdia/mdhd");
        const timescale = shape.timescale ?? view(mdhd.body as Uint8Array).getUint32(12);
        setBody(mdhd, 12, [...u32(timescale), ...u32(samples * delta)]);
        const movie = Math.round((samples * delta * 1000) / timescale);
        setBody(find(moov, "mvhd"), 16, u32(movie));
        setBody(find(trak, "tkhd"), 20, u32(movie));
        setBody(find(trak, "edts/elst"), 8, [...u32(movie), ...u32(0), ...u32(0x10000)]);
        stbl.children = (stbl.children ?? [])
          .filter((c) => c.type !== "ctts")
          .map((c) => {
            switch (c.type) {
              case "stts":
                return box("stts", [...u32(0), ...u32(1), ...u32(samples), ...u32(delta)]);
              case "stss":
                return box("stss", [...u32(0), ...u32(1), ...u32(1)]);
              case "stsc":
                return box("stsc", [...u32(0), ...u32(1), ...u32(1), ...u32(samples), ...u32(1)]);
              case "stsz": {
                if (shape.fixed === true) {
                  return box("stsz", [...u32(0), ...u32(size), ...u32(samples)]);
                }
                const body = new Uint8Array(12 + samples * 4);
                view(body).setUint32(8, samples);
                for (let i = 0; i < samples; i++) {
                  view(body).setUint32(12 + i * 4, size);
                }
                return box("stsz", body);
              }
              case "stco":
                return box("stco", [...u32(0), ...u32(1), ...u32(offset)]);
              default:
                return c;
            }
          });
      },
      false,
    );
    const top = topBoxes(file);
    const [, mdatAt] = top.find(([t]) => t === "mdat") ?? ["", 0];
    return { file, mdatAt };
  };
  // Two passes: the moov's size fixes the mdat's offset.
  const first = build(0);
  const second = build(first.mdatAt + 8);
  head = second.file.slice(0, second.mdatAt + 8);
  mdatStart = second.mdatAt + 8;
  const length = mdatStart + samples * size;
  view(head).setUint32(second.mdatAt, 8 + samples * size);
  const sample = new Uint8Array(size);
  view(sample).setUint32(0, size - 4);
  sample[4] = 0x41;
  const stream = (chunk = 65_536) => {
    let at = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (at >= length) {
            controller.close();
            return;
          }
          const end = Math.min(length, at + chunk);
          const out = new Uint8Array(end - at);
          for (let i = at; i < end;) {
            const within = (i - mdatStart) % size;
            const [from, n] =
              i < mdatStart
                ? [head.subarray(i), Math.min(end, mdatStart) - i]
                : [sample.subarray(within), Math.min(end - i, size - within)];
            out.set(from.subarray(0, n), i - at);
            i += n;
          }
          at = end;
          controller.enqueue(out);
        },
      },
      { highWaterMark: 0 },
    );
  };
  return { length, stream, head };
}

// ---- MP3

const CRC = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

export function crc16(bytes: Uint8Array, crc = 0): number {
  let c = crc;
  for (const b of bytes) {
    c = (c >>> 8) ^ (CRC[(c ^ b) & 0xff] ?? 0);
  }
  return c;
}

// The Xing frame's layout in a fixture: its length, the Xing tag's offset and the LAME fields' offset.
export function xingLayout(file: Uint8Array): { frame: number; xing: number; lame: number } {
  const h = view(file).getUint32(0);
  const mpeg1 = ((h >>> 19) & 3) === 3;
  const mono = ((h >>> 6) & 3) === 3;
  const br =
    (mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[(h >>> 12) & 15] ?? 0;
  const sr = (mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000])[(h >>> 10) & 3] ?? 1;
  const frame = Math.floor(((mpeg1 ? 144000 : 72000) * br) / sr) + ((h >>> 9) & 1);
  const xing = 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
  return { frame, xing, lame: xing + 120 };
}

// Rewrites the Xing frame's byte count, music length, music CRC and tag CRC for `file` as given.
export function refreshXing(file: Uint8Array, musicCrc?: number): Uint8Array {
  const out = file.slice();
  const { frame, xing, lame } = xingLayout(out);
  const v = view(out);
  v.setUint32(xing + 12, out.length);
  v.setUint32(lame + 28, out.length);
  v.setUint16(lame + 32, musicCrc ?? crc16(out.subarray(frame)));
  const span = new Uint8Array(190);
  span.set(out.subarray(0, Math.min(frame, 190)));
  span[lame + 34] = 0;
  span[lame + 35] = 0;
  v.setUint16(lame + 34, crc16(span));
  return out;
}

// An MP3 of the fixture's Xing frame (its fields rewritten) followed by `frames` copies of the fixture's second
// frame, with the TOC, frame count and CRCs the muxer would write. The frames' music is not changed.
export function repeatedMp3(fixture: Uint8Array, frames: number): Uint8Array {
  const { frame } = xingLayout(fixture);
  const h = view(fixture).getUint32(frame);
  const mpeg1 = ((h >>> 19) & 3) === 3;
  const br =
    (mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[(h >>> 12) & 15] ?? 0;
  const sr = (mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000])[(h >>> 10) & 3] ?? 1;
  const length = Math.floor(((mpeg1 ? 144000 : 72000) * br) / sr) + ((h >>> 9) & 1);
  const one = fixture.slice(frame, frame + length);
  const out = new Uint8Array(frame + frames * length);
  out.set(fixture.subarray(0, frame));
  for (let i = 0; i < frames; i++) {
    out.set(one, frame + i * length);
  }
  const { xing } = xingLayout(out);
  const v = view(out);
  v.setUint32(xing + 8, frames);
  // mp3enc.c's bags and TOC.
  const bags = new Float64Array(400);
  let position = 0;
  let want = 1;
  let seen = 0;
  let size = frame;
  for (let i = 0; i < frames; i++) {
    seen++;
    size += length;
    if (seen === want) {
      bags[position++] = size;
      if (position === 400) {
        for (let k = 1; k < 400; k += 2) {
          bags[k >> 1] = bags[k] ?? 0;
        }
        want *= 2;
        position = 200;
      }
      seen = 0;
    }
  }
  for (let i = 0; i < 100; i++) {
    out[xing + 16 + i] =
      i === 0 ? 0 : Math.min(255, Math.floor((256 * (bags[Math.floor((i * position) / 100)] ?? 0)) / size));
  }
  return refreshXing(out);
}
