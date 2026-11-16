import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { walkReplies } from "../src/federation/replies";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { create, DAVE, followed, mastodonNote, type Note, type Setup, setup, statusRow } from "./inbox-status-helpers";
import { reply, serveNote, startWalk, storedRoot, walkRounds, walkRow, withReplies } from "./reply-walk-helpers";
//  The statuses a walk fetches again (#1607 D9, D11, D13; Mastodon 4.7.5's FetchReplyWorker through
// FetchRemoteStatusService): a stored node, the root included, is applied as its author's Update; a node other than the
// root whose own URI answers 404 with no redirect has the public or unlisted status stored under it then removed, with
// no retraction (fetch_remote_status_service.rb:86-98); the root's 404 removes nothing
// (fetch_all_replies_worker.rb:85-91 hands its body to FetchReplyWorker); and a create walk records the items it lists
// stored or not
// (fetch_replies_service.rb:33-39). The Store's clock is the faked Date.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const OTHER_ORIGIN = "https://other.example";
const EDITED_AT = "2026-10-11T18:00:00Z";

// The root author on mastodon.example; bob on other.example, followed by dave, so that his Creates are delivered.
async function world() {
  const t = await setup();
  const root = await mastodonActor(t.web, "root");
  const bob = await mastodonActor(t.web, "bob", { origin: OTHER_ORIGIN, key: 1 });
  await followed(t, bob, DAVE);
  return { t, root, bob };
}

// `note` as its server serves it after an edit to `content`, with a newer `updated`.
function editedServed(t: Setup, note: Note, content: string): void {
  const html = `<p>${content}</p>`;
  serveNote(t.web, { ...note, content: html, contentMap: { en: html }, updated: EDITED_AT });
}

// A reply by `actor` to `parent`, delivered (stored and linked under its stored parent) and served.
async function delivered(t: Setup, actor: TestActor, parent: string, extra: Record<string, unknown> = {}) {
  const note = reply(t.web, actor, parent, extra);
  expect(await t.post(actor, create(actor, note))).toBe(202);
  return note;
}

const removal = async (t: Setup, uri: string) =>
  (
    await sql<{ withdrawn: number; visibility: string; job: number }>(
      t.store,
      `SELECT s.withdrawn, s.visibility,
				EXISTS (SELECT 1 FROM inbound_jobs j WHERE j.kind = 'delete' AND j.key = s.id AND j.done_at IS NULL) AS job
			FROM statuses s WHERE s.uri = ?`,
      uri,
    )
  )[0];
const KEPT = { withdrawn: 0, job: 0 };
const REMOVING = { withdrawn: 1, visibility: "direct", job: 1 };
const retractions = async (t: Setup) =>
  (await sql<{ n: number }>(t.store, "SELECT count(*) AS n FROM inbound_retractions"))[0]!.n;
const fetches = (t: Setup, url: string) => t.web.fetched.filter((fetched) => fetched === url).length;

async function jobs(t: Setup): Promise<void> {
  for (let round = 0; round < 10 && (await runStoreJobs(t.store, BUILD, { now: NOW })).pending; round++) {
    // Until no batch is left.
  }
}

describe("a walk's stored nodes (D11)", () => {
  it("refreshes a stored node: a listed reply whose server serves a newer version is updated, its place kept", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    const item = await delivered(t, bob, note.id);
    const before = await statusRow(t.store, item.id);
    expect(before?.in_reply_to_id).toBe(rootId);
    // Served edited, naming another parent: the edit applies, the parent stays the stored row's.
    editedServed(t, { ...item, inReplyTo: `${OTHER_ORIGIN}/users/bob/statuses/elsewhere` }, "edited");
    serveNote(t.web, withReplies(t.web, note, [item.id]));
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(fetches(t, item.id)).toBe(1);
    expect(await statusRow(t.store, item.id)).toMatchObject({
      content: "<p>edited</p>",
      edited_at: expect.any(String),
      in_reply_to_id: rootId,
      in_reply_to_uri: note.id,
    });
    const history = await sql<{ n: number }>(
      t.store,
      "SELECT count(*) AS n FROM status_edits WHERE status_id = ?",
      before!.id,
    );
    expect(history).toEqual([{ n: 2 }]);
  });

  it("refreshes the root: its newer version is applied, and its replies are read", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    const g = reply(t.web, bob, note.id);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    editedServed(t, withReplies(t.web, note, [g.id]), "edited root");
    await startWalk(t.store, rootId, NOW);
    await walkRounds(t);
    expect(await statusRow(t.store, note.id)).toMatchObject({ content: "<p>edited root</p>" });
    expect(await statusRow(t.store, g.id)).toMatchObject({ in_reply_to_id: rootId });
  });
});

