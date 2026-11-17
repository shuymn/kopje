import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { Db } from "../src/db/sql";
import { REACH_INBOX_BYTES, reachFollowerInboxes, recipientsFor } from "../src/domain/audience";
import { COLLECTION_REACH_INBOX_BYTES } from "../src/domain/collection-jobs";
import {
  beginRetraction,
  type DeliveryEnvelope,
  enqueueActivity,
  PROVENANCE_MAX,
  STAGE_MIN_ROWS,
  stageRetraction,
} from "../src/domain/deliveries";
import { deliveryRound } from "../src/jobs/deliver";
import { endPolls } from "../src/jobs/scheduled";
import type { StoreStub } from "../src/platform/store-client";
import { bearer, settleDeliveries, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { LEGACY } from "./federation-helpers";
import { BUILD, drainDeliveries } from "./helpers";
import { mastodonActor } from "./inbox-helpers";
import { localStatus, setup } from "./inbox-status-helpers";
import { deliveryDeps } from "./quote-helpers";
import { community, post, type User } from "./status-helpers";

// #1733: a follower's or voter's inbox (its shared inbox, else its personal one) is judged in SQL before it is read
// (audience.ts reachInboxSql): TEXT of 1 to REACH_INBOX_BYTES UTF-8 bytes without NUL, the rule collection reach
// stages by (CHECK collection_reach_inbox), else none (RES-2, NET-2). Accounts' inbox columns have no stored bound, so
// the values outside it are an import's or an older release's, set here in SQL. The recipients behind each inbox keep
// their provenance (VIS-30): the first PROVENANCE_MAX + 1 by id and the first of each of PROVENANCE_MAX + 1 hosts.

// A deliverable https inbox of exactly `bytes` UTF-8 bytes on `host`.
function sized(host: string, bytes: number): string {
  const head = `https://${host}/`;
  return head + "a".repeat(bytes - head.length);
}

const sorted = (ids: readonly string[]) => JSON.stringify([...ids].toSorted());

// Remote accounts, each `id` on `host` with its personal inbox there and the shared inbox `shared` (null: none).
async function remotes(
  store: StoreStub,
  accounts: readonly { id: string; host: string; shared: string | null }[],
): Promise<void> {
  await sql(
    store,
    `INSERT INTO accounts (id, uri, username, domain, inbox_url, shared_inbox_url)
		SELECT j.value ->> 'id', 'https://' || (j.value ->> 'host') || '/users/u' || (j.value ->> 'id'),
			'u' || (j.value ->> 'id'), j.value ->> 'host',
			'https://' || (j.value ->> 'host') || '/users/u' || (j.value ->> 'id') || '/inbox', j.value ->> 'shared'
		FROM json_each(?) j`,
    JSON.stringify(accounts),
  );
}

async function follow(store: StoreStub, target: string, ids: readonly string[]): Promise<void> {
  await sql(
    store,
    `INSERT INTO follows (account_id, target_account_id, state, created_at)
		SELECT value, ?2, 'accepted', ?3 FROM json_each(?1)`,
    JSON.stringify(ids),
    target,
    new Date(NOW).toISOString(),
  );
}

// `count` accounts with ids from `base`, on `hosts(i)`, sharing the inbox `shared`.
function group(base: bigint, count: number, shared: string, hosts: (i: number) => string) {
  return Array.from({ length: count }, (_, i) => ({ id: String(base + BigInt(i)), host: hosts(i), shared }));
}

// Inboxes outside the rule, each set in SQL as an import leaves it (`set`, over `params`), on an account of its own
// host: a value past REACH_INBOX_BYTES (its personal inbox a deliverable one, which must not be taken instead), malformed
// UTF-8 past it, NUL inside and at the end, a BLOB, empty and missing inboxes, and a BLOB personal inbox. (A number
// stored in these TEXT columns is read back as TEXT, so no other type can arrive.)
const FF = (n: number) => new Uint8Array(n).fill(0xff).buffer;
const OUTSIDE: readonly { name: string; set: string; params: SqlStorageValue[] }[] = [
  {
    name: "past the bound",
    set: "shared_inbox_url = ?, inbox_url = ?",
    params: [sized("over.example", REACH_INBOX_BYTES + 1), "https://over.example/users/o/inbox"],
  },
  {
    name: "malformed, past the bound",
    set: "shared_inbox_url = ? || CAST(? AS TEXT)",
    params: ["https://mal.example/", FF(REACH_INBOX_BYTES + 1 - "https://mal.example/".length)],
  },
  { name: "a NUL inside", set: "shared_inbox_url = ? || char(0) || 'box'", params: ["https://nul.example/in"] },
  { name: "a NUL at the end", set: "shared_inbox_url = ? || char(0)", params: ["https://end.example/inbox"] },
  { name: "a BLOB", set: "shared_inbox_url = CAST(? AS BLOB)", params: ["https://blob.example/inbox"] },
  { name: "empty", set: "shared_inbox_url = '', inbox_url = ''", params: [] },
  { name: "none", set: "shared_inbox_url = NULL, inbox_url = NULL", params: [] },
  {
    name: "a BLOB personal inbox",
    set: "shared_inbox_url = NULL, inbox_url = CAST(? AS BLOB)",
    params: ["https://pblob.example/inbox"],
  },
];

// The accounts of OUTSIDE from `base`, each on its own host, their inboxes set.
async function outside(store: StoreStub, base: bigint): Promise<string[]> {
  const ids = OUTSIDE.map((_, i) => String(base + BigInt(i)));
  await remotes(
    store,
    ids.map((id, i) => ({ id, host: `x${i}.example`, shared: null })),
  );
  for (const [i, { set, params }] of OUTSIDE.entries()) {
    await sql(store, `UPDATE accounts SET ${set} WHERE id = ?`, ...params, ids[i]!);
  }
  return ids;
}

type Row = { inbox: string; type: string; accounts: string | null; domains: string | null; many: number | null };

function rows(store: StoreStub): Promise<Row[]> {
  return sql<Row>(
    store,
    `SELECT d.inbox_url AS inbox, json_extract(o.body, '$.activity.type') AS type, d.recipient_accounts AS accounts,
			d.recipient_domains AS domains, d.recipients_many AS many
		FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id ORDER BY d.id`,
  );
}

const hostsOf = (n: number, prefix: string) => Array.from({ length: n }, (_, k) => `${prefix}${k}.example`);

// alice's followers: four inboxes at the bound, of 16 accounts on one host, 17 on one host, 34 on 17 hosts (two each,
// in host order, so the hosts after the first 17 ids are found by the host arm alone) and 35 on 16 hosts; a follower
// whose shared inbox is empty, reached at its personal inbox; and one of each OUTSIDE. Her poll's voters: one of the
// 16 (a follower too), one voting twice at an inbox of its own at the bound, and two outside the rule.
async function world() {
  const h = await community(["alice"]);
  const { alice } = h.users;
  const at = (tag: string) => sized(`${tag}.example`, REACH_INBOX_BYTES);
  const g16 = group(810000000000000000n, PROVENANCE_MAX, at("g16"), () => "g16.example");
  const g17 = group(820000000000000000n, PROVENANCE_MAX + 1, at("g17"), () => "g17.example");
  const g34hosts = hostsOf(PROVENANCE_MAX + 1, "h");
  const g34 = group(830000000000000000n, 2 * (PROVENANCE_MAX + 1), at("g34"), (i) => g34hosts[Math.floor(i / 2)]!);
  const g35hosts = hostsOf(PROVENANCE_MAX, "k");
  const g35 = group(840000000000000000n, 35, at("g35"), (i) => g35hosts[Math.min(Math.floor(i / 2), 15)]!);
  const empty = { id: "850000000000000000", host: "personal.example", shared: "" };
  await remotes(h.store, [...g16, ...g17, ...g34, ...g35, empty]);
  const bad = await outside(h.store, 860000000000000000n);
  await follow(h.store, alice.id, [...[g16, g17, g34, g35].flat().map((a) => a.id), empty.id, ...bad]);
  const status = await post(h, alice, { status: "which?", poll: { options: ["x", "y"], expires_in: 3600 } });
  const multi = { id: "870000000000000000", host: "voters.example", shared: at("voters") };
  await remotes(h.store, [multi]);
  const badVoters = await outside(h.store, 880000000000000000n);
  const votes = [
    [g16[0]!.id, 0],
    [multi.id, 0],
    [multi.id, 1],
    [badVoters[0]!, 0],
    [badVoters[2]!, 1],
  ] as const;
  for (const [voter, choice] of votes) {
    await sql(
      h.store,
      "INSERT INTO poll_votes (poll_id, account_id, choice) VALUES (?, ?, ?)",
      status.id,
      voter,
      choice,
    );
  }
  return { h, alice, status, at, g16, g17, g34, g35, g34hosts, g35hosts, empty, bad, multi, badVoters };
}

describe("followers' and voters' inboxes in SQL (#1733, RES-2)", () => {
  // The values recipientsFor returns, by account: an inbox at the bound comes whole; every value outside the rule
  // comes as none, its account still among the rows (so its judgement ran). Each returned value's raw bytes are read
  // in SQL. Fails if the CASE admits REACH_INBOX_BYTES + 1 bytes (`BETWEEN 1 AND bytes + 1`), drops its NUL test
  // (`instr(...) = 0`) or its type test (`typeof(...) = 'text'`: the BLOB comes as bytes), or takes the personal inbox
  // when the shared one is outside the rule.
  it("returns no inbox outside the rule, the bound's own whole", async () => {
    const w = await world();
    const read = await runInDurableObject(w.h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const recipients = recipientsFor(
        db,
        w.alice.id,
        { type: "Update", object: { type: "Question" } },
        { followers: true, accounts: [], pollVoters: w.status.id },
      );
      const raw = (id: string) =>
        db.first<{ bytes: number }>(
          "SELECT length(CAST(COALESCE(NULLIF(shared_inbox_url, ''), inbox_url) AS BLOB)) AS bytes FROM accounts WHERE id = ?",
          id,
        )!.bytes;
      const of = (list: typeof recipients.followers) =>
        list.map((r) => ({ id: r.id, inbox: r.inbox, bytes: r.inbox === null ? null : raw(r.id) }));
      return { followers: of(recipients.followers), voters: of(recipients.voters) };
    });
    const byId = (list: { id: string; inbox: unknown }[]) => new Map(list.map((r) => [r.id, r.inbox]));
    const followers = byId(read.followers);
    for (const id of w.bad) {
      expect(followers.has(id), id).toBe(true);
      expect(followers.get(id), id).toBeNull();
    }
    const voters = byId(read.voters);
    for (const id of [w.badVoters[0]!, w.badVoters[2]!]) {
      expect(voters.has(id), id).toBe(true);
      expect(voters.get(id), id).toBeNull();
    }
    const inboxes = (list: { inbox: unknown }[]) => new Set(list.map((r) => r.inbox));
    expect(inboxes(read.followers)).toEqual(
      new Set([
        w.at("g16"),
        w.at("g17"),
        w.at("g34"),
        w.at("g35"),
        "https://personal.example/users/u850000000000000000/inbox",
        null,
      ]),
    );
    expect(inboxes(read.voters)).toEqual(new Set([w.at("g16"), w.at("voters"), null]));
    const bytes = [...read.followers, ...read.voters].map((r) => r.bytes ?? 0);
    expect(Math.max(...bytes)).toBe(REACH_INBOX_BYTES);
  });

  // What staging records of the same world: a Create of the poll to the followers, then the poll's Update to the
  // followers and voters, each at an inbox within the rule, with its recipients (VIS-30). The 16 list their accounts and
  // host; 17 are many on one host; 34 on 17 hosts are many and list no host; 35 on 16 hosts list the 16. The voter that
  // is a follower is one of the 16; the voter of two choices is one recipient.
  it("stages the inboxes within the rule with their recipients, and none outside it", async () => {
    const w = await world();
    const create = await rows(w.h.store);
    await sql(w.h.store, "UPDATE polls SET update_due_at = ?", new Date(NOW).toISOString());
    await endPolls(w.h.env, { build: () => BUILD, now: () => NOW, store: () => w.h.store, doorbell: vi.fn() });
    const update = (await rows(w.h.store)).filter((r) => r.type === "Update");
    const followers = [
      { inbox: w.at("g16"), accounts: sorted(w.g16.map((a) => a.id)), domains: '["g16.example"]', many: null },
      { inbox: w.at("g17"), accounts: null, domains: '["g17.example"]', many: 1 },
      { inbox: w.at("g34"), accounts: null, domains: null, many: 1 },
      { inbox: w.at("g35"), accounts: null, domains: JSON.stringify(w.g35hosts.toSorted()), many: 1 },
      {
        inbox: "https://personal.example/users/u850000000000000000/inbox",
        accounts: JSON.stringify([w.empty.id]),
        domains: '["personal.example"]',
        many: null,
      },
    ];
    const recorded = (list: Row[]) =>
      list
        .map(({ inbox, accounts, domains, many }) => ({ inbox, accounts, domains, many }))
        .toSorted((a, b) => (a.inbox < b.inbox ? -1 : 1));
    expect(create.map((r) => r.type)).toEqual(Array<string>(followers.length).fill("Create"));
    expect(recorded(create)).toEqual(followers.toSorted((a, b) => (a.inbox < b.inbox ? -1 : 1)));
    expect(recorded(update)).toEqual(
      [
        ...followers,
        { inbox: w.at("voters"), accounts: JSON.stringify([w.multi.id]), domains: '["voters.example"]', many: null },
      ].toSorted((a, b) => (a.inbox < b.inbox ? -1 : 1)),
    );
  });

  // Each a control of the other: a lone follower at the bound is delivered, one a byte past it is not, and no intent
  // is recorded for it (the guarded value reaches recipientsFor as its only follower).
  it.each([
    [REACH_INBOX_BYTES, true],
    [REACH_INBOX_BYTES + 1, false],
  ])("a lone follower at %i bytes is delivered: %s", async (bytes, delivered) => {
    const h = await community(["alice"]);
    const inbox = sized("lone.example", bytes);
    await remotes(h.store, [{ id: "810000000000000001", host: "lone.example", shared: inbox }]);
    await follow(h.store, h.users.alice.id, ["810000000000000001"]);
    await post(h, h.users.alice, { status: "to the one" });
    expect((await rows(h.store)).map((r) => r.inbox)).toEqual(delivered ? [inbox] : []);
    expect((await sql(h.store, "SELECT id FROM outbound_activities")).length).toBe(delivered ? 1 : 0);
  });
});

