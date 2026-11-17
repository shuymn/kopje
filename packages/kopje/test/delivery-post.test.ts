import { type DocumentLoader, verifyRequestDetailed } from "@fedify/fedify";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { LEASE_MS, retryDelay } from "../src/domain/deliveries";
import type { DeliveryOutcome } from "../src/domain/deliveries";
import {
  ACTIVITY_CONTENT_TYPE,
  classifyStatus,
  DELIVERY_TIMEOUT_MS,
  MAX_DOORBELL_DELAY_SECONDS,
  type PostDeps,
  postActivity,
} from "../src/federation/delivery";
import { type DeliveryDeps, deliveryRound, scheduledDeliveries } from "../src/jobs/deliver";
import { handleQueue } from "../src/jobs/queue";
import type { StoreStub } from "../src/platform/store-client";
import { createKeyring } from "../src/security/keyring";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { LEGACY, signAsLegacy } from "./federation-helpers";
import { QueueSim } from "./queue-sim";
import { community, post, remoteAccount, remoteFollows } from "./status-helpers";

// The Worker's side of outbound delivery: the signed POST (NET-2, NET-3, DATA-1, DATA-7), Mastodon's response
// classification, rounds over the Store, and the Queue doorbell (RES-5, RES-6). All fetches are mocked.

const ALICE = "https://kopje.test/ap/users/alice";
const KEY_ID = new URL(`${ALICE}#main-key`);
const publicHost = () => Promise.resolve({ kind: "public" } as const);

function aliceLoader(pubkey: string): DocumentLoader {
  return (url) =>
    Promise.resolve({
      contextUrl: null,
      documentUrl: url,
      document: {
        "@context": ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"],
        id: ALICE,
        type: "Person",
        inbox: `${ALICE}/inbox`,
        publicKey: { id: KEY_ID.href, owner: ALICE, publicKeyPem: pubkey },
      },
    });
}

async function aliceSigner() {
  return (await aliceSigning()).sign;
}

function aliceSigning() {
  return createKeyring(LEGACY.kek).signerFor({ ...LEGACY, keyId: KEY_ID });
}

type Sent = { url: string; request: Request };

function recordingFetch(answer: (request: Request) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, request: request.clone() });
    return answer(request);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

// An answer as postActivity returns it: classifyStatus's outcome, a failure marked as the POST's.
function answered(status: number): DeliveryOutcome {
  const outcome = classifyStatus(status);
  return outcome.kind === "failed" ? { ...outcome, failure: { stage: "post" } } : outcome;
}

// One POST with a full budget: the clock stands at NOW and the deadline is the round's.
function send(
  deps: Omit<PostDeps, "now">,
  inbox: string,
  body: string,
  sign: (request: Request) => Promise<Request>,
): Promise<DeliveryOutcome> {
  return postActivity(
    { ...deps, now: () => NOW },
    { inbox, body, signer: () => Promise.resolve(sign), deadline: NOW + 50_000 },
  );
}

const BODY = JSON.stringify({ "@context": "https://www.w3.org/ns/activitystreams", id: `${ALICE}#x`, type: "Like" });

