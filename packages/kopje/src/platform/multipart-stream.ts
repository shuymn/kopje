// A multipart/form-data body read as a stream (#1828 PR4-4, the media upload route): part by part, each part's head
// judged by the runtime's own form parser (so a name and a file are read exactly as `Request#formData` reads them, the
// parser today's whole-body path uses), its body either buffered (a text field) or handed on in chunks (the one file
// part a video or audio upload streams to R2). Nothing is held beyond the part being read: a part's body is handed on
// up to the delimiter, keeping back only the bytes that may begin it.
//
// Every byte pulled from the body is counted (`pulled`), and each pull is refused past the reader's ceiling (`limit`),
// which the caller moves as the request goes on (the prefix bound before the sniff, the upload's cap after it). Until
// `replay` is asked for, every raw chunk pulled is also kept, so a request handed back to the whole-body path is read
// there byte for byte as sent: the chunks kept, then the rest of the body.

const CRLF = new Uint8Array([13, 10]);
const DASHES = new Uint8Array([45, 45]);

// The most bytes of one part's head (its header lines), as a file part's head is bounded on the whole-body path
// (params.ts FILE_PART_SLACK).
const PART_HEAD_LIMIT = 16 * 1024;

// The body was refused: past its ceiling (`limit`), or not a multipart body this reader can follow (`malformed`).
export class MultipartRefused extends Error {
  constructor(readonly reason: "limit" | "malformed") {
    super(`multipart body refused: ${reason}`);
  }
}

// One part's head as the runtime's form parser reads it: its field name (null when it has none it reads), and whether
// it is a file part (a filename that is not empty). `bytes`: the header lines as sent.
export type PartHead = { name: string | null; file: boolean; bytes: Uint8Array };