describe("one rule with collection reach (#1733, RES-6)", () => {
  // recipientsFor's followers and a collection job's followers round (reachFollowerInboxes) read each follower's inbox
  // by the one fragment, and the CHECK collection_reach_inbox stores exactly the values it admits, over every OUTSIDE
  // value, the bound's own and malformed UTF-8 at the bound (raw bytes, as SQL counts them).
  it("admits the inboxes the followers round and the staged CHECK admit", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const within = ["810000000000000001", "810000000000000002"];
    await remotes(h.store, [
      { id: within[0]!, host: "max.example", shared: sized("max.example", REACH_INBOX_BYTES) },
      { id: within[1]!, host: "mal.example", shared: null },
    ]);
    const head = "https://mal.example/";
    await sql(
      h.store,
      "UPDATE accounts SET shared_inbox_url = ? || CAST(? AS TEXT) WHERE id = ?",
      head,
      FF(REACH_INBOX_BYTES - head.length),
      within[1]!,
    );
    const bad = await outside(h.store, 860000000000000000n);
    const ids = [...within, ...bad];
    await follow(h.store, alice.id, ids);
    const judged = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      const followers = new Map(
        recipientsFor(
          db,
          alice.id,
          { type: "Create", object: { type: "Note" } },
          { followers: true, accounts: [] },
        ).followers.map((r) => [r.id, r.inbox]),
      );
      const accountOf = new Map(
        db
          .all<{ id: string; account_id: string }>(
            "SELECT CAST(id AS TEXT) AS id, account_id FROM follows WHERE target_account_id = ?",
            alice.id,
          )
          .map((r) => [r.id, r.account_id]),
      );
      const round = new Map(
        reachFollowerInboxes(
          db,
          alice.id,
          "-9223372036854775808",
          "9223372036854775807",
          100,
          COLLECTION_REACH_INBOX_BYTES,
        ).map((r) => [accountOf.get(r.id)!, r.inbox]),
      );
      const job = db.first<{ id: string }>(
        "INSERT INTO collection_jobs (account_id, phase) VALUES (?, 'followers') RETURNING CAST(id AS TEXT) AS id",
        alice.id,
      )!.id;
      const stored = (id: string) => {
        try {
          db.run(
            `INSERT INTO collection_reach (job_id, inbox)
						SELECT CAST(? AS INTEGER), COALESCE(NULLIF(shared_inbox_url, ''), inbox_url) FROM accounts WHERE id = ?`,
            job,
            id,
          );
          return true;
        } catch {
          return false;
        }
      };
      return ids.map((id) => ({ id, follower: followers.get(id), round: round.get(id), stored: stored(id) }));
    });
    expect(judged.map((j) => j.follower !== null)).toEqual(ids.map((id) => within.includes(id)));
    for (const j of judged) {
      expect(j.round, j.id).toEqual(j.follower);
      expect(j.stored, j.id).toBe(j.follower !== null);
    }
  });
});