describe("the POST (NET-2, NET-3)", () => {
  it("signs the activity with its author key, as JSON-LD, and Mastodon-compatible (DATA-7)", async () => {
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }));
    const deps = { fetch, resolveHost: publicHost, userAgent: "Kopje/test" };
    expect(await send(deps, "https://remote.example/inbox", BODY, await aliceSigner())).toEqual({
      kind: "delivered",
      status: 202,
    });
    const request = sent[0]?.request;
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("content-type")).toBe(ACTIVITY_CONTENT_TYPE);
    expect(request?.headers.get("digest")).toMatch(/^SHA-256=/);
    expect(request?.headers.get("signature")).toContain(`keyId="${KEY_ID.href}"`);
    expect(request?.headers.get("signature")).toMatch(/headers="\(request-target\) [^"]*digest[^"]*"/);
    expect(await request?.clone().text()).toBe(BODY);
    // Fedify's verifier (what a Fedify server runs) accepts it, digest included.
    expect(
      await verifyRequestDetailed(request as Request, { documentLoader: aliceLoader(LEGACY.pubkey) }),
    ).toMatchObject({
      verified: true,
      key: { id: KEY_ID },
    });
  });

  it("NET-2: never follows a redirect with a private activity, and retries instead", async () => {
    const { fetch, sent } = recordingFetch(
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/collect" } }),
    );
    const result = await send(
      { fetch, resolveHost: publicHost, userAgent: "Kopje/test" },
      "https://remote.example/inbox",
      JSON.stringify({ type: "Create", to: ["https://remote.example/users/bob"], object: { content: "secret" } }),
      await aliceSigner(),
    );
    expect(result).toEqual({
      kind: "failed",
      status: 307,
      error: "redirect not followed (HTTP 307)",
      permanent: false,
      failure: { stage: "post" },
    });
    expect(sent.map((s) => s.url)).toEqual(["https://remote.example/inbox"]);
    for (const status of [301, 302, 303, 308]) {
      expect(classifyStatus(status)).toMatchObject({ kind: "failed", permanent: false });
    }
  });

  it("classifies answers as Mastodon does", () => {
    const permanent = (status: number) => {
      const outcome = classifyStatus(status);
      return outcome.kind === "failed" ? outcome.permanent : "delivered";
    };
    expect([200, 201, 202, 204].map(permanent)).toEqual(["delivered", "delivered", "delivered", "delivered"]);
    expect([400, 403, 404, 410, 413, 422, 501].map(permanent)).toEqual([true, true, true, true, true, true, true]);
    expect([401, 408, 429, 500, 502, 503, 504].map(permanent)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("NET-3: refuses inboxes that fail the public-host rules before any request", async () => {
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }));
    const sign = await aliceSigner();
    const deps = { fetch, resolveHost: publicHost, userAgent: "Kopje/test" };
    for (const inbox of [
      "http://remote.example/inbox",
      "https://127.0.0.1/inbox",
      "https://[::1]/inbox",
      "https://localhost/inbox",
      "https://intranet/inbox",
      "https://user:pw@remote.example/inbox",
      "not a url",
    ]) {
      expect(await send(deps, inbox, BODY, sign)).toMatchObject({ kind: "failed", permanent: true });
    }
    // A name that resolves to a private address is refused by the DNS check, and retried later.
    const privateDns = { ...deps, resolveHost: () => Promise.resolve({ kind: "private" } as const) };
    expect(await send(privateDns, "https://rebound.example/inbox", BODY, sign)).toMatchObject({
      kind: "failed",
      permanent: false,
    });
    expect(sent).toEqual([]);
  });

  it("NET-2: times out the POST before the lease ends", async () => {
    expect(DELIVERY_TIMEOUT_MS).toBeLessThan(LEASE_MS);
    const fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    const result = await send(
      { fetch, resolveHost: publicHost, userAgent: "Kopje/test", timeoutMs: 20 },
      "https://slow.example/inbox",
      BODY,
      await aliceSigner(),
    );
    expect(result).toEqual({
      kind: "failed",
      status: null,
      error: "timed out after 20 ms",
      permanent: false,
      failure: { stage: "post", timeout: "whole" },
    });
  });

  it("reports a network error by class only (DATA-5)", async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError("connect failed to https://remote.example/inbox?token=SECRET")),
    ) as unknown as typeof globalThis.fetch;
    const result = await send(
      { fetch, resolveHost: publicHost, userAgent: "Kopje/test" },
      "https://remote.example/inbox",
      BODY,
      await aliceSigner(),
    );
    expect(result).toEqual({
      kind: "failed",
      status: null,
      error: "network error (TypeError)",
      permanent: false,
      failure: { stage: "post" },
    });
  });
});

