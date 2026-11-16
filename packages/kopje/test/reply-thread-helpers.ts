import { runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";

import { REPLIES_COOLDOWN_MS } from "../src/domain/reply-walk-reads";
import { claimReplyWalk, completeReplyStep, type ReplyStepInput } from "../src/domain/reply-walks";
import { walkReplies } from "../src/federation/replies";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { countingStore, inboxDeps } from "./app-helpers";
import { mastodonActor, type RemoteWeb, type TestActor } from "./inbox-helpers";
import {
  accountId,
  ALICE,
  AS,
  DAVE,
  followed,
  mastodonNote,
  type Note,
  type Setup,
  setup,
} from "./inbox-status-helpers";
import { serveNote, startWalk, storedRoot, walkRounds } from "./reply-walk-helpers";

// Threads for the scans and debts of the walks of replies collections (#1607 D12; domain/reply-walk-debts.ts): statuses
// served with the collection a fixture gives each, stored replies written straight to the Store (as a delivery would
// have stored them, linked under their stored parents), and walks of a root run one after another past its cooldown.

export const OTHER_ORIGIN = "https://other.example";

// The root author on mastodon.example; bob on other.example, followed by dave, so that no step needs him.
export async function threadWorld() {
  const t = await setup();
  const root = await mastodonActor(t.web, "root");
  const bob = await mastodonActor(t.web, "bob", { origin: OTHER_ORIGIN, key: 1 });
  await followed(t, bob, DAVE);
  return { t, root, bob };
}

// How a status serves its replies collection: its first page embedded (Mastodon's shape), named by URI in the embedded
// collection (first), the collection itself named by URI (collection), every page embedded in the one before (chain),
// none (absent), or a URI that answers 404 (failed). Items go `page` to a page (all in one by default).
export type Shape = "embedded" | "first" | "collection" | "chain" | "absent" | "failed";
export type Listing = { items?: readonly unknown[]; page?: number; shape?: Shape };

export const pageUri = (note: Note, k: number) => `${note.id}/replies?page=${k}`;

// `note` served with the collection `listing` gives it; returns it.
export function served(web: RemoteWeb, note: Note, listing: Listing = {}): Note {
  const items = listing.items ?? [];
  const size = Math.max(listing.page ?? items.length, 1);
  const pages: unknown[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  if (pages.length === 0) {
    pages.push([]);
  }
  const collection = `${note.id}/replies`;
  const page = (k: number): Record<string, unknown> => ({
    type: "CollectionPage",
    partOf: collection,
    items: pages[k - 1],
    ...(k < pages.length ? { next: listing.shape === "chain" ? page(k + 1) : pageUri(note, k + 1) } : {}),
  });
  const shape = listing.shape ?? "embedded";
  if (shape !== "chain") {
    for (let k = 2; k <= pages.length; k++) {
      web.serve(pageUri(note, k), { "@context": AS, id: pageUri(note, k), ...page(k) });
    }
  }
  const replies =
    shape === "absent"
      ? undefined
      : shape === "failed"
        ? `${collection}/gone`
        : shape === "collection"
          ? collection
          : shape === "first"
            ? { id: collection, type: "Collection", first: pageUri(note, 1) }
            : { id: collection, type: "Collection", first: page(1) };
  if (shape === "first") {
    web.serve(pageUri(note, 1), { "@context": AS, id: pageUri(note, 1), ...page(1) });
  }
  if (shape === "collection") {
    web.serve(collection, { "@context": AS, id: collection, type: "Collection", first: page(1) });
  }
  const { replies: _, ...rest } = note;
  const out = (replies === undefined ? rest : { ...rest, replies }) as Note;
  serveNote(web, out);
  return out;
}

// A public reply of `actor` to `parent`, not stored, served with `listing`.
export function servedReply(web: RemoteWeb, actor: TestActor, parent: string, listing: Listing = {}): Note {
  return served(web, mastodonNote(actor, { inReplyTo: parent }), listing);
}

// Ids for the statuses a fixture stores, 18 digits from 1…, below every id the Store draws in this decade; `at` places
// one among them (a lower `at` scans first).
let nextStored = 0;
export const storedId = (at = ++nextStored) => `1${String(at).padStart(17, "0")}`;

export type StoredReply = {
  note: Note;
  parentId: string;
  id?: string;
  // The author's account id (bob's by default; a local account's for a local reply).
  account?: string;
  published?: string;
  visibility?: string;
};

// Replies stored as a delivery stores them: linked under their stored parents, public unless given, published as
// their notes say. Returns their ids, in order.
export async function storeReplies(t: Setup, author: TestActor, rows: readonly StoredReply[]): Promise<string[]> {
  const bob = (await accountId(t.store, author.uri))!;
  const parents = await sql<{ id: string; uri: string; account_id: string }>(
    t.store,
    "SELECT id, uri, account_id FROM statuses WHERE id IN (SELECT value FROM json_each(?))",
    JSON.stringify([...new Set(rows.map((row) => row.parentId))]),
  );
  const values = rows.map((row) => {
    const parent = parents.find((p) => p.id === row.parentId);
    if (parent === undefined) {
      // A parent stored by this call, earlier in `rows`.
      const earlier = rows.find((r) => r.id === row.parentId);
      expect(earlier, "a stored reply's parent").toBeDefined();
    }
    return {
      id: row.id ?? storedId(),
      uri: row.note.id,
      account: row.account ?? bob,
      content: row.note.content,
      // As the Store keeps a time (milliseconds, Z).
      published: new Date(row.published ?? (row.note.published as string)).toISOString(),
      parent: row.parentId,
      parentUri: parent?.uri ?? rows.find((r) => r.id === row.parentId)!.note.id,
      parentAccount: parent?.account_id ?? bob,
      visibility: row.visibility ?? "public",
    };
  });
  await sql(
    t.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, in_reply_to_id, in_reply_to_uri,
			in_reply_to_account_id, remote_version)
		SELECT value ->> 'id', value ->> 'uri', value ->> 'account', value ->> 'visibility', value ->> 'content',
			value ->> 'published', value ->> 'parent', value ->> 'parentUri', value ->> 'parentAccount', value ->> 'published'
		FROM json_each(?) ORDER BY key`,
    JSON.stringify(values),
  );
  return values.map((value) => value.id);
}

// `count` stored public replies of bob to the status `parentId` (whose URI is `parentUri`), each served with an empty
// collection, with ids from `at` on (storedId) when given.
export async function storedReplies(
  t: Setup,
  bob: TestActor,
  parentId: string,
  parentUri: string,
  count: number,
  options: { at?: number; listing?: (i: number) => Listing; serve?: boolean } = {},
): Promise<{ notes: Note[]; ids: string[] }> {
  const notes = Array.from({ length: count }, (_, i) =>
    options.serve === false
      ? mastodonNote(bob, { inReplyTo: parentUri })
      : servedReply(t.web, bob, parentUri, options.listing?.(i) ?? {}),
  );
  const ids = await storeReplies(
    t,
    bob,
    notes.map((note, i) => ({
      note,
      parentId,
      ...(options.at === undefined ? {} : { id: storedId(options.at + i) }),
    })),
  );
  return { notes, ids };
}

// Replies of the account to the status, public, stored with ids at `at`, `at + step`, … and URIs under `prefix`:
// alice's (local, the default) a scan passes; a remote account's it admits or owes (none served).
export async function bulkReplies(
  t: Setup,
  parentId: string,
  parentUri: string,
  count: number,
  at: number,
  options: { step?: number; account?: string; prefix?: string } = {},
) {
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, in_reply_to_id, in_reply_to_uri)
		SELECT printf('1%017d', ?2 + i * ?3), ?7 || (?2 + i * ?3), ?4, 'public', '<p>l</p>',
			'2026-10-11T12:00:00.000Z', ?5, ?6 FROM n`,
    count,
    at,
    options.step ?? 1,
    options.account ?? ALICE,
    parentId,
    parentUri,
    options.prefix ?? "https://kopje.test/ap/o/local-",
  );
}

// Local replies of alice to the status, stored with ids at `at`, `at + step`, …: a scan passes them.
export function localReplies(t: Setup, parentId: string, parentUri: string, count: number, at: number, step = 1) {
  return bulkReplies(t, parentId, parentUri, count, at, { step });
}

// The root `note` of `root`, served with `listing` and stored by its delivered Create; returns its id.
export async function threadRoot(t: Setup, root: TestActor, note: Note, listing: Listing = {}): Promise<string> {
  return storedRoot(t, root, served(t.web, note, listing));
}

// One context walk of the status, started past the cooldown of its last (the clock moved), run to its end: the URIs
// of `watched` it fetched, in order, each as often as fetched.
export async function walkOnce(
  t: Setup,
  rootId: string,
  watched?: ReadonlySet<string>,
  loader = t.web.loader,
): Promise<string[]> {
  vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
  const before = t.web.fetched.length;
  await startWalk(t.store, rootId, Date.now());
  await walkRounds(t, 2000, loader);
  const fetched = t.web.fetched.slice(before);
  return watched === undefined ? fetched : fetched.filter((url) => watched.has(url));
}

export type DebtRow = {
  status: string;
  kind: number;
  page: string | null;
  offset: number;
  depth: number;
  key: [number, number, number];
};

// The debts of the root, in key order, by their statuses' URIs.
export async function debtsOf(store: StoreStub, rootId: string): Promise<DebtRow[]> {
  const rows = await sql<{
    uri: string;
    kind: number;
    page: string | null;
    page_offset: number;
    depth: number;
    owed_walk: number;
    owed_seq: number;
    owed_pos: number;
  }>(
    store,
    `SELECT s.uri, d.kind, d.page, d.page_offset, d.depth, d.owed_walk, d.owed_seq, d.owed_pos
			FROM reply_walk_debts d JOIN statuses s ON s.id = d.status_id WHERE d.root_id = ?
			ORDER BY d.owed_walk, d.owed_seq, d.owed_pos`,
    rootId,
  );
  return rows.map((row) => ({
    status: row.uri,
    kind: row.kind,
    page: row.page,
    offset: row.page_offset,
    depth: row.depth,
    key: [row.owed_walk, row.owed_seq, row.owed_pos],
  }));
}

// The cursor of the status's scans, or null.
export async function cursorOf(store: StoreStub, statusId: string): Promise<string | null> {
  const rows = await sql<{ after_id: string }>(
    store,
    "SELECT after_id FROM reply_walk_cursors WHERE status_id = ?",
    statusId,
  );
  return rows[0]?.after_id ?? null;
}

// A debt of the root, written as a walk owes one (kind 0, a row debt, unless given; its key's walk 1).
export async function owedDebt(
  store: StoreStub,
  rootId: string,
  statusId: string,
  debt: { kind?: number; page?: string | null; offset?: number; depth: number; key: [number, number, number] },
): Promise<void> {
  await sql(
    store,
    `INSERT INTO reply_walk_debts (root_id, status_id, kind, page, page_offset, owed_walk, owed_seq, owed_pos, depth)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rootId,
    statusId,
    debt.kind ?? 0,
    debt.page ?? null,
    debt.offset ?? 0,
    ...debt.key,
    debt.depth,
  );
}

// One context walk of the status as walkOnce runs it, over a Store that records each step's first completion: the
// steps in order, a fetch by its node's URI and stage, a Store-only step as 'store'.
export async function walkSteps(t: Setup, rootId: string): Promise<{ uri: string; stage: string }[]> {
  vi.setSystemTime(Date.now() + REPLIES_COOLDOWN_MS + 1);
  await startWalk(t.store, rootId, Date.now());
  const counting = countingStore(t.store);
  const deps = inboxDeps(() => counting.stub, t.web.loader);
  for (let round = 0; await walkReplies(t.env, deps); round++) {
    expect(round).toBeLessThan(2000);
  }
  return counting.records
    .filter((record) => record.name === "completeReplyStep")
    .map((record) => record.args[1] as ReplyStepInput)
    .filter((input) => input.author === undefined)
    .map(({ step }) => (step.stage === "store" ? { uri: "", stage: "store" } : { uri: step.uri, stage: step.stage }));
}

// One call of the walk's Store operations, measured in its transaction: the rows it changed (total_changes(), triggers
// and cascades included), those of reply_walk_debts, and the debts it inserted. stage: the completed step's (null for
// a claim); retried: a completion sent again with the author its first answer needed (the same step).
export type MeasuredCall = {
  name: "claim" | "complete";
  stage: string | null;
  retried: boolean;
  changes: number;
  debts: number;
  owed: number;
};

// A Store whose claims and completions run measured (MeasuredCall), in the order the rounds make them.
export function measuringStore(t: Setup): { stub: StoreStub; calls: MeasuredCall[] } {
  const calls: MeasuredCall[] = [];
  const measured = <I, O>(
    operation: { run: (sql: SqlStorage, input: I, savepoint: <T>(fn: () => T) => T) => O },
    name: MeasuredCall["name"],
    stage: string | null,
    input: I,
    retried = false,
  ) =>
    runInDurableObject(t.store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const real = state.storage.sql;
        const changes = () => real.exec<{ n: number }>("SELECT total_changes() AS n").one().n;
        const call = { name, stage, retried, changes: 0, debts: 0, owed: 0 };
        const counted = {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            if (!/^\s*(INSERT INTO|DELETE FROM|UPDATE) reply_walk_debts\b/.test(query)) {
              return real.exec(query, ...params);
            }
            const before = changes();
            const cursor = real.exec(query, ...params);
            const changed = changes() - before;
            call.debts += changed;
            call.owed += /^\s*INSERT/.test(query) ? changed : 0;
            return cursor;
          },
        } as unknown as SqlStorage;
        const before = changes();
        const result = operation.run(counted, input, (fn) => state.storage.transactionSync(fn));
        call.changes = changes() - before;
        calls.push(call);
        return result;
      }),
    );
  const stub = new Proxy(t.store, {
    get: (target, name) => {
      if (name === "claimReplyWalk") {
        return () => measured(claimReplyWalk, "claim", null, { now: Date.now() });
      }
      if (name === "completeReplyStep") {
        return (_build: string, input: ReplyStepInput) =>
          measured(
            completeReplyStep,
            "complete",
            input.step.stage,
            { ...input, now: Date.now() },
            input.author !== undefined,
          );
      }
      return Reflect.get(target, name) as unknown;
    },
  });
  return { stub, calls };
}
