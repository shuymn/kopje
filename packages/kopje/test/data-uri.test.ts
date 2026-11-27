import { describe, expect, it } from "vitest";

import { base64DataUriPayload, decodeRubyBase64 } from "../src/platform/data-uri";

// Paperclip's data URI pattern and Ruby's Base64.decode64 (src/platform/data-uri.ts). Every expected value was printed
// by Ruby 2.6.10 (`ruby -rbase64`): the pattern's match group 2 and `Base64.decode64(payload).unpack1("H*")`. The
// decoding's time over a value at the request's text bound: test/param-shapes.test.ts.

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("base64DataUriPayload", () => {
  it.each([
    ["data:image/png;base64,aGk=", "aGk="],
    ["data:;base64,aGk=", "aGk="],
    ["data:a-b_c/x+y.z-1_;base64,x", "x"],
    ["data:image/svg+xml;base64,", ""],
  ])("reads the payload of %j as Paperclip's pattern does", (value, payload) => {
    const start = base64DataUriPayload(value);
    expect(start === undefined ? undefined : value.slice(start)).toBe(payload);
  });

  it.each([
    "DATA:image/png;base64,x",
    "data:image/png;BASE64,x",
    "data:image/png;charset=utf-8;base64,x",
    "data:image/;base64,x",
    "data:/png;base64,x",
    "data:image;base64,x",
    "data:image/png,x",
    " data:;base64,x",
    "data:imagé/png;base64,x",
    "data:image/pńg;base64,x",
    "data:a/b;base64",
    "data:a/b/c;base64,x",
    "data:a.b/c;base64,x",
    "data:",
    "x",
  ])("matches no handler for %j", (value) => {
    expect(base64DataUriPayload(value)).toBeUndefined();
  });
});

describe("decodeRubyBase64", () => {
  it.each([
    ["aGk=", "6869"],
    ["aGk", "6869"],
    ["aG!k=", "6869"],
    ["aG-k", "6869"],
    ["aG_k", "6869"],
    ["aG k\n=\t", "6869"],
    ["aG\u000bk", "6869"],
    ["aG\u0000k", "6869"],
    // Both UTF-8 bytes of the NBSP are skipped, so the group goes on to `x`.
    ["aGk x", "686931"],
    ["aGkx\u{1F600}YQ", "68693161"],
    ["aGk==", "6869"],
    ["aGk=aGk=", "6869"],
    ["aGkxYQ=x", "68693161"],
    ["=aGk", "6869"],
    ["a=Gk", "6869"],
    ["aG=k", "68"],
    ["====", ""],
    ["a", ""],
    ["a ", ""],
    ["aGkxa\n", "686931"],
    ["aGkxaGk\u00e9", "6869316869"],
    ["aG", "68"],
    ["aGkxa", "686931"],
    ["", ""],
    ["/+/+", "ffeffe"],
  ])("decodes %j as Base64.decode64 does", (payload, bytes) => {
    expect(hex(decodeRubyBase64(`p${payload}`, 1))).toBe(bytes);
  });
});
