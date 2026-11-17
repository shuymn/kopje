import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { inDomainSql } from "../src/domain/audience";
import { actorDomainBlocked, ticketFor } from "../src/domain/instance-domain-blocks";
import { INBOX_BODY_LIMIT } from "../src/federation/spool";
import { hostDomain } from "../src/platform/domain-name";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain, blockDomainIn } from "./domain-block-helpers";
import { drainDeliveries, migratedStore } from "./helpers";
import { mastodonActor, serveWebFinger } from "./inbox-helpers";
import { accountId, AS, DAVE_URI, type Setup, setup } from "./inbox-status-helpers";
import { world } from "./remote-suspension-helpers";
import { post, remoteAccount, remoteFollows } from "./status-helpers";

// A host's trailing dots (R38, VIS-30, ID-2; docs/mastodon-deviations.md): every domain policy compares a URL's host
// without the port and without every trailing dot, in the Worker (hostDomain) and in SQL (audience.ts uriHostSql) alike,
// while the actor id, the inbox and every stored URL keep their bytes. Mastodon's Addressable drops a single dot only.

const DOTS = [0, 1, 2, 3] as const;
const ID = "900000000000000000";
const dotted = (host: string, dots: number) => `${host}${".".repeat(dots)}`;

// The stored HTTP(S) actor ids the comparison covers, as the URL parser writes them (stored ids are URL hrefs): capitals,
// an IDN, a subdomain, a port and an explicit default port, each with 0 to 3 trailing dots, and the key each gives.
// Ids outside that form (userinfo, an IP literal, unparsable bytes an import may hold) are not claimed to agree: the
// loader never stores one (NET-1), and SQL reads only the scheme, authority and path separators.
const CORPUS = DOTS.flatMap((dots) =>
  [
    { written: `https://${dotted("blocked.example", dots)}/users/a`, key: "blocked.example" },
    { written: `https://${dotted("Blocked.EXAMPLE", dots)}/users/a`, key: "blocked.example" },
    { written: `http://${dotted("blocked.example", dots)}/users/a`, key: "blocked.example" },
    { written: `https://${dotted("social.blocked.example", dots)}:8443/u/a`, key: "social.blocked.example" },
    { written: `https://${dotted("blocked.example", dots)}:443/users/a`, key: "blocked.example" },
    { written: `https://${dotted("bücher.example", dots)}/u/b`, key: "xn--bcher-kva.example" },
    { written: `https://${dotted("blocked.example", dots)}`, key: "blocked.example" },
  ].map(({ written, key }) => ({ uri: new URL(written).href, key })),
);

describe("the host key of an actor id (HD1)", () => {
  it("is the same in the Worker and in SQL for every stored spelling, dots and all, and leaves the id as it is", async () => {
    const store = await migratedStore();
    const rows = await runInDurableObject(store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      return CORPUS.map(({ uri }) => {
        // The stored domain is one no key equals, so inDomainSql can match by the id's host alone.
        db.run("INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, 'a', 'unrelated.invalid')", ID, uri);
        const key = hostDomain(uri);
        const matched = (domain: string) =>
          db.first<{ yes: number }>(
            `SELECT ${inDomainSql("a", "?2")} AS yes FROM accounts a WHERE a.uri = ?1`,
            uri,
            domain,
          )?.yes;
        const row = { uri, key, sql: matched(key), dotted: matched(`${key}.`) };
        const stored = db.first<{ uri: string }>("SELECT uri FROM accounts")?.uri;
        db.run("DELETE FROM accounts");
        return { ...row, stored };
      });
    });
    expect(rows).toEqual(CORPUS.map(({ uri, key }) => ({ uri, key, sql: 1, dotted: 0, stored: uri })));
  });

  it("decides a block of the host the same through each gate that reads it in the Worker", async () => {
    const store = await migratedStore();
    const verdicts = await runInDurableObject(store, (_instance, state) => {
      blockDomainIn(state.storage.sql, "blocked.example");
      const db = new Db(state.storage.sql);
      return DOTS.map((dots) => {
        const uri = `https://${dotted("blocked.example", dots)}/users/a`;
        return { dots, ticket: ticketFor(db, uri), blocked: actorDomainBlocked(db, uri) };
      });
    });
    expect(verdicts).toEqual(
      DOTS.map((dots) => ({ dots, ticket: { host: "blocked.example", refused: true }, blocked: true })),
    );
  });
});

