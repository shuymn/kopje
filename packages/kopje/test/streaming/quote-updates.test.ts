import { describe, expect, it } from "vitest";

import { verifyQuotes } from "../../src/federation/quotes";
import { sql } from "../api-helpers";
import { inboxDeps, NOW } from "../app-helpers";
import { mastodonActor, type TestActor } from "../inbox-helpers";
import {
  AS,
  create,
  DAVE,
  DAVE_URI,
  followed,
  localStatus,
  mastodonNote,
  nextId,
  PUBLIC,
  remove,
  type Setup,
  setup,
  statusRow,
  update,
} from "../inbox-status-helpers";
import { quoteAccept, quoteReject, quoteRequest, quoting, serveStamp } from "../quote-helpers";
import { drained, type Inbox, settled, subscribed } from "./stream-helpers";

// A quote's state change streams its quoting status (the trigger stream_quote_state, migration
// 0100_quote_state_stream; docs/threat-model.md VIS-26, RES-6): whatever writes the state, one `edit` row is journaled
// for the quoting status, and a `user` socket that home shows it to is sent one `status.update` with the new
// `quote.state`; a hidden quoting status costs the row and is sent to no one (R33). One case per writer of the state.

// Job rounds as the Queue and cron run them, until no quote's work is due.
async function rounds(t: Setup): Promise<void> {
  const deps = { ...inboxDeps(() => t.store, t.web.loader), now: () => NOW };
  for (let n = 0; await verifyQuotes(t.env, deps); n++) {
    expect(n).toBeLessThan(20);
  }
}

// What a writer does, on its world: the quoting status's uri, and the quote's state it leaves (null: the status is
// hidden).
type Case = { world: () => Promise<{ t: Setup; act: () => Promise<void>; uri: string }>; state: string | null };

// bob (followed by alice) quotes carol's served Note with a valid stamp; settled = the rounds ran (accepted).
async function received(settled: boolean) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const carol = await mastodonActor(t.web, "carol", { origin: "https://other.example", key: 2 });
  const target = mastodonNote(carol);
  t.web.serve(target.id, { "@context": AS, ...target });
  const stamp = `${carol.uri}/quote_authorizations/${nextId()}`;
  const quote = quoting(bob, target.id, stamp);
  serveStamp(t.web, stamp, carol, quote.id, target.id);
  expect(await t.post(bob, create(bob, quote))).toBe(202);
  if (settled) {
    await rounds(t);
    expect(await stateOf(t, quote.id)).toBe("accepted");
  }
  return { t, bob, carol, target, stamp, quote, uri: quote.id };
}

// alice's pending quote of bob's quotable Note (bob followed by alice); accepted: bob's Accept with a stamp applied.
async function ours(accepted: boolean) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const theirs = mastodonNote(bob, { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } });
  expect(await t.post(bob, create(bob, theirs))).toBe(202);
  t.web.serve(theirs.id, { "@context": AS, ...theirs });
  const target = (await statusRow(t.store, theirs.id))!.id;
  const mine = await localStatus(t, { status: "look", quoted_status_id: target });
  const stamp = `${bob.uri}/quote_authorizations/${nextId()}`;
  if (accepted) {
    expect(await t.post(bob, quoteAccept(bob, mine.uri, stamp))).toBe(202);
    expect(await stateOf(t, mine.uri)).toBe("accepted");
  } else {
    expect(await stateOf(t, mine.uri)).toBe("pending");
  }
  return { t, bob, mine, stamp, uri: mine.uri };
}

// bob (followed by alice) quotes alice's status by a QuoteRequest; accepted: the request answered.
async function asked(accepted: boolean) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const mine = await localStatus(t, { status: "quote me", visibility: "public" });
  const note = quoting(bob, mine.uri, null);
  t.web.serve(note.id, { "@context": AS, ...note });
  const request = () => t.post(bob, quoteRequest(bob, mine.uri, note.id));
  if (accepted) {
    expect(await request()).toBe(202);
    expect(await stateOf(t, note.id)).toBe("accepted");
  }
  return { t, mine, request, uri: note.id };
}

async function stateOf(t: Setup, uri: string): Promise<string | undefined> {
  return (
    await sql<{ state: string }>(
      t.store,
      "SELECT q.state FROM quotes q JOIN statuses s ON s.id = q.status_id WHERE s.uri = ?",
      uri,
    )
  )[0]?.state;
}

function stampDelete(actor: TestActor, stamp: string) {
  return { "@context": AS, id: `${stamp}#delete-${nextId()}`, type: "Delete", actor: actor.uri, object: stamp };
}

