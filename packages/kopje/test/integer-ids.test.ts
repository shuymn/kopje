import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { moderationLog } from "../src/domain/moderation-log";
import { suspendRemote } from "../src/domain/remote-suspension";
import { moderationRound, suspendLocal } from "../src/domain/suspension";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { authorizationCode, bearer, exchange, form, registerApp, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { VAPID } from "./push-helpers";
import { act, unsuspend, world, type World } from "./remote-suspension-helpers";
import { post, remoteAccount } from "./status-helpers";

// DATA-6: INTEGER ids, fences, epochs and generations past 2^53 stay exact on every Store path that carries them
// (issue 1290). Each case seeds ids around 2^53 by SQL, so a value read as a JavaScript number names its neighbour:
// 2^53 + 1 reads as 2^53, and 2^53 + 3 as 2^53 + 4.

const AT = new Date(NOW).toISOString();
const big = (offset: number) => String(9007199254740992n + BigInt(offset));
const TWO_53 = big(0);
const INT64_MAX = "9223372036854775807";

function inStore<T>(store: StoreStub, step: (db: Db) => T): Promise<T> {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.transactionSync(() => step(new Db(state.storage.sql, (fn) => state.storage.transactionSync(fn)))),
  );
}

describe("the report fence past 2^53 (VIS-29)", () => {
  // The moderation log's newest row at `id`: the next admin write is logged as `id` + 1.
  const logAt = (w: World, id: string) =>
    sql(
      w.h.store,
      `INSERT INTO admin_actions (id, actor, action, target_type, target_id, detail, created_at)
			VALUES (CAST(? AS INTEGER), 'access', 'seed', 'Setting', 'seed', '{}', ?)`,
      id,
      AT,
    );
  const report = async (w: World, target: string, n: number) =>
    (
      await sql<{ id: string }>(
        w.h.store,
        `INSERT INTO reports (account_id, target_account_id, status_ids, comment, category, forwarded, uri, created_at)
				VALUES (?, ?, '[]', '', 'other', 0, 'https://kopje.test/reports/' || ?, ?) RETURNING CAST(id AS TEXT) AS id`,
        w.bob.id,
        target,
        n,
        AT,
      )
    )[0]!.id;
  const reopen = async (w: World, id: string) =>
    (await w.h.request(`/api/v1/admin/reports/${id}/reopen`, bearer(w.admin, { method: "POST" }))).status;
  const resolved = (w: World) =>
    sql(w.h.store, "SELECT CAST(id AS TEXT) AS id, action_taken_at IS NOT NULL AS resolved FROM reports ORDER BY id");
  const fences = (w: World) =>
    sql(
      w.h.store,
      `SELECT CAST(action_bound AS TEXT) AS fence FROM moderation_jobs WHERE kind = 'suspension'
			UNION ALL SELECT CAST(action_bound AS TEXT) FROM remote_moderation_jobs WHERE kind = 'account'`,
    );

  // The suspension's fence is 2^53 + 3, which reads as 2^53 + 4: the id the reopen after it is logged as, so a rounded
  // fence resolves the reopened report again.
  it.each(["local", "remote"] as const)(
    "leaves open a %s account's report that the next action reopened (logAction)",
    async (kind) => {
      const w = await world();
      const target = kind === "local" ? w.alice.id : await remoteAccount(w.h.store, "carol", "r.example");
      await logAt(w, big(2));
      const [reopened, untouched] = [await report(w, target, 1), await report(w, target, 2)];
      expect((await act(w, target, { type: "suspend" })).status).toBe(200);
      expect(await fences(w)).toEqual([{ fence: big(3) }]);
      expect(await reopen(w, reopened)).toBe(200);
      expect(
        await sql(w.h.store, "SELECT CAST(last_action_id AS TEXT) AS logged FROM reports WHERE id = ?", reopened),
      ).toEqual([{ logged: big(4) }]);
      await settle(w.h.store);
      expect(await resolved(w)).toEqual([
        { id: reopened, resolved: 0 },
        { id: untouched, resolved: 1 },
      ]);
    },
  );

  // Without an admin, the fence is the newest log row (actionBound): 2^53 + 3 again.
  it.each(["local", "remote"] as const)(
    "leaves open a %s account's report that the next action reopened (actionBound)",
    async (kind) => {
      const w = await world();
      const target = kind === "local" ? w.alice.id : await remoteAccount(w.h.store, "carol", "r.example");
      await logAt(w, big(3));
      const [reopened, untouched] = [await report(w, target, 1), await report(w, target, 2)];
      await inStore(w.h.store, (db) =>
        kind === "local" ? suspendLocal(db, target, null, NOW) : suspendRemote(db, target, null, NOW),
      );
      expect(await fences(w)).toEqual([{ fence: big(3) }]);
      expect(await reopen(w, reopened)).toBe(200);
      await settle(w.h.store);
      expect(await resolved(w)).toEqual([
        { id: reopened, resolved: 0 },
        { id: untouched, resolved: 1 },
      ]);
    },
  );
});