describe("a walk's node gone at its own URI (D9)", () => {
  it("removes a listed public reply whose URI answers 404, with no retraction, and keeps a 410, a redirected 404 and a followers-only one", async () => {
    const { t, root, bob } = await world();
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    const gone = await delivered(t, bob, note.id);
    const gone410 = await delivered(t, bob, note.id);
    const redirected = await delivered(t, bob, note.id);
    const followersOnly = await delivered(t, bob, note.id, { to: [`${bob.uri}/followers`], cc: [] });
    expect(await statusRow(t.store, followersOnly.id)).toMatchObject({ visibility: "private" });
    t.web.fail(gone.id, 404);
    t.web.fail(gone410.id, 410);
    t.web.redirect(redirected.id, `${redirected.id}/moved`);
    t.web.fail(`${redirected.id}/moved`, 404);
    t.web.fail(followersOnly.id, 404);
    const listed = [gone, gone410, redirected, followersOnly];
    serveNote(
      t.web,
      withReplies(
        t.web,
        note,
        listed.map((n) => n.id),
      ),
    );
    const repliesCount = async () => (await statusRow(t.store, note.id))?.replies_count;
    // The public replies count; the followers-only one does not.
    expect(await repliesCount()).toBe(3);
    await startWalk(t.store, rootId, NOW);
    // The walk's round asks for another, which runs the removal's batches.
    expect(
      await walkReplies(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
      ),
    ).toBe(true);
    // Each was fetched (each branch ran).
    expect(listed.map((n) => fetches(t, n.id))).toEqual([1, 1, 1, 1]);
    expect(await removal(t, gone.id)).toMatchObject(REMOVING);
    for (const kept of [gone410, redirected]) {
      expect(await removal(t, kept.id)).toMatchObject({ ...KEPT, visibility: "public" });
    }
    expect(await removal(t, followersOnly.id)).toMatchObject({ ...KEPT, visibility: "private" });
    expect(await retractions(t)).toBe(0);
    // The hidden reply leaves its parent's count at once; the removal's recount sets the same.
    expect(await repliesCount()).toBe(2);
    await jobs(t);
    expect(await statusRow(t.store, gone.id)).toBeUndefined();
    expect(await repliesCount()).toBe(2);
    expect(await walkRow(t.store, rootId)).toMatchObject({ finished_at: NOW });
    // Once the removal ended, a Create of the same status stores it again.
    expect(await t.post(bob, create(bob, gone))).toBe(202);
    expect(await removal(t, gone.id)).toMatchObject({ ...KEPT, visibility: "public" });
  });

  it("keeps the root whose URI answers 404: the walk ends, nothing removed", async () => {
    const { t, root } = await world();
    const note = mastodonNote(root);
    serveNote(t.web, withReplies(t.web, note, []));
    const rootId = await storedRoot(t, root, note);
    t.web.fail(note.id, 404);
    await startWalk(t.store, rootId, NOW);
    expect(
      await walkReplies(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
      ),
    ).toBe(false);
    expect(fetches(t, note.id)).toBe(1);
    expect(await removal(t, note.id)).toMatchObject({ ...KEPT, visibility: "public" });
    expect(await walkRow(t.store, rootId)).toMatchObject({ finished_at: NOW });
  });

  // The node is handed out unstored; its fetch is held while its delayed Create stores it, then answers 404 (or, the
  // control, the served document): judged on the row stored when the fetch completes.
  it.each([
    ["answering 404: removed", 404, REMOVING],
    ["answering its document: updated and kept", 200, { ...KEPT, visibility: "public" }],
  ] as const)(
    "judges a node stored after its hand-out by the row at completion, %s",
    async (_name, answer, expected) => {
      const { t, root, bob } = await world();
      const note = mastodonNote(root);
      const item = reply(t.web, bob, note.id);
      const rootId = await storedRoot(t, root, serveNote(t.web, withReplies(t.web, note, [])));
      serveNote(t.web, withReplies(t.web, note, [item.id]));
      if (answer === 404) {
        t.web.fail(item.id, 404);
      } else {
        editedServed(t, item, "edited");
      }
      expect(await statusRow(t.store, item.id)).toBeUndefined();
      await startWalk(t.store, rootId, NOW);
      const held = t.web.hold(item.id);
      const round = walkReplies(
        t.env,
        inboxDeps(() => t.store, t.web.loader),
      );
      await held.reached;
      expect(await t.post(bob, create(bob, item))).toBe(202);
      expect(await removal(t, item.id)).toMatchObject({ ...KEPT, visibility: "public" });
      held.release();
      await round;
      expect(await removal(t, item.id)).toMatchObject(expected);
      if (answer === 200) {
        expect((await statusRow(t.store, item.id))?.content).toBe("<p>edited</p>");
      }
    },
  );
});

describe("a create walk's stored items (D13)", () => {
  it("fetches a listed item Kopje stores and applies its newer version", async () => {
    const { t, bob } = await world();
    const note = mastodonNote(bob);
    // a arrives first (stored, waiting on its parent), then the note's Create links it and records the walk.
    const a = mastodonNote(bob, { inReplyTo: note.id });
    serveNote(t.web, withReplies(t.web, a, []));
    expect(await t.post(bob, create(bob, a))).toBe(202);
    serveNote(t.web, withReplies(t.web, note, [a.id]));
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const noteId = (await statusRow(t.store, note.id))!.id;
    expect(await statusRow(t.store, a.id)).toMatchObject({ in_reply_to_id: noteId });
    expect((await walkRow(t.store, noteId))?.nodes).toBe(2);
    editedServed(t, withReplies(t.web, a, []), "edited");
    await walkRounds(t);
    expect(fetches(t, a.id)).toBe(1);
    expect(await statusRow(t.store, a.id)).toMatchObject({ content: "<p>edited</p>", in_reply_to_id: noteId });
  });
});
