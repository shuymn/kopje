import dns from "node:dns/promises";

import { validatePublicUrl } from "@fedify/fedify";
import { afterEach, describe, expect, it, vi } from "vitest";

// The delivery sink's host check (federation/loader.ts resolveDeliveryHost, NET-3) against Fedify's validatePublicUrl,
// over the same stubbed lookups: it is `public` only where validatePublicUrl lets the URL through, and its result
// keeps what Fedify's UrlError does not (domain/delivery-hosts.ts hostCaused counts a confirmed no-address answer,
// never a resolver failure).

// The Worker's modules, loaded by computed specifiers: they are typed against the Workers runtime, which this suite's
// TypeScript project does not include; each is read as the shape used here.
type Resolution = { kind: "public" | "private" | "none" | "error"; code?: string | null };
type Failure = { stage: "resolve"; resolution: string; code: string | null };
const { resolveDeliveryHost } = (await import(new URL("../src/federation/loader.ts", import.meta.url).href)) as {
  resolveDeliveryHost: (url: URL) => Promise<Resolution>;
};
const { hostCaused } = (await import(new URL("../src/domain/delivery-hosts.ts", import.meta.url).href)) as {
  hostCaused: (failure: Failure | undefined, permanent: boolean) => boolean;
};

type Lookup = () => Promise<{ address: string; family: number }[]>;

const failing = (code?: string): Lookup => {
  return () => Promise.reject(Object.assign(new Error("lookup failed"), code === undefined ? {} : { code }));
};

const CASES: { name: string; lookup: Lookup; kind: string; counts: boolean }[] = [
  {
    name: "a public address",
    lookup: () => Promise.resolve([{ address: "93.184.215.14", family: 4 }]),
    kind: "public",
    counts: false,
  },
  {
    name: "public addresses of both families",
    lookup: () =>
      Promise.resolve([
        { address: "93.184.215.14", family: 4 },
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      ]),
    kind: "public",
    counts: false,
  },
  { name: "an empty answer", lookup: () => Promise.resolve([]), kind: "none", counts: true },
  // workerd answers a CNAME chain with the name rows too (cloudflare/workerd#6886).
  {
    name: "a CNAME-only answer",
    lookup: () => Promise.resolve([{ address: "alias.example", family: 4 }]),
    kind: "none",
    counts: true,
  },
  {
    name: "a private address",
    lookup: () => Promise.resolve([{ address: "10.0.0.1", family: 4 }]),
    kind: "private",
    counts: true,
  },
  {
    name: "a public and a private address",
    lookup: () =>
      Promise.resolve([
        { address: "93.184.215.14", family: 4 },
        { address: "fd00::1", family: 6 },
      ]),
    kind: "private",
    counts: true,
  },
  { name: "ENOTFOUND", lookup: failing("ENOTFOUND"), kind: "error", counts: true },
  { name: "ENODATA", lookup: failing("ENODATA"), kind: "error", counts: true },
  { name: "EAI_AGAIN", lookup: failing("EAI_AGAIN"), kind: "error", counts: false },
  { name: "ESERVFAIL", lookup: failing("ESERVFAIL"), kind: "error", counts: false },
  { name: "an error without a code", lookup: failing(), kind: "error", counts: false },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDeliveryHost", () => {
  it.each(CASES)(
    "reads $name as $kind, public only where validatePublicUrl passes",
    async ({ lookup, kind, counts }) => {
      vi.spyOn(dns, "lookup").mockImplementation(lookup as never);
      const url = new URL("https://h.example/inbox");
      const resolution = await resolveDeliveryHost(url);
      expect(resolution.kind).toBe(kind);
      const fedify = await validatePublicUrl(url.href).then(
        () => "passed",
        () => "refused",
      );
      expect(fedify).toBe(kind === "public" ? "passed" : "refused");
      // As the sink records it (federation/delivery.ts postActivity), and whether the host's count takes it.
      const failure =
        resolution.kind === "public"
          ? undefined
          : {
              stage: "resolve" as const,
              resolution: resolution.kind,
              code: resolution.kind === "error" ? (resolution.code ?? null) : null,
            };
      expect(failure === undefined ? false : hostCaused(failure, false)).toBe(counts);
    },
  );

  it("judges an IP literal and localhost without a lookup, as validatePublicUrl does", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => Promise.reject(new Error("no lookup")));
    for (const [href, kind] of [
      ["https://93.184.215.14/inbox", "public"],
      ["https://10.0.0.1/inbox", "private"],
      ["https://[fd00::1]/inbox", "private"],
      ["https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/inbox", "public"],
      ["https://localhost/inbox", "private"],
      ["ftp://h.example/inbox", "private"],
    ] as const) {
      expect((await resolveDeliveryHost(new URL(href))).kind, href).toBe(kind);
      const fedify = await validatePublicUrl(href).then(
        () => "passed",
        () => "refused",
      );
      expect(fedify, href).toBe(kind === "public" ? "passed" : "refused");
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});