describe("credential epochs past 2^53", () => {
  const epochAt = async (w: World, account: string, epoch: string) => {
    await sql(
      w.h.store,
      "UPDATE local_accounts SET credential_epoch = CAST(? AS INTEGER) WHERE account_id = ?",
      epoch,
      account,
    );
    await sql(w.h.store, "UPDATE oauth_tokens SET epoch = CAST(? AS INTEGER) WHERE account_id = ?", epoch, account);
  };
  const generations = (w: World) =>
    sql(
      w.h.store,
      "SELECT kind, CAST(generation AS TEXT) AS generation FROM moderation_jobs ORDER BY kind, generation",
    );
  const tokens = (w: World, account: string) =>
    sql(w.h.store, "SELECT count(*) AS n FROM oauth_tokens WHERE account_id = ?", account);

  it("suspends from 2^53 beside a tokens job of 2^53, and the restoration keeps the new epoch", async () => {
    const w = await world();
    await epochAt(w, w.alice.id, TWO_53);
    // The tokens job of the suspension that set 2^53, still running: 2^53 + 1 read as 2^53 collides with its key.
    await sql(
      w.h.store,
      "INSERT INTO moderation_jobs (kind, account_id, generation, phase) VALUES ('tokens', ?, CAST(? AS INTEGER), 'tokens')",
      w.alice.id,
      TWO_53,
    );
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(200);
    expect(await generations(w)).toEqual([
      { kind: "suspension", generation: big(1) },
      { kind: "tokens", generation: TWO_53 },
      { kind: "tokens", generation: big(1) },
    ]);
    await settle(w.h.store);
    expect((await unsuspend(w, w.alice.id)).status).toBe(200);
    expect(await generations(w)).toEqual([{ kind: "reach", generation: big(1) }]);
  });

  it("deletes the tokens of 2^53 once the epoch is 2^53 + 1", async () => {
    const w = await world();
    await epochAt(w, w.alice.id, TWO_53);
    expect(await tokens(w, w.alice.id)).toEqual([{ n: 1 }]);
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(200);
    await settle(w.h.store);
    expect(await tokens(w, w.alice.id)).toEqual([{ n: 0 }]);
  });

  it("ends a suspension job of 2^53 in the epoch 2^53 + 1 at its next round", async () => {
    const w = await world();
    await epochAt(w, w.alice.id, big(1));
    await sql(w.h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", AT, w.alice.id);
    await sql(
      w.h.store,
      `INSERT INTO moderation_jobs (kind, account_id, generation, follow_bound, phase)
			VALUES ('suspension', ?, CAST(? AS INTEGER), 0, 'followers')`,
      w.alice.id,
      TWO_53,
    );
    expect(await inStore(w.h.store, (db) => moderationRound(db, NOW))).toMatchObject({ fresh: true });
    expect(await generations(w)).toEqual([]);
    // The guarded branch: a round of the current generation keeps its job, which moves on.
    await sql(
      w.h.store,
      `INSERT INTO moderation_jobs (kind, account_id, generation, follow_bound, phase)
			VALUES ('suspension', ?, CAST(? AS INTEGER), 0, 'followers')`,
      w.alice.id,
      big(1),
    );
    await inStore(w.h.store, (db) => moderationRound(db, NOW));
    expect(await sql(w.h.store, "SELECT phase FROM moderation_jobs")).toEqual([{ phase: "reporters" }]);
  });

  it("refuses a suspension from the largest epoch and rolls it back, and suspends into it", async () => {
    const w = await world();
    const state = () =>
      sql(
        w.h.store,
        "SELECT suspended_at, CAST(credential_epoch AS TEXT) AS epoch FROM local_accounts WHERE account_id = ?",
        w.alice.id,
      );
    // The guarded branch: from the largest epoch but one, the suspension moves to the largest.
    await epochAt(w, w.alice.id, "9223372036854775806");
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(200);
    expect(await generations(w)).toEqual([
      { kind: "suspension", generation: INT64_MAX },
      { kind: "tokens", generation: INT64_MAX },
    ]);
    await settle(w.h.store);
    const before = await state();
    expect(before).toEqual([{ suspended_at: expect.any(String), epoch: INT64_MAX }]);
    w.h.now.mockReturnValue(NOW + 1000);
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(500);
    expect(await state()).toEqual(before);
    expect(await generations(w)).toEqual([]);
  });

  it("grants no code of 2^53 once the epoch is 2^53 + 1, and one of 2^53 + 1", async () => {
    const w = await world();
    const app = await registerApp(w.h);
    const [stale, current] = [
      await authorizationCode(w.h, app, { email: "alice@example.com" }),
      await authorizationCode(w.h, app, { email: "alice@example.com" }),
    ];
    await sql(
      w.h.store,
      "UPDATE local_accounts SET credential_epoch = CAST(? AS INTEGER) WHERE account_id = ?",
      big(1),
      w.alice.id,
    );
    for (const [code, epoch] of [
      [stale, TWO_53],
      [current, big(1)],
    ] as const) {
      await sql(
        w.h.store,
        "UPDATE oauth_tokens SET epoch = CAST(? AS INTEGER) WHERE token_hash = ?",
        epoch,
        await sha256Hex(code),
      );
    }
    expect((await exchange(w.h, app, stale)).status).toBe(400);
    expect((await exchange(w.h, app, current)).status).toBe(200);
  });
});

describe("push subscription ids past 2^53", () => {
  // Push subscriptions of `owner` at 2^53 + 1 and of `other` at 2^53, which the first reads as.
  async function subscriptions(w: World, owner: string, other: string) {
    for (const [token, id] of [
      [owner, big(1)],
      [other, TWO_53],
    ] as const) {
      await sql(
        w.h.store,
        `INSERT INTO push_subscriptions (id, token_hash, endpoint, key_p256dh, key_auth, alerts)
				VALUES (CAST(?1 AS INTEGER), ?2, 'https://push.example/' || ?1, 'p256dh', 'auth', '{"mention":true}')`,
        id,
        await sha256Hex(token),
      );
    }
  }
  const subscribed = (w: World) => sql(w.h.store, "SELECT CAST(id AS TEXT) AS id FROM push_subscriptions ORDER BY id");

  it("deletes only the suspended account's subscription in its tokens round", async () => {
    const w = await world();
    await subscriptions(w, w.alice.token, w.bob.token);
    expect((await act(w, w.alice.id, { type: "suspend" })).status).toBe(200);
    await settle(w.h.store);
    expect(await subscribed(w)).toEqual([{ id: TWO_53 }]);
  });

  it("deletes only the subscription a refused push names", async () => {
    const w = await world({ VAPID_JWK: VAPID.env });
    await subscriptions(w, w.alice.token, w.bob.token);
    await post(w.h, w.carol, { status: "@alice hi" });
    const claim = await w.h.store.claimPushes(BUILD, { now: NOW, leaseToken: "a" });
    expect(claim.pushes).toHaveLength(1);
    const outcome = { kind: "failed", status: 410, error: "gone", permanent: true } as const;
    expect(
      await w.h.store.completePush(BUILD, { id: claim.pushes[0]!.id, leaseToken: "a", now: NOW, outcome }),
    ).toMatchObject({ status: "unsubscribed" });
    expect(await subscribed(w)).toEqual([{ id: TWO_53 }]);
  });
});

describe("notification and conversation ids past 2^53", () => {
  it("queues the push of the notification just inserted, after one restored at 2^53", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
			VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"mention":true,"follow":true}')`,
      await sha256Hex(w.alice.token),
    );
    await sql(
      w.h.store,
      `INSERT INTO notifications (id, account_id, type, from_account_id, created_at)
			VALUES (CAST(? AS INTEGER), ?, 'follow', ?, ?)`,
      TWO_53,
      w.alice.id,
      w.dan.id,
      AT,
    );
    await post(w.h, w.bob, { status: "@alice hi" });
    expect(await sql(w.h.store, "SELECT CAST(notification_id AS TEXT) AS id FROM push_deliveries ORDER BY id")).toEqual(
      [{ id: big(1) }],
    );
  });

  it("links a direct status to its sender's new conversation, after another's at 2^53", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO conversations (id, account_id, thread, participants, last_status_id, unread)
			VALUES (CAST(? AS INTEGER), ?, 'other', '[]', '000000000000000001', 0)`,
      TWO_53,
      w.dan.id,
    );
    const status = await post(w.h, w.bob, { status: "@alice hi", visibility: "direct" });
    // bob's conversation is made at 2^53 + 1, which reads as dan's.
    expect(
      await sql(
        w.h.store,
        `SELECT CAST(c.id AS TEXT) AS id, c.account_id FROM conversation_statuses cs
				JOIN conversations c ON c.id = cs.conversation_id WHERE cs.status_id = ? ORDER BY c.id`,
        status.id,
      ),
    ).toEqual([{ id: big(1), account_id: w.bob.id }]);
  });
});

describe("instance domain block ids past 2^53", () => {
  const BLOCKS = "/api/v1/admin/domain_blocks";

  it("answers, logs, reads and deletes a block of 2^53 + 1 by its own id", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO instance_domain_blocks (id, domain, severity, created_at, updated_at)
			VALUES (CAST(? AS INTEGER), 'seed.example', 'noop', ?, ?)`,
      TWO_53,
      AT,
      AT,
    );
    const created = await w.h.request(BLOCKS, bearer(w.admin, form({ domain: "new.example", severity: "noop" })));
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ id: big(1), domain: "new.example" });
    expect(await sql(w.h.store, "SELECT target_id FROM admin_actions WHERE target_type = 'DomainBlock'")).toEqual([
      { target_id: big(1) },
    ]);
    const listed = await w.h.request(BLOCKS, bearer(w.admin));
    expect((await listed.json<{ id: string }[]>()).map((block) => block.id)).toEqual([big(1), TWO_53]);
    const read = await w.h.request(`${BLOCKS}/${big(1)}`, bearer(w.admin));
    expect(await read.json()).toMatchObject({ id: big(1), domain: "new.example" });
    expect((await w.h.request(`${BLOCKS}/${big(1)}`, bearer(w.admin, { method: "DELETE" }))).status).toBe(200);
    expect(await sql(w.h.store, "SELECT CAST(id AS TEXT) AS id, domain FROM instance_domain_blocks")).toEqual([
      { id: TWO_53, domain: "seed.example" },
    ]);
  });

  it("finds no block for an id past the INTEGER range, which a cast would saturate to the largest", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO instance_domain_blocks (id, domain, severity, created_at, updated_at)
			VALUES (9223372036854775807, 'max.example', 'noop', ?1, ?1)`,
      AT,
    );
    // The guarded branch: the largest id itself is found.
    expect((await w.h.request(`${BLOCKS}/${INT64_MAX}`, bearer(w.admin))).status).toBe(200);
    const past = `${BLOCKS}/9223372036854775808`;
    expect((await w.h.request(past, bearer(w.admin))).status).toBe(404);
    expect((await w.h.request(past, bearer(w.admin, form({ severity: "suspend" }, { method: "PUT" })))).status).toBe(
      404,
    );
    expect((await w.h.request(past, bearer(w.admin, { method: "DELETE" }))).status).toBe(404);
    expect(await sql(w.h.store, "SELECT CAST(id AS TEXT) AS id, severity FROM instance_domain_blocks")).toEqual([
      { id: INT64_MAX, severity: "noop" },
    ]);
  });

  it("pages blocks in id order across a change of digit count", async () => {
    const w = await world();
    for (const id of [9, 10]) {
      await sql(
        w.h.store,
        `INSERT INTO instance_domain_blocks (id, domain, severity, created_at, updated_at)
				VALUES (?1, 'b' || ?1 || '.example', 'noop', ?2, ?2)`,
        id,
        AT,
      );
    }
    const listed = await w.h.request(BLOCKS, bearer(w.admin));
    expect((await listed.json<{ id: string }[]>()).map((block) => block.id)).toEqual(["10", "9"]);
    const after = await w.h.request(`${BLOCKS}?min_id=0`, bearer(w.admin));
    expect((await after.json<{ id: string }[]>()).map((block) => block.id)).toEqual(["10", "9"]);
  });
});

describe("notification and request ids past the INTEGER range", () => {
  it("finds no notification for an id past the range, and finds the largest", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO notifications (id, account_id, type, from_account_id, created_at)
			VALUES (9223372036854775807, ?, 'follow', ?, ?)`,
      w.alice.id,
      w.dan.id,
      AT,
    );
    const past = "/api/v1/notifications/9223372036854775808";
    expect((await w.h.request(past, bearer(w.alice.token))).status).toBe(404);
    expect((await w.h.request(`${past}/dismiss`, bearer(w.alice.token, { method: "POST" }))).status).toBe(404);
    expect(await sql(w.h.store, "SELECT CAST(id AS TEXT) AS id FROM notifications")).toEqual([{ id: INT64_MAX }]);
    // The guarded branch: the largest id itself is found.
    expect((await w.h.request(`/api/v1/notifications/${INT64_MAX}`, bearer(w.alice.token))).status).toBe(200);
  });

  it("finds no notification request for an id past the range, and finds the largest", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO notification_requests (id, account_id, from_account_id, notifications_count)
			VALUES (9223372036854775807, ?, ?, 1)`,
      w.alice.id,
      w.dan.id,
    );
    const requests = "/api/v1/notifications/requests";
    expect((await w.h.request(`${requests}/9223372036854775808`, bearer(w.alice.token))).status).toBe(404);
    expect(
      (await w.h.request(`${requests}/dismiss`, bearer(w.alice.token, form({ "id[]": "9223372036854775808" })))).status,
    ).toBe(200);
    expect(await sql(w.h.store, "SELECT CAST(id AS TEXT) AS id FROM notification_requests")).toEqual([
      { id: INT64_MAX },
    ]);
    // The guarded branch: the largest id itself is found.
    expect((await w.h.request(`${requests}/${INT64_MAX}`, bearer(w.alice.token))).status).toBe(200);
  });
});

describe("pages ordered by INTEGER id across a change of digit count", () => {
  it("lists the moderation log newest first", async () => {
    const w = await world();
    for (const id of [9, 10]) {
      await sql(
        w.h.store,
        `INSERT INTO admin_actions (id, actor, action, target_type, target_id, detail, created_at)
				VALUES (?, 'access', 'seed', 'Setting', 'seed', '{}', ?)`,
        id,
        AT,
      );
    }
    const page = await runInDurableObject(w.h.store, (_instance, state) => moderationLog.run(state.storage.sql, {}));
    expect(page.entries.map((entry) => entry.id)).toEqual(["10", "9"]);
  });

  it("claims pushes due at once in id order", async () => {
    const w = await world({ VAPID_JWK: VAPID.env });
    await sql(
      w.h.store,
      `INSERT INTO push_subscriptions (token_hash, endpoint, key_p256dh, key_auth, alerts)
			VALUES (?, 'https://push.example/alice', 'p256dh', 'auth', '{"mention":true}')`,
      await sha256Hex(w.alice.token),
    );
    await post(w.h, w.bob, { status: "@alice one" });
    await post(w.h, w.bob, { status: "@alice two" });
    // The two pushes at 9 and 10, due at the same time.
    await sql(w.h.store, "UPDATE push_deliveries SET id = id + 8, next_attempt_at = ?", NOW);
    const claim = await w.h.store.claimPushes(BUILD, { now: NOW, leaseToken: "a" });
    expect(claim.pushes.map((push) => push.id)).toEqual(["9", "10"]);
  });
});

describe("conversation ids and stream sequences", () => {
  it("finds no conversation for an id past the INTEGER range", async () => {
    const w = await world();
    await sql(
      w.h.store,
      `INSERT INTO conversations (id, account_id, thread, participants, last_status_id, unread)
			VALUES (9223372036854775807, ?, 'other', '[]', '000000000000000001', 1)`,
      w.alice.id,
    );
    const past = "/api/v1/conversations/9223372036854775808";
    expect((await w.h.request(`${past}/read`, bearer(w.alice.token, { method: "POST" }))).status).toBe(404);
    expect((await w.h.request(past, bearer(w.alice.token, { method: "DELETE" }))).status).toBe(404);
    expect(await sql(w.h.store, "SELECT CAST(id AS TEXT) AS id, unread FROM conversations")).toEqual([
      { id: INT64_MAX, unread: 1 },
    ]);
    // The guarded branch: the largest id itself is found.
    const read = `/api/v1/conversations/${INT64_MAX}/read`;
    expect((await w.h.request(read, bearer(w.alice.token, { method: "POST" }))).status).toBe(200);
    expect(await sql(w.h.store, "SELECT unread FROM conversations")).toEqual([{ unread: 0 }]);
  });

  it("stores the owner's streaming sequence past 2^53 as it is", async () => {
    const w = await world();
    await sql(
      w.h.store,
      "INSERT INTO stream_conversation_marks (account_id, seq) VALUES (?, CAST(? AS INTEGER))",
      w.bob.id,
      TWO_53,
    );
    await post(w.h, w.bob, { status: "@alice hi", visibility: "direct" });
    expect(
      await sql(w.h.store, "SELECT CAST(stream_seq AS TEXT) AS seq FROM conversations WHERE account_id = ?", w.bob.id),
    ).toEqual([{ seq: big(1) }]);
  });
});