// A community whose alice signs with the legacy fixture key, and remote followers on two servers (or the first only).
async function signedCommunity(servers = 2) {
  const h = await community(["alice"]);
  const { alice } = h.users;
  await signAsLegacy(h.store, alice.id);
  for (const [name, domain] of (
    [
      ["fan", "fans.example"],
      ["other", "other.example"],
    ] as const
  ).slice(0, servers)) {
    await remoteFollows(h.store, await remoteAccount(h.store, name, domain), alice.id);
  }
  return h;
}

function roundDeps(store: StoreStub, fetch: typeof globalThis.fetch, now = () => NOW): DeliveryDeps {
  let n = 0;
  return {
    build: () => env.CF_VERSION_METADATA.id,
    store: () => store,
    now,
    fetch,
    resolveHost: publicHost,
    leaseToken: () => `lease-${++n}`,
  };
}

const testEnv = (queue: QueueSim, extra: Record<string, unknown> = {}) =>
  ({ ...env, USER_KEK: LEGACY.kek, QUEUE: queue.queue, ...extra }) as unknown as Env;

function doorbellBatch(count: number) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `d${i}`,
    body: { kind: "deliver" },
    timestamp: new Date(NOW),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: { queue: "kopje", messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch,
    messages,
  };
}

describe("delivery rounds", () => {
  it("delivers a status to each inbox, signed by its author, and settles the rows", async () => {
    const h = await signedCommunity();
    const status = await post(h, h.users.alice, { status: "hello fediverse" });
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }));
    const result = await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch));
    expect(result).toEqual({ claimed: 2, settled: ["delivered", "delivered"], nextDueAt: null });
    expect(sent.map((s) => s.url).toSorted()).toEqual(["https://fans.example/inbox", "https://other.example/inbox"]);
    for (const { request } of sent) {
      expect(await verifyRequestDetailed(request, { documentLoader: aliceLoader(LEGACY.pubkey) })).toMatchObject({
        verified: true,
      });
      expect(JSON.parse(await request.text())).toMatchObject({ type: "Create", object: { id: status.uri } });
    }
    expect(await sql(h.store, "SELECT id FROM deliveries")).toEqual([]);
    expect(await sql(h.store, "SELECT id FROM outbound_activities")).toEqual([]);
  });

  it("retries a failure and keeps the other inboxes going", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "hello" });
    const { fetch } = recordingFetch(
      (request) => new Response(null, { status: new URL(request.url).origin === "https://fans.example" ? 503 : 202 }),
    );
    const result = await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch));
    expect(result.settled.toSorted()).toEqual(["delivered", "retry"]);
    expect(result.nextDueAt).toBe(NOW + 60_000);
    expect(await sql(h.store, "SELECT inbox_url, state, last_status FROM deliveries")).toEqual([
      { inbox_url: "https://fans.example/inbox", state: "pending", last_status: 503 },
    ]);
  });

  it("OPS-3: a lost completion leaves the row leased until its lease ends, then it is delivered again", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "hello" });
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }));
    const store = h.store;
    // The Store is unreachable for the completions: the POSTs happened, their outcomes did not arrive.
    const lossy = new Proxy(store, {
      get: (target, name) =>
        name === "completeDelivery"
          ? () => Promise.reject(new Error("Network connection lost."))
          : (Reflect.get(target, name) as unknown),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lost = await deliveryRound(testEnv(new QueueSim()), { ...roundDeps(store, fetch), store: () => lossy });
    expect(lost).toMatchObject({ claimed: 2, settled: [] });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: "kopje.delivery.complete.failed" }));
    errors.mockRestore();
    expect(await deliveryRound(testEnv(new QueueSim()), roundDeps(store, fetch))).toMatchObject({ claimed: 0 });
    const later = await deliveryRound(
      testEnv(new QueueSim()),
      roundDeps(store, fetch, () => NOW + LEASE_MS),
    );
    expect(later).toMatchObject({ claimed: 2, settled: ["delivered", "delivered"] });
    // The receivers saw the same activity twice and deduplicate it by its id.
    expect(
      new Set(await Promise.all(sent.map(async (s) => (JSON.parse(await s.request.text()) as { id: string }).id))).size,
    ).toBe(1);
  });
});

