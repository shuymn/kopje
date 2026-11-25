import { describe, expect, it } from "vitest";

import { MultipartRefused, MultipartStream, multipartBoundary } from "../src/platform/multipart-stream";

// The AV upload's multipart reader (#1828 PR4-4) frames a body as workerd's form parser does (the image path's parser,
// Request#formData): a delimiter is LF then `--` and the boundary, a CR before it belonging to the delimiter; after
// it `--` closes, CRLF or LF starts a part, anything else is refused; a part's head ends at an empty line of LF or
// CRLF. Checked against formData() on the same small bodies, split at every position (code review r1 M6).

const enc = new TextEncoder();
const dec = new TextDecoder();

type Entry = [name: string, file: boolean, body: string];

async function viaFormData(body: string): Promise<Entry[] | "refused"> {
  try {
    const form = await new Response(enc.encode(body), {
      headers: { "content-type": "multipart/form-data; boundary=B" },
    }).formData();
    const entries: Entry[] = [];
    for (const [name, value] of form.entries() as Iterable<[string, string | File]>) {
      entries.push(typeof value === "string" ? [name, false, value] : [name, true, await value.text()]);
    }
    return entries;
  } catch {
    return "refused";
  }
}

// The body in two chunks, split at `at`.
function split(body: Uint8Array, at: number): ReadableStream<Uint8Array> {
  const chunks = [body.slice(0, at), body.slice(at)].filter((c) => c.byteLength > 0);
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
  });
}

async function viaReader(stream: ReadableStream<Uint8Array>): Promise<Entry[] | "refused"> {
  const reader = new MultipartStream(stream, "B", 1 << 20);
  const entries: Entry[] = [];
  try {
    for (;;) {
      const head = await reader.next();
      if (head === null) {
        return entries;
      }
      const chunks: Uint8Array[] = [];
      await reader.body((chunk) => {
        chunks.push(chunk.slice());
      });
      entries.push([head.name ?? "", head.file, chunks.map((c) => dec.decode(c)).join("")]);
    }
  } catch (error) {
    if (error instanceof MultipartRefused) {
      return "refused";
    }
    throw error;
  }
}

const HEAD_A = 'Content-Disposition: form-data; name="a"';
const FILE_F = 'Content-Disposition: form-data; name="file"; filename="v.mp4"\r\nContent-Type: video/mp4';

const AGREED: Record<string, string> = {
  crlf: `--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--\r\n`,
  "lf separator": `--B\r\n${FILE_F}\r\n\r\nvideo\n--B\r\n${HEAD_A}\r\n\r\ny\r\n--B--\r\n`,
  "lf close": `--B\r\n${HEAD_A}\r\n\r\nx\n--B--\r\n`,
  "close at EOF": `--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--`,
  "close, padding and an epilogue": `--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--  \r\nepilogue`,
  "lf heads": `--B\n${HEAD_A}\n\nx\n--B--\n`,
  "preamble ending in lf": `pre\n--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--\r\n`,
  "a bare cr is data": `--B\r\n${FILE_F}\r\n\r\nx\r--B\r\nmore\r\n--B--\r\n`,
  "a head ended by lf lf": `--B\r\n${HEAD_A}\n\nx\r\n--B--\r\n`,
  "a cr lf inside data": `--B\r\n${FILE_F}\r\n\r\nx\r\n\r\n-B\r\n--\r\n--B--\r\n`,
  "an empty body": `--B\r\n${HEAD_A}\r\n\r\n\r\n--B--\r\n`,
  // workerd takes the first `--B` anywhere as the first delimiter, mid-line included (code review r2 M4).
  "a first delimiter mid-line": `preamble --B\r\n${HEAD_A}\r\n\r\nfrom-preamble\r\n--B\r\n${FILE_F}\r\n\r\nvideo\r\n--B--\r\n`,
};