// RES-2: an inbound actor id, which the inbox gate reads before verification (actorDomainBlocked), may be as long as the
// body (INBOX_BODY_LIMIT, 1 MiB), its host a run of dots. hostDomain trims the run in one scan
// (test-node/cutover-convert.test.ts times it alone, where a regex's quadratic case shows); here the real gate answers
// such a request at the body's cap within a generous time.
describe("a host with a run of dots as long as an inbound activity (RES-2)", () => {
  const SIZES = [100_000, INBOX_BODY_LIMIT];

  it("answers an inbound activity whose actor's host is one, at the body's cap, within a generous time", async () => {
    // The size test-node/cutover-convert.test.ts times hostDomain at.
    expect(INBOX_BODY_LIMIT).toBe(1024 * 1024);
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    for (const size of SIZES) {
      const activity = { "@context": AS, id: `${bob.uri}#follows/1`, type: "Follow", actor: "", object: DAVE_URI };
      const base = new TextEncoder().encode(JSON.stringify(activity)).byteLength;
      const host = `a${".".repeat(size - base - "https://ab.example/u".length)}b.example`;
      activity.actor = `https://${host}/u`;
      expect(new TextEncoder().encode(JSON.stringify(activity)).byteLength).toBe(size);
      const started = performance.now();
      expect(await t.post(bob, activity)).toBe(202);
      expect(performance.now() - started, `${size}`).toBeLessThan(2000);
    }
    expect(t.web.fetched).toEqual([]);
  });
});

// The Worker's gates through the real inbound, search and delivery paths, a suspend block of blocked.example standing
// or committing while a request is held (RemoteWeb.hold), for the host with 0 to 3 trailing dots (HD2).

const BLOCKED = "blocked.example";

const requestsTo = (t: Setup, origin: string, from = 0) =>
  t.web.fetched.slice(from).filter((url) => new URL(url).origin === origin);

const follow = (uri: string, n: number) => ({
  "@context": AS,
  id: `${uri}#follows/${n}`,
  type: "Follow",
  actor: uri,
  object: DAVE_URI,
});

