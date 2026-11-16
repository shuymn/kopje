import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DoKvStore } from "../src/federation/kv-store";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { countingStore, harness, NOW, seedInstanceKey } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { mastodonActor } from "./inbox-helpers";
import { AS, create, followed, mastodonNote, setup, type Setup } from "./inbox-status-helpers";

// Store calls of a poll read (GET /api/v1/polls/:id, #1655; docs/threat-model.md RES-6): after the host check's domain
// read that every API request makes (instanceDomain, WEB-6), getPoll; for a due poll, reservePollRefresh, whose answer
// carries the signer and the first request's policy ticket; fetchRefused before each later send (the RFC 9421 retry of
// a 401 alone, since no redirect is followed); ensureInstanceActorKey once per instance, when a public or unlisted
// post's fetch finds no instance key; refreshPoll for a document taken. At most five, and no KV call: the refresh's
// loader is the per-request memo, never the KV-cached signed loader, and no JSON-LD context is loaded.

const ODD_CONTEXT = "https://contexts.example/odd.jsonld";

afterEach(() => {
  vi.useRealTimers();
});

const choices = (cats: number, dogs: number) => [
  { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
  { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: dogs } },
];

// bob's public Question, stored by its Create, its poll due; the instance key stored unless cold.
async function world(cold: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const note = mastodonNote(bob, {
    type: "Question",
    endTime: "2026-10-12T01:00:00Z",
    votersCount: 0,
    oneOf: choices(0, 0),
  });
  t.web.serve(note.id, { "@context": AS, ...note, votersCount: 3, oneOf: choices(1, 2) });
  expect(await t.post(bob, create(bob, note))).toBe(202);
  const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
  if (cold) {
    await sql(t.store, "DELETE FROM instance_settings WHERE name = 'instance_actor_key'");
  } else {
    await seedInstanceKey(t.store);
  }
  t.web.fetched.length = 0;
  return { t, note, id: row!.id };
}

// alice's read of the poll over the counted Store; `first` answers the first fetch in place of the web.
async function readCounted(w: { t: Setup; id: string }, options: { store?: StoreStub; first?: Response } = {}) {
  const counting = countingStore(options.store ?? w.t.store);
  let first = options.first;
  const loader = {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      if (first !== undefined) {
        const answer = first;
        first = undefined;
        w.t.web.fetched.push(new Request(input, init).url);
        return Promise.resolve(answer);
      }
      return w.t.web.fetch(input, init);
    }) as typeof fetch,
    checkHost: () => Promise.resolve(),
  };
  const h = harness(counting.stub, {}, BUILD, { keygen: fixtureKeyGen, loader }, () => NOW);
  const response = await h.request(`/api/v1/polls/${w.id}`, {
    headers: { authorization: `Bearer ${w.t.tokens.alice}` },
  });
  expect(response.status).toBe(200);
  const body = await response.json<{ votes_count: number }>();
  // The request's own calls: the day's activity stamp is a session write made after the answer (mastodon/activity.ts).
  return { body, calls: counting.calls.filter((name) => name !== "noteActivity") };
}

const unauthorized = () => new Response("Unauthorized", { status: 401 });

describe("Store calls of a poll read", () => {
  it("not due: one", async () => {
    const w = await world(false);
    await sql(w.t.store, "UPDATE polls SET refresh_at = ? WHERE status_id = ?", NOW, w.id);
    const { body, calls } = await readCounted(w);
    expect(calls).toEqual(["instanceDomain", "getPoll"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([0, []]);
  });

  it("due, another read reserved first: two", async () => {
    const w = await world(false);
    // The other read's reservation commits between this read's getPoll and its reservation.
    const tokenHash = await sha256Hex(w.t.tokens.dave);
    const raced = new Proxy(w.t.store, {
      get: (target, name) => {
        const method = (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[String(name)];
        if (typeof method !== "function") {
          return Reflect.get(target, name) as unknown;
        }
        return async (...args: unknown[]) => {
          const answer = await method(...args);
          if (name === "getPoll") {
            const other = await target.reservePollRefresh(BUILD, {
              credential: { tokenHash, scope: "read:statuses", now: NOW },
              id: w.id,
            });
            expect(other).toMatchObject({ status: "ok", value: { statusId: w.id } });
          }
          return answer;
        };
      },
    });
    const { body, calls } = await readCounted(w, { store: raced });
    expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([0, []]);
  });

  it("warm, applied: three", async () => {
    const w = await world(false);
    const { body, calls } = await readCounted(w);
    expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh", "refreshPoll"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([3, [w.note.id]]);
  });

  it("warm, a 401 then applied: four", async () => {
    const w = await world(false);
    const { body, calls } = await readCounted(w, { first: unauthorized() });
    expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh", "fetchRefused", "refreshPoll"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([3, [w.note.id, w.note.id]]);
  });

  it("cold, a public post, a 401 then applied: five", async () => {
    const w = await world(true);
    const { body, calls } = await readCounted(w, { first: unauthorized() });
    expect(calls).toEqual([
      "instanceDomain",
      "getPoll",
      "reservePollRefresh",
      "ensureInstanceActorKey",
      "fetchRefused",
      "refreshPoll",
    ]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([3, [w.note.id, w.note.id]]);
  });

  it("warm, a 302: two", async () => {
    const w = await world(false);
    w.t.web.redirect(w.note.id, `${w.note.id}/elsewhere`);
    w.t.web.serve(`${w.note.id}/elsewhere`, { "@context": AS, id: w.note.id });
    const { body, calls } = await readCounted(w);
    expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([0, [w.note.id]]);
  });

  it("cold, a public post, a 503: three", async () => {
    const w = await world(true);
    w.t.web.fail(w.note.id, 503);
    const { body, calls } = await readCounted(w);
    expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh", "ensureInstanceActorKey"]);
    expect([body.votes_count, w.t.web.fetched]).toEqual([0, [w.note.id]]);
  });

  // A document naming a context that is not preloaded: none is loaded, so the KV cache is never read or written, cold
  // or warm (an entry for it stored as Fedify's kvCache stores one).
  for (const warm of [false, true]) {
    it(`a context that is not preloaded, the KV cache ${warm ? "warm" : "cold"}: no KV call`, async () => {
      const w = await world(false);
      const served = w.t.web.served.get(w.note.id)!.body as Record<string, unknown>;
      w.t.web.serve(w.note.id, { ...served, "@context": [AS, ODD_CONTEXT] });
      w.t.web.serve(ODD_CONTEXT, { "@context": { odd: "https://contexts.example/odd#" } });
      if (warm) {
        const kv = new DoKvStore(
          () => w.t.store,
          BUILD,
          () => NOW,
        );
        const document = { "@context": { odd: "https://contexts.example/odd#" } };
        await kv.set(
          ["_fedify", "remoteDocument", ODD_CONTEXT],
          { contextUrl: null, document, documentUrl: ODD_CONTEXT },
          { ttl: Temporal.Duration.from({ minutes: 5 }) },
        );
      }
      const { body, calls } = await readCounted(w);
      expect(calls).toEqual(["instanceDomain", "getPoll", "reservePollRefresh", "refreshPoll"]);
      expect([body.votes_count, w.t.web.fetched]).toEqual([3, [w.note.id]]);
    });
  }
});