const REFUSED_BY_BOTH: Record<string, string> = {
  "junk after a separator": `--B\r\n${HEAD_A}\r\n\r\nx\r\n--Bjunk\r\nmore\r\n--B--\r\n`,
  "padding after a separator": `--B\r\n${HEAD_A}\r\n\r\nx\r\n--B  \r\n${HEAD_A}\r\n\r\ny\r\n--B--\r\n`,
  "no closing delimiter": `--B\r\n${HEAD_A}\r\n\r\nx\r\n`,
};

describe("MultipartStream frames as workerd's formData() (code review r1 M6)", () => {
  it.each(Object.entries(AGREED))("reads %s as formData() does, at every split", async (_, body) => {
    const expected = await viaFormData(body);
    expect(expected).not.toBe("refused");
    const bytes = enc.encode(body);
    for (let at = 0; at <= bytes.byteLength; at++) {
      expect([at, await viaReader(split(bytes, at))]).toEqual([at, expected]);
    }
  });

  it.each(Object.entries(REFUSED_BY_BOTH))("refuses %s, as formData() does, at every split", async (_, body) => {
    expect(await viaFormData(body)).toBe("refused");
    const bytes = enc.encode(body);
    for (let at = 0; at <= bytes.byteLength; at++) {
      expect([at, await viaReader(split(bytes, at))]).toEqual([at, "refused"]);
    }
  });

  // formData() ignores what follows `--B--`; the AV reader takes the closing line only as RFC 2046 writes it
  // (transport padding, then CRLF, LF or the end), so a malformed close never reaches the queue.
  it("refuses a closing delimiter followed by anything but padding and a line end, at every split", async () => {
    const body = `--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--junk`;
    expect(await viaFormData(body)).toEqual([["a", false, "x"]]);
    const bytes = enc.encode(body);
    for (let at = 0; at <= bytes.byteLength; at++) {
      expect([at, await viaReader(split(bytes, at))]).toEqual([at, "refused"]);
    }
  });
});

describe("the closing line's padding", () => {
  // Padding after `--B--` is dropped as it is read: the buffer never holds it (commit security review).
  it("reads a megabyte of padding after the close in chunks, holding none of it", async () => {
    const head = enc.encode(`--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--`);
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          controller.enqueue(head);
        } else if (sent <= 16) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(enc.encode("\r\n"));
          controller.close();
        }
        sent++;
      },
    });
    const reader = new MultipartStream(stream, "B", Number.MAX_SAFE_INTEGER);
    expect(await reader.next()).toMatchObject({ name: "a" });
    await reader.body(() => {});
    expect(await reader.next()).toBeNull();
    expect(reader.buffered).toBeLessThanOrEqual(chunk.byteLength);
  });
});

describe("the boundary parameter, as workerd's MIME parser reads it (code review r2 M4)", () => {
  it.each([
    ['multipart/form-data; note="a;boundary=inner;z"; boundary=B'],
    ['multipart/form-data; boundary="B"'],
    ["multipart/form-data;boundary=B"],
    ['Multipart/Form-Data; BOUNDARY="B"; charset=utf-8'],
  ])("reads %s as formData() does", async (contentType) => {
    const body = enc.encode(`--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--\r\n`);
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    expect(form.get("a")).toBe("x");
    expect(multipartBoundary(contentType)).toBe("B");
  });
});

describe("the closing padding read in one pass (code review r2 LOW)", () => {
  it("reads 32 MiB of padding after the close in one chunk within a generous time", async () => {
    const head = enc.encode(`--B\r\n${HEAD_A}\r\n\r\nx\r\n--B--`);
    const padding = new Uint8Array(32 * 1024 * 1024).fill(0x20);
    const chunks = [head, padding, enc.encode("\r\n")];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
    });
    const reader = new MultipartStream(stream, "B", Number.MAX_SAFE_INTEGER);
    await reader.next();
    await reader.body(() => {});
    const started = performance.now();
    expect(await reader.next()).toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });
});