// Drains every due row through the claim and its confirmation (VIS-30's send-time check), the type and inbox of each
// row sent.
function drain(store: StoreStub): Promise<[string, string][]> {
  return drainDeliveries(
    store,
    ({ inbox, body }): [string, string] => [(JSON.parse(body) as { type: string }).type, inbox],
    { now: NOW, until: "all", strict: true, rounds: 20 },
  );
}

describe("the provenance behind an inbox at the bound, beside inboxes outside it (#1733, VIS-30)", () => {
  // Every case also has alice's followers outside the rule, so their rows share recipientsFor's read. A local status's
  // Delete is staged in steps by its own reads (deliveries.ts stageRetraction), which reach some of them: only the
  // gateway's rows are compared.
  async function gateway(accounts: readonly { id: string; host: string }[]) {
    const h = await community(["alice"]);
    const inbox = sized("gateway.example", REACH_INBOX_BYTES);
    await remotes(
      h.store,
      accounts.map((a) => ({ ...a, shared: inbox })),
    );
    const bad = await outside(h.store, 860000000000000000n);
    await follow(h.store, h.users.alice.id, [...accounts.map((a) => a.id), ...bad]);
    return { h, alice: h.users.alice, inbox };
  }
  const gone = (store: StoreStub, ids: readonly string[]) =>
    sql(
      store,
      "UPDATE accounts SET deleted_at = ? WHERE id IN (SELECT value FROM json_each(?))",
      new Date(NOW).toISOString(),
      JSON.stringify(ids),
    );

  it("sends content while one recipient behind the inbox is available, and only the retraction once none is", async () => {
    const accounts = [
      { id: "810000000000000001", host: "a.example" },
      { id: "810000000000000002", host: "b.example" },
    ];
    for (const [deleted, sent] of [
      [[accounts[0]!.id], ["Create", "Delete"]],
      [accounts.map((a) => a.id), ["Delete"]],
    ] as const) {
      const { h, alice, inbox } = await gateway(accounts);
      const status = await post(h, alice, { status: "soon gone" });
      expect((await rows(h.store)).map((r) => [r.inbox, r.accounts, r.domains])).toEqual([
        [inbox, sorted(accounts.map((a) => a.id)), '["a.example","b.example"]'],
      ]);
      await gone(h.store, deleted);
      await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
      await settleDeliveries(h.store);
      expect((await drain(h.store)).filter(([, to]) => to === inbox).map(([type]) => type)).toEqual(sent);
    }
  });

  // 19 accounts on 16 hosts (b0 to b15), then the 17th host's only account with the highest id: the host arm of byInbox
  // alone finds it, so the target lists no host. Once the 16 are blocked the content is still sent (the inbox's host
  // and the 17th are not). Fails without the host arm (`OR (hn = 1 AND hr <= 17)`): the 16 hosts are listed, every one
  // blocked, and the row is dropped.
  it("keeps the host overflow its last account makes, so blocking the first 16 hosts drops nothing", async () => {
    const first = hostsOf(PROVENANCE_MAX, "b");
    const accounts = [
      ...Array.from({ length: 19 }, (_, i) => ({ id: String(810000000000000001n + BigInt(i)), host: first[i % 16]! })),
      { id: "819000000000000000", host: "z.example" },
    ];
    const { h, alice, inbox } = await gateway(accounts);
    await post(h, alice, { status: "to the gateway" });
    expect((await rows(h.store)).map((r) => [r.inbox, r.accounts, r.domains, r.many])).toEqual([
      [inbox, null, null, 1],
    ]);
    for (const host of first) {
      await blockDomain(h.store, host);
    }
    expect((await drain(h.store)).map(([type, to]) => [type, to === inbox])).toEqual([["Create", true]]);
  });

  // A retraction recorded whole (recordOutbound, not staged) also reaches the inbox's earlier receivers, whose
  // recipients are unknown: the target merged from the followers' and the receipt's lists none, and is sent, though its
  // one follower is gone.
  it("records no recipients when the inbox also received the status, and sends the retraction", async () => {
    const accounts = [{ id: "810000000000000001", host: "a.example" }];
    const { h, alice, inbox } = await gateway(accounts);
    const status = await post(h, alice, { status: "received" });
    const [{ uri }] = (await sql<{ uri: string }>(h.store, "SELECT uri FROM statuses WHERE id = ?", status.id)) as [
      { uri: string },
    ];
    expect((await drain(h.store)).map(([type]) => type)).toEqual(["Create"]);
    expect(await sql(h.store, "SELECT inbox_url FROM outbound_receipts")).toEqual([{ inbox_url: inbox }]);
    await gone(h.store, [accounts[0]!.id]);
    await runInDurableObject(h.store, (_instance, state) =>
      state.storage.transactionSync(() =>
        enqueueActivity(
          new Db(state.storage.sql),
          alice.id,
          {
            activity: {
              type: "Delete",
              id: `${uri}#delete`,
              actor: "https://kopje.test/ap/users/alice",
              object: uri,
            },
            audience: { followers: true, accounts: [] },
          },
          NOW,
        ),
      ),
    );
    expect((await rows(h.store)).map((r) => [r.type, r.inbox === inbox, r.accounts, r.domains, r.many])).toEqual([
      ["Delete", true, null, null, null],
    ]);
    expect((await drain(h.store)).map(([type, to]) => [type, to === inbox])).toEqual([["Delete", true]]);
  });
});

