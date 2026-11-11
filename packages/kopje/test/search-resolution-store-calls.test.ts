import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { seedAccount, sql } from "./api-helpers";
import { countingStore, harness, NOW, seedInstanceKey } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { LOCAL, MASTODON, mastodonActor, type RemoteWeb, serveWebFinger } from "./inbox-helpers";
import { ALICE, AS, mastodonNote, setup, type Setup } from "./inbox-status-helpers";

// The Store calls of a resolving search (GET /api/v2/search and GET /api/v1/accounts/search with resolve=true): one
// read before any network work (Store.resolutionGate: the token, the domain and the first request's preparation, or a
// refusal), then the reads whose timing is the guarantee (store.ts, "How a request talks to the Store").

const WEBFINGER = `${MASTODON}/.well-known/webfinger?resource=${encodeURIComponent("acct:bob@mastodon.example")}`;
const INSTANCE_KEY = `${LOCAL}/actor#main-key`;

// The fetches a test holds and the requests it leaves running, released and settled after each test, also when an
// assertion failed before the test released them (docs/engineering.md, "Tests").
const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];
afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
});
function hold(t: Setup, url: string) {
  const held = t.web.hold(url);
  holds.push(held);
  return held;
}
function track<T>(request: Promise<T>): Promise<T> {
  outstanding.push(request);
  return request;
}

// The app over the counted Store, its fetches through `web`, each DNS check recorded.
function counted(t: Setup, web: RemoteWeb = t.web, env: Record<string, unknown> = {}) {
  const counting = countingStore(t.store);
  const dns: string[] = [];
  const loader = {
    fetch: web.fetch,
    checkHost: (url: URL) => {
      dns.push(url.hostname);
      return Promise.resolve();
    },
  };
  const h = harness(counting.stub, env, BUILD, { keygen: fixtureKeyGen, loader }, () => NOW);
  const request = (path: string, token: string = t.tokens.alice) =>
    h.request(path, { headers: { authorization: `Bearer ${token}` } });
  // The request's own calls: the day's activity stamp is a session write made after the answer (mastodon/activity.ts).
  const calls = () => counting.calls.filter((name) => name !== "noteActivity");
  return { records: counting.records, calls, dns, request };
}

// bob, his status and his WebFinger, served; the instance key stored unless cold.
async function world(cold: boolean) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  const note = mastodonNote(bob);
  t.web.serve(note.id, { "@context": AS, ...note });
  serveWebFinger(t.web, "acct:bob@mastodon.example", "acct:bob@mastodon.example", bob.uri);
  if (cold) {
    await sql(t.store, "DELETE FROM instance_settings WHERE name = 'instance_actor_key'");
  } else {
    await seedInstanceKey(t.store);
  }
  return { t, bob, note };
}

const ADDRESS = encodeURIComponent("bob@mastodon.example");

// The gate's answer among a request's recorded Store calls.
function gateOf(records: ReturnType<typeof countingStore>["records"]) {
  const gate = records.find((record) => record.name === "resolutionGate");
  expect(gate?.settled).toBe(true);
  return gate!.answer as { status: string; value?: { prefetch: unknown } };
}

