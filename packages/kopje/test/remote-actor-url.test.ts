import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { KEY_REFRESH_MS } from "../src/domain/inbox";
import { suspendRemote } from "../src/domain/remote-suspension";
import { processInbox } from "../src/federation/inbox";
import { fedifyActorView, profileUrl, remoteActorInput } from "../src/federation/remote-actor";
import { httpUrl } from "../src/platform/http-url";
import { PROFILE_URL_LIMIT } from "../src/platform/stored-bounds";
import { announcementHarness } from "./announcement-helpers";
import { bearer, json, sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import urls from "./fixtures/profile-url/urls.json";
import { BUILD } from "./helpers";
import { LOCAL, MASTODON, mastodonActor, signedInit, type TestActor } from "./inbox-helpers";
import { accountId, AS, DAVE_URI, followed, nextId, OTHER, type Setup, setup } from "./inbox-status-helpers";
import { getJson, remoteAccount } from "./status-helpers";

// #1734 (AU): an actor's profile URL is read from its document's literal `url` (remote-actor.ts profileUrl), never
// from Fedify's object (`url` is not in FEDIFY_MEMBERS), and chosen as Mastodon 4.7.5 chooses it: one candidate by
// the mimeType and first-string rules, then that candidate checked against the actor id's host and the stored bound;
// an ineligible one is none, and no later candidate is tried. A remote account without one shows its actor id
// (accounts.ts accountUrl), as Mastodon stores `url || @uri`.

type Row = (typeof urls.rows)[number];

const A = "https://actor.example/users/a";
const ORIGIN = "https://kopje.test";

// The categories of docs/mastodon-deviations.md each listed row falls in: a host the URL parser reads otherwise than
// Addressable (Kopje keeps a URL Mastodon refuses), a URL it does not parse, one past PROFILE_URL_LIMIT serialized,
// and a value on which Mastodon raises (and stores no account).
function differenceOf(row: Row, kopje: string | null): string | null {
  const mastodon = row.mastodon as { url?: string | null; raises?: string };
  if (mastodon.raises !== undefined) {
    return "raises";
  }
  if (mastodon.url === null || mastodon.url === undefined) {
    return kopje === null ? null : "host";
  }
  const href = httpUrl(mastodon.url)?.href;
  if (href === undefined) {
    return "unparsed";
  }
  if (href.length > PROFILE_URL_LIMIT) {
    return "bound";
  }
  return kopje === href ? null : "other";
}

describe("the candidate Mastodon 4.7.5 chooses (#1734)", () => {
  // AU1: test/fixtures/profile-url/urls.json is ProcessAccountService#url as the 4.7.5 image runs it (capture.rb). Each
  // row agrees, as the URL parser serializes Mastodon's URL, or is a listed difference of the kind it names.
  it("keeps Mastodon's URL for each form, or the listed difference", () => {
    expect([urls.ruby, urls.addressable]).toEqual(["4.0.9", "2.9.2"]);
    const differences: unknown[] = [];
    const kinds: Record<string, number> = {};
    for (const row of urls.rows) {
      const kopje = profileUrl(row.value, new URL(row.uri));
      const kind = differenceOf(row, kopje);
      if (kind !== row.listed) {
        differences.push({ value: row.value, uri: row.uri, listed: row.listed, kind, kopje, mastodon: row.mastodon });
      }
      kinds[kind ?? "same"] = (kinds[kind ?? "same"] ?? 0) + 1;
      if (kind === "unparsed" || kind === "bound") {
        expect(kopje, JSON.stringify(row.value)).toBeNull();
      }
    }
    expect(differences).toEqual([]);
    expect(kinds).toEqual({ same: 72, host: 4, unparsed: 1, bound: 1, raises: 16 });
    // Where Mastodon raises, Kopje stores the account; its URL is none but for a tab the URL parser drops.
    const kept = urls.rows.filter((row) => row.listed === "raises" && profileUrl(row.value, new URL(row.uri)) !== null);
    expect(kept.map((row) => row.value)).toEqual(["https://act\tor.example/@a"]);
  });

  // §3 G5's forms: the first candidate on another host is none, and no later one on the actor's host is taken; a
  // non-HTML Link before an HTML one is passed over.
  it("never takes a later candidate once the chosen one is refused", () => {
    const id = new URL(A);
    const html = (href: string) => ({ type: "Link", mimeType: "text/html", href });
    const png = (href: string) => ({ type: "Link", mimeType: "image/png", href });
    expect(profileUrl([html("https://other.example/@a"), html("https://actor.example/@a")], id)).toBeNull();
    expect(profileUrl(["https://other.example/profile", html("https://actor.example/@a")], id)).toBeNull();
    expect(profileUrl([png("https://other.example/a.png"), html("https://actor.example/@a")], id)).toBe(
      "https://actor.example/@a",
    );
    expect(profileUrl([png("https://actor.example/a.png"), html("https://other.example/@a")], id)).toBeNull();
    // On the actor id's host, whatever the scheme and port, ASCII case aside; a trailing dot is another host.
    expect(profileUrl("http://ACTOR.example:8443/@a", id)).toBe("http://actor.example:8443/@a");
    expect(profileUrl("https://actor.example./@a", id)).toBeNull();
    expect(profileUrl("https://actor.example/@a", new URL("https://actor.example./users/a"))).toBeNull();
  });

  // ID-1: the document's url never reaches Fedify, so no value of it refuses the actor (Fedify fails the whole actor on
  // a Link whose href is a number or whose nameMap holds one, test/remote-actor-view.test.ts).
  it("reads every form from the JSON, the actor read whole", async () => {
    for (const row of urls.rows.filter((r) => r.uri === A)) {
      const document = {
        "@context": [AS, "https://w3id.org/security/v1"],
        id: A,
        type: "Person",
        preferredUsername: "a",
        inbox: `${A}/inbox`,
        url: row.value,
      };
      const input = await remoteActorInput(await Person.fromJsonLd(fedifyActorView(document)), document);
      expect(input?.url, JSON.stringify(row.value)).toBe(profileUrl(row.value, new URL(A)));
    }
  });
});

// An HTML Link to `href`, and Links of other media types.
const html = (href: string) => ({ type: "Link", mimeType: "text/html", href });
const png = (href: string) => ({ type: "Link", mimeType: "image/png", href });
const OWN = `${MASTODON}/@profile`;

// [label, the actor's url member, the stored url (null: none, and the account shows its actor id)]
const FORMS: [string, (uri: string) => unknown, string | null][] = [
  ["html-other-first", () => [html(`${OTHER}/@a`), html(OWN)], null],
  ["string-other-first", () => [`${OTHER}/profile`, html(OWN)], null],
  ["png-other-first", () => [png(`${OTHER}/a.png`), html(OWN)], OWN],
  ["string", () => OWN, OWN],
  ["list", () => [OWN, `${MASTODON}/@second`], OWN],
  ["link", () => ({ type: "Link", href: OWN }), OWN],
  ["blank-mime", () => ({ type: "Link", mimeType: " ", href: OWN }), OWN],
  ["media-type-ignored", () => ({ type: "Link", mediaType: "image/png", href: OWN }), OWN],
  ["port-scheme", () => "http://mastodon.example:8080/@profile", "http://mastodon.example:8080/@profile"],
  ["case", () => "https://MASTODON.Example/@profile", OWN],
  ["other-host", () => `${OTHER}/@a`, null],
  ["trailing-dot", () => "https://mastodon.example./@profile", null],
  ["relative", () => "/@profile", null],
  ["malformed", () => ({ type: "Link", href: 5 }), null],
  ["fedify-unreadable", () => ({ type: "Link", href: OWN, nameMap: { en: 5 } }), OWN],
  ["overlong", () => `${MASTODON}/${"x".repeat(PROFILE_URL_LIMIT - MASTODON.length)}`, null],
  ["longest", () => `${MASTODON}/${"x".repeat(PROFILE_URL_LIMIT - MASTODON.length - 1)}`, "longest"],
];

// The stored url a form expects, `longest` spelled out.
const expected = (form: (typeof FORMS)[number]) =>
  form[2] === "longest" ? `${MASTODON}/${"x".repeat(PROFILE_URL_LIMIT - MASTODON.length - 1)}` : form[2];

// The account's stored url and the url the API shows for it.
async function urlOf(t: Setup, uri: string): Promise<{ stored: string | null; shown: string }> {
  const id = (await accountId(t.store, uri))!;
  const [row] = await sql<{ url: string | null }>(t.store, "SELECT url FROM accounts WHERE id = ?", id);
  const answer = await t.api<{ url: string }>(`/api/v1/accounts/${id}`);
  expect(answer.status).toBe(200);
  return { stored: row!.url, shown: answer.body.url };
}

// The outcome a form expects: its stored url, and that url or the actor id shown.
const outcome = (form: (typeof FORMS)[number], uri: string) => ({
  stored: expected(form),
  shown: expected(form) ?? uri,
});

// An Update(Person) of `actor` embedding `object`.
const updateOf = (actor: TestActor, object: unknown) => ({
  "@context": AS,
  id: `${actor.uri}#updates/${nextId()}`,
  type: "Update",
  actor: actor.uri,
  object,
});

describe("each path that stores an actor's document (#1734, ID-1, HTML-3)", () => {
  // AU1, fetched: a search resolve fetches the document (federation/resolve.ts fetchActor).
  it("stores the chosen URL of a fetched actor, and shows the actor id without one", async () => {
    const t = await setup();
    for (const form of FORMS) {
      const name = form[0].replaceAll("-", "");
      const actor = await mastodonActor(t.web, name, { extra: { url: form[1](`${MASTODON}/users/${name}`) } });
      t.web.fetched.length = 0;
      const answer = await t.api<{ accounts: { acct: string }[] }>(
        `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(actor.uri)}`,
      );
      expect(t.web.fetched, form[0]).toContain(actor.uri);
      expect(
        answer.body.accounts.map((a) => a.acct),
        form[0],
      ).toEqual([`${name}@mastodon.example`]);
      expect(await urlOf(t, actor.uri), form[0]).toEqual(outcome(form, actor.uri));
    }
  }, 60_000);

  // AU1, embedded: an Update(Person) embedding the actor (inbound.ts readEmbeddedActor), live and at replay.
  it("stores the chosen URL of an embedded actor, live and replayed", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    for (const form of FORMS) {
      t.web.fetched.length = 0;
      const update = updateOf(bob, { ...bob.document, url: form[1](bob.uri), name: form[0] });
      expect(await t.post(bob, update), form[0]).toBe(202);
      expect(t.web.fetched, form[0]).toEqual([]);
      const [stored] = await sql<{ display_name: string }>(
        t.store,
        "SELECT display_name FROM accounts WHERE uri = ?",
        bob.uri,
      );
      expect(stored?.display_name, form[0]).toBe(form[0]);
      expect(await urlOf(t, bob.uri), form[0]).toEqual(outcome(form, bob.uri));
    }
    // A spooled request's replay reads the embedded actor as live.
    for (const form of [FORMS[0]!, FORMS[2]!]) {
      const update = updateOf(bob, { ...bob.document, url: form[1](bob.uri) });
      const init = await signedInit(bob, "/inbox", update);
      const replayed = await processInbox(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
        {
          url: `${LOCAL}/inbox`,
          method: "POST",
          headers: [...new Headers(init.headers)],
          body: new TextEncoder().encode(init.body as string),
          receivedAt: NOW,
        },
        "replay",
      );
      expect(replayed, form[0]).toMatchObject({ status: 202, reason: "actor-updated" });
      expect(await urlOf(t, bob.uri), form[0]).toEqual(outcome(form, bob.uri));
    }
  }, 60_000);

  // AU2: the key's document fetched for a signature (its keys a day old) is stored as any fetched one, and replaces a
  // URL an earlier release stored on another host; a later document without an eligible URL leaves none.
  it("replaces a stored URL at the next store of a fetched document", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    await sql(t.store, "UPDATE accounts SET url = ? WHERE uri = ?", `${OTHER}/@legacy`, bob.uri);
    expect(await urlOf(t, bob.uri)).toEqual({ stored: `${OTHER}/@legacy`, shown: `${OTHER}/@legacy` });
    const expire = () =>
      sql(
        t.store,
        "UPDATE remote_keys SET fetched_at = ? WHERE account_id = (SELECT id FROM accounts WHERE uri = ?)",
        NOW - KEY_REFRESH_MS,
        bob.uri,
      );
    const follow = () => ({ "@context": AS, id: `${bob.uri}#follows/${nextId()}`, type: "Follow", actor: bob.uri });
    await expire();
    t.web.fetched.length = 0;
    expect(await t.post(bob, { ...follow(), object: DAVE_URI })).toBe(202);
    expect(t.web.fetched).toContain(bob.uri);
    expect(await urlOf(t, bob.uri)).toEqual({ stored: `${MASTODON}/@bob`, shown: `${MASTODON}/@bob` });
    t.web.serve(bob.uri, { ...bob.document, url: [html(`${OTHER}/@bob`), html(`${MASTODON}/@bob`)] });
    await expire();
    expect(await t.post(bob, { ...follow(), object: DAVE_URI })).toBe(202);
    expect(await urlOf(t, bob.uri)).toEqual({ stored: null, shown: bob.uri });
  });

  // AU2: an actor whose url Fedify cannot decode (which refused it whole while Fedify read the url) is stored, and its
  // key verifies its signatures; another key's signature, an Update embedding another actor, and a suspended actor's
  // Update change nothing.
  it("verifies such an actor's signature by its key alone, and applies only its own document", async () => {
    const t = await setup();
    const unreadable = { type: "Link", href: `${MASTODON}/@erin`, nameMap: { en: 5 } };
    const erin = await mastodonActor(t.web, "erin", { extra: { url: unreadable } });
    const follow = { "@context": AS, id: `${erin.uri}#follows/${nextId()}`, type: "Follow", actor: erin.uri };
    const mallory = await mastodonActor(t.web, "mallory", { key: 3 });
    expect(await t.post({ ...erin, privateKey: mallory.privateKey }, { ...follow, object: DAVE_URI })).toBe(401);
    expect(await accountId(t.store, erin.uri)).toBeUndefined();
    expect(await t.post(erin, { ...follow, object: DAVE_URI })).toBe(202);
    expect(await urlOf(t, erin.uri)).toEqual({ stored: `${MASTODON}/@erin`, shown: `${MASTODON}/@erin` });
    // mallory's Update embedding erin's document under erin's id applies to neither.
    await followed(t, mallory);
    const forged = updateOf(mallory, { ...erin.document, url: `${MASTODON}/@forged` });
    expect(await t.post(mallory, forged)).toBe(202);
    expect(await urlOf(t, erin.uri)).toEqual({ stored: `${MASTODON}/@erin`, shown: `${MASTODON}/@erin` });
    expect((await urlOf(t, mallory.uri)).stored).toBe(`${MASTODON}/@mallory`);
    // Suspended, erin's Update changes no profile (R38): the url stays.
    const id = (await accountId(t.store, erin.uri))!;
    await runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => suspendRemote(new Db(state.storage.sql), id, null, NOW)),
    );
    expect(await t.post(erin, updateOf(erin, { ...erin.document, url: `${MASTODON}/@moved` }))).toBe(202);
    expect((await urlOf(t, erin.uri)).stored).toBe(`${MASTODON}/@erin`);
  });
});