const resolveUri = (t: Setup, uri: string) =>
  t.api<{ accounts: { acct: string }[] }>(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(uri)}`);

describe.each(DOTS)("a blocked host with %i trailing dots (HD2)", (dots) => {
  const origin = `https://${dotted(BLOCKED, dots)}`;

  it("ignores an inbound Follow before any fetch, and stores nothing (actorDomainBlocked)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob", { origin });
    await blockDomain(t.store, BLOCKED);
    expect(await t.post(bob, follow(bob.uri, 1))).toBe(202);
    expect(requestsTo(t, origin)).toEqual([]);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  it("resolves the actor id in search with no request to the host (the Store answer's ticket)", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob", { origin });
    await blockDomain(t.store, BLOCKED);
    expect(await resolveUri(t, bob.uri)).toMatchObject({ status: 200, body: { accounts: [] } });
    expect(requestsTo(t, origin)).toEqual([]);
    expect(await accountId(t.store, bob.uri)).toBeUndefined();
  });

  // The ticket of the inbound request's Store answer serves its first request; the block commits while that request
  // is held, so the next request, a same-origin redirect's or the RFC 9421 retry of a 401, asks the Store again.
  // Unblocked, the same answers make the next request (the control): the redirect's target, or the retry.
  for (const answer of ["redirect", "retry"] as const) {
    for (const blocked of [true, false]) {
      it(`${blocked ? "requests nothing after the block commits" : "goes on unblocked"} during the key fetch, at the ${answer}`, async () => {
        const t = await setup();
        const bob = await mastodonActor(t.web, "bob", { origin });
        const next = answer === "redirect" ? `${origin}/users/bob2` : bob.uri;
        const keyFetch = t.web.hold(bob.uri);
        const response = t.post(bob, follow(bob.uri, 1));
        await keyFetch.reached;
        if (blocked) {
          await blockDomain(t.store, BLOCKED);
        }
        if (answer === "redirect") {
          t.web.redirect(bob.uri, next);
        } else {
          t.web.fail(bob.uri, 401);
        }
        keyFetch.release();
        expect(await response).toBe(401);
        expect(requestsTo(t, origin)).toEqual(blocked ? [bob.uri] : [bob.uri, next]);
        expect(await accountId(t.store, bob.uri)).toBeUndefined();
      });
    }
  }

  // The Store's own gates after the fetch (receiveActivity's actorDomainBlocked, upsertRemoteActor's host check): bob's
  // document claims a handle on another, unblocked domain, which WebFinger there confirms, so only his id's host is
  // covered once the block commits during his key fetch. Unblocked, the same answers store him (the control).
  for (const blocked of [true, false]) {
    it(`${blocked ? "stores no actor" : "stores the actor"} whose handle is elsewhere, the block ${blocked ? "committing" : "absent"} during the key fetch`, async () => {
      const t = await setup();
      const bob = await mastodonActor(t.web, "bob", { origin, extra: { webfinger: "acct:bob@nice.example" } });
      serveWebFinger(t.web, "acct:bob@nice.example", "acct:bob@nice.example", bob.uri);
      const keyFetch = t.web.hold(bob.uri);
      const response = t.post(bob, follow(bob.uri, 1));
      await keyFetch.reached;
      if (blocked) {
        await blockDomain(t.store, BLOCKED);
      }
      keyFetch.release();
      expect(await response).toBe(202);
      expect(await sql(t.store, "SELECT uri, domain FROM accounts WHERE uri = ?", bob.uri)).toEqual(
        blocked ? [] : [{ uri: bob.uri, domain: "nice.example" }],
      );
    });
  }

  // The send-time check's inbox rule (deliveries.ts inboxCovered): g lives on an unblocked host, so the hosts its
  // provenance lists are not covered, and only its inbox's host is.
  it("drops content queued to an inbox on the host at the claim, and keeps the inbox as written", async () => {
    const w = await world();
    const g = await remoteAccount(w.h.store, "g", "gateway.example");
    const inbox = `${origin}/inbox`;
    await sql(w.h.store, "UPDATE accounts SET inbox_url = ?, shared_inbox_url = NULL WHERE id = ?", inbox, g);
    await remoteFollows(w.h.store, g, w.alice.id);
    await post(w.h, w.alice, { status: "to followers" });
    expect(await sql(w.h.store, "SELECT inbox_url, recipient_domains FROM deliveries")).toEqual([
      { inbox_url: inbox, recipient_domains: '["gateway.example"]' },
    ]);
    await blockDomain(w.h.store, BLOCKED);
    expect(await drain(w.h.store)).toEqual([]);
    expect(await sql(w.h.store, "SELECT count(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
  });
});

function drain(store: StoreStub): Promise<string[]> {
  return drainDeliveries(store, ({ inbox }) => inbox, { now: NOW, until: "all", rounds: 100 });
}