describe("the doorbell (RES-5, RES-6)", () => {
  it("runs one round for a batch of doorbells and rings again for retries, delayed", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "hello" });
    const queue = new QueueSim();
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 503 }));
    const { batch, messages } = doorbellBatch(5);
    const deps = roundDeps(h.store, fetch);
    await handleQueue(batch, testEnv(queue), { build: deps.build, store: deps.store, delivery: deps });
    expect(sent).toHaveLength(2);
    expect(messages.every((m) => m.ack.mock.calls.length === 1 && m.retry.mock.calls.length === 0)).toBe(true);
    expect(queue.pending.map((m) => [m.body, m.delaySeconds])).toEqual([[{ kind: "deliver" }, 60]]);
  });

  it("RES-5: claims nothing and counts no attempt in maintenance", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "hello" });
    const queue = new QueueSim();
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 202 }));
    const { batch, messages } = doorbellBatch(1);
    const deps = roundDeps(h.store, fetch);
    await handleQueue(batch, testEnv(queue, { MAINTENANCE: "readonly" }), {
      build: deps.build,
      store: deps.store,
      delivery: deps,
    });
    await scheduledDeliveries(testEnv(queue, { MAINTENANCE: "full" }), deps);
    expect(sent).toEqual([]);
    expect(messages[0]?.ack).toHaveBeenCalled();
    expect(queue.pending).toEqual([]);
    expect(await sql(h.store, "SELECT attempts, state FROM deliveries")).toEqual([
      { attempts: 0, state: "pending" },
      { attempts: 0, state: "pending" },
    ]);
  });

  it("rings at once while due work remains after a round, and from the cron", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (let i = 0; i < 17; i++) {
      await remoteFollows(h.store, await remoteAccount(h.store, `f${i}`, `server${i}.example`), alice.id);
    }
    await post(h, alice, { status: "to many" });
    const queue = new QueueSim();
    const { fetch } = recordingFetch(() => new Response(null, { status: 202 }));
    const deps = roundDeps(h.store, fetch);
    await handleQueue(doorbellBatch(1).batch, testEnv(queue, { USER_KEK: "" }), {
      build: deps.build,
      store: deps.store,
      delivery: deps,
    });
    // The fixture keys of community() do not unwrap: the 16 claimed are retried, and the 17th is due at once.
    expect(queue.pending.map((m) => m.delaySeconds)).toEqual([0]);
    await scheduledDeliveries(testEnv(queue), deps);
    expect(queue.pending).toHaveLength(2);
    expect(MAX_DOORBELL_DELAY_SECONDS).toBe(12 * 60 * 60);
  });

  it("rings after an API write", async () => {
    const h = await community(["alice"]);
    await post(h, h.users.alice, { status: "hello" });
    expect(h.doorbell).toHaveBeenCalledTimes(1);
    await h.request("/api/v1/timelines/home", { headers: { authorization: `Bearer ${h.users.alice.token}` } });
    expect(h.doorbell).toHaveBeenCalledTimes(1);
  });
});

const formOf = (request: Request) =>
  request.headers.has("signature-input") ? "rfc9421" : request.headers.has("signature") ? "cavage" : "unsigned";

// An inbox that answers a draft-cavage POST with `cavage` and an RFC 9421 one with `rfc9421`, as one that accepts
// only RFC 9421 answers 401 (or 400) to the first.
function byForm(cavage: number, rfc9421: number | ((request: Request) => Response | Promise<Response>) = 202) {
  return (request: Request) =>
    formOf(request) === "cavage"
      ? new Response(null, { status: cavage })
      : typeof rfc9421 === "number"
        ? new Response(null, { status: rfc9421 })
        : rfc9421(request);
}

// Mastodon 4.7's RFC 9421 signature of a POST (request.rb perform_rfc9421_signed_request): exactly @method,
// @target-uri and content-digest, bare, by alice's key.
const MASTODON_47_POST = new RegExp(
  `^sig1=\\("@method" "@target-uri" "content-digest"\\);alg="rsa-v1_5-sha256";keyid="${KEY_ID.href}";created=\\d+$`,
);