describe("Store calls of a resolving search", () => {
  for (const cold of [false, true]) {
    const key = cold ? "a missing instance key" : "a warm instance key";
    const ensure = cold ? ["ensureInstanceActorKey"] : [];

    it(`resolves a status URL in ${3 + ensure.length} calls, with ${key}`, async () => {
      const { t, bob, note } = await world(cold);
      const c = counted(t);
      const response = await c.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`);
      expect(response.status).toBe(200);
      expect((await response.json<{ statuses: unknown[] }>()).statuses).toHaveLength(1);
      expect(c.calls()).toEqual(["resolutionGate", ...ensure, "actorRevision", "resolveSearch"]);
      expect(gateOf(c.records)).toMatchObject({
        status: "ok",
        value: {
          refused: null,
          prefetch: { signer: { username: null }, ticket: { host: "mastodon.example", refused: false } },
        },
      });
      expect(t.web.fetched).toEqual([note.id, bob.uri]);
      expect(t.web.signers).toEqual([INSTANCE_KEY, INSTANCE_KEY]);
    });

    for (const [endpoint, path, search] of [
      ["v2", `/api/v2/search?resolve=true&q=${ADDRESS}`, "search"],
      ["v1", `/api/v1/accounts/search?resolve=true&q=${ADDRESS}`, "searchAccounts"],
    ] as const) {
      it(`resolves an address on ${endpoint} in ${5 + ensure.length} calls, with ${key}`, async () => {
        const { t, bob } = await world(cold);
        const c = counted(t);
        expect((await c.request(path)).status).toBe(200);
        // The policy read before the declared-domain WebFinger follows an awaited response, so it stays separate.
        expect(c.calls()).toEqual([
          "resolutionGate",
          "actorRevision",
          ...ensure,
          "fetchRefused",
          "resolveSearch",
          search,
        ]);
        expect(t.web.fetched).toEqual([WEBFINGER, bob.uri, WEBFINGER]);
        expect(t.web.signers).toEqual(["unsigned", INSTANCE_KEY, "unsigned"]);
        expect(await sql(t.store, "SELECT count(*) AS n FROM accounts WHERE uri = ?", bob.uri)).toEqual([{ n: 1 }]);
      });
    }
  }

  it("stops before the actor fetch for a block committed while the WebFinger response was awaited (VIS-30)", async () => {
    const { t, bob } = await world(false);
    const c = counted(t);
    const held = hold(t, WEBFINGER);
    const response = track(c.request(`/api/v1/accounts/search?resolve=true&q=${ADDRESS}`));
    await held.reached;
    await blockDomain(t.store, "mastodon.example");
    held.release();
    expect((await response).status).toBe(200);
    // The guarded branch ran: the revision read after the response carried the block's verdict for the actor's host.
    expect(c.records.find((record) => record.name === "actorRevision")?.answer).toEqual({
      revision: null,
      ticket: { host: "mastodon.example", refused: true },
    });
    expect(c.calls()).toEqual(["resolutionGate", "actorRevision", "resolveSearch", "searchAccounts"]);
    expect(t.web.fetched).toEqual([WEBFINGER]);
    expect(await sql(t.store, "SELECT count(*) AS n FROM accounts WHERE uri = ?", bob.uri)).toEqual([{ n: 0 }]);
  });
});

// The decision of #1458: resolution stops before any signer read, DNS check or fetch while the Store does not accept
// writes or the env's MAINTENANCE is not off, and the search answers as without resolve=true.
describe("a resolving search refused before any network work", () => {
  const flags = {
    "the Store readonly": (t: Setup) => t.store.setMaintenance(BUILD, true),
    "an unpublished import": (t: Setup) =>
      runInDurableObject(t.store, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('unpublished', ?)",
          JSON.stringify({ at: NOW, import: "import-1" }),
        );
      }),
  };

  // carol's display name holds the address, so the plain search finds her and resolution would find bob first.
  async function refusedWorld() {
    const { t, bob, note } = await world(false);
    await seedAccount(t.store, { username: "carol", displayName: "bob@mastodon.example" });
    return { t, bob, note };
  }

  for (const [name, refuse] of Object.entries(flags)) {
    it(`answers the plain search under ${name}, the gate refusing with nothing prepared`, async () => {
      const { t, note } = await refusedWorld();
      await refuse(t);
      const c = counted(t);
      const v1 = await c.request(`/api/v1/accounts/search?resolve=true&q=${ADDRESS}`);
      expect((await v1.json<{ acct: string }[]>()).map((a) => a.acct)).toEqual(["carol"]);
      const v2 = await c.request(`/api/v2/search?resolve=true&type=accounts&q=${ADDRESS}`);
      expect((await v2.json<{ accounts: { acct: string }[] }>()).accounts.map((a) => a.acct)).toEqual(["carol"]);
      const url = await c.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`);
      expect(url.status).toBe(200);
      expect(c.calls()).toEqual([
        "resolutionGate",
        "searchAccounts",
        "resolutionGate",
        "search",
        "resolutionGate",
        "search",
      ]);
      const reason = name === "the Store readonly" ? "maintenance" : "unpublished";
      for (const record of c.records.filter((r) => r.name === "resolutionGate")) {
        expect(record.answer).toEqual({ status: "ok", value: { refused: reason } });
      }
      expect([t.web.fetched, c.dns]).toEqual([[], []]);
    });

    // An instance key that cannot be parsed: a read of it (readInstanceKey, the signer's) throws, so an answer shows
    // that the refused gate never read it.
    it(`reads no signer under ${name}: the refusal is decided before the preparation`, async () => {
      const { t, note } = await refusedWorld();
      await sql(t.store, "UPDATE instance_settings SET value = 'not json' WHERE name = 'instance_actor_key'");
      const c = counted(t);
      const path = `/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`;
      // The guarded branch: with writes admitted, the gate reads the key, and the request fails on it.
      expect((await c.request(path)).status).toBe(500);
      await refuse(t);
      expect((await c.request(path)).status).toBe(200);
      expect(c.records.filter((r) => r.name === "resolutionGate").map((r) => r.error === undefined)).toEqual([
        false,
        true,
      ]);
      expect([t.web.fetched, c.dns]).toEqual([[], []]);
    });
  }

  // The Store comes to refuse writes while the last response is awaited: the final store is refused, and the search
  // answers as the plain search does, judging the token again at its own time.
  describe("refused while resolving", () => {
    async function heldWorld() {
      const { t, bob, note } = await refusedWorld();
      // erin's display name holds the URL, so the plain search finds her for the URL query.
      await seedAccount(t.store, { username: "erin", displayName: note.id });
      return { t, bob, note };
    }
    const during = async (t: Setup, url: string, path: string) => {
      const c = counted(t);
      const held = hold(t, url);
      const response = track(c.request(path));
      await held.reached;
      await t.store.setMaintenance(BUILD, true);
      held.release();
      return { c, response: await response };
    };

    it("answers a v2 URL query with the plain search", async () => {
      const { t, bob, note } = await heldWorld();
      const { c, response } = await during(t, bob.uri, `/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`);
      expect(response.status).toBe(200);
      const body = await response.json<{ accounts: { acct: string }[]; statuses: unknown[] }>();
      expect([body.accounts.map((a) => a.acct), body.statuses]).toEqual([["erin"], []]);
      expect(c.calls()).toEqual(["resolutionGate", "actorRevision", "resolveSearch", "search"]);
      expect(t.web.fetched).toEqual([note.id, bob.uri]);
    });

    for (const [endpoint, path] of [
      ["v2", `/api/v2/search?resolve=true&type=accounts&q=${ADDRESS}`],
      ["v1", `/api/v1/accounts/search?resolve=true&q=${ADDRESS}`],
    ] as const) {
      it(`answers a ${endpoint} address query with the plain search`, async () => {
        const { t, bob } = await heldWorld();
        const { response } = await during(t, bob.uri, path);
        const body = await response.json<{ accounts: { acct: string }[] } | { acct: string }[]>();
        const accounts = Array.isArray(body) ? body : body.accounts;
        expect([response.status, accounts.map((a) => a.acct)]).toEqual([200, ["carol"]]);
        expect(await sql(t.store, "SELECT count(*) AS n FROM accounts WHERE uri = ?", bob.uri)).toEqual([{ n: 0 }]);
      });
    }

    it("refuses a token that expired in that window, on a v2 URL query (AUTH-1)", async () => {
      const clock = { now: NOW };
      const { t, bob, note } = await heldWorld();
      await sql(
        t.store,
        "UPDATE oauth_tokens SET expires_at = ? WHERE account_id = ?",
        new Date(NOW + 60_000).toISOString(),
        ALICE,
      );
      const c = countingStore(t.store);
      const h = harness(c.stub, {}, BUILD, { keygen: fixtureKeyGen, loader: t.web.loader }, () => clock.now);
      const held = hold(t, bob.uri);
      const response = track(
        h.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, {
          headers: { authorization: `Bearer ${t.tokens.alice}` },
        }),
      );
      await held.reached;
      await t.store.setMaintenance(BUILD, true);
      clock.now = NOW + 120_000;
      held.release();
      expect((await response).status).toBe(401);
      expect(c.calls.filter((name) => name !== "noteActivity")).toEqual([
        "resolutionGate",
        "actorRevision",
        "resolveSearch",
        "search",
      ]);
    });
  });

  it("answers an invalid token 401 under the Store readonly: the gate judges the token first", async () => {
    const { t, note } = await refusedWorld();
    await t.store.setMaintenance(BUILD, true);
    const c = counted(t);
    const url = await c.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, "not-a-token");
    expect(url.status).toBe(401);
    expect(c.records.map((record) => [record.name, record.answer])).toEqual([
      ["resolutionGate", { status: "unauthenticated" }],
    ]);
  });

  // MAINTENANCE=full answers every API request 503 before its handler (app.ts, the maintenance gate).
  it("answers the plain search under the env's MAINTENANCE=readonly, with no gate read", async () => {
    const { t, note } = await refusedWorld();
    const c = counted(t, t.web, { MAINTENANCE: "readonly" });
    const v1 = await c.request(`/api/v1/accounts/search?resolve=true&q=${ADDRESS}`);
    expect([v1.status, (await v1.json<{ acct: string }[]>()).map((a) => a.acct)]).toEqual([200, ["carol"]]);
    const v2 = await c.request(`/api/v2/search?resolve=true&type=accounts&q=${ADDRESS}`);
    expect((await v2.json<{ accounts: { acct: string }[] }>()).accounts.map((a) => a.acct)).toEqual(["carol"]);
    expect((await c.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`)).status).toBe(200);
    expect(c.calls()).toEqual(["searchAccounts", "search", "search"]);
    expect([t.web.fetched, c.dns]).toEqual([[], []]);
  });

  it("answers an invalid token 401 under the env's MAINTENANCE=readonly, from the plain search", async () => {
    const { t, note } = await refusedWorld();
    const c = counted(t, t.web, { MAINTENANCE: "readonly" });
    const url = await c.request(`/api/v2/search?resolve=true&q=${encodeURIComponent(note.id)}`, "not-a-token");
    expect(url.status).toBe(401);
    expect(c.calls()).toEqual(["search"]);
  });

  it("resolves once writes are admitted again (the guard ran)", async () => {
    const { t, bob } = await refusedWorld();
    await t.store.setMaintenance(BUILD, true);
    await t.store.setMaintenance(BUILD, false);
    const c = counted(t);
    const v1 = await c.request(`/api/v1/accounts/search?resolve=true&q=${ADDRESS}`);
    expect((await v1.json<{ acct: string }[]>()).map((a) => a.acct)).toEqual(["bob@mastodon.example", "carol"]);
    expect(t.web.fetched).toContain(bob.uri);
  });
});
