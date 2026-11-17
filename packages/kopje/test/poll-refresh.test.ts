import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Poll } from "../src/domain/poll-presenter";
import type { PollReservation } from "../src/domain/polls";
import { REQUEST_MAX_BYTES, REQUEST_MAX_FETCHES } from "../src/federation/loader";
import { createPollFetcher } from "../src/federation/poll-refresh";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { POLL_REVISION_MAX } from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { countingStore, harness, NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { LOCAL, mastodonActor } from "./inbox-helpers";
import {
  ALICE_URI,
  AS,
  create,
  DAVE,
  followed,
  localStatus,
  mastodonNote,
  type Note,
  PUBLIC,
  type Setup,
  setup,
  update,
} from "./inbox-status-helpers";

// A signed-in read of a remote poll refreshes it from its status's document (#1655; Mastodon 4.7.5's
// Api::V1::PollsController#refresh_poll and Poll#possibly_stale?): docs/mastodon-deviations.md "Polls", and
// docs/threat-model.md DATA-7, RES-6, ID-2, ID-6, ID-7 and NET-4. The Store's clock is faked (its kernel reads Date at
// each call) and moved with the app's, so P1's minute is the Store's own.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INSTANCE_KEY = `${LOCAL}/actor#main-key`;
const ALICE_KEY = `${ALICE_URI}#main-key`;

const holds: { release: () => void }[] = [];
const outstanding: Promise<unknown>[] = [];

afterEach(async () => {
  for (const held of holds.splice(0)) {
    held.release();
  }
  await Promise.allSettled(outstanding.splice(0));
  vi.useRealTimers();
});

const choices = (cats: number, dogs: number) => [
  { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
  { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: dogs } },
];

type World = Awaited<ReturnType<typeof world>>;

// alice follows bob, whose Question (no votes, ending an hour after NOW unless `extra` says otherwise) is stored by its
// Create and served at its id. Its poll was never fetched, so it is due at its first signed-in read.
async function world(extra: Record<string, unknown> = {}) {
  const clock = { now: NOW };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = await setup(clock);
  const bob = await mastodonActor(t.web, "bob");
  await followed(t, bob);
  const note = mastodonNote(bob, {
    type: "Question",
    content: "<p>which?</p>",
    contentMap: { en: "<p>which?</p>" },
    endTime: "2026-10-12T01:00:00Z",
    votersCount: 0,
    oneOf: choices(0, 0),
    ...extra,
  });
  serve(t, note);
  expect(await t.post(bob, create(bob, note))).toBe(202);
  const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
  t.web.fetched.length = 0;
  t.web.keyIds.length = 0;
  // Moves the app's and the Store's clocks together.
  const move = (ms: number) => {
    clock.now += ms;
    vi.setSystemTime(clock.now);
  };
  return { t, clock, bob, note, id: row!.id, move };
}

function serve(t: Setup, note: Note): void {
  t.web.serve(note.id, { "@context": AS, ...note });
}

// The Question as its server renders it with these counts (as many voters as votes, when it counts voters).
function counted(w: World, cats: number, dogs: number, extra: Record<string, unknown> = {}): Note {
  const voters = w.note.votersCount === undefined ? {} : { votersCount: cats + dogs };
  return { ...w.note, oneOf: choices(cats, dogs), ...voters, ...extra };
}

// A same-version Update of the Question (its published time, the stored watermark), as Mastodon's
// DistributePollUpdateWorker sends one.
const implicit = (w: World, object: Note) => update(w.bob, object, w.note.published as string);

const read = (w: World, as: "alice" | "dave" | null = "alice") => w.t.api<Poll>(`/api/v1/polls/${w.id}`, as);

const fetches = (w: World) => w.t.web.fetched.filter((url) => url === w.note.id).length;

const vote = (w: World, as: "alice" | "dave", choice: string) =>
  w.t.request(`/api/v1/polls/${w.id}/votes`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.t.tokens[as]}`, "content-type": "application/json" },
    body: JSON.stringify({ choices: [choice] }),
  });

type Stored = {
  tallies: string;
  votes_count: number;
  voters_count: number | null;
  expires_at: string | null;
  ended: number;
  generation: number;
  fetched_at: number | null;
  refresh_at: number | null;
  revision: number;
  quote_policy: number;
};

const stored = async (w: World) =>
  (
    await sql<Stored>(
      w.t.store,
      `SELECT p.tallies, p.votes_count, p.voters_count, p.expires_at, p.ended, p.generation, p.fetched_at, p.refresh_at,
				p.revision, s.quote_policy
			FROM polls p JOIN statuses s ON s.id = p.status_id WHERE p.status_id = ?`,
      w.id,
    )
  )[0]!;

async function credential(w: World) {
  return { tokenHash: await sha256Hex(w.t.tokens.alice), scope: "read:statuses" as const, now: w.clock.now };
}

// alice's reservation, made through the Store as the Worker makes it, by a Worker that then stops.
async function reserve(w: World): Promise<PollReservation> {
  const answer = await w.t.store.reservePollRefresh(BUILD, { credential: await credential(w), id: w.id });
  if (answer.status !== "ok" || answer.value === null) {
    throw new Error(`no reservation: ${JSON.stringify(answer)}`);
  }
  return answer.value;
}

const fetcher = (w: World, budget?: Parameters<typeof createPollFetcher>[0]["budget"]) =>
  createPollFetcher({
    build: () => BUILD,
    store: () => w.t.store,
    now: () => w.clock.now,
    keygen: fixtureKeyGen,
    loader: w.t.web.loader,
    ...(budget === undefined ? {} : { budget }),
  });

describe("a signed-in read of a remote poll", () => {
  it("refreshes a stale remote poll read by a user", async () => {
    const w = await world();
    serve(w.t, counted(w, 3, 5));
    const { status, body } = await read(w);
    expect(status).toBe(200);
    expect(body).toMatchObject({ votes_count: 8, voters_count: 8, options: [{ votes_count: 3 }, { votes_count: 5 }] });
    expect(fetches(w)).toBe(1);
    expect(await stored(w)).toMatchObject({ tallies: "[3,5]", fetched_at: NOW, refresh_at: NOW });
  });

  // The refresh applies the document as its author's implicit Update (fetch_remote_poll_service.rb:11 reaches
  // ProcessStatusUpdateService), whose update_counts! stores the status's untrusted counts as well.
  it("stores the status's likes and shares counts the refreshed document gives", async () => {
    const w = await world({
      likes: { type: "Collection", totalItems: 1 },
      shares: { type: "Collection", totalItems: 2 },
    });
    const untrusted = () =>
      sql(
        w.t.store,
        "SELECT untrusted_favourites_count AS f, untrusted_reblogs_count AS r FROM statuses WHERE id = ?",
        w.id,
      );
    expect(await untrusted()).toEqual([{ f: 1, r: 2 }]);
    serve(
      w.t,
      counted(w, 3, 5, {
        likes: { type: "Collection", totalItems: 42 },
        shares: { type: "Collection", totalItems: "" },
      }),
    );
    expect((await read(w)).body).toMatchObject({ votes_count: 8 });
    expect(fetches(w)).toBe(1);
    expect(await untrusted()).toEqual([{ f: 42, r: null }]);
  });

  it("fetches nothing for an anonymous reader or an app token", async () => {
    const w = await world();
    await sql(
      w.t.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', NULL, 'read')",
      await sha256Hex("app-token"),
    );
    expect((await read(w, null)).status).toBe(200);
    const app = await w.t.request(`/api/v1/polls/${w.id}`, { headers: { authorization: "Bearer app-token" } });
    expect(app.status).toBe(200);
    expect([fetches(w), (await stored(w)).refresh_at]).toEqual([0, null]);
    // A user's read of the same poll fetches.
    await read(w);
    expect(fetches(w)).toBe(1);
  });

  it("never refreshes a local poll", async () => {
    const w = await world();
    const { id } = await localStatus(w.t, { status: "which?", poll: { options: ["a", "b"], expires_in: 3600 } });
    expect((await w.t.api(`/api/v1/polls/${id}`, "dave")).status).toBe(200);
    expect(w.t.web.fetched).toEqual([]);
    expect(await sql(w.t.store, "SELECT refresh_at FROM polls WHERE status_id = ?", id)).toEqual([
      { refresh_at: null },
    ]);
    // dave's read of the remote one fetches.
    await read(w, "dave");
    expect(fetches(w)).toBe(1);
  });

  it("waits a full minute after an applied Update", async () => {
    // Delivered: a same-version Update at NOW + 1 s marks the poll fetched. Exactly a minute later it is not due yet
    // (Mastodon's `last_fetched_at < 1.minute.ago`); 61 s later it is.
    const w = await world();
    w.move(1000);
    expect(await w.t.post(w.bob, implicit(w, counted(w, 1, 1)))).toBe(202);
    expect((await stored(w)).fetched_at).toBe(NOW + 1000);
    w.move(MINUTE);
    await read(w);
    expect(fetches(w)).toBe(0);
    w.move(1000);
    await read(w);
    expect(fetches(w)).toBe(1);
    // Fetched: a search that refetches the stored status marks it too.
    w.move(2 * MINUTE);
    const found = await w.t.api(`/api/v2/search?resolve=true&type=statuses&q=${encodeURIComponent(w.note.id)}`);
    expect(found.status).toBe(200);
    expect(fetches(w)).toBe(2);
    expect((await stored(w)).fetched_at).toBe(w.clock.now);
    w.move(MINUTE);
    await read(w);
    expect(fetches(w)).toBe(2);
  });

  it("waits a full minute after any attempt", async () => {
    // Exactly a minute after the reservation the poll is not due yet, as after a fetch; 61 s after it, it is.
    const w = await world();
    w.t.web.fail(w.note.id, 503);
    await read(w);
    expect(fetches(w)).toBe(1);
    expect(await stored(w)).toMatchObject({ fetched_at: null, refresh_at: NOW });
    w.move(MINUTE);
    await read(w);
    expect(fetches(w)).toBe(1);
    w.move(1000);
    await read(w);
    expect(fetches(w)).toBe(2);
    // Times after the Store's (imported, or written under a skewed clock) read as none: the poll is due.
    await sql(
      w.t.store,
      "UPDATE polls SET refresh_at = ?1, fetched_at = ?1 WHERE status_id = ?2",
      w.clock.now + DAY,
      w.id,
    );
    await read(w);
    expect(fetches(w)).toBe(3);
  });

  it("reserves the attempt before the fetch", async () => {
    const w = await world();
    serve(w.t, counted(w, 3, 5));
    const held = w.t.web.hold(w.note.id);
    holds.push(held);
    const first = read(w, "alice");
    outstanding.push(first);
    await held.reached;
    // dave's read while alice's fetch is held: the attempt is reserved, so he is answered the stored poll at once.
    expect((await read(w, "dave")).body).toMatchObject({ votes_count: 0 });
    expect((await stored(w)).refresh_at).toBe(NOW);
    held.release();
    expect((await first).body).toMatchObject({ votes_count: 8 });
    expect(fetches(w)).toBe(1);
  });

  it("an abandoned reservation waits a minute", async () => {
    // The first read's Worker stops after its reservation: it never fetches nor applies.
    const w = await world();
    await reserve(w);
    w.move(59_000);
    await read(w);
    expect(fetches(w)).toBe(0);
    w.move(2000);
    await read(w);
    expect(fetches(w)).toBe(1);
  });

  it("only the reservation's own refresh applies", async () => {
    const w = await world();
    serve(w.t, counted(w, 3, 5));
    const held = w.t.web.hold(w.note.id, { snapshot: true });
    holds.push(held);
    const first = read(w, "alice");
    outstanding.push(first);
    await held.reached;
    // alice's fetch stalls past a minute; dave's read reserves anew and applies the newer counts.
    w.move(61_000);
    serve(w.t, counted(w, 7, 5));
    expect((await read(w, "dave")).body).toMatchObject({ votes_count: 12 });
    held.release();
    // alice's refresh, of the older document, applies nothing and answers the poll as stored now.
    expect((await first).body).toMatchObject({ votes_count: 12 });
    expect(await stored(w)).toMatchObject({ tallies: "[7,5]", refresh_at: NOW + 61_000 });
  });

  describe("keeps what commits during the fetch", () => {
    // alice's read reserves and fetches the document her server sent before the commit (3 and 5 votes, no end, no
    // quote policy), released after `commit`. The refresh applies nothing: the poll and its status stay as committed,
    // their revision included, and refresh_at is the reservation's.
    async function during(w: World, commit: () => Promise<void>): Promise<Stored> {
      serve(w.t, counted(w, 3, 5, { endTime: undefined }));
      const held = w.t.web.hold(w.note.id, { snapshot: true });
      holds.push(held);
      const first = read(w, "alice");
      outstanding.push(first);
      await held.reached;
      await commit();
      const committed = await stored(w);
      held.release();
      expect((await first).status).toBe(200);
      expect(fetches(w)).toBe(1);
      expect(await stored(w)).toEqual(committed);
      expect(committed.refresh_at).toBe(NOW);
      return committed;
    }

    it("(a) a same-version Update with the final tallies and its end", async () => {
      const w = await world();
      const committed = await during(w, async () => {
        expect(await w.t.post(w.bob, implicit(w, counted(w, 9, 9, { closed: "2026-10-11T23:59:00Z" })))).toBe(202);
      });
      expect(committed).toMatchObject({ tallies: "[9,9]", expires_at: "2026-10-11T23:59:00.000Z", fetched_at: NOW });
    });

    it("(b) a same-version Update whose poll values are the stored ones and whose quote policy differs", async () => {
      const w = await world();
      const policy = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };
      const committed = await during(w, async () => {
        expect(await w.t.post(w.bob, implicit(w, counted(w, 0, 0, policy)))).toBe(202);
      });
      expect(committed).toMatchObject({ tallies: "[0,0]", fetched_at: NOW });
      expect(committed.quote_policy).not.toBe(0);
    });

    it("(c) a local vote by another user in a poll that counts no voters", async () => {
      const w = await world({ votersCount: undefined });
      const committed = await during(w, async () => {
        expect((await vote(w, "dave", "0")).status).toBe(200);
      });
      expect(committed).toMatchObject({ tallies: "[1,0]", voters_count: null, generation: 0, fetched_at: null });
      expect((await read(w, "dave")).body).toMatchObject({ own_votes: [0], votes_count: 1 });
    });
  });

  it("revisions from the maximum", async () => {
    // A poll whose revision is 2^53 - 1 (imported): each write leaves one within the bound, other than the one before.
    const w = await world();
    const maximum = () =>
      sql(w.t.store, "UPDATE polls SET revision = ?1 WHERE status_id = ?2", POLL_REVISION_MAX, w.id);
    const moved = async () => {
      const { revision } = await stored(w);
      expect(Number.isSafeInteger(revision) && revision >= 0 && revision !== POLL_REVISION_MAX).toBe(true);
    };
    // A reservation.
    await maximum();
    const reservation = await reserve(w);
    await moved();
    // A vote, after which the refresh reserved before it applies nothing.
    await maximum();
    expect((await vote(w, "dave", "1")).status).toBe(200);
    await moved();
    const refreshed = await w.t.store.refreshPoll(BUILD, {
      credential: await credential(w),
      statusId: reservation.statusId,
      revision: reservation.revision,
      status: parseRemoteStatus(counted(w, 4, 0))!,
      now: w.clock.now,
      origin: LOCAL,
      present: { origin: LOCAL },
    });
    expect(refreshed).toMatchObject({ status: "ok", value: { poll: { votes_count: 1 } } });
    expect((await stored(w)).tallies).toBe("[0,1]");
    // An accepted Update.
    await maximum();
    expect(await w.t.post(w.bob, implicit(w, counted(w, 2, 2)))).toBe(202);
    await moved();
  });

  it("refreshes an ended poll once after its end", async () => {
    const w = await world({ endTime: "2026-10-12T00:30:00Z" });
    w.move(HOUR);
    serve(w.t, counted(w, 4, 4, { closed: "2026-10-12T00:30:00Z" }));
    expect((await read(w)).body).toMatchObject({ expired: true, votes_count: 8 });
    expect(fetches(w)).toBe(1);
    w.move(2 * MINUTE);
    await read(w);
    w.move(DAY);
    await read(w);
    expect(fetches(w)).toBe(1);
  });

  it("a refused choice change leaves the poll due", async () => {
    // A poll past its end, whose server renames a choice without a newer version: the change is refused, so its
    // fetched_at stays unset and it is tried again once a full minute has passed, as Mastodon tries it at every read.
    const w = await world({ endTime: "2026-10-12T00:30:00Z" });
    w.move(HOUR);
    serve(w.t, counted(w, 4, 4, { oneOf: [{ ...choices(4, 4)[0]!, name: "birds" }, choices(4, 4)[1]!] }));
    await read(w);
    expect(fetches(w)).toBe(1);
    expect(await stored(w)).toMatchObject({ tallies: "[0,0]", fetched_at: null, refresh_at: NOW + HOUR });
    w.move(MINUTE);
    await read(w);
    expect(fetches(w)).toBe(1);
    w.move(1000);
    await read(w);
    expect(fetches(w)).toBe(2);
  });

  it("fetches nothing while writes are refused", async () => {
    const w = await world();
    serve(w.t, counted(w, 3, 5));
    // The env's MAINTENANCE: no reservation is asked for.
    const readonly = harness(
      w.t.store,
      { MAINTENANCE: "readonly" },
      BUILD,
      { keygen: fixtureKeyGen, loader: w.t.web.loader },
      () => w.clock.now,
    );
    const during = await readonly.request(`/api/v1/polls/${w.id}`, {
      headers: { authorization: `Bearer ${w.t.tokens.alice}` },
    });
    expect(during.status).toBe(200);
    expect(await during.json()).toMatchObject({ votes_count: 0 });
    // The Store readonly: the reservation is refused, and the stored poll answered.
    await w.t.store.setMaintenance(BUILD, true);
    expect(await read(w)).toMatchObject({ status: 200, body: { votes_count: 0 } });
    expect([fetches(w), (await stored(w)).refresh_at]).toEqual([0, null]);
    // Writes admitted again, the read fetches.
    await w.t.store.setMaintenance(BUILD, false);
    expect((await read(w)).body).toMatchObject({ votes_count: 8 });
    expect(fetches(w)).toBe(1);
  });

  describe("answers the stored poll when the refresh fails", () => {
    it.each([
      ["a 503", 503],
      ["a 404", 404],
      ["a 410", 410],
      ["no answer", 0],
    ])("%s", async (_name, code) => {
      const w = await world();
      w.t.web.fail(w.note.id, code);
      expect(await read(w)).toMatchObject({ status: 200, body: { votes_count: 0 } });
      expect(fetches(w)).toBe(1);
      expect(await stored(w)).toMatchObject({ tallies: "[0,0]", fetched_at: null, refresh_at: NOW });
      expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses WHERE id = ?", w.id)).toEqual([{ n: 1 }]);
    });

    // The request's budget (RES-6), spent or past its deadline: nothing is sent.
    it.each([
      ["a spent budget", { fetches: 0, bytes: REQUEST_MAX_BYTES, late: false }],
      ["a budget past its deadline", { fetches: REQUEST_MAX_FETCHES, bytes: REQUEST_MAX_BYTES, late: true }],
    ])("%s", async (_name, { fetches: remaining, bytes, late }) => {
      const w = await world();
      serve(w.t, counted(w, 3, 5));
      const reservation = await reserve(w);
      const spent = fetcher(w, (now) => ({ fetches: remaining, bytes, deadline: late ? now - 1 : now + 15_000 }));
      expect(await spent(env, reservation)).toBeNull();
      expect(fetches(w)).toBe(0);
      // Within the budget, the same reservation's document is taken.
      expect(await fetcher(w)(env, reservation)).toMatchObject({ uri: w.note.id });
    });
  });

  it("signs a public or unlisted post's fetch as the instance actor, another's as the reader", async () => {
    const w = await world();
    const followers = `${w.bob.uri}/followers`;
    const mention = { type: "Mention", href: ALICE_URI, name: "@alice" };
    const cases: [visibility: string, addressing: Record<string, unknown>, key: string][] = [
      ["public", { to: [PUBLIC], cc: [followers] }, INSTANCE_KEY],
      ["unlisted", { to: [followers], cc: [PUBLIC] }, INSTANCE_KEY],
      ["private", { to: [followers], cc: [] }, ALICE_KEY],
      ["direct", { to: [ALICE_URI], cc: [], tag: [mention] }, ALICE_KEY],
      ["limited", { to: [ALICE_URI], cc: [] }, ALICE_KEY],
    ];
    for (const [visibility, addressing, key] of cases) {
      const note = { ...counted(w, 0, 0), ...mastodonNote(w.bob, { type: "Question" }), ...addressing } as Note;
      serve(w.t, { ...note, oneOf: choices(1, 1), votersCount: 2 });
      expect(await w.t.post(w.bob, create(w.bob, note))).toBe(202);
      const [row] = await sql<{ id: string; visibility: string }>(
        w.t.store,
        "SELECT id, visibility FROM statuses WHERE uri = ?",
        note.id,
      );
      expect(row!.visibility).toBe(visibility);
      w.t.web.fetched.length = 0;
      w.t.web.keyIds.length = 0;
      const answer = await w.t.api<Poll>(`/api/v1/polls/${row!.id}`);
      expect([visibility, answer.status, answer.body.votes_count]).toEqual([visibility, 200, 2]);
      expect([visibility, w.t.web.fetched, w.t.web.keyIds]).toEqual([visibility, [note.id], [key]]);
    }
  });

  describe("a refused fetch answers the stored poll and waits a minute", () => {
    // Draft-cavage, then RFC 9421 by the same key on a 401, once on a 403; the other signer is never tried.
    it.each([
      ["a 401 to the instance actor", 401, false, [INSTANCE_KEY, INSTANCE_KEY]],
      ["a 403 to the instance actor", 403, false, [INSTANCE_KEY]],
      ["a 401 to the reader", 401, true, [ALICE_KEY, ALICE_KEY]],
      ["a 403 to the reader", 403, true, [ALICE_KEY]],
    ])("%s", async (_name, code, direct, keys) => {
      const w = await world();
      const mention = { type: "Mention", href: ALICE_URI, name: "@alice" };
      const addressing = direct ? { to: [ALICE_URI], cc: [], tag: [mention] } : {};
      const note = { ...counted(w, 0, 0), ...mastodonNote(w.bob, { type: "Question" }), ...addressing } as Note;
      expect(await w.t.post(w.bob, create(w.bob, note))).toBe(202);
      const [row] = await sql<{ id: string }>(w.t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
      w.t.web.fail(note.id, code);
      w.t.web.keyIds.length = 0;
      expect(await w.t.api<Poll>(`/api/v1/polls/${row!.id}`)).toMatchObject({ status: 200, body: { votes_count: 0 } });
      expect(w.t.web.keyIds).toEqual(keys);
      w.move(MINUTE - 1);
      await w.t.api(`/api/v1/polls/${row!.id}`);
      expect(w.t.web.keyIds).toEqual(keys);
    });

    // The domain policy: a reservation whose verdict refuses the host sends nothing. A block that covers the status's
    // host covers its author too (R38), so its poll is not shown at all and no reservation is made.
    it("by the domain policy", async () => {
      const w = await world();
      const reservation = await reserve(w);
      expect(reservation.prefetch?.ticket).toEqual({ host: "mastodon.example", refused: false });
      const refused = {
        ...reservation,
        prefetch: { ...reservation.prefetch!, ticket: { host: "mastodon.example", refused: true } },
      };
      expect(await fetcher(w)(env, refused)).toBeNull();
      expect(w.t.web.fetched).toEqual([]);
      expect(await fetcher(w)(env, reservation)).toMatchObject({ uri: w.note.id });
      expect(fetches(w)).toBe(1);
      await blockDomain(w.t.store, "mastodon.example");
      w.move(2 * MINUTE);
      expect((await read(w)).status).toBe(404);
      expect(fetches(w)).toBe(1);
    });
  });

  describe("takes no document but the status's own", () => {
    it.each([
      [
        "of another id",
        (w: World) => w.t.web.serve(w.note.id, { "@context": AS, ...counted(w, 5, 5), id: `${w.note.id}-other` }),
      ],
      [
        "behind a redirect",
        (w: World) => {
          w.t.web.redirect(w.note.id, `${w.note.id}/elsewhere`);
          w.t.web.serve(`${w.note.id}/elsewhere`, { "@context": AS, ...counted(w, 5, 5) });
        },
      ],
      ["of another author", (w: World) => serve(w.t, { ...counted(w, 5, 5), attributedTo: `${w.bob.uri}-other` })],
    ])("%s", async (_name, arrange) => {
      const w = await world();
      arrange(w);
      const counting = countingStore(w.t.store);
      const h = harness(counting.stub, {}, BUILD, { keygen: fixtureKeyGen, loader: w.t.web.loader }, () => w.clock.now);
      const answer = await h.request(`/api/v1/polls/${w.id}`, {
        headers: { authorization: `Bearer ${w.t.tokens.alice}` },
      });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ votes_count: 0 });
      // Reserved and fetched once, and nothing handed to the Store to apply.
      expect(w.t.web.fetched).toEqual([w.note.id]);
      expect(counting.calls).toContain("reservePollRefresh");
      expect(counting.calls).not.toContain("refreshPoll");
      expect(await stored(w)).toMatchObject({ tallies: "[0,0]", fetched_at: null, refresh_at: NOW });
    });
  });

  it("applies the document as its author's Update", async () => {
    const w = await world();
    const boosted = await w.t.request(`/api/v1/statuses/${w.id}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.t.tokens.dave}` },
    });
    expect(boosted.status).toBe(200);
    serve(
      w.t,
      counted(w, 1, 2, {
        content: "<p>edited</p>",
        contentMap: { en: "<p>edited</p>" },
        updated: "2026-10-11T23:00:00Z",
      }),
    );
    expect((await read(w)).body).toMatchObject({ votes_count: 3 });
    const history = await w.t.api<{ content: string }[]>(`/api/v1/statuses/${w.id}/history`);
    expect(history.body.map((version) => version.content)).toEqual(["<p>which?</p>", "<p>edited</p>"]);
    expect(
      await sql(w.t.store, "SELECT account_id FROM notifications WHERE type = 'update' AND status_id = ?", w.id),
    ).toEqual([{ account_id: DAVE }]);
  });

  it("only the poll read refreshes", async () => {
    const w = await world();
    expect((await vote(w, "dave", "0")).status).toBe(200);
    expect((await w.t.api(`/api/v1/statuses/${w.id}`)).status).toBe(200);
    expect((await w.t.api("/api/v1/timelines/home")).status).toBe(200);
    expect((await w.t.api("/api/v1/timelines/public")).status).toBe(200);
    expect(fetches(w)).toBe(0);
    await read(w);
    expect(fetches(w)).toBe(1);
  });
});
