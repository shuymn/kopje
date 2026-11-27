import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MENTION_ADDRESSES_PER_POST } from "../src/domain/mention-addresses";
import { MAX_RAW_LENGTH } from "../src/domain/status-text";
import { DOCUMENT_BODY_LIMIT, mentionBudget, REQUEST_DEADLINE_MS, REQUEST_MAX_BYTES } from "../src/federation/loader";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, serveWebFinger } from "./inbox-helpers";
import { ALICE } from "./inbox-status-helpers";
import {
  accountAt,
  mentionWorld,
  type MentionWorld,
  plainActor,
  posted,
  splitDomain,
  webfinger,
} from "./mention-helpers";
import { remoteAccount } from "./status-helpers";

// The Store calls, requests and DNS checks of a post's or an edit's mention resolution (#1558,
// domain/mention-addresses.ts, federation/resolve.ts createAddressResolver): after the host check's domain read every
// API request makes (instanceDomain, WEB-6), the gate (one read, before any network work), then per address the reads
// whose timing is the guarantee (docs/engineering.md, "How a request talks to the Store"), then the write. The unit of
// RES-6's mention budget is one address (docs/engineering.md, "Measure a unit's maximum before setting an aggregate
// budget over it"): its rows are measured here, and mentionBudget is derived from the largest.

const PLAIN = ["instanceDomain", "postMentionGate", "actorState", "fetchRefused", "postStatus"];
// The confirmation's second WebFinger reads the policy again: it follows an awaited response.
const CONFIRMED_TWICE = [
  "instanceDomain",
  "postMentionGate",
  "actorState",
  "fetchRefused",
  "fetchRefused",
  "postStatus",
];

// One address's path: what the request made, and whether the address was mentioned.
async function unit(w: MentionWorld, text: string) {
  const status = await posted(w.post({ status: text }));
  return { calls: w.calls(), fetched: [...w.t.web.fetched], dns: w.dns.length, mentions: status.mentions.length };
}