describe("every reader of followers and voters (#1733, NET-2)", () => {
  // The envelope's inboxes as staged, read whole after enqueueActivity.
  async function staged(store: StoreStub, signer: string, envelope: DeliveryEnvelope, withdraws = false) {
    await runInDurableObject(store, (_instance, state) =>
      state.storage.transactionSync(() =>
        enqueueActivity(new Db(state.storage.sql), signer, envelope, NOW, { withdraws }),
      ),
    );
    return (await rows(store)).map((r) => r.inbox);
  }
  const GOOD = "https://good.example/inbox";

  // Followers of `owner`: one at GOOD and one of each OUTSIDE.
  async function followed(store: StoreStub, owner: string, base: bigint) {
    await remotes(store, [{ id: String(base), host: "good.example", shared: GOOD }]);
    const bad = await outside(store, base + 1n);
    await follow(store, owner, [String(base), ...bad]);
  }

  // reachOf: another owner's audience (a stamp's Delete reaches the quoted status's), read under that owner.
  it("reads another owner's followers through reachOf by the same rule", async () => {
    const h = await community(["alice", "bob"]);
    await followed(h.store, h.users.bob.id, 810000000000000000n);
    const envelope: DeliveryEnvelope = {
      activity: {
        type: "Delete",
        id: "https://kopje.test/ap/stamps/1#delete",
        actor: "https://kopje.test/ap/users/alice",
        object: "https://kopje.test/ap/stamps/1",
      },
      audience: { followers: false, accounts: [] },
      reachOf: [
        { owner: h.users.bob.id, object: "https://kopje.test/ap/o/1", audience: { followers: true, accounts: [] } },
      ],
    };
    expect(await staged(h.store, h.users.alice.id, envelope)).toEqual([GOOD]);
  });

  // shares: a forward whose reference resolves (alice's boost) reaches her followers.
  it("reads the forwarder's followers for a resolving share by the same rule", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await followed(h.store, alice.id, 810000000000000000n);
    await remotes(h.store, [{ id: "890000000000000000", host: "author.example", shared: null }]);
    await sql(
      h.store,
      `INSERT INTO statuses (id, uri, account_id, visibility, published_at) VALUES
				('890000000000000001', 'https://author.example/o/1', '890000000000000000', 'public', ?1),
				('890000000000000002', 'https://kopje.test/ap/o/boost', ?2, 'public', ?1)`,
      new Date(NOW).toISOString(),
      alice.id,
    );
    await sql(h.store, "UPDATE statuses SET reblog_of_id = '890000000000000001' WHERE id = '890000000000000002'");
    const envelope: DeliveryEnvelope = {
      activity: {
        type: "Delete",
        id: "https://author.example/o/1#delete",
        actor: "https://author.example/users/u890000000000000000",
        object: "https://author.example/o/1",
      },
      audience: { followers: false, accounts: [], shares: ["890000000000000002"] },
      immutable: true,
    };
    expect(await staged(h.store, alice.id, envelope)).toEqual([GOOD]);
  });

  // The voters read: those of the poll's current generation, of the signer's own status, while the poll is not
  // removed; for a retraction, whatever its visibility now. Each world has a voter within the rule (delivered) and one
  // outside it. Fails without `pv.generation = pp.generation` (the earlier generation's voter is reached),
  // `vs.account_id = ?2` (bob's poll's voters are) or `pp.removed = 0` (the removed poll's are).
  it("reads the voters of the signer's current poll alone, by the same rule", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const poll = async (author: User) =>
      (await post(h, author, { status: "which?", poll: { options: ["x", "y"], expires_in: 3600 } })).id;
    const current = await poll(alice);
    const removed = await poll(alice);
    const others = await poll(bob);
    await sql(h.store, "DELETE FROM deliveries");
    await sql(h.store, "DELETE FROM outbound_activities");
    await remotes(h.store, [
      { id: "810000000000000001", host: "good.example", shared: GOOD },
      { id: "810000000000000002", host: "stale.example", shared: "https://stale.example/inbox" },
      { id: "810000000000000003", host: "bobs.example", shared: "https://bobs.example/inbox" },
      { id: "810000000000000004", host: "removed.example", shared: "https://removed.example/inbox" },
    ]);
    const bad = await outside(h.store, 820000000000000000n);
    const vote = (pollId: string, account: string, generation = 1) =>
      sql(
        h.store,
        "INSERT INTO poll_votes (poll_id, generation, account_id, choice) VALUES (?, ?, ?, 0)",
        pollId,
        generation,
        account,
      );
    await sql(h.store, "UPDATE polls SET generation = 1");
    await vote(current, "810000000000000001");
    await vote(current, "810000000000000002", 0);
    for (const id of bad) {
      await vote(current, id);
    }
    await vote(others, "810000000000000003");
    await vote(removed, "810000000000000004");
    await sql(h.store, "UPDATE polls SET removed = 1 WHERE status_id = ?", removed);
    const update = (pollVoters: string): DeliveryEnvelope => ({
      activity: {
        type: "Update",
        id: `https://kopje.test/ap/o/${pollVoters}#u`,
        actor: "https://kopje.test/ap/users/alice",
        object: { type: "Question", id: `https://kopje.test/ap/o/${pollVoters}` },
      },
      audience: { followers: false, accounts: [], pollVoters },
    });
    expect(await staged(h.store, alice.id, update(current))).toEqual([GOOD]);
    await sql(h.store, "DELETE FROM deliveries");
    expect(await staged(h.store, alice.id, update(others))).toEqual([]);
    expect(await staged(h.store, alice.id, update(removed))).toEqual([]);
    // A retraction of the current poll's status reaches its voters as they are.
    await sql(h.store, "UPDATE statuses SET visibility = 'direct' WHERE id = ?", current);
    const retraction: DeliveryEnvelope = {
      activity: {
        type: "Delete",
        id: `https://kopje.test/ap/o/${current}#delete`,
        actor: "https://kopje.test/ap/users/alice",
        object: `https://kopje.test/ap/o/${current}`,
      },
      audience: { followers: false, accounts: [], pollVoters: current },
    };
    expect(await staged(h.store, alice.id, retraction)).toEqual([GOOD]);
  });
});

