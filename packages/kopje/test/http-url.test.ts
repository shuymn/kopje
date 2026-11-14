import { describe, expect, it } from "vitest";

import { sameOrigin } from "../src/platform/http-url";

describe("sameOrigin", () => {
  it.each([
    ["https://a.example/users/x", "https://a.example/statuses/1"],
    ["http://a.example/x", "http://a.example:80/y"],
    ["https://a.example/x", "https://a.example:443/y"],
    ["https://A.Example/x", "HTTPS://a.example/y"],
    ["https://a.example./x", "https://a.example./y"],
  ])("holds for %s and %s", (a, b) => {
    expect(sameOrigin(a, b)).toBe(true);
    expect(sameOrigin(b, a)).toBe(true);
  });

  it.each([
    ["urn:uuid:1", "urn:uuid:2", "two opaque ids"],
    ["urn:uuid:1", "urn:uuid:1", "an opaque id and itself"],
    ["tag:a.example,2026:x", "https://a.example/x", "an opaque id and an http(s) one"],
    ["data:text/plain,x", "data:text/plain,x", "two data: URLs"],
    ["blob:https://a.example/x", "https://a.example/y", "a blob: URL and the origin inside it"],
    ["ftp://a.example/x", "ftp://a.example/y", "two ids of another scheme"],
    ["http://a.example/x", "https://a.example/y", "mixed schemes"],
    ["https://a.example/x", "https://a.example:8443/y", "another port"],
    ["https://a.example:8443/x", "https://a.example:9443/y", "two other ports"],
    ["https://a.example/x", "https://b.example/x", "another host"],
    ["https://a.example/x", "https://sub.a.example/x", "a subdomain"],
    ["https://a.example/x", "https://a.example./x", "a trailing dot"],
    ["not a url", "not a url", "two unparsable ids"],
    ["", "", "two empty strings"],
  ])("refuses %s and %s (%s)", (a, b) => {
    expect(sameOrigin(a, b)).toBe(false);
    expect(sameOrigin(b, a)).toBe(false);
  });

  it("refuses null on either side", () => {
    expect(sameOrigin(null, null)).toBe(false);
    expect(sameOrigin(null, "https://a.example/x")).toBe(false);
    expect(sameOrigin("https://a.example/x", null)).toBe(false);
  });
});