// bob, stored as bob@old.example by a search, whose old domain then names bob@new.example, which names him.
async function movedHandle(w: MentionWorld) {
  const bob = await mastodonActor(w.t.web, "bob", { origin: "https://old.example" });
  const search = await w.t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent("bob@old.example")}`);
  expect(search.status).toBe(200);
  expect(await accountAt(w.t.store, "bob", "old.example")).toMatchObject({ uri: bob.uri });
  serveWebFinger(w.t.web, "acct:bob@old.example", "acct:bob@new.example", bob.uri);
  serveWebFinger(w.t.web, "acct:bob@new.example", "acct:bob@new.example", bob.uri);
  w.reset();
  return bob;
}

describe("the unit: one address (RES-6)", () => {
  it("costs 3 requests on the plain path: its WebFinger, the actor and the confirming WebFinger", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    expect(await unit(w, "hi @bob@mastodon.example")).toEqual({
      calls: PLAIN,
      fetched: [webfinger("bob", "mastodon.example"), bob.uri, webfinger("bob", "mastodon.example")],
      dns: 3,
      mentions: 1,
    });
    // The first WebFinger spends the gate's verdict and the actor fetch the verdict actorState carries.
    expect(w.gates()).toEqual([
      {
        status: "ok",
        value: expect.objectContaining({
          kind: "prepared",
          prepared: {
            signer: expect.objectContaining({ username: null }),
            ticket: { host: "mastodon.example", refused: false },
          },
        }),
      },
    ]);
    expect(w.t.web.signers).toEqual(["unsigned", `https://kopje.test/actor#main-key`, "unsigned"]);
  });

  it("costs 4 on a split domain's canonical address, and 4 on its server host, which stays text", async () => {
    const w = await mentionWorld();
    const ali = await splitDomain(w.t.web);
    expect(await unit(w, "hi @ali@nice.example")).toEqual({
      calls: CONFIRMED_TWICE,
      fetched: [
        webfinger("ali", "nice.example"),
        ali.uri,
        webfinger("ali", "social.example"),
        webfinger("ali", "nice.example"),
      ],
      dns: 4,
      mentions: 1,
    });
    const other = await mentionWorld();
    await splitDomain(other.t.web);
    expect(await unit(other, "hi @ali@social.example")).toEqual({
      calls: CONFIRMED_TWICE,
      fetched: [
        webfinger("ali", "social.example"),
        ali.uri,
        webfinger("ali", "social.example"),
        webfinger("ali", "nice.example"),
      ],
      dns: 4,
      mentions: 0,
    });
  });

  it("costs 4 for an old handle stored, the new address typed: the stored handle's claim is confirmed again (T3, plan 12b)", async () => {
    const w = await mentionWorld();
    const bob = await movedHandle(w);
    expect(await unit(w, "hi @bob@new.example")).toEqual({
      calls: CONFIRMED_TWICE,
      fetched: [
        webfinger("bob", "new.example"),
        bob.uri,
        webfinger("bob", "old.example"),
        webfinger("bob", "new.example"),
      ],
      dns: 4,
      mentions: 1,
    });
    // The account found by the new address it moved to, and stored under it.
    expect(await sql(w.t.store, "SELECT username, domain FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { username: "bob", domain: "new.example" },
    ]);
  });

  it("costs 2 for an actor that answers 410, with no policy read after actorState and no actorGone", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    w.t.web.fail(bob.uri, 410);
    expect(await unit(w, "hi @bob@mastodon.example")).toEqual({
      calls: ["instanceDomain", "postMentionGate", "actorState", "postStatus"],
      fetched: [webfinger("bob", "mastodon.example"), bob.uri],
      dns: 2,
      mentions: 0,
    });
  });

  it("has the plain shape for an edit", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    const own = await posted(w.post({ status: "first" }));
    w.reset();
    const edited = await w.edit(own.id, { status: "now @bob@mastodon.example" });
    expect(edited.status).toBe(200);
    expect(w.calls()).toEqual(["instanceDomain", "editMentionGate", "actorState", "fetchRefused", "editStatus"]);
    expect(w.t.web.fetched).toEqual([
      webfinger("bob", "mastodon.example"),
      bob.uri,
      webfinger("bob", "mastodon.example"),
    ]);
  });

  it("makes the gate read and the write, and no request, when every address is stored (U1b)", async () => {
    const w = await mentionWorld();
    await remoteAccount(w.t.store, "carol", "remote.example");
    await posted(w.post({ status: "hi @carol@remote.example @dave" }));
    expect(w.calls()).toEqual(["instanceDomain", "postMentionGate", "postStatus"]);
    expect(w.gates()).toEqual([{ status: "ok", value: { kind: "none" } }]);
    expect([w.t.web.fetched, w.dns]).toEqual([[], []]);
  });
});

describe("what one resolution shares", () => {
  it("creates a missing instance key once, at the first signed fetch, for two addresses (U4)", async () => {
    let generated = 0;
    const keygen = () => {
      generated++;
      return fixtureKeyGen();
    };
    const w = await mentionWorld({ cold: true, keygen });
    await plainActor(w.t.web, "bob");
    await plainActor(w.t.web, "carol", "other.example");
    const status = await posted(w.post({ status: "@bob@mastodon.example @carol@other.example" }));
    expect(status.mentions.map((m) => m.acct).toSorted()).toEqual(["bob@mastodon.example", "carol@other.example"]);
    expect(w.calls()).toEqual([
      "instanceDomain",
      "postMentionGate",
      "actorState",
      "ensureInstanceActorKey",
      "fetchRefused",
      "fetchRefused",
      "actorState",
      "fetchRefused",
      "postStatus",
    ]);
    expect(generated).toBe(1);
  });

  it("reads an uncached JSON-LD context once, then from the cache (U5)", async () => {
    const w = await mentionWorld();
    const context = "https://contexts.example/ns.jsonld";
    w.t.web.serve(
      context,
      { "@context": { kopjeTest: "https://contexts.example/ns#kopjeTest" } },
      "application/ld+json",
    );
    for (const [name, host] of [
      ["bob", "mastodon.example"],
      ["carol", "other.example"],
    ] as const) {
      const actor = await plainActor(w.t.web, name, host);
      actor.document["@context"] = [...(actor.document["@context"] as unknown[]), context];
      w.t.web.serve(actor.uri, actor.document);
    }
    await posted(w.post({ status: "@bob@mastodon.example" }));
    expect(w.calls()).toEqual([
      "instanceDomain",
      "postMentionGate",
      "actorState",
      "kvGet",
      "fetchRefused",
      "kvSet",
      // The document is read once more against the context, now from the cache.
      "kvGet",
      "fetchRefused",
      "postStatus",
    ]);
    expect(w.t.web.fetched.filter((url) => url === context)).toHaveLength(1);
    w.reset();
    await posted(w.post({ status: "@carol@other.example" }));
    expect(w.calls()).toEqual([
      "instanceDomain",
      "postMentionGate",
      "actorState",
      "kvGet",
      "kvGet",
      "fetchRefused",
      "postStatus",
    ]);
    expect(w.t.web.fetched).not.toContain(context);
  });
});