describe("a remote vote received, then the poll's Update (#1733)", () => {
  // The vote arrives through the inbox as any spooled activity is replayed into it, and its count's Update is recorded
  // by the cron: it reaches the voter within the rule, not the one whose stored inbox is past it.
  it("reaches the voter within the rule only", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { key: 1 });
    const status = await localStatus(t, { status: "which?", poll: { options: ["cats", "dogs"], expires_in: 3600 } });
    const vote = (actor: typeof bob, name: string, n: number) => ({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor.uri}#votes/${n}/activity`,
      type: "Create",
      actor: actor.uri,
      to: [`${new URL(status.uri).origin}/ap/users/alice`],
      object: {
        id: `${actor.uri}#votes/${n}`,
        type: "Note",
        name,
        attributedTo: actor.uri,
        inReplyTo: status.uri,
        to: [],
      },
    });
    expect(await t.post(bob, vote(bob, "dogs", 1))).toBe(202);
    expect(await t.post(carol, vote(carol, "cats", 2))).toBe(202);
    const past = sized("bob.example", REACH_INBOX_BYTES + 1);
    await sql(t.store, "UPDATE accounts SET shared_inbox_url = ? WHERE uri = ?", past, bob.uri);
    await sql(t.store, "DELETE FROM deliveries");
    await endPolls(t.env, { build: () => BUILD, now: () => NOW + 3 * 60_000, store: () => t.store });
    const [reach] = await sql<{ inbox: string }>(
      t.store,
      "SELECT COALESCE(NULLIF(shared_inbox_url, ''), inbox_url) AS inbox FROM accounts WHERE uri = ?",
      carol.uri,
    );
    expect((await rows(t.store)).map((r) => [r.type, r.inbox])).toEqual([["Update", reach!.inbox]]);
  });
});

