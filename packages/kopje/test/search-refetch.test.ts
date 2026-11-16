import { describe, expect, it } from "vitest";

import { QUOTE_HOPS } from "../src/domain/quotes";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { mastodonActor } from "./inbox-helpers";
import {
  AS,
  DAVE,
  type Note,
  mastodonNote,
  OTHER,
  PUBLIC,
  type Setup,
  setup,
  statusRow,
  update,
} from "./inbox-status-helpers";
import { quoting } from "./quote-helpers";

// A search with resolve=true of a remote status Kopje already stores (docs/threat-model.md ID-7, VIS-30): the fetched
// document is applied as its author's Update (storeFetchedStatus in src/domain/remote-statuses.ts), as Mastodon
// 4.7.5's ResolveURLService hands it to FetchRemoteStatusService, which turns a stored status's Create into an Update
// (fetch_remote_status_service.rb:48), under the Update's version rules; a 404 keeps and answers the stored status, a
// 410 keeps it and answers nothing (resolve_url_service.rb:38-61). /authorize_interaction shares the path:
// test/interaction.test.ts.

const at = (minutes: number) => new Date(Date.parse("2026-10-11T12:00:00Z") + minutes * 60_000).toISOString();

type Found = { statuses: { id: string; content: string; edited_at: string | null; poll: { votes_count: number } }[] };

const search = (t: Setup, uri: string, as: "alice" | "dave" = "alice") =>
  t.api<Found>(`/api/v2/search?resolve=true&type=statuses&q=${encodeURIComponent(uri)}`, as);

function serve(t: Setup, note: Note): Note {
  t.web.serve(note.id, { "@context": AS, ...note });
  return note;
}

const choices = (cats: number) => [
  { type: "Note", name: "cats", replies: { type: "Collection", totalItems: cats } },
  { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: 0 } },
];
const poll = (cats: number) => ({
  type: "Question",
  endTime: "2026-10-13T00:00:00Z",
  votersCount: cats,
  oneOf: choices(cats),
});

// bob's `note`, served and stored by alice's search; bob has no local follower, so no Update reaches this instance.
async function stored(extra: Record<string, unknown> = {}) {
  const t = await setup();
  const bob = await mastodonActor(t.web, "bob");
  const note = serve(t, mastodonNote(bob, extra));
  const first = await search(t, note.id);
  expect(first.body.statuses).toHaveLength(1);
  const id = first.body.statuses[0]!.id;
  return { t, bob, note, id };
}

const row = (t: Setup, id: string) =>
  sql<{ content: string; edited_at: string | null; quote_policy: number; votes: number | null; edits: number }>(
    t.store,
    `SELECT s.content, s.edited_at, s.quote_policy, (SELECT votes_count FROM polls WHERE status_id = s.id) AS votes,
			(SELECT count(*) FROM status_edits WHERE status_id = s.id) AS edits
		FROM statuses s WHERE s.id = ?`,
    id,
  ).then((rows) => rows[0]);

