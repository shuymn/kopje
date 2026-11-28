import { expect } from "vitest";

import type { TestActor } from "./inbox-helpers";
import { AS, type Setup } from "./inbox-status-helpers";
import type { QueueSim } from "./queue-sim";

// The fixtures of the moved-account suites (#1561): test/collection-move.test.ts, test/collection-move-fetch.test.ts,
// test/move-doorbells.test.ts and test/forward-delete.test.ts.

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
