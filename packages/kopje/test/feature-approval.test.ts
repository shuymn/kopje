import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ANSWER_CHUNK, accountsOf } from "../src/domain/accounts";
import { type ApiHarness, sql } from "./api-helpers";
import { block, community, follow, getJson, post, remoteAccount, type User } from "./status-helpers";
import { recordingSql } from "./status-row-fixtures";

// An account's feature_approval (#1589 PR 2, design §6 2-T1 to 2-T3): the policy's halves from the row and the answer
// to the viewer (audience.ts featureApprovalSql, read per chunk by featureApprovalReads), on every account answer.

type Approval = { automatic: string[]; manual: string[]; current_user: string };

const approval = async (h: ApiHarness, id: string, viewer?: User) =>
  (await getJson<{ feature_approval: Approval }>(h, `/api/v1/accounts/${id}`, viewer?.token)).body.feature_approval;

const set = (h: ApiHarness, id: string, columns: string) =>
  sql(h.store, `UPDATE accounts SET ${columns} WHERE id = ?`, id);

describe("feature_approval", () => {
  // 2-T1. Fails if the account itself is answered before the discoverability test: the account that is not
  // discoverable would read automatic to itself.
  it("answers a local account's policy in Mastodon's order", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await set(h, alice.id, "discoverable = 1, locked = 0");
    expect(await approval(h, alice.id, bob)).toEqual({ automatic: ["public"], manual: [], current_user: "automatic" });
    expect(await approval(h, alice.id)).toEqual({ automatic: ["public"], manual: [], current_user: "denied" });
    await set(h, alice.id, "locked = 1");
    expect(await approval(h, alice.id, bob)).toEqual({ automatic: ["followers"], manual: [], current_user: "denied" });
    expect((await approval(h, alice.id, alice)).current_user).toBe("automatic");
    await sql(
      h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      bob.id,
      alice.id,
    );
    expect((await approval(h, alice.id, bob)).current_user).toBe("automatic");
    await set(h, alice.id, "discoverable = 0");
    expect(await approval(h, alice.id, alice)).toEqual({ automatic: [], manual: [], current_user: "denied" });
    expect(await approval(h, alice.id, bob)).toEqual({ automatic: [], manual: [], current_user: "denied" });
  });

  // 2-T2. Fails if the reads drop the override (the blocked and suspended accounts read automatic, the blocking
  // remote one missing), or gate the policy on mayFeatureSql (the remote account reads denied).
  it("denies across a block either way and for an unavailable account, and answers a remote account missing", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    const { alice, bob, carol, dave } = h.users;
    for (const id of [alice.id, dave.id]) {
      await set(h, id, "discoverable = 1, locked = 0");
    }
    await block(h.store, alice.id, bob.id);
    expect((await approval(h, alice.id, bob)).current_user).toBe("denied");
    expect((await approval(h, alice.id, carol)).current_user).toBe("automatic");
    await block(h.store, carol.id, alice.id);
    expect((await approval(h, alice.id, carol)).current_user).toBe("denied");
    // Suspended: the halves as the row holds them, as Mastodon shows them, the answer denied.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01' WHERE account_id = ?", dave.id);
    expect(await approval(h, dave.id, bob)).toEqual({ automatic: ["public"], manual: [], current_user: "denied" });
    const remote = await remoteAccount(h.store, "erin");
    expect(await approval(h, remote, bob)).toEqual({ automatic: [], manual: [], current_user: "missing" });
    await block(h.store, remote, bob.id);
    expect((await approval(h, remote, bob)).current_user).toBe("denied");
    expect((await approval(h, remote, carol)).current_user).toBe("missing");
  });

  it("is read in one statement per chunk of ANSWER_CHUNK accounts, their moved-to accounts included", async () => {
    const h = await community(["alice"]);
    const ids = [h.users.alice.id];
    for (let n = ids.length; n < 2 * ANSWER_CHUNK + 1; n++) {
      ids.push(await remoteAccount(h.store, `r${n}`));
    }
    // A remote account moved to the last: its target is answered with it, in the first chunk's statement.
    await sql(h.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", ids.at(-1)!, ids[1]!);
    const { counted, moved } = await runInDurableObject(h.store, (_instance, state) => {
      const { sql: recording, reads } = recordingSql(state.storage.sql);
      const accounts = [...accountsOf(new Db(recording), ids, { origin: "https://kopje.test", viewerId: ids[0]! })];
      return {
        counted: reads.filter((query) => query.includes("AS current_user")).length,
        moved: accounts[1]?.moved?.feature_approval.current_user,
      };
    });
    expect(counted).toBe(3);
    expect(moved).toBe("missing");
  });

  // 2-T3. Fails if a caller presents its accounts for no viewer (viewerId null): bob's answers read denied.
  it("is answered to the viewer on a status's account and a notification's", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await set(h, alice.id, "discoverable = 1, locked = 0");
    const status = await post(h, alice, { status: "@bob hi", visibility: "public" });
    const shown = await getJson<{ account: { feature_approval: Approval } }>(
      h,
      `/api/v1/statuses/${status.id}`,
      bob.token,
    );
    expect(shown.body.account.feature_approval.current_user).toBe("automatic");
    const timeline = await getJson<{ account: { feature_approval: Approval } }[]>(
      h,
      "/api/v1/timelines/public",
      bob.token,
    );
    expect(timeline.body.map((entry) => entry.account.feature_approval.current_user)).toEqual(["automatic"]);
    const listed = await getJson<{ account: { feature_approval: Approval } }[]>(h, "/api/v1/notifications", bob.token);
    expect(listed.body.map((entry) => entry.account.feature_approval.current_user)).toEqual(["automatic"]);
    // Followed, alice's own credential account answers itself.
    await follow(h, bob, alice.id);
    const own = await getJson<{ feature_approval: Approval }>(h, "/api/v1/accounts/verify_credentials", alice.token);
    expect(own.body.feature_approval.current_user).toBe("automatic");
  });
});