const CASES: Record<string, Case> = {
  "recordQuote: an Update naming another stamp writes an accepted quote back": {
    state: "pending",
    world: async () => {
      const w = await received(true);
      const second = `${w.carol.uri}/quote_authorizations/${nextId()}`;
      const restamp = { ...update(w.bob, { ...w.quote, quoteAuthorization: second }, ""), id: `${w.quote.id}#u` };
      return { ...w, act: async () => expect(await w.t.post(w.bob, restamp)).toBe(202) };
    },
  },
  "finish: a round decides a pending quote": {
    state: "accepted",
    world: async () => {
      const w = await received(false);
      expect(await stateOf(w.t, w.quote.id)).toBe("pending");
      return { ...w, act: () => rounds(w.t) };
    },
  },
  "revocationBatch: the stamp's Delete revokes a received quote": {
    state: "revoked",
    world: async () => {
      const w = await received(true);
      return { ...w, act: async () => expect(await w.t.post(w.carol, remove(w.carol, w.stamp))).toBe(202) };
    },
  },
  "revokeLocalStamp: the stamp's Delete revokes our quote": {
    state: "revoked",
    world: async () => {
      const w = await ours(true);
      return { ...w, act: async () => expect(await w.t.post(w.bob, stampDelete(w.bob, w.stamp))).toBe(202) };
    },
  },
  "acceptOurQuote: an Accept of our request": {
    state: "accepted",
    world: async () => {
      const w = await ours(false);
      return {
        ...w,
        act: async () => expect(await w.t.post(w.bob, quoteAccept(w.bob, w.mine.uri, w.stamp))).toBe(202),
      };
    },
  },
  "rejectOurQuote: a Reject of our request": {
    state: "rejected",
    world: async () => {
      const w = await ours(false);
      return { ...w, act: async () => expect(await w.t.post(w.bob, quoteReject(w.bob, w.mine.uri))).toBe(202) };
    },
  },
  "answerQuoteRequest: a QuoteRequest accepted": {
    state: "accepted",
    world: async () => {
      const w = await asked(false);
      return { ...w, act: async () => expect(await w.request()).toBe(202) };
    },
  },
  "revokeQuoteRow: the revoke API": {
    state: "revoked",
    world: async () => {
      const w = await asked(true);
      const quoting = (await statusRow(w.t.store, w.uri))!.id;
      return {
        ...w,
        act: async () => {
          const response = await w.t.request(`/api/v1/statuses/${w.mine.id}/quotes/${quoting}/revoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${w.t.tokens.alice}` },
          });
          expect(response.status).toBe(200);
        },
      };
    },
  },
  "retireQuoteOf: a Delete of the quoting status": {
    state: null,
    world: async () => {
      const w = await received(true);
      return { ...w, act: async () => expect(await w.t.post(w.bob, remove(w.bob, w.quote.id))).toBe(202) };
    },
  },
  "STATUS_CHILDREN's detach: the quoted status's removal": {
    state: "deleted",
    world: async () => {
      const w = await received(true);
      await followed(w.t, w.carol);
      return { ...w, act: async () => expect(await w.t.post(w.carol, remove(w.carol, w.target.id))).toBe(202) };
    },
  },
};

// Every row the journal takes from here on, whatever the fan-out prunes after sending it.
async function capture(t: Setup): Promise<() => Promise<{ kind: string; subject: string }[]>> {
  await sql(t.store, "CREATE TABLE test_journal (kind TEXT, subject TEXT)");
  await sql(
    t.store,
    `CREATE TRIGGER test_journal_capture AFTER INSERT ON stream_events
		BEGIN INSERT INTO test_journal (kind, subject) VALUES (NEW.kind, NEW.subject); END`,
  );
  return () => sql<{ kind: string; subject: string }>(t.store, "SELECT kind, subject FROM test_journal");
}

// The `status.update` messages of `id` on the socket, as the quote state each carries.
function updates(inbox: Inbox, id: string): (string | undefined)[] {
  return inbox
    .rest()
    .filter((m) => m.event === "status.update")
    .map((m) => JSON.parse(m.payload ?? "null") as { id: string; quote: { state: string } | null })
    .filter((status) => status.id === id)
    .map((status) => status.quote?.state);
}

