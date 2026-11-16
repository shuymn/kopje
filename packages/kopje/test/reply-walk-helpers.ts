import { expect } from "vitest";

import { walkReplies } from "../src/federation/replies";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { inboxDeps } from "./app-helpers";
import type { RemoteWeb, TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  AS,
  create,
  followed,
  mastodonNote,
  type Note,
  type Setup,
  statusRow,
} from "./inbox-status-helpers";

// Fixtures of the walks of replies collections (domain/reply-walks.ts, federation/replies.ts): Mastodon-shaped threads
// on the remote web (ActivityPub::NoteSerializer#replies and ActivityPub::RepliesController of v4.7.5), a walk started
// as the context's refresh starts one, and the job rounds run until none is due.

// A Note's replies as Mastodon serves them: the Note embeds the collection and its first page, which lists the
// author's own replies (self) and, given others, names the next page, the other accounts' replies, which the server
// serves at that address (an item the server holds as its own is embedded whole there, any other is its URI).
export function withReplies(web: RemoteWeb, note: Note, self: string[], others?: unknown[]): Note {
  const collection = `${note.id}/replies`;
  const first: Record<string, unknown> = { type: "CollectionPage", partOf: collection, items: self };
  if (others !== undefined) {
    const next = `${collection}?only_other_accounts=true&page=true`;
    web.serve(next, { "@context": AS, id: next, type: "CollectionPage", partOf: collection, items: others });
    first.next = next;
  }
  note.replies = { id: collection, type: "Collection", first };
  return note;
}

// A Note served at its id.
export function serveNote(web: RemoteWeb, note: Note): Note {
  web.serve(note.id, { "@context": AS, ...note });
  return note;
}

// A public reply by `actor` to `parent`, served (with an empty replies collection unless the caller sets one).
export function reply(web: RemoteWeb, actor: TestActor, parent: string, extra: Record<string, unknown> = {}): Note {
  const note = mastodonNote(actor, { inReplyTo: parent, ...extra });
  withReplies(web, note, []);
  return serveNote(web, note);
}

// The root `note` of `actor` stored, as a delivered Create stores it (alice follows the actor); returns its id.
export async function storedRoot(t: Setup, actor: TestActor, note: Note): Promise<string> {
  const known = await accountId(t.store, actor.uri);
  const follows =
    known === undefined
      ? []
      : await sql(t.store, "SELECT 1 FROM follows WHERE account_id = ? AND target_account_id = ?", ALICE, known);
  if (follows.length === 0) {
    await followed(t, actor);
  }
  expect(await t.post(actor, create(actor, note))).toBe(202);
  return (await statusRow(t.store, note.id))!.id;
}

let refreshes = 0;

// A context walk of the status, started as startRepliesRefresh starts one: a running row with a refresh id, queued and
// due at `now`, and its root node, valid, at the status stage, in place of a create walk its Create recorded.
export async function startWalk(store: StoreStub, statusId: string, now: number): Promise<string> {
  const uri = (await sql<{ uri: string }>(store, "SELECT uri FROM statuses WHERE id = ?", statusId))[0]!.uri;
  const id = (++refreshes).toString(16).padStart(32, "0");
  await sql(
    store,
    `INSERT INTO reply_walks (status_id, kind, refresh_id, queued_at, due_at, next_seq, nodes)
		VALUES (?1, 0, ?2, ?3, ?3, 1, 1)
		ON CONFLICT (status_id) DO UPDATE SET kind = 0, refresh_id = excluded.refresh_id, queued_at = ?3, due_at = ?3,
			finished_at = NULL, token = NULL, next_seq = 1, nodes = 1, pages = 0, result_count = 0, handouts = 0,
			handout = NULL`,
    statusId,
    id,
    now,
  );
  await sql(store, "DELETE FROM reply_walk_nodes WHERE status_id = ?", statusId);
  await sql(store, "INSERT INTO reply_walk_nodes (status_id, uri, seq, valid) VALUES (?, ?, 0, 1)", statusId, uri);
  return id;
}

export type WalkRow = {
  queued_at: number;
  due_at: number | null;
  finished_at: number | null;
  token: string | null;
  next_seq: number;
  nodes: number;
  pages: number;
  result_count: number;
  handouts: number;
  handout: number | null;
};

export async function walkRow(store: StoreStub, statusId: string): Promise<WalkRow | undefined> {
  return (
    await sql<WalkRow>(
      store,
      `SELECT queued_at, due_at, finished_at, token, next_seq, nodes, pages, result_count, handouts, handout
			FROM reply_walks WHERE status_id = ?`,
      statusId,
    )
  )[0];
}

export type NodeRow = {
  uri: string;
  seq: number;
  state: number;
  stage: number;
  valid: number;
  parent: string | null;
  fetch: string | null;
  skip: number;
  attempts: number;
};

export function walkNodes(store: StoreStub, statusId: string): Promise<NodeRow[]> {
  return sql<NodeRow>(
    store,
    `SELECT uri, seq, state, stage, valid, parent, fetch, skip, attempts FROM reply_walk_nodes WHERE status_id = ?
			ORDER BY seq`,
    statusId,
  );
}

// The replies family's rounds (federation/replies.ts) until none reports a walk due, at most `limit`.
export async function walkRounds(t: Setup, limit = 100, loader = t.web.loader): Promise<number> {
  const deps = inboxDeps(() => t.store, loader);
  for (let round = 1; round <= limit; round++) {
    if (!(await walkReplies(t.env, deps))) {
      return round;
    }
  }
  throw new Error(`walks still due after ${limit} rounds`);
}

// The URIs of the statuses a store holds, of those given.
export async function storedOf(store: StoreStub, uris: readonly string[]): Promise<string[]> {
  const rows = await sql<{ uri: string }>(
    store,
    "SELECT uri FROM statuses WHERE uri IN (SELECT value FROM json_each(?))",
    JSON.stringify(uris),
  );
  return uris.filter((uri) => rows.some((row) => row.uri === uri));
}