const INBOX = "https://remote.example/inbox";

// One POST with the keyring's pair and a full budget, the clock at `now`; `loads` records each signer loaded.
async function knock(
  deps: Omit<PostDeps, "now">,
  now: () => number = () => NOW,
  loads: string[] = [],
): Promise<DeliveryOutcome> {
  const { sign, retry } = await aliceSigning();
  return postActivity(
    { ...deps, now },
    {
      inbox: INBOX,
      body: BODY,
      signer: () => {
        loads.push("sign");
        return Promise.resolve(sign);
      },
      retry: () => {
        loads.push("retry");
        return Promise.resolve(retry);
      },
      deadline: NOW + 50_000,
    },
  );
}

// Mastodon 4.7's double knock for deliveries (NET-2): a POST answered 400 or 401 to its draft-cavage signature is sent
// once more, signed with RFC 9421 by the same key, after the deadline and host checks and the Store's confirmation
// again; its answer settles the delivery.
describe("the RFC 9421 retry (NET-2, NET-3, VIS-30)", () => {
  it.each([401, 400])(
    "sends a POST answered %i once more, signed with RFC 9421 by the same key, which Fedify verifies",
    async (status) => {
      const { fetch, sent } = recordingFetch(byForm(status));
      const deps = { fetch, resolveHost: publicHost, userAgent: "Kopje/test" };
      expect(await knock(deps)).toEqual({ kind: "delivered", status: 202 });
      const [cavage, rfc9421, ...rest] = sent.map((s) => s.request);
      expect(rest).toEqual([]);
      expect(cavage?.headers.get("signature")).toContain(`keyId="${KEY_ID.href}"`);
      expect(cavage?.headers.has("signature-input")).toBe(false);
      expect(rfc9421?.url).toBe(INBOX);
      expect(rfc9421?.method).toBe("POST");
      expect(rfc9421?.redirect).toBe("manual");
      expect(rfc9421?.headers.get("content-type")).toBe(ACTIVITY_CONTENT_TYPE);
      expect(rfc9421?.headers.get("signature-input")).toMatch(MASTODON_47_POST);
      expect(await rfc9421?.clone().text()).toBe(BODY);
      expect(
        await verifyRequestDetailed(rfc9421 as Request, { documentLoader: aliceLoader(LEGACY.pubkey) }),
      ).toMatchObject({ verified: true, signatureLabel: "sig1", key: { id: KEY_ID } });
    },
  );

  it.each([202, 403, 404, 410, 500, 302])("sends a POST answered %i once", async (status) => {
    const { fetch, sent } = recordingFetch(
      () => new Response(null, { status, headers: status === 302 ? { location: "https://elsewhere.example/" } : {} }),
    );
    const outcome = await knock({ fetch, resolveHost: publicHost, userAgent: "Kopje/test" });
    expect(outcome).toEqual(answered(status));
    expect(sent.map((s) => formOf(s.request))).toEqual(["cavage"]);
  });

  it.each<[string, number, number | ((request: Request) => Response | Promise<Response>), Partial<DeliveryOutcome>]>([
    ["400 twice: permanent", 400, 400, { status: 400, error: "HTTP 400", permanent: true }],
    ["401 twice: retried later", 401, 401, { status: 401, error: "HTTP 401", permanent: false }],
    ["400 then 401: retried later", 400, 401, { status: 401, error: "HTTP 401", permanent: false }],
    ["401 then 400: permanent", 401, 400, { status: 400, error: "HTTP 400", permanent: true }],
    [
      "401 then a network error: retried later",
      401,
      () => Promise.reject(new TypeError("connection reset")),
      { status: null, error: "network error (TypeError)", permanent: false },
    ],
    [
      "401 then 302: retried later, the redirect not followed",
      401,
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/collect" } }),
      { status: 302, error: "redirect not followed (HTTP 302)", permanent: false },
    ],
  ])("settles by the second answer: %s", async (_, cavage, rfc9421, outcome) => {
    const { fetch, sent } = recordingFetch(byForm(cavage, rfc9421));
    expect(await knock({ fetch, resolveHost: publicHost, userAgent: "Kopje/test" })).toEqual({
      kind: "failed",
      ...outcome,
      failure: { stage: "post" },
    });
    expect(sent.map((s) => [s.url, formOf(s.request)])).toEqual([
      [INBOX, "cavage"],
      [INBOX, "rfc9421"],
    ]);
  });

  it("runs the host check again before the retry, and sends nothing more once it refuses (NET-3)", async () => {
    const { fetch, sent } = recordingFetch(byForm(401));
    const checked: string[] = [];
    const resolveHost = (url: URL) => {
      checked.push(url.href);
      return Promise.resolve(checked.length > 1 ? ({ kind: "private" } as const) : ({ kind: "public" } as const));
    };
    expect(await knock({ fetch, resolveHost, userAgent: "Kopje/test" })).toEqual({
      kind: "failed",
      status: null,
      error: "refused or unresolved host",
      permanent: false,
      failure: { stage: "resolve", resolution: "private", code: null },
    });
    expect(checked).toEqual([INBOX, INBOX]);
    expect(sent.map((s) => formOf(s.request))).toEqual(["cavage"]);
  });

  // The first answer may have refused only the signature's form, so a retry the deadline leaves no room for is
  // transient, never the first answer's permanent 400.
  it("sends no retry past the deadline, and fails as transient", async () => {
    let clock = NOW;
    const { fetch, sent } = recordingFetch(() => {
      clock = NOW + 50_000;
      return new Response(null, { status: 400 });
    });
    const loads: string[] = [];
    expect(await knock({ fetch, resolveHost: publicHost, userAgent: "Kopje/test" }, () => clock, loads)).toEqual({
      kind: "failed",
      status: null,
      error: "lease budget exhausted",
      permanent: false,
      failure: { stage: "budget" },
    });
    expect(sent.map((s) => formOf(s.request))).toEqual(["cavage"]);
    // The retry's signer (a delivery's second confirmation) is not even loaded.
    expect(loads).toEqual(["sign"]);
  });

  it("holds both POSTs to one timeout", async () => {
    const { fetch, sent } = recordingFetch(byForm(401, () => new Promise<Response>(() => {})));
    expect(await knock({ fetch, resolveHost: publicHost, userAgent: "Kopje/test", timeoutMs: 20 })).toEqual({
      kind: "failed",
      status: null,
      error: "timed out after 20 ms",
      permanent: false,
      failure: { stage: "post", timeout: "whole" },
    });
    expect(sent.map((s) => formOf(s.request))).toEqual(["cavage", "rfc9421"]);
  });

  it("sends once a target without a retry (Web Push's), and keeps the first answer when the retry's signer is null", async () => {
    const { sign } = await aliceSigning();
    const once = (retry?: () => Promise<null>) => {
      const recorded = recordingFetch(() => new Response(null, { status: 401 }));
      const deps = { fetch: recorded.fetch, resolveHost: publicHost, userAgent: "Kopje/test", now: () => NOW };
      const target = { inbox: INBOX, body: BODY, signer: () => Promise.resolve(sign), retry, deadline: NOW + 50_000 };
      return { sent: recorded.sent, outcome: postActivity(deps, target) };
    };
    const without = once();
    expect(await without.outcome).toEqual(answered(401));
    expect(without.sent).toHaveLength(1);
    const withheld = once(() => Promise.resolve(null));
    expect(await withheld.outcome).toEqual(answered(401));
    expect(withheld.sent).toHaveLength(1);
  });
});