// The boundary of a multipart/form-data Content-Type, or null for any other type.
export function multipartBoundary(contentType: string): string | null {
  const [type, ...params] = contentType.split(";");
  if (type?.trim().toLowerCase() !== "multipart/form-data") {
    return null;
  }
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === "boundary") {
      const raw = param.slice(eq + 1).trim();
      const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
      // RFC 2046: 1 to 70 characters.
      return value.length >= 1 && value.length <= 70 ? value : null;
    }
  }
  return null;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) {
    return b;
  }
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  outer: for (let i = haystack.indexOf(first ?? 0, from); i !== -1 && i <= haystack.length - needle.length;) {
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        i = haystack.indexOf(first ?? 0, i + 1);
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

// What a guard does with each pull: a deadline or a cancellation races the read (a rejection cancels the body).
export type PullGuard = <T>(read: Promise<T>) => Promise<T>;

export class MultipartStream {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #boundary: string;
  readonly #delimiter: Uint8Array;
  // Unconsumed bytes, the body's start preceded by the CRLF the first delimiter lacks.
  #buf: Uint8Array = CRLF;
  #done = false;
  #kept: Uint8Array[] | null = [];
  #pulled = 0;
  // Where the reader is: before the first delimiter, just after a delimiter, in a part's body, or past the closing
  // delimiter.
  #at: "start" | "delimiter" | "body" | "end" = "start";
  limit: number;
  guard: PullGuard;

  constructor(body: ReadableStream<Uint8Array>, boundary: string, limit: number, guard: PullGuard = (read) => read) {
    this.#reader = body.getReader();
    this.#boundary = boundary;
    this.#delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
    this.limit = limit;
    this.guard = guard;
  }

  // The bytes pulled from the body so far.
  get pulled(): number {
    return this.#pulled;
  }

  // Pulls one chunk into the buffer; false at the body's end.
  async #pull(): Promise<boolean> {
    if (this.#done) {
      return false;
    }
    const read = this.#reader.read();
    read.catch(() => {});
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await this.guard(read);
    } catch (error) {
      await this.cancel();
      throw error;
    }
    if (result.done) {
      this.#done = true;
      return false;
    }
    const chunk = result.value;
    this.#pulled += chunk.byteLength;
    if (this.#pulled > this.limit) {
      await this.cancel();
      throw new MultipartRefused("limit");
    }
    this.#kept?.push(chunk);
    this.#buf = concat(this.#buf, chunk);
    return true;
  }

  async #need(n: number): Promise<void> {
    while (this.#buf.byteLength < n) {
      if (!(await this.#pull())) {
        throw new MultipartRefused("malformed");
      }
    }
  }

  // The next part's head, or null after the closing delimiter. The current part's body, if any, is skipped (each of
  // its bytes still counted against the ceiling).
  async next(): Promise<PartHead | null> {
    if (this.#at === "end") {
      return null;
    }
    if (this.#at === "body") {
      await this.body(() => {});
    } else if (this.#at === "start") {
      // The first delimiter, after any preamble.
      for (;;) {
        const at = indexOf(this.#buf, this.#delimiter);
        if (at !== -1) {
          this.#buf = this.#buf.subarray(at + this.#delimiter.byteLength);
          break;
        }
        this.#buf = this.#buf.subarray(Math.max(0, this.#buf.byteLength - this.#delimiter.byteLength + 1));
        if (!(await this.#pull())) {
          throw new MultipartRefused("malformed");
        }
      }
    }
    await this.#need(2);
    if (this.#buf[0] === DASHES[0] && this.#buf[1] === DASHES[1]) {
      this.#at = "end";
      return null;
    }
    // Transport padding, then the line's CRLF.
    for (;;) {
      await this.#need(1);
      const byte = this.#buf[0];
      if (byte !== 0x20 && byte !== 0x09) {
        break;
      }
      this.#buf = this.#buf.subarray(1);
    }
    await this.#need(2);
    if (this.#buf[0] !== CRLF[0] || this.#buf[1] !== CRLF[1]) {
      throw new MultipartRefused("malformed");
    }
    this.#buf = this.#buf.subarray(2);
    // The header lines end at an empty line: CRLF CRLF, or CRLF at once when there are none.
    let bytes: Uint8Array;
    for (;;) {
      await this.#need(2);
      if (this.#buf[0] === CRLF[0] && this.#buf[1] === CRLF[1]) {
        bytes = new Uint8Array(0);
        this.#buf = this.#buf.subarray(2);
        break;
      }
      const end = indexOf(this.#buf, new Uint8Array([13, 10, 13, 10]));
      if (end !== -1 && end <= PART_HEAD_LIMIT) {
        bytes = this.#buf.slice(0, end);
        this.#buf = this.#buf.subarray(end + 4);
        break;
      }
      if (this.#buf.byteLength > PART_HEAD_LIMIT + 4) {
        throw new MultipartRefused("malformed");
      }
      if (!(await this.#pull())) {
        throw new MultipartRefused("malformed");
      }
    }
    this.#at = "body";
    return { ...(await this.#judge(bytes)), bytes };
  }

  // The head's name and kind as the runtime's form parser reads a part with these header lines and no body.
  async #judge(head: Uint8Array): Promise<{ name: string | null; file: boolean }> {
    const open = new TextEncoder().encode(`--${this.#boundary}\r\n`);
    const close = new TextEncoder().encode(`\r\n\r\n\r\n--${this.#boundary}--\r\n`);
    const body = concat(concat(open, head), close);
    try {
      const form = await new Response(body, {
        headers: { "content-type": `multipart/form-data; boundary="${this.#boundary}"` },
      }).formData();
      const [first] = [...(form.entries() as Iterable<[string, string | File]>)];
      if (first !== undefined) {
        return { name: first[0], file: typeof first[1] !== "string" };
      }
    } catch {
      // A head the parser refuses: no name it reads.
    }
    return { name: null, file: false };
  }

  // The current part's body, handed to `sink` in chunks up to its delimiter (awaited before more is pulled, so the
  // caller's writes pace the reading). The delimiter's possible start is kept back between pulls.
  async body(sink: (chunk: Uint8Array) => unknown): Promise<void> {
    if (this.#at !== "body") {
      throw new Error("no part body to read");
    }
    const keep = this.#delimiter.byteLength - 1;
    for (;;) {
      const at = indexOf(this.#buf, this.#delimiter);
      if (at !== -1) {
        const last = this.#buf.subarray(0, at);
        this.#buf = this.#buf.subarray(at + this.#delimiter.byteLength);
        this.#at = "delimiter";
        if (last.byteLength > 0) {
          await sink(last);
        }
        return;
      }
      if (this.#buf.byteLength > keep) {
        const out = this.#buf.subarray(0, this.#buf.byteLength - keep);
        this.#buf = this.#buf.slice(this.#buf.byteLength - keep);
        await sink(out);
      }
      if (!(await this.#pull())) {
        throw new MultipartRefused("malformed");
      }
    }
  }

  // At least the first `n` bytes of the current part's body (fewer when the part ends first), without consuming them:
  // a later `body` hands them on first.
  async peek(n: number): Promise<Uint8Array> {
    for (;;) {
      const at = indexOf(this.#buf, this.#delimiter);
      if (at !== -1) {
        return this.#buf.subarray(0, Math.min(at, n));
      }
      if (this.#buf.byteLength >= n + this.#delimiter.byteLength) {
        return this.#buf.subarray(0, n);
      }
      if (!(await this.#pull())) {
        throw new MultipartRefused("malformed");
      }
    }
  }

  // The body as sent: every chunk pulled so far, then the rest. Keeping stops here; the reader is the stream's.
  replay(): ReadableStream<Uint8Array> {
    const kept = this.#kept ?? [];
    this.#kept = null;
    const reader = this.#reader;
    const done = this.#done;
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = kept[i];
        if (chunk !== undefined) {
          kept[i++] = new Uint8Array(0);
          controller.enqueue(chunk);
          return;
        }
        if (done) {
          controller.close();
          return;
        }
        const next = await reader.read();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  // Stops keeping the chunks pulled (the request will not be replayed): from here only the part being read is held.
  forget(): void {
    this.#kept = null;
  }

  async cancel(): Promise<void> {
    this.#done = true;
    this.#kept = null;
    await this.#reader.cancel().catch(() => {});
  }
}
