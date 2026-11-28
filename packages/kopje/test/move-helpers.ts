import { expect } from "vitest";

import { SYNC_RETRY_MS } from "../src/domain/remote-collections";
import { syncCollections } from "../src/federation/collections";
import { sql } from "./api-helpers";
import { inboxDeps, NOW } from "./app-helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { accountId, AS, followed, OTHER, type Setup } from "./inbox-status-helpers";
import type { QueueSim } from "./queue-sim";

// The fixtures of the moved-account suites (#1561): test/collection-move.test.ts, test/collection-move-fetch.test.ts,
// test/move-doorbells.test.ts, test/forward-delete.test.ts and test/account-moved.test.ts.

// The destination a pending Bob's document names, on another server.
export const DEST = `${OTHER}/users/dest`;

export type MoveState = { moved: string | null; pending: number; revision: number };

export function moveState(t: Setup, uri: string): Promise<MoveState | undefined> {
  return sql<MoveState>(
    t.store,
    `SELECT (SELECT m.uri FROM accounts m WHERE m.id = a.moved_to_account_id) AS moved, a.move_pending AS pending,
			a.document_revision AS revision
		FROM accounts a WHERE a.uri = ?`,
    uri,
  ).then((rows) => rows[0]);
}

// Bob, stored (followed by alice, who signs his collections) with a document whose movedTo names DEST; and the
// destination served. Bob's collections answer 404, so his other parts read through at once.
export async function pendingBob(
  t: Setup,
  options: { movedTo?: string; extra?: Record<string, unknown> } = {},
): Promise<{ bob: TestActor; bobId: string; dest: TestActor }> {
  const dest = await mastodonActor(t.web, "dest", { origin: OTHER, key: 3 });
  const bob = await mastodonActor(t.web, "bob");
  t.web.serve(bob.uri, { ...bob.document, movedTo: options.movedTo ?? DEST, ...options.extra });
  const bobId = await followed(t, bob);
  expect(await moveState(t, bob.uri)).toMatchObject({ moved: null, pending: 1 });
  expect(await accountId(t.store, DEST)).toBeUndefined();
  return { bob, bobId, dest };
}

// Every sync due run, the clock moved past each backoff, until none is left (at most `calls` calls).
export async function syncUntilDone(t: Setup, calls = 10): Promise<void> {
  let now = NOW;
  for (let call = 0; call < calls; call++) {
    await syncCollections(t.env, { ...inboxDeps(() => t.store, t.web.loader), now: () => now });
    if ((await sql(t.store, "SELECT 1 FROM collection_syncs")).length === 0) {
      return;
    }
    now += SYNC_RETRY_MS;
  }
}

// `source`'s Move to `target`, as Mastodon's ActivityPub::MoveSerializer writes it.
export function moveActivity(source: TestActor, target: string): Record<string, unknown> {
  return { "@context": AS, id: `${source.uri}#moves/1`, type: "Move", actor: source.uri, object: source.uri, target };
}

// A fresh document of `actor` stored through its Update.
export async function updated(t: Setup, actor: TestActor, document: Record<string, unknown>, n: number): Promise<void> {
  t.web.serve(actor.uri, document);
  const update = {
    "@context": AS,
    id: `${actor.uri}#updates/${n}`,
    type: "Update",
    actor: actor.uri,
    object: document,
  };
  expect(await t.post(actor, update)).toBe(202);
}

// Whether the Worker asked the Queue for a jobs round.
export const jobsRung = (queue: QueueSim) =>
  queue.pending.some((message) => (message.body as { kind?: string }).kind === "inbound-jobs");