// The delivery round's retry: the Store confirms the row again right before it (VIS-30, confirmDelivery), and the body
// it returns is the one signed and sent.
describe("the RFC 9421 retry in delivery rounds (VIS-30, RES-5, RES-6)", () => {
  // Every Store call and every POST, in order.
  function recording(store: StoreStub, events: string[]): StoreStub {
    return new Proxy(store, {
      get: (target, name) => {
        const value = Reflect.get(target, name) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) => {
              events.push(String(name));
              return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[String(name)]!(...args);
            }
          : value;
      },
    });
  }

  it("confirms the row again right before the retry and sends the body it returns, signed by the author", async () => {
    const h = await signedCommunity(1);
    const status = await post(h, h.users.alice, { status: "knock knock" });
    const events: string[] = [];
    const { fetch, sent } = recordingFetch((request) => {
      events.push(`POST ${formOf(request)}`);
      return byForm(401)(request);
    });
    const deps = { ...roundDeps(h.store, fetch), store: () => recording(h.store, events) };
    expect(await deliveryRound(testEnv(new QueueSim()), deps)).toEqual({
      claimed: 1,
      settled: ["delivered"],
      nextDueAt: null,
    });
    expect(events).toEqual([
      "claimDeliveries",
      "confirmDelivery",
      "POST cavage",
      "confirmDelivery",
      "POST rfc9421",
      "completeDelivery",
    ]);
    expect(sent.map((s) => s.url)).toEqual(["https://fans.example/inbox", "https://fans.example/inbox"]);
    for (const { request } of sent.filter((s) => formOf(s.request) === "rfc9421")) {
      expect(request.headers.get("signature-input")).toMatch(MASTODON_47_POST);
      expect(await verifyRequestDetailed(request, { documentLoader: aliceLoader(LEGACY.pubkey) })).toMatchObject({
        verified: true,
      });
      expect(JSON.parse(await request.text())).toMatchObject({ type: "Create", object: { id: status.uri } });
    }
    expect(await sql(h.store, "SELECT id FROM deliveries")).toEqual([]);

    // RES-6: a POST answered at once costs one confirmation.
    await post(h, h.users.alice, { status: "once" });
    const once: string[] = [];
    const accepted = recordingFetch(() => new Response(null, { status: 202 }));
    await deliveryRound(testEnv(new QueueSim()), {
      ...roundDeps(h.store, accepted.fetch),
      store: () => recording(h.store, once),
    });
    expect(once).toEqual(["claimDeliveries", "confirmDelivery", "completeDelivery"]);
    expect(accepted.sent).toHaveLength(1);
  });

  it("sends no retry for a row its second confirmation drops (a block committed between the POSTs)", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "blocked meanwhile" });
    const { fetch, sent } = recordingFetch(async (request) => {
      if (new URL(request.url).host === "fans.example" && formOf(request) === "cavage") {
        await blockDomain(h.store, "fans.example");
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 202 });
    });
    const result = await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch));
    expect(result.settled.toSorted()).toEqual(["delivered", "dropped"]);
    expect(sent.map((s) => [s.url, formOf(s.request)]).toSorted(([a], [b]) => a!.localeCompare(b!))).toEqual([
      ["https://fans.example/inbox", "cavage"],
      ["https://other.example/inbox", "cavage"],
    ]);
    expect(await sql(h.store, "SELECT id FROM deliveries")).toEqual([]);
  });

  it("knocks again on the next attempt after both forms are answered 401 (RES-5)", async () => {
    const h = await signedCommunity();
    await post(h, h.users.alice, { status: "refused twice" });
    const { fetch, sent } = recordingFetch(() => new Response(null, { status: 401 }));
    expect(await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch))).toMatchObject({
      settled: ["retry", "retry"],
      nextDueAt: NOW + retryDelay(1),
    });
    expect(await sql(h.store, "SELECT attempts, state, last_status FROM deliveries")).toEqual([
      { attempts: 1, state: "pending", last_status: 401 },
      { attempts: 1, state: "pending", last_status: 401 },
    ]);
    expect(sent.map((s) => formOf(s.request))).toEqual(["cavage", "cavage", "rfc9421", "rfc9421"]);
    const later = () => NOW + retryDelay(1);
    expect(await deliveryRound(testEnv(new QueueSim()), roundDeps(h.store, fetch, later))).toMatchObject({
      settled: ["retry", "retry"],
    });
    expect(sent.slice(4).map((s) => formOf(s.request))).toEqual(["cavage", "cavage", "rfc9421", "rfc9421"]);
  });
});
