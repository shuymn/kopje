import { describe, expect, it } from "vitest";

import { sql } from "./api-helpers";
import { countingStore, harness, seedInstanceKey } from "./app-helpers";
import { mastodonActor } from "./inbox-helpers";
import { ALICE, AS, localStatus, nextId, setup, type Setup } from "./inbox-status-helpers";
import { seedEmojiRow } from "./local-emoji-helpers";
import { quoting } from "./quote-helpers";

// The Store calls of a self-gated federation GET (federation/routes.ts SELF_GATED_ROUTES): one read, which also
// decides setup, plus the snapshot save of an always-served answer (SETUP-1, NET-5). Each request is made by a fresh
// app, so no snapshot save is throttled by an earlier one.

const AP = { accept: "application/activity+json" };
const EMOJI = "222222222222222222";
const MISSING_EMOJI = "123456789012345678";
const FEP = "https://w3id.org/fep/044f#QuoteRequest";

// alice's public status, quoted by bob with her approval: the stamp's path, and the ids to revoke it by.
async function world() {
  const t = await setup();
  await seedInstanceKey(t.store);
  const bob = await mastodonActor(t.web, "bob");
  const mine = await localStatus(t, { status: "quote me", visibility: "public" });
  const note = quoting(bob, mine.uri, null);
  t.web.serve(note.id, { "@context": AS, ...note });
  const request = {
    "@context": [AS, { QuoteRequest: FEP }],
    id: `${bob.uri}/quote_requests/${nextId()}`,
    type: "QuoteRequest",
    actor: bob.uri,
    object: mine.uri,
    instrument: note.id,
  };
  expect(await t.post(bob, request)).toBe(202);
  const [quote] = await sql<{ authorization_id: string; status_id: string }>(
    t.store,
    "SELECT authorization_id, status_id FROM quotes WHERE state = 'accepted'",
  );
  await seedEmojiRow(t.store, { id: EMOJI, shortcode: "blob", owner: ALICE });
  return { t, stamp: `/ap/users/alice/quote_authorizations/${quote!.authorization_id}`, mine, quote: quote! };
}

async function calls(t: Setup, method: string, path: string) {
  const counting = countingStore(t.store);
  const response = await harness(counting.stub).request(path, { method, headers: AP });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
    calls: counting.calls,
  };
}

const NODEINFO = 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/';

describe("self-gated federation GETs", () => {
  it.each(["GET", "HEAD"])("make one Store read each (%s)", async (method) => {
    const { t, stamp } = await world();
    const rows: [string, number, string | null, string | null, string[]][] = [
      ["/.well-known/nodeinfo", 200, "application/json", null, ["apSite", "saveSnapshot"]],
      // Hono matches the decoded template; the raw spelling is no route of Kopje's or Fedify's, as on main.
      ["/.well-known/%6eodeinfo", 404, "text/plain;charset=UTF-8", null, ["apSite"]],
      ["/nodeinfo/%32.0", 404, "text/plain;charset=UTF-8", null, ["apSite"]],
      ["/nodeinfo/2.0", 200, `${NODEINFO}2.0#"`, null, ["apNodeInfo", "saveSnapshot"]],
      ["/nodeinfo/2.1", 200, `${NODEINFO}2.1#"`, null, ["apNodeInfo", "saveSnapshot"]],
      ["/actor/outbox", 200, "application/activity+json", null, ["apSite"]],
      ["/actor/outbox?cursor=first", 200, "application/activity+json", null, ["apSite"]],
      ["/actor/outbox?cursor=x", 404, "text/plain;charset=UTF-8", null, ["apSite"]],
      [stamp, 200, "application/activity+json", "no-store", ["apQuoteAuthorization"]],
      [
        `/ap/users/alice/quote_authorizations/${"0".repeat(32)}`,
        404,
        "text/plain;charset=UTF-8",
        "no-store",
        ["apQuoteAuthorization"],
      ],
      ["/ap/users/alice/quote_authorizations/x", 404, "text/plain;charset=UTF-8", null, ["apSite"]],
      [`/emojis/${EMOJI}`, 200, "application/activity+json", "public, max-age=180", ["apEmoji"]],
      [`/emojis/${MISSING_EMOJI}`, 404, "text/plain;charset=UTF-8", null, ["apEmoji"]],
      ["/emojis/abc", 404, "text/plain;charset=UTF-8", null, ["apSite"]],
    ];
    for (const [path, status, type, cache, expected] of rows) {
      expect(await calls(t, method, path), path).toEqual({ status, type, cache, calls: expected });
    }
  });

  it("answers a revoked stamp 404 from its one read", async () => {
    const { t, stamp, mine, quote } = await world();
    expect((await calls(t, "GET", stamp)).status).toBe(200);
    const revoked = await t.request(`/api/v1/statuses/${mine.id}/quotes/${quote.status_id}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.alice}` },
    });
    expect(revoked.status).toBe(200);
    expect(await calls(t, "GET", stamp)).toEqual({
      status: 404,
      type: "text/plain;charset=UTF-8",
      cache: "no-store",
      calls: ["apQuoteAuthorization"],
    });
  });

  it("answers the setup 503 from the one read before setup", async () => {
    const { t, stamp } = await world();
    await sql(t.store, "DELETE FROM instance_settings WHERE name = 'domain'");
    const rows: [string, string][] = [
      ["/.well-known/nodeinfo", "apSite"],
      ["/nodeinfo/2.0", "apNodeInfo"],
      ["/nodeinfo/2.1", "apNodeInfo"],
      ["/actor/outbox", "apSite"],
      [stamp, "apQuoteAuthorization"],
      ["/ap/users/alice/quote_authorizations/x", "apSite"],
      [`/emojis/${EMOJI}`, "apEmoji"],
      ["/emojis/abc", "apSite"],
    ];
    for (const [path, read] of rows) {
      expect(await calls(t, "GET", path), path).toEqual({
        status: 503,
        type: "application/json",
        cache: null,
        calls: [read],
      });
    }
  });
});
