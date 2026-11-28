import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { rowHeapSql } from "../src/db/columns";
import { Db } from "../src/db/sql";
import { ACCOUNT_COLUMN_MAP, createdDaySql } from "../src/domain/account-columns";
import type { Account } from "../src/domain/accounts";
import { actorPublished } from "../src/domain/actor-row";
import { adminAccountStream } from "../src/domain/admin-account-presenter";
import { sql } from "./api-helpers";
import { community, follow, getJson, remoteAccount, seedStatus } from "./status-helpers";
import { recordingSql } from "./status-row-fixtures";

// Account#created_at as REST::AccountSerializer shows it (Mastodon v4.7.5: `object.created_at.midnight.as_json`): the
// creation day's midnight UTC, the nested `moved` account's included (account-columns.ts createdDaySql). A stored value
// that is not a stored time as a whole is shown as it is read: as stored for an account, cut at
// MOVED_CREATED_AT_LIMIT for a moved-to account.

const EXACT = "2026-10-12T13:14:15.678Z";
const MIDNIGHT = "2026-10-12T00:00:00.000Z";

type Notification = { type: string; account: Account };
type Status = { id: string; account: Account };

async function fixture() {
  const h = await community(["alice", "bob"]);
  const { alice, bob } = h.users;
  const carol = await remoteAccount(h.store, "carol");
  const created = (id: string, value: string) =>
    sql(h.store, "UPDATE accounts SET created_at = ? WHERE id = ?", value, id);
  const move = (source: string, target: string) =>
    sql(h.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", target, source);
  const shown = async (id: string) => {
    const { status, body } = await getJson<Account>(h, `/api/v1/accounts/${id}`, bob.token);
    expect(status).toBe(200);
    return body;
  };
  return { h, alice, bob, carol, created, move, shown };
}

describe("an account's created_at", () => {
  it("is the creation day's midnight wherever an Account is presented, local and remote", async () => {
    const { h, alice, bob, carol, created, move, shown } = await fixture();
    for (const id of [alice.id, bob.id, carol]) {
      await created(id, EXACT);
    }
    // bob follows alice (a follow notification from bob); carol mentions alice (a mention notification from carol).
    await follow(h, bob, alice.id);
    const mention = await seedStatus(h.store, {
      accountId: carol,
      visibility: "public",
      mentions: [{ accountId: alice.id }],
    });
    await sql(
      h.store,
      "INSERT INTO notifications (account_id, type, from_account_id, status_id) VALUES (?, 'mention', ?, ?)",
      alice.id,
      carol,
      mention,
    );
    const own = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    // Two accounts that moved: to the local alice and to the remote carol.
    const [toAlice, toCarol] = [await remoteAccount(h.store, "dave"), await remoteAccount(h.store, "erin")];
    await move(toAlice, alice.id);
    await move(toCarol, carol);

    expect([(await shown(alice.id)).created_at, (await shown(carol)).created_at]).toEqual([MIDNIGHT, MIDNIGHT]);
    const credential = await getJson<Account>(h, "/api/v1/accounts/verify_credentials", alice.token);
    expect(credential.body.created_at).toBe(MIDNIGHT);
    for (const id of [own, mention]) {
      const status = await getJson<Status>(h, `/api/v1/statuses/${id}`, bob.token);
      expect(status.body.account.created_at, id).toBe(MIDNIGHT);
    }
    const notifications = await getJson<Notification[]>(h, "/api/v1/notifications", alice.token);
    expect(
      notifications.body
        .map((n) => [n.type, n.account.id, n.account.created_at])
        .toSorted(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual([
      ["follow", bob.id, MIDNIGHT],
      ["mention", carol, MIDNIGHT],
    ]);
    expect([(await shown(toAlice)).moved?.created_at, (await shown(toCarol)).moved?.created_at]).toEqual([
      MIDNIGHT,
      MIDNIGHT,
    ]);
  });

  it("is midnight for the earliest and latest moment of a day", async () => {
    const { carol, created, shown } = await fixture();
    for (const [stored, day] of [
      ["0099-01-01T23:59:59.999Z", "0099-01-01T00:00:00.000Z"],
      ["2026-10-12T00:00:00.000Z", MIDNIGHT],
    ] as const) {
      await created(carol, stored);
      expect((await shown(carol)).created_at, stored).toBe(day);
    }
  });

  // The actor (actor-row.ts actorPublished) judges in the Worker what createdDaySql judges in SQL, so the actor and
  // the Account agree on every stored value: its day for a stored time, else the value as stored.
  it("is judged alike for the actor and the Account", async () => {
    const { h } = await fixture();
    const values = [
      EXACT,
      MIDNIGHT,
      "0099-01-01T23:59:59.999Z",
      "0000-01-01T00:00:00.000Z",
      "2026-10-12T00:15:00+01:00",
      "2026-10-12 13:14:15",
      `${EXACT}junk`,
      "2026-10-12T13:14:15Z",
      "2026-10-12T24:00:00.000Z",
      "2026-10-12T99:14:15.678Z",
      "2026-02-30T13:14:15.678Z",
      "2026-10-12T13:14:60.000Z",
      "-000001-12-31T23:15:00.000Z",
      "２026-10-12T13:14:15.678Z",
      "",
    ];
    const days = await runInDurableObject(h.store, (_instance, state) =>
      values.map(
        (value) =>
          state.storage.sql
            .exec<{ day: string | null }>(`SELECT ${createdDaySql("v.c")} AS day FROM (SELECT ?1 AS c) v`, value)
            .one().day,
      ),
    );
    expect(days.filter((day) => day !== null)).toHaveLength(4);
    expect(values.map((value) => actorPublished(value))).toEqual(
      values.map((value, i) => (days[i] === null ? value : `${days[i]}T00:00:00Z`)),
    );
  });

  // engineering.md, "Stored values": the value is judged as stored, before the moved-to account's cut.
  it.each([
    ["a time in another form", "2026-10-12 13:14:15", "2026-10-12 13:14:15"],
    ["a stored time with a suffix", `${EXACT}junk`, EXACT],
  ])("shows %s as it does today, as stored and as cut for a moved-to account", async (_name, stored, cut) => {
    const { h, carol, created, move, shown } = await fixture();
    await created(carol, stored);
    const source = await remoteAccount(h.store, "dave");
    await move(source, carol);
    expect((await shown(carol)).created_at).toBe(stored);
    expect((await shown(source)).moved?.created_at).toBe(cut);
  });
});

// RES-3: SQLite's OP_Column with OPFLAG_BYTELENARG (0xc0 in p5) answers octet_length from the record header without
// loading the value; a read without it loads the whole value, however long an import stored it. The row heap estimate
// (rowHeapSql, R in status-rows.ts) measures created_at without loading it, and the admin entity's exact time loads it
// only once its bytes are a stored time's.
describe("an account's created_at, measured", () => {
  const BYTELENARG = 0xc0;
  type Op = { addr: number; opcode: string; p1: number; p2: number; p5: number };
  // The accounts table's reads of created_at in `query`'s program, in order.
  const createdAtReads = (storage: SqlStorage, query: string, ...params: SqlStorageValue[]) => {
    const [{ rootpage }] = storage
      .exec<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .toArray() as [{ rootpage: number }];
    const column = storage.exec("SELECT * FROM accounts LIMIT 0").columnNames.indexOf("created_at");
    const program = storage.exec<Op>(`EXPLAIN ${query}`, ...params).toArray();
    const cursors = new Set(program.filter((op) => op.opcode === "OpenRead" && op.p2 === rootpage).map((op) => op.p1));
    return program.filter((op) => op.opcode === "Column" && cursors.has(op.p1) && op.p2 === column);
  };

  it("estimates the row's heap from the record header", async () => {
    const { h } = await fixture();
    await runInDurableObject(h.store, (_instance, state) => {
      const reads = createdAtReads(
        state.storage.sql,
        `SELECT ${rowHeapSql({ created_at: ACCOUNT_COLUMN_MAP.created_at })} AS heap FROM accounts a WHERE a.id = ?`,
        "1",
      );
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.p5 & BYTELENARG, String(read.addr)).toBe(BYTELENARG);
      }
    });
  });

  it("reads the admin entity's exact time only after its bytes", async () => {
    const { h, carol, created } = await fixture();
    await created(carol, EXACT);
    await runInDurableObject(h.store, (_instance, state) => {
      const recording = recordingSql(state.storage.sql);
      const [entity] = [...adminAccountStream(new Db(recording.sql), [carol], carol, { origin: "https://kopje.test" })];
      expect(entity?.created_at).toBe(EXACT);
      const query = recording.reads.find((read) => read.includes("exact_created_at"))!;
      const reads = createdAtReads(state.storage.sql, query, JSON.stringify([carol]));
      expect(reads.length).toBeGreaterThan(1);
      expect(reads[0]!.p5 & BYTELENARG).toBe(BYTELENARG);
    });
  });
});