describe("a retraction staging across the upgrade (#1733, RES-6)", () => {
  // An older release began staging a retraction and stopped in its followers: it had written two followers' inboxes
  // by its own projection (retraction_reach), each one the rule refuses (a NUL; past REACH_INBOX_BYTES), and its cursor
  // is past them. The rest is staged by the rule: the rows staged before are emitted as they were, the follower within
  // the rule after the cursor is added and the one outside it is not; the staging, its rows and the intent's mark are
  // gone at its end, and every target is sent. Nothing is left to a later call.
  it("writes the rows staged before it and ends", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    const GOOD = "https://good.example/inbox";
    const nul = "https://nul.example/in\0box";
    const past = sized("past.example", REACH_INBOX_BYTES + 1);
    const later = sized("later.example", REACH_INBOX_BYTES + 1);
    const ids = ["810000000000000001", "810000000000000002", "810000000000000003", "810000000000000004"];
    await remotes(h.store, [
      { id: ids[0]!, host: "nul.example", shared: null },
      { id: ids[1]!, host: "past.example", shared: past },
      { id: ids[2]!, host: "good.example", shared: GOOD },
      { id: ids[3]!, host: "later.example", shared: later },
    ]);
    await sql(h.store, "UPDATE accounts SET shared_inbox_url = ? WHERE id = ?", nul, ids[0]!);
    expect(
      await sql(
        h.store,
        "SELECT instr(CAST(shared_inbox_url AS BLOB), x'00') AS at FROM accounts WHERE id = ?",
        ids[0]!,
      ),
    ).toEqual([{ at: 23 }]);
    for (const id of ids) {
      await follow(h.store, alice, [id]);
    }
    const object = "https://kopje.test/ap/o/staging";
    const envelope: DeliveryEnvelope = {
      activity: { type: "Delete", id: `${object}#delete`, actor: "https://kopje.test/ap/users/alice", object },
      audience: { followers: true, accounts: [] },
    };
    const calls = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      const db = new Db(sql, (fn) => state.storage.transactionSync(fn));
      const intent = state.storage.transactionSync(() => beginRetraction(db, alice, envelope, NOW, 1, "bounded")!);
      const follow = (id: string) =>
        sql.exec<{ id: number }>("SELECT id FROM follows WHERE account_id = ?", id).one().id;
      // As the older release left it.
      const staging = sql
        .exec<{ id: string }>(
          `INSERT INTO retraction_stagings (activity_id, follow_bound, phase, after_id)
					VALUES (CAST(?1 AS INTEGER), ?2, 'followers', ?3) RETURNING CAST(id AS TEXT) AS id`,
          intent,
          follow(ids[3]!),
          follow(ids[1]!),
        )
        .one().id;
      sql.exec("UPDATE outbound_activities SET staged = ? WHERE id = CAST(? AS INTEGER)", staging, intent);
      for (const [inbox, account] of [
        [nul, ids[0]!],
        [past, ids[1]!],
      ] as const) {
        sql.exec(
          "INSERT INTO retraction_reach (staging_id, neutral, key, accounts) VALUES (CAST(? AS INTEGER), 1, ?, json_array(?))",
          staging,
          inbox,
          account,
        );
      }
      for (let call = 1; call < 50; call++) {
        if (state.storage.transactionSync(() => stageRetraction(db, alice, object, STAGE_MIN_ROWS))) {
          return call;
        }
      }
      throw new Error("the staging did not end");
    });
    expect(calls).toBeGreaterThan(1);
    expect(
      await sql(
        h.store,
        `SELECT (SELECT count(*) FROM retraction_stagings) + (SELECT count(*) FROM retraction_reach) AS n,
					(SELECT count(*) FROM outbound_activities WHERE staged IS NOT NULL) AS marked`,
      ),
    ).toEqual([{ n: 0, marked: 0 }]);
    const sent = (await drain(h.store)).map(([type, inbox]) => `${type} ${inbox}`);
    expect(sent).toHaveLength(3);
    expect(new Set(sent)).toEqual(new Set([`Delete ${GOOD}`, `Delete ${nul}`, `Delete ${past}`]));
    expect(await sql(h.store, "SELECT count(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
  });
});