describe("the request's bounds (RES-6)", () => {
  it("derives mentionBudget from the unit, and four split-domain addresses spend its fetches exactly (U6)", async () => {
    // The unit's largest row above: 4 requests (the split domain, the old handle).
    const unitFetches = 4;
    expect(mentionBudget(0)).toEqual({
      fetches: MENTION_ADDRESSES_PER_POST * unitFetches,
      bytes: REQUEST_MAX_BYTES,
      deadline: REQUEST_DEADLINE_MS,
    });
    const w = await mentionWorld();
    const names = ["ali", "bea", "cid", "dan"];
    for (const name of names) {
      await splitDomain(w.t.web, name);
    }
    const text = names.map((name) => `@${name}@nice.example`).join(" ");
    const found = await w.resolver()(w.h.env, await w.start(text));
    expect(found.map((entry) => entry.key)).toEqual(names.map((name) => `${name}@nice.example`));
    expect(w.made[0]?.fetches).toBe(0);
    // The figures of RES-6 derived from the unit and the cap, and the run within them.
    const requests = MENTION_ADDRESSES_PER_POST * unitFetches;
    const loadAttempts = requests + MENTION_ADDRESSES_PER_POST;
    const dnsLookups = 2 * loadAttempts;
    const policyReads = loadAttempts;
    expect([requests, loadAttempts, dnsLookups, policyReads]).toEqual([16, 20, 40, 20]);
    expect(w.t.web.fetched.length).toBeLessThanOrEqual(requests);
    expect(w.dns.length).toBeLessThanOrEqual(loadAttempts);
    const reads = w.calls();
    expect(reads.filter((name) => name === "actorState").length).toBeLessThanOrEqual(MENTION_ADDRESSES_PER_POST);
    expect(reads.filter((name) => name === "fetchRefused").length).toBeLessThanOrEqual(policyReads);
    // Each body read stops at the document limit or the bytes left.
    expect(DOCUMENT_BODY_LIMIT).toBeLessThan(REQUEST_MAX_BYTES);
  });

  describe("starts no address once the budget is spent (U7)", () => {
    async function twoHosts() {
      const w = await mentionWorld();
      await plainActor(w.t.web, "bob");
      await plainActor(w.t.web, "carol", "other.example");
      return { w, start: await w.start("@bob@mastodon.example @carol@other.example") };
    }
    // The second address made no policy read, DNS check or request.
    const untouched = (w: MentionWorld) => {
      expect(w.dns).not.toContain("other.example");
      expect(w.t.web.fetched.filter((url) => url.includes("other.example"))).toEqual([]);
      const reads = w.counting.records.filter((r) => r.name === "fetchRefused").map((r) => r.args[1]);
      expect(reads).not.toContainEqual({ host: "other.example" });
    };

    it("its fetches", async () => {
      const { w, start } = await twoHosts();
      const found = await w.resolver((now) => ({ ...mentionBudget(now), fetches: 3 }))(w.h.env, start);
      expect(found.map((e) => e.key)).toEqual(["bob@mastodon.example"]);
      untouched(w);
      // Control: with one fetch more, the second address starts, and the one budget it shares stops it (T5, plan 7).
      const again = await twoHosts();
      const more = await again.w.resolver((now) => ({ ...mentionBudget(now), fetches: 4 }))(again.w.h.env, again.start);
      expect(again.w.dns).toContain("other.example");
      expect(more.map((e) => e.key)).toEqual(["bob@mastodon.example"]);
    });

    it("its bytes", async () => {
      const probe = await twoHosts();
      await probe.w.resolver((now) => ({ ...mentionBudget(now), fetches: 3 }))(probe.w.h.env, probe.start);
      const spent = REQUEST_MAX_BYTES - probe.w.made[0]!.bytes;
      const { w, start } = await twoHosts();
      const found = await w.resolver((now) => ({ ...mentionBudget(now), bytes: spent }))(w.h.env, start);
      expect(found.map((e) => e.key)).toEqual(["bob@mastodon.example"]);
      expect(w.made[0]?.bytes).toBe(0);
      untouched(w);
    });

    it("its deadline", async () => {
      const { w, start } = await twoHosts();
      w.t.web.delay(webfinger("bob", "mastodon.example"), 300);
      const found = await w.resolver((now) => ({ ...mentionBudget(now), deadline: now + 100 }))(w.h.env, start);
      expect(found).toEqual([]);
      // The guarded branch ran: the first address was requested.
      expect(w.dns).toContain("mastodon.example");
      untouched(w);
    });
  });

  it("makes no gate call for a text without an address on another host (U8; a warning's address: T13)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    await posted(w.post({ status: "hello @dave https://example.com/@bob@mastodon.example" }));
    expect(w.calls()).toEqual(["instanceDomain", "postStatus"]);
    expect(w.t.web.fetched).toEqual([]);
  });
});

