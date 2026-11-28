import { describe, expect, it } from "vitest";

import { sql } from "./api-helpers";
import { mastodonActor, type TestActor } from "./inbox-helpers";
import { announce, AS, DAVE_URI, followed, mastodonNote, OTHER, type Setup, setup } from "./inbox-status-helpers";

// A store that leaves a move pending (accounts.move_pending) rings the jobs queue, so the collection sync that resolves
// it runs at once rather than at the next cron: the inbox's Move target and fetched author, and search resolution's
// account and status author (/authorize_interaction: test/interaction.test.ts). Each is beside a control whose stored
// actor names no destination, which rings nothing.

const DEST = `${OTHER}/users/dest`;

const rang = (t: Setup) =>
  t.queue.pending.some((message) => (message.body as { kind?: string }).kind === "inbound-jobs");

const pending = (t: Setup, uri: string) =>
  sql<{ pending: number }>(t.store, "SELECT move_pending AS pending FROM accounts WHERE uri = ?", uri).then(
    (rows) => rows[0]?.pending,
  );

// An actor whose document names DEST as its movedTo when `moved`, else none; DEST itself is never served.
async function actor(t: Setup, username: string, key: number, moved: boolean): Promise<TestActor> {
  const served = await mastodonActor(t.web, username, { key });
  if (moved) {
    t.web.serve(served.uri, { ...served.document, movedTo: DEST });
  }
  return served;
}

describe("the doorbell for a pending move", () => {
  it.each([
    ["rings for a pending account", true],
    ["rings for none otherwise", false],
  ])("search resolution of an account %s", async (_name, moved) => {
    const t = await setup();
    const carol = await actor(t, "carol", 2, moved);
    const found = await t.api<{ accounts: unknown[] }>(
      `/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(carol.uri)}`,
    );
    expect(found.body.accounts).toHaveLength(1);
    expect(await pending(t, carol.uri)).toBe(moved ? 1 : 0);
    expect(rang(t)).toBe(moved);
  });

  it.each([
    ["rings for a pending author", true],
    ["rings for none otherwise", false],
  ])("search resolution of a status %s", async (_name, moved) => {
    const t = await setup();
    const carol = await actor(t, "carol", 2, moved);
    const note = mastodonNote(carol);
    t.web.serve(note.id, { "@context": AS, ...note });
    const found = await t.api<{ statuses: unknown[] }>(
      `/api/v2/search?resolve=true&type=statuses&q=${encodeURIComponent(note.id)}`,
    );
    expect(found.body.statuses).toHaveLength(1);
    expect(await pending(t, carol.uri)).toBe(moved ? 1 : 0);
    expect(rang(t)).toBe(moved);
  });

  it.each([
    ["rings for a pending author", true],
    ["rings for none otherwise", false],
  ])("the inbox's fetched author %s", async (_name, moved) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const carol = await actor(t, "carol", 2, moved);
    const note = mastodonNote(carol);
    t.web.serve(note.id, { "@context": AS, ...note });
    t.queue.pending.length = 0;
    expect(await t.post(bob, announce(bob, note.id))).toBe(202);
    expect(await pending(t, carol.uri)).toBe(moved ? 1 : 0);
    expect(rang(t)).toBe(moved);
  });

  it.each([
    ["rings for a pending target", true],
    ["rings for none otherwise", false],
  ])("the inbox's Move target %s", async (_name, moved) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await t.post(bob, { "@context": AS, id: `${bob.uri}#follows/1`, type: "Follow", actor: bob.uri, object: DAVE_URI });
    const bob2 = await mastodonActor(t.web, "bob2", { key: 2 });
    t.web.serve(bob2.uri, { ...bob2.document, alsoKnownAs: [bob.uri], ...(moved ? { movedTo: DEST } : {}) });
    t.queue.pending.length = 0;
    const move = {
      "@context": AS,
      id: `${bob.uri}#moves/1`,
      type: "Move",
      actor: bob.uri,
      object: bob.uri,
      target: bob2.uri,
    };
    expect(await t.post(bob, move)).toBe(202);
    expect(await pending(t, bob2.uri)).toBe(moved ? 1 : 0);
    expect(rang(t)).toBe(moved);
  });
});
