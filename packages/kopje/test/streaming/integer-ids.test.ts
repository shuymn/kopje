import { describe, expect, it } from "vitest";

import { sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { community, follow, post } from "../status-helpers";
import { drained, notifications, subscribed } from "./stream-helpers";

// DATA-6 on the streaming journal: its ids, the fan-out's position, a conversation event's ceiling and the sockets'
// change sequences past 2^53 stay exact. The journal and the position are not dumped (dump-catalog.ts); a restored
// conversation's stream_seq is, and the owner's mark is made from it. Each case seeds them at 2^53 by SQL, so what
// follows is 2^53 + 1, 2^53 + 2, ...: read as a number, 2^53 + 1 is 2^53 (not after the socket's start, nor after the
// position) and 2^53 + 3 is 2^53 + 4.

const TWO_53 = "9007199254740992";
const big = (offset: number) => String(9007199254740992n + BigInt(offset));

describe("the journal past 2^53", () => {
  it("sends every event and conversation change after ids just above 2^53, neither stalling nor skipping", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, alice, bob.id);
    // The journal's head and the position at 2^53, and alice's conversation mark at 2^53.
    await sql(h.store, "DELETE FROM stream_events");
    await sql(
      h.store,
      "INSERT INTO stream_events (id, kind, subject, created_at) VALUES (CAST(? AS INTEGER), 'merged', ?, ?)",
      TWO_53,
      bob.id,
      new Date(NOW).toISOString(),
    );
    await sql(
      h.store,
      "UPDATE stream_cursor SET event_id = CAST(? AS INTEGER), subject = 0, account_id = NULL",
      TWO_53,
    );
    await sql(
      h.store,
      "INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, CAST(? AS INTEGER))",
      alice.id,
      TWO_53,
    );
    const inbox = await subscribed(h, alice.token, "user", "direct");

    const shown = await post(h, bob, { status: "@alice one", visibility: "public" });
    const first = await post(h, bob, { status: "@alice two", visibility: "direct" });
    const second = await post(h, bob, { status: "@alice three", visibility: "direct" });
    const deleted = await h.request(`/api/v1/statuses/${shown.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(deleted.status).toBe(200);
    await drained(h, inbox);

    const sent = inbox.rest();
    expect(notifications(sent, "user").map((n) => n.type)).toEqual(["mention", "mention", "mention"]);
    expect(sent.filter((m) => m.event === "update").map((m) => (JSON.parse(m.payload!) as { id: string }).id)).toEqual([
      shown.id,
      first.id,
      second.id,
    ]);
    const changes = sent
      .filter((m) => m.event === "conversation")
      .map((m) => (JSON.parse(m.payload!) as { last_status: { id: string } }).last_status.id);
    expect(changes.toSorted()).toEqual([first.id, second.id].toSorted());
    expect(sent.filter((m) => m.event === "delete").map((m) => m.payload)).toEqual([shown.id]);
    // The position is at the head, exactly, past 2^53; the conversation changes took 2^53 + 1 and 2^53 + 2.
    const [cursor] = await sql<{ position: string; account_id: string | null; head: string; mark: string }>(
      h.store,
      `SELECT CAST(c.event_id AS TEXT) AS position, c.account_id,
					(SELECT CAST(max(id) AS TEXT) FROM stream_events) AS head,
					(SELECT CAST(seq AS TEXT) FROM stream_conversation_marks WHERE account_id = ?) AS mark
				FROM stream_cursor c`,
      alice.id,
    );
    expect(cursor).toEqual({ position: cursor!.head, account_id: null, head: cursor!.head, mark: big(2) });
    expect(BigInt(cursor!.head)).toBeGreaterThan(BigInt(TWO_53));
  });
});