describe("the gate's selection, by the Store operation (U9)", () => {
  const selected = (answer: Awaited<ReturnType<MentionWorld["postGate"]>>) =>
    answer.status === "ok" && answer.value.kind === "prepared" ? answer.value.addresses.map((a) => a.key) : answer;

  it("answers only the unstored addresses on another host, none on a domain the author blocks, at most four", async () => {
    const w = await mentionWorld();
    await remoteAccount(w.t.store, "carol", "remote.example");
    await sql(w.t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'blocked.example')", ALICE);
    expect(selected(await w.postGate("@alice@kopje.test @bob@mastodon.example"))).toEqual(["bob@mastodon.example"]);
    expect(selected(await w.postGate("@carol@remote.example @bob@mastodon.example"))).toEqual(["bob@mastodon.example"]);
    expect(selected(await w.postGate("@x@blocked.example @bob@mastodon.example"))).toEqual(["bob@mastodon.example"]);
    // Control: the blocked domain's address is answered for an author who does not block it.
    await sql(w.t.store, "DELETE FROM domain_blocks");
    expect(selected(await w.postGate("@x@blocked.example @bob@mastodon.example"))).toEqual([
      "x@blocked.example",
      "bob@mastodon.example",
    ]);
    const five = ["a", "b", "c", "d", "e"].map((n) => `@${n}@h${n}.example`).join(" ");
    expect(selected(await w.postGate(five))).toEqual(["a", "b", "c", "d"].map((n) => `${n}@h${n}.example`));
    // An address spelled twice is answered once, in its first place.
    expect(selected(await w.postGate("@bob@mastodon.example @x@h.example @BOB@Mastodon.Example"))).toEqual([
      "bob@mastodon.example",
      "x@h.example",
    ]);
  });

  it("answers none, not an error, for a scheduled_at that is no time and a text past the raw bound", async () => {
    const w = await mentionWorld();
    expect(selected(await w.postGate("@bob@mastodon.example"))).toEqual(["bob@mastodon.example"]);
    expect(await w.postGate("@bob@mastodon.example", { scheduledAt: "tomorrow" })).toEqual({
      status: "ok",
      value: { kind: "none" },
    });
    const long = `@bob@mastodon.example ${"x".repeat(MAX_RAW_LENGTH)}`;
    expect(await w.postGate(long)).toEqual({ status: "ok", value: { kind: "none" } });
  });
});