describe("the address of an actor whose host has trailing dots (HD2, HD3)", () => {
  const stored = (t: Setup, uri: string) =>
    sql(t.store, "SELECT uri, username, hex(domain) AS domain FROM accounts WHERE uri = ?", uri);
  const hex = (text: string) =>
    [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
  // An Update of the actor carrying its document, which a refresh stores as a fetch would (readEmbeddedActor).
  const update = (actor: { uri: string; document: Record<string, unknown> }, n: number) => ({
    "@context": AS,
    id: `${actor.uri}#updates/${n}`,
    type: "Update",
    actor: actor.uri,
    object: actor.document,
  });

  it.each(DOTS)("claims and stores the dot-free host WebFinger confirms, the id kept whole (%i dots)", async (dots) => {
    const t = await setup();
    const origin = `https://${dotted("ok.example", dots)}`;
    const bob = await mastodonActor(t.web, "bob", { origin });
    const found = await resolveUri(t, bob.uri);
    expect(found.body.accounts.map((a) => a.acct)).toEqual(["bob@ok.example"]);
    expect(await stored(t, bob.uri)).toEqual([{ uri: bob.uri, username: "bob", domain: hex("ok.example") }]);
  });

  it("keeps a domain confirmed on another host, which a block of the actor's host still covers", async () => {
    const t = await setup();
    const origin = `https://${dotted("social.example", 2)}`;
    const ali = await mastodonActor(t.web, "ali", { origin, key: 3 });
    serveWebFinger(t.web, "acct:ali@social.example", "acct:ali@nice.example", ali.uri);
    serveWebFinger(t.web, "acct:ali@nice.example", "acct:ali@nice.example", ali.uri);
    expect((await resolveUri(t, ali.uri)).body.accounts.map((a) => a.acct)).toEqual(["ali@nice.example"]);
    // A refresh claims ali@social.example again, which WebFinger answers with the same subject.
    expect(await t.post(ali, follow(ali.uri, 1))).toBe(202);
    expect(await stored(t, ali.uri)).toEqual([{ uri: ali.uri, username: "ali", domain: hex("nice.example") }]);
    await blockDomain(t.store, "social.example");
    const id = (await accountId(t.store, ali.uri))!;
    const shown = await t.api<{ suspended?: boolean }>(`/api/v1/accounts/${id}`);
    expect(shown.body.suspended).toBe(true);
  });

  // An earlier converter kept one dot fewer than the id's host had (the old hostDomain), and an import may hold a
  // domain that is not UTF-8; neither tells WebFinger confirmed it. A refresh whose claim WebFinger does not confirm
  // keeps the stored bytes (copied in SQL), and one it confirms takes the confirmed domain.
  it("keeps a converted or imported domain until WebFinger confirms the claim, then takes it", async () => {
    const t = await setup();
    const legacyRows = (u: Setup) =>
      sql(
        u.store,
        "SELECT uri, username, hex(domain) AS domain FROM accounts WHERE id LIKE '90000000000000000_' ORDER BY id",
      );
    const legacy = [
      { name: "a", dots: 2, domain: "X'682E6578616D706C652E'" },
      { name: "b", dots: 3, domain: "X'682E6578616D706C652E2E'" },
      { name: "c", dots: 2, domain: "X'682E6578616D706C65FF2E2E'" },
    ];
    const actors = [];
    for (const [i, { name, dots, domain }] of legacy.entries()) {
      const actor = await mastodonActor(t.web, name, { origin: `https://${dotted("h.example", dots)}`, key: 4 + i });
      await sql(
        t.store,
        `INSERT INTO accounts (id, uri, username, domain, inbox_url, search_text, created_at)
				VALUES (?, ?, ?, CAST(${domain} AS TEXT), ?, '', '2024-01-01T00:00:00.000Z')`,
        `90000000000000000${i}`,
        actor.uri,
        name,
        `${actor.uri}/inbox`,
      );
      // The host does not confirm the claim yet.
      t.web.fail(
        `https://h.example/.well-known/webfinger?resource=${encodeURIComponent(`acct:${name}@h.example`)}`,
        404,
      );
      actors.push({ actor, domain });
    }
    const before = await legacyRows(t);
    expect(before.map((row) => row.domain)).toEqual([
      "682E6578616D706C652E",
      "682E6578616D706C652E2E",
      "682E6578616D706C65FF2E2E",
    ]);
    for (const { actor } of actors) {
      expect(await t.post(actor, update(actor, 1))).toBe(202);
    }
    expect(await legacyRows(t)).toEqual(before);
    for (const { actor } of actors) {
      serveWebFinger(
        t.web,
        `acct:${actor.document.preferredUsername as string}@h.example`,
        `acct:${actor.document.preferredUsername as string}@h.example`,
        actor.uri,
      );
      expect(await t.post(actor, update(actor, 2))).toBe(202);
    }
    expect(await legacyRows(t)).toEqual(
      actors.map(({ actor }) => ({
        uri: actor.uri,
        username: actor.document.preferredUsername,
        domain: hex("h.example"),
      })),
    );
  });
});