// #1734: what Mastodon's url_for gives such an account (`url || @uri`) wherever an account's url is shown; the account
// entity, mentions, link cards and notification fallbacks have their own tests (account-answer-bytes, link-cards,
// notification-fallback).
describe("a remote account without a profile URL, wherever its url is shown (#1734)", () => {
  it("is linked by its actor id in announcements, a report's target page and its tagged page", async () => {
    const h = await announcementHarness(["alice"]);
    const carol = await remoteAccount(h.store, "carol");
    await sql(h.store, "UPDATE accounts SET url = NULL WHERE id = ?", carol);
    const actor = "https://remote.example/users/carol";
    await h.admin.create({ text: "Hi @carol@remote.example" });
    const listed = await getJson<{ content: string; mentions: { url: string }[] }[]>(
      h,
      "/api/v1/announcements",
      h.users.alice.token,
    );
    expect(listed.body[0]!.mentions.map((m) => m.url)).toEqual([actor]);
    expect(listed.body[0]!.content).toContain(`href="${actor}"`);
    const report = await h.request("/api/v1/reports", bearer(h.users.alice.token, json({ account_id: carol })));
    expect(report.status).toBe(200);
    const { id } = await report.json<{ id: string }>();
    expect(await h.store.reportTargetPage(BUILD, { authority: h.authority, id, origin: ORIGIN })).toEqual({
      ok: true,
      page: actor,
    });
    const tagged = await h.request("/@carol@remote.example/tagged/walks", { redirect: "manual" });
    expect([tagged.status, tagged.headers.get("location")]).toEqual([302, actor]);
  });
});