describe("the gate's credential and refusals", () => {
  async function tokens(w: MentionWorld) {
    const insert = async (value: string, accountId: string | null, scopes: string) =>
      sql(
        w.t.store,
        "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, ?)",
        await sha256Hex(value),
        accountId,
        scopes,
      );
    await insert("read-only", ALICE, "read");
    await insert("app-token", null, "read write follow");
    return { invalid: "no-such-token", scopeless: "read-only", app: "app-token" };
  }

  it("answers an invalid token 401, a missing scope 403 and an app token 422, with no write and no fetch (U10)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const t = await tokens(w);
    const status = async (token: string) => (await w.post({ status: "@bob@mastodon.example" }, {}, token)).status;
    expect([await status(t.invalid), await status(t.scopeless), await status(t.app)]).toEqual([401, 403, 422]);
    expect(w.calls()).toEqual(Array.from({ length: 3 }, () => ["instanceDomain", "postMentionGate"]).flat());
    expect(w.t.web.fetched).toEqual([]);
    // Control: a valid token fetches.
    await posted(w.post({ status: "@bob@mastodon.example" }));
    expect(w.t.web.fetched).not.toEqual([]);
  });

  const refusals = {
    "the Store readonly": async (w: MentionWorld) => w.t.store.setMaintenance(BUILD, true),
    "an unpublished import": (w: MentionWorld) =>
      runInDurableObject(w.t.store, (_instance, state) => {
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('unpublished', ?)",
          JSON.stringify({ at: NOW, import: "import-1" }),
        );
      }),
  };
  for (const [name, refuse] of Object.entries(refusals)) {
    it(`answers 503 under ${name}, whatever the token, the gate reading nothing (U11)`, async () => {
      const w = await mentionWorld();
      await plainActor(w.t.web, "bob");
      await refuse(w);
      for (const token of [w.t.tokens.alice, "no-such-token"]) {
        expect((await w.post({ status: "@bob@mastodon.example" }, {}, token)).status).toBe(503);
      }
      expect(w.calls()).toEqual(
        Array.from({ length: 2 }, () => ["instanceDomain", "postMentionGate", "postStatus"]).flat(),
      );
      const reason = name === "the Store readonly" ? "maintenance" : "unpublished";
      expect(w.gates()).toEqual([
        { status: "refused", reason },
        { status: "refused", reason },
      ]);
      expect([w.t.web.fetched, w.dns]).toEqual([[], []]);
    });
  }

  // An instance key that cannot be parsed: the gate's preparation reads it and fails, so an answer shows the refused gate
  // never read it.
  it("reads no signer under the Store readonly: the refusal is decided before the preparation (U11)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    await sql(w.t.store, "UPDATE instance_settings SET value = 'not json' WHERE name = 'instance_actor_key'");
    // The guarded branch: with writes admitted, the gate reads the key and fails, and the write answers with text.
    const status = await posted(w.post({ status: "@bob@mastodon.example" }));
    expect(status.mentions).toEqual([]);
    const gate = w.counting.records.find((r) => r.name === "postMentionGate");
    expect(gate?.error).toBeDefined();
    w.reset();
    await w.t.store.setMaintenance(BUILD, true);
    expect((await w.post({ status: "@bob@mastodon.example" })).status).toBe(503);
    expect(w.gates()).toEqual([{ status: "refused", reason: "maintenance" }]);
    expect(w.t.web.fetched).toEqual([]);
  });
});

describe("the times the gate and the write take (U12)", () => {
  // A clock that moves 1 s at each read.
  function ticking() {
    let at = NOW;
    return {
      get now() {
        at += 1000;
        return at;
      },
      set now(value: number) {
        at = value;
      },
    };
  }
  const nowOf = (w: MentionWorld, name: string) =>
    w.counting.records
      .filter((r) => r.name === name)
      .map((r) => {
        const input = r.args[1] as { now: number; scheduleNow?: number; credential: { now: number } };
        return { now: input.now, credential: input.credential.now, scheduleNow: input.scheduleNow };
      })[0];

  it("gives the write the gate's credential and now when nothing was fetched, and later ones after a fetch", async () => {
    const w = await mentionWorld({ clock: ticking() });
    await remoteAccount(w.t.store, "carol", "remote.example");
    await posted(w.post({ status: "@carol@remote.example" }));
    const gate = nowOf(w, "postMentionGate")!;
    expect(nowOf(w, "postStatus")).toEqual({ now: gate.now, credential: gate.credential, scheduleNow: gate.now });
    w.reset();
    await plainActor(w.t.web, "bob");
    await posted(w.post({ status: "@bob@mastodon.example" }));
    const fetched = nowOf(w, "postMentionGate")!;
    const write = nowOf(w, "postStatus")!;
    expect(write.now).toBeGreaterThan(fetched.now);
    expect(write.credential).toBeGreaterThan(fetched.credential);
    expect(write.scheduleNow).toBe(fetched.now);
  });
});