describe("search of a stored status applies the served document as an Update", () => {
  it("applies a newer version as an edit: content, edited_at and the history", async () => {
    const { t, note, id } = await stored();
    serve(t, { ...note, content: "<p>edited</p>", updated: at(60) });
    const found = await search(t, note.id);
    expect(found.body.statuses).toMatchObject([{ id, content: "<p>edited</p>", edited_at: at(60) }]);
    const history = await t.api<{ content: string }[]>(`/api/v1/statuses/${id}/history`);
    expect(history.body.map((version) => version.content)).toEqual([note.content, "<p>edited</p>"]);
  });

  it("refreshes a never-edited poll's counts from a document that names no version; edited_at stays null", async () => {
    const { t, note, id } = await stored(poll(0));
    serve(t, { ...note, ...poll(3) });
    expect((await search(t, note.id)).body.statuses).toMatchObject([{ id, edited_at: null, poll: { votes_count: 3 } }]);
    expect(await row(t, id)).toMatchObject({ content: note.content, edited_at: null, votes: 3, edits: 0 });
  });

  // ID-7: an older served version changes nothing; the fixture's newer one does (the branch ran).
  it("ignores an older version and applies a newer one", async () => {
    const { t, note, id } = await stored({ content: "<p>at 60</p>", updated: at(60) });
    serve(t, { ...note, content: "<p>older</p>", updated: at(30) });
    await search(t, note.id);
    expect(await row(t, id)).toMatchObject({ content: "<p>at 60</p>", edited_at: at(60), edits: 0 });
    serve(t, { ...note, content: "<p>newer</p>", updated: at(90) });
    await search(t, note.id);
    expect(await row(t, id)).toMatchObject({ content: "<p>newer</p>", edited_at: at(90), edits: 2 });
  });

  // ID-7: a peer serves its cached copy from before an edit (Mastodon's render cache keeps a status's body 3 minutes,
  // cache_concern.rb:31-32): the edit Kopje received, with the counts and policy it carried, stays.
  it("keeps an edit, its counts and its policy against a cached copy from before the edit", async () => {
    const { t, bob, note, id } = await stored(poll(0));
    const policy = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };
    const edit = update(bob, { ...note, ...poll(1), ...policy, content: "<p>edited</p>" }, at(60));
    expect(await t.post(bob, edit)).toBe(202);
    const edited = await row(t, id);
    expect(edited).toMatchObject({ content: "<p>edited</p>", edited_at: at(60), votes: 1, edits: 2 });
    expect(edited!.quote_policy).not.toBe(0);
    // The server still serves the first render: no `updated`, no votes, no policy.
    expect((await search(t, note.id)).body.statuses).toMatchObject([{ id, content: "<p>edited</p>" }]);
    expect(await row(t, id)).toEqual(edited);
  });

  it("notifies the local boosters of a significant edit, as an inbound Update does", async () => {
    const { t, note, id } = await stored();
    const boosted = await t.request(`/api/v1/statuses/${id}/reblog`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.tokens.dave}` },
    });
    expect(boosted.status).toBe(200);
    serve(t, { ...note, content: "<p>edited</p>", updated: at(60) });
    await search(t, note.id);
    expect(await sql(t.store, "SELECT account_id FROM notifications WHERE type = 'update'")).toEqual([
      { account_id: DAVE },
    ]);
  });

  // ID-3, ID-6: only a status stored under the document's own id is updated, as Mastodon's Status.exists?(uri:)
  // (fetch_remote_status_service.rb:48); a document naming a stored status by atomUri only is a Create, which finds
  // that status and keeps it (Create#find_existing_status).
  it("updates nothing, and stores nothing new, for a document naming a stored status only by atomUri", async () => {
    const { t, bob, note, id } = await stored({ published: new Date(NOW - 60_000).toISOString() });
    const other = serve(t, {
      ...mastodonNote(bob, { published: new Date(NOW - 60_000).toISOString() }),
      atomUri: note.id,
      content: "<p>other</p>",
      updated: new Date(NOW).toISOString(),
    });
    await search(t, other.id);
    expect(t.web.fetched).toContain(other.id);
    expect(await statusRow(t.store, other.id)).toBeUndefined();
    expect(await row(t, id)).toMatchObject({ content: note.content, edited_at: null, edits: 0 });
  });

  // R38, VIS-30: nothing is updated for an unavailable author; once available again, the same search applies it.
  it("updates nothing of an unavailable author's status; an available author's is updated", async () => {
    const { t, bob, note, id } = await stored();
    const suspend = (on: boolean) =>
      sql(
        t.store,
        "UPDATE accounts SET suspended_at = ?, suspension_source = ? WHERE uri = ?",
        on ? new Date(NOW).toISOString() : null,
        on ? "account" : null,
        bob.uri,
      );
    await suspend(true);
    serve(t, { ...note, content: "<p>edited</p>", updated: at(60) });
    t.web.fetched.length = 0;
    expect((await search(t, note.id)).body.statuses).toEqual([]);
    expect(t.web.fetched).toContain(note.id);
    expect(await row(t, id)).toMatchObject({ content: note.content, edited_at: null });
    await suspend(false);
    await search(t, note.id);
    expect(await row(t, id)).toMatchObject({ content: "<p>edited</p>", edited_at: at(60) });
  });

  // D8: a 404 or a 410 removes nothing on search. Mastodon's process_url_from_db answers the stored status only after a
  // 401, 403 or 404 (resolve_url_service.rb:44), so a 410 answers nothing.
  it.each([
    { name: "keeps and answers a stored status whose fetch answers 404", status: 404, answered: true },
    { name: "answers nothing for a stored status whose fetch answers 410, and keeps it", status: 410, answered: false },
  ])("$name", async ({ status, answered }) => {
    const { t, note, id } = await stored();
    t.web.fail(note.id, status);
    t.web.fetched.length = 0;
    const { statuses } = (await search(t, note.id)).body;
    if (answered) expect(statuses).toMatchObject([{ id }]);
    else expect(statuses).toEqual([]);
    expect(t.web.fetched).toContain(note.id);
    expect(await row(t, id)).toMatchObject({ content: note.content });
  });
});

// ID-2, ID-7: a document is taken only from its own id, as Mastodon's FetchResourceService#process_response
// (fetch_resource_service.rb:54-59 in v4.7.5): when the URL searched, or the URL that answered after redirects, is not
// the document's id, the id is fetched again, terminal (no redirect, a 200 whose id is that URL), and only that document
// is used. Another URL of the same origin (the loader refuses another origin's id) cannot speak for a stored status.
describe("search takes a status document only from its id", () => {
  const forged = (note: Note): Note => ({
    ...note,
    content: "<p>FORGED</p>",
    updated: at(60),
    interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
  });
  const serveAt = (t: Setup, url: string, note: Note) => t.web.serve(url, { "@context": AS, ...note });
  const origin = (note: Note) => new URL(note.id).origin;

  it("updates nothing from another URL of the origin whose document names a stored status's id", async () => {
    const { t, note, id } = await stored();
    const before = await row(t, id);
    serveAt(t, `${origin(note)}/noncanonical-cache`, forged(note));
    t.web.fetched.length = 0;
    expect((await search(t, `${origin(note)}/noncanonical-cache`)).body.statuses).toMatchObject([{ id }]);
    expect(await row(t, id)).toEqual(before);
    expect(t.web.fetched).toContain(note.id);
  });

  it("updates nothing through a redirect to a document naming a stored status's id", async () => {
    const { t, note, id } = await stored();
    const before = await row(t, id);
    t.web.redirect(`${origin(note)}/redirecting`, `${origin(note)}/forged`);
    serveAt(t, `${origin(note)}/forged`, forged(note));
    await search(t, `${origin(note)}/redirecting`);
    expect(await row(t, id)).toEqual(before);
    expect(t.web.fetched).toContain(note.id);
  });

  // The URL that answered is part of the check: the id searched, redirected to another URL serving that id.
  it("updates nothing from a document its id redirects to", async () => {
    const { t, note, id } = await stored();
    const before = await row(t, id);
    t.web.redirect(note.id, `${origin(note)}/elsewhere`);
    serveAt(t, `${origin(note)}/elsewhere`, forged(note));
    await search(t, note.id);
    expect(await row(t, id)).toEqual(before);
  });

  // Mastodon serves a status at its page URL with the Note's id: the id is fetched again and its document applied.
  it.each([
    { name: "applies the document its id serves when searched by the status's page URL", redirect: false },
    { name: "applies the document its id serves when searched through a redirect", redirect: true },
  ])("$name", async ({ redirect }) => {
    const { t, note, id } = await stored();
    const page = note.url as string;
    if (redirect) t.web.redirect(`${origin(note)}/short`, page);
    serveAt(t, page, note);
    serve(t, { ...note, content: "<p>edited</p>", updated: at(60) });
    await search(t, redirect ? `${origin(note)}/short` : page);
    expect(await row(t, id)).toMatchObject({ content: "<p>edited</p>", edited_at: at(60), edits: 2 });
  });

  // Mastodon compares the id with the URL searched as well as the URL that answered: a redirect that ends at the id is
  // followed by one more fetch of the id, terminal.
  it("fetches the id again when a redirect ends at it", async () => {
    const { t, note } = await stored();
    t.web.redirect(`${origin(note)}/to-id`, note.id);
    t.web.fetched.length = 0;
    await search(t, `${origin(note)}/to-id`);
    expect(t.web.fetched.filter((url) => url === note.id)).toHaveLength(2);
  });

  // A document Mastodon does not take (fetch_resource_service.rb:54) is not followed to its id.
  it("follows no id that a document of another context names", async () => {
    const { t, note, id } = await stored();
    const before = await row(t, id);
    t.web.serve(`${origin(note)}/other-context`, { "@context": "https://example.com/ns", ...forged(note) });
    serve(t, forged(note));
    t.web.fetched.length = 0;
    await search(t, `${origin(note)}/other-context`);
    expect(t.web.fetched).not.toContain(note.id);
    expect(await row(t, id)).toEqual(before);
  });
});

describe("search of a stored status arrives as a root for its quote", () => {
  // bob's status quoting carol's, stored by search, its quote's work spent (no budget, nothing due).
  async function spent(extra: Record<string, unknown> = {}) {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { origin: OTHER, key: 2 });
    const target = serve(t, mastodonNote(carol));
    const note = serve(t, quoting(bob, target.id, null, extra));
    const id = (await search(t, note.id)).body.statuses[0]!.id;
    await sql(t.store, "UPDATE quotes SET hops = 0, attempts = 3, verify_after = NULL WHERE status_id = ?", id);
    return { t, bob, note, id };
  }

  const quote = (t: Setup, id: string) =>
    sql<{ state: string; hops: number; due: number }>(
      t.store,
      "SELECT state, hops, verify_after <= ? AS due FROM quotes WHERE status_id = ?",
      NOW,
      id,
    );

  // updateRemoteStatus stops before its quote step for each: the quote is promoted all the same, as a stored status
  // found again was before (storeRemoteStatus's known branch). The edited status was stored with `updated` (edited_at
  // set), and its server serves it without.
  const withoutUpdated = ({ updated: _, ...note }: Note): Note => note;
  it.each([
    ["an older version", { updated: at(60) }, (note: Note) => ({ ...note, updated: at(30) })],
    ["a version past the skew", {}, (note: Note) => ({ ...note, updated: new Date(NOW + 10 * 60_000).toISOString() })],
    ["no version for an edited status", { updated: at(60) }, withoutUpdated],
  ] as const)("is due again after a search that finds %s", async (_name, extra, served) => {
    const { t, note, id } = await spent(extra);
    expect(await quote(t, id)).toEqual([{ state: "pending", hops: 0, due: null }]);
    serve(t, served(note));
    await search(t, note.id);
    expect(await quote(t, id)).toEqual([{ state: "pending", hops: QUOTE_HOPS, due: 1 }]);
  });
});