describe("deliveries staged before the rule (#1733, NET-2, NET-3, VIS-30)", () => {
  const ALICE_URI = "https://kopje.test/ap/users/alice";
  const NOTE = "https://kopje.test/ap/o/staged";
  // An inbox an older release staged (no stored bound held it): a deliverable https URL past REACH_INBOX_BYTES.
  const long = (host: string) => sized(host, REACH_INBOX_BYTES + 904);

  // alice's activity, recorded as an older release recorded it, and its id.
  async function recorded(store: StoreStub, alice: string, envelope: DeliveryEnvelope, object: string) {
    const [row] = await sql<{ id: string }>(
      store,
      `INSERT INTO outbound_activities (account_id, body, object_uri, created_at) VALUES (?, ?, ?, ?)
			RETURNING CAST(id AS TEXT) AS id`,
      alice,
      JSON.stringify(envelope),
      object,
      NOW,
    );
    return row!.id;
  }

  // A row of `activity` to `inbox` in `state`, behind its recipient `account` (VIS-30's provenance).
  async function staged(
    store: StoreStub,
    activity: string,
    alice: string,
    inbox: string,
    state: string,
    account: string,
  ) {
    await sql(
      store,
      `INSERT INTO deliveries (activity_id, account_id, inbox_url, lane, state, lease_token, next_attempt_at, updated_at,
				recipient_accounts)
			VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, CASE WHEN ?5 = 'leased' THEN 'old' END, ?6, ?6, json_array(?7))`,
      activity,
      alice,
      inbox,
      new URL(inbox).origin,
      state,
      state === "leased" ? NOW - 1 : NOW,
      account,
    );
  }

  // The rule judges recipients as they are read, never a row or a chunk already staged: a pending row and the queued one
  // behind it, a given-up row the operator retries, a row whose lease ran out and a chunk not yet expanded, each to an
  // inbox past the rule, are claimed and sent as before; the row whose one recipient is gone is dropped at the claim
  // (VIS-30). Fails if the send-time check's recipients rule is taken out (`row.recipient_accounts !== null &&` read as
  // false): that row is sent.
  it("sends the rows and chunks staged to inboxes past the rule, under the send-time check", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    const hosts = ["a", "b", "c", "d", "e"].map((x) => `${x}.example`);
    await remotes(
      h.store,
      hosts.map((host, i) => ({ id: String(810000000000000001n + BigInt(i)), host, shared: long(host) })),
    );
    const id = (i: number) => String(810000000000000001n + BigInt(i));
    await sql(h.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), id(1));
    const activity = await recorded(
      h.store,
      alice,
      {
        activity: { type: "Create", id: `${NOTE}/activity`, actor: ALICE_URI, object: { id: NOTE, type: "Note" } },
        audience: { followers: true, accounts: [] },
      },
      NOTE,
    );
    const queued = `${long("a.example")}/queued`;
    await staged(h.store, activity, alice, long("a.example"), "pending", id(0));
    await staged(h.store, activity, alice, queued, "queued", id(0));
    await staged(h.store, activity, alice, long("b.example"), "pending", id(1));
    await staged(h.store, activity, alice, long("c.example"), "gave_up", id(2));
    await staged(h.store, activity, alice, long("d.example"), "leased", id(3));
    await sql(
      h.store,
      "INSERT INTO outbound_targets (activity_id, targets) VALUES (CAST(? AS INTEGER), json_array(json_object('inbox', ?, 'accounts', json_array(?))))",
      activity,
      long("e.example"),
      id(4),
    );
    const [gaveUp] = await sql<{ id: string }>(
      h.store,
      "SELECT CAST(id AS TEXT) AS id FROM deliveries WHERE state = 'gave_up'",
    );
    expect(await h.store.retryDeliveries(BUILD, { ids: [gaveUp!.id], now: NOW })).toMatchObject({ retried: 1 });
    const sent = await drain(h.store);
    expect(sent.map(([, inbox]) => inbox).toSorted()).toEqual(
      [long("a.example"), queued, long("c.example"), long("d.example"), long("e.example")].toSorted(),
    );
    expect(Math.min(...sent.map(([, inbox]) => new TextEncoder().encode(inbox).length))).toBeGreaterThan(
      REACH_INBOX_BYTES,
    );
    expect(await sql(h.store, "SELECT count(*) AS n FROM deliveries")).toEqual([{ n: 0 }]);
  });

  // The Worker's rounds: a Follow's row at the shared inbox, answered 404, moves to its recipient's personal inbox,
  // past the rule, which the next round POSTs to after NET-3's host check of that URL. The fallback reads the
  // recipient's stored inbox as before (personalFallback), not by the rule, which judges followers and voters only.
  it("moves a row to a personal inbox past the rule and checks its host before the POST", async () => {
    const h = await community(["alice"]);
    const alice = h.users.alice.id;
    await sql(
      h.store,
      "UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?",
      LEGACY.privkey.slice().buffer,
      LEGACY.salt.slice().buffer,
      LEGACY.pubkey,
      alice,
    );
    const shared = "https://f.example/inbox";
    const personal = long("f.example");
    await remotes(h.store, [{ id: "810000000000000001", host: "f.example", shared }]);
    await sql(h.store, "UPDATE accounts SET inbox_url = ? WHERE id = '810000000000000001'", personal);
    const target = "https://f.example/users/u810000000000000001";
    const activity = await recorded(
      h.store,
      alice,
      {
        activity: { type: "Follow", id: `${ALICE_URI}#follows/1`, actor: ALICE_URI, object: target },
        audience: { followers: false, accounts: ["810000000000000001"] },
      },
      `${ALICE_URI}#follows/1`,
    );
    await staged(h.store, activity, alice, shared, "pending", "810000000000000001");
    const posted: string[] = [];
    const checked: string[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      posted.push(url);
      return Promise.resolve(new Response(null, { status: url === shared ? 404 : 202 }));
    }) as unknown as typeof globalThis.fetch;
    const deps = {
      ...deliveryDeps(
        () => h.store,
        fetch,
        () => NOW,
      ),
      checkHost: (url: URL) => {
        checked.push(url.href);
        return Promise.resolve();
      },
    };
    const env = { ...h.env, USER_KEK: LEGACY.kek } as unknown as Env;
    expect(await deliveryRound(env, deps)).toMatchObject({ claimed: 1, settled: ["retry"] });
    expect(await sql(h.store, "SELECT inbox_url AS inbox, state FROM deliveries")).toEqual([
      { inbox: personal, state: "pending" },
    ]);
    expect(await deliveryRound(env, deps)).toMatchObject({ claimed: 1, settled: ["delivered"] });
    expect(posted).toEqual([shared, personal]);
    expect(checked).toEqual([shared, personal]);
  });
});