describe("a quote's state change on the user stream", () => {
  it.for(Object.entries(CASES))("%s", async ([, { world, state }]) => {
    const w = await world();
    const listener = await subscribed(w.t, w.t.tokens.alice, "user");
    const journal = await capture(w.t);
    // The quoting status's id: before the act when it is stored (a Delete removes it), else once the act stored it.
    const id = async () => (await statusRow(w.t.store, w.uri))?.id;
    const before = await id();
    await w.act();
    const quoting = before ?? (await id())!;
    await drained(w.t, listener);
    const edits = (await journal()).filter((row) => row.kind === "edit").map((row) => row.subject);
    expect(edits).toEqual([quoting]);
    expect(updates(listener, quoting)).toEqual(state === null ? [] : [state]);
  });
});

// The messages left on a socket, as [stream, event, the status id of a status event, or the type of a notification].
function events(inbox: Inbox): [string | undefined, string | undefined, string][] {
  return inbox.rest().map((m) => {
    const payload = JSON.parse(m.payload ?? "null") as { id?: string; type?: string } | null;
    return [m.stream?.[0], m.event, (m.event === "notification" ? payload?.type : payload?.id) ?? ""];
  });
}

async function call(t: Setup, path: string, body: Record<string, unknown> = {}) {
  const response = await t.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${t.tokens.alice}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json<{ id: string }>();
}

// Mastodon broadcasts an accepted QuoteRequest with skip_notifications (activity/quote_request.rb:41 in v4.7.5): its
// `status.update` reaches home, the lists and the feeds, and no account only a mention shows the quoting status to
// (answerQuoteRequest makes the row stream_quote_state wrote a quiet edit). The revoke API broadcasts in full.
describe("an accepted QuoteRequest and a held mention", () => {
  it("sends nothing through the quoting status's held mention, and home, the list and the feeds are sent it", async () => {
    // bob (followed and listed by alice) quotes alice's status in a public Note with #cats mentioning dave, who follows
    // no one and keeps his mention. alice listens on `user` and her list, and on `public` and `hashtag` #cats on a
    // second socket; dave on `user` and `user:notification`.
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const [account] = await sql<{ id: string }>(t.store, "SELECT id FROM accounts WHERE uri = ?", bob.uri);
    const list = await call(t, "/api/v1/lists", { title: "list" });
    await call(t, `/api/v1/lists/${list.id}/accounts`, { account_ids: [account!.id] });
    const mine = await localStatus(t, { status: "quote me", visibility: "public" });
    const note = quoting(bob, mine.uri, null, {
      cc: [`${bob.uri}/followers`, DAVE_URI],
      content: "<p>@dave #cats</p>",
      tag: [
        { type: "Mention", href: DAVE_URI, name: "@dave" },
        { type: "Hashtag", href: "https://mastodon.example/tags/cats", name: "#cats" },
      ],
    });
    t.web.serve(note.id, { "@context": AS, ...note });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    expect(await stateOf(t, note.id)).toBe("pending");
    const quoting_ = (await statusRow(t.store, note.id))!.id;
    const held = "SELECT 1 FROM notifications WHERE type = 'mention' AND account_id = ? AND status_id = ?";
    expect(await sql(t.store, held, DAVE, quoting_)).toHaveLength(1);
    const home = await subscribed(t, t.tokens.alice, "user");
    home.send({ type: "subscribe", stream: "list", list: list.id });
    await settled(t, home);
    const fed = await subscribed(t, t.tokens.alice, "public");
    fed.send({ type: "subscribe", stream: "hashtag", tag: "cats" });
    await settled(t, fed);
    const mentioned = await subscribed(t, t.tokens.dave, "user", "user:notification");

    expect(await t.post(bob, quoteRequest(bob, mine.uri, note.id))).toBe(202);
    expect(await stateOf(t, note.id)).toBe("accepted");
    await drained(t, home, fed, mentioned);
    expect(events(home)).toEqual([
      ["user", "status.update", quoting_],
      ["list", "status.update", quoting_],
      ["user", "notification", "quote"],
    ]);
    expect(events(fed)).toEqual([
      ["public", "status.update", quoting_],
      ["hashtag", "status.update", quoting_],
    ]);
    expect(events(mentioned)).toEqual([]);

    // The revoke API's move is sent through the mention.
    await call(t, `/api/v1/statuses/${mine.id}/quotes/${quoting_}/revoke`);
    expect(await stateOf(t, note.id)).toBe("revoked");
    await drained(t, mentioned);
    expect(events(mentioned)).toEqual([
      ["user", "status.update", quoting_],
      ["user:notification", "status.update", quoting_],
    ]);
  });
});
