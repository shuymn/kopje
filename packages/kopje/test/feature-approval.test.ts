import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { ANSWER_CHUNK, accountsOf } from "../src/domain/accounts";
import { type RemoteFeaturePolicyInput, upsertRemoteActor } from "../src/domain/remote-actors";
import { type ApiHarness, sql } from "./api-helpers";
import { actorDefaults, confirmedAs, mastodonActor } from "./inbox-helpers";
import { accountId, ALICE, DAVE, followed, setup, type Setup } from "./inbox-status-helpers";
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
  it("is answered to the viewer on a status's account and a notification's, grouped or not", async () => {
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
    const grouped = await getJson<{ accounts: { feature_approval: Approval }[] }>(
      h,
      "/api/v2/notifications",
      bob.token,
    );
    expect(grouped.body.accounts.map((account) => account.feature_approval.current_user)).toEqual(["automatic"]);
    // Followed, alice's own credential account answers itself.
    await follow(h, bob, alice.id);
    const own = await getJson<{ feature_approval: Approval }>(h, "/api/v1/accounts/verify_credentials", alice.token);
    expect(own.body.feature_approval.current_user).toBe("automatic");
  });
});

// 4-T1: a remote account's canFeature (#1589 PR 4, D23), read from its actor document as Mastodon's
// InteractionPolicyParser reads it (federation/remote-actor.ts featurePolicyOf, remote-actors.ts remoteFeaturePolicy),
// stored in accounts.feature_policy, and presented with the viewer's answer (audience.ts featureApprovalSql).
describe("a remote account's feature policy", () => {
  const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
  const F = { unsupported_policy: 1, public: 2, followers: 4, following: 8, disabled: 16 } as const;
  const automatic = (flags: number) => flags << 16;
  let n = 0;

  // An actor whose document states `canFeature` (none when undefined), stored by its Follow of dave and followed by
  // alice: its policy as stored.
  async function stored(t: Setup, canFeature: unknown, name = `p${++n}`, extra: Record<string, unknown> = {}) {
    const uri = `https://mastodon.example/users/${name}`;
    const self = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("$self", uri)) as unknown;
    const actor = await mastodonActor(t.web, name, {
      extra: { ...extra, ...(canFeature === undefined ? {} : { interactionPolicy: { canFeature: self(canFeature) } }) },
    });
    const id = await followed(t, actor);
    const [row] = await sql<{ policy: number }>(
      t.store,
      "SELECT feature_policy AS policy FROM accounts WHERE id = ?",
      id,
    );
    return { actor, id, policy: row!.policy };
  }

  // Each fails with its rule removed from remoteFeaturePolicy or featurePolicyOf: a public spelling not matched (the
  // first three), the `||` read as an or of all three (the fourth: Public would be deleted too, no unsupported_policy),
  // the followers or following match, the leftover rule, the disabled rule, MAX_QUOTE_POLICY_ENTRIES (the 33rd would
  // add public), an object half read as one entry ({} would add unsupported_policy), or an unreadable collection
  // read as one that matches nothing (unsupported_policy would be added).
  it("reads canFeature's halves as Mastodon's InteractionPolicyParser does", async () => {
    const t = await setup();
    const followers = "$self/followers";
    const following = "$self/following";
    const filler = Array.from({ length: 32 }, (_, i) => `https://other.example/${i}`);
    for (const [name, canFeature, expected] of [
      ["the full IRI", { automaticApproval: AS_PUBLIC }, automatic(F.public)],
      ["as:Public", { automaticApproval: ["as:Public"] }, automatic(F.public)],
      ["Public", { manualApproval: ["Public"] }, F.public],
      ["two spellings", { automaticApproval: ["as:Public", "Public"] }, automatic(F.public | F.unsupported_policy)],
      [
        "followers and following",
        { automaticApproval: [followers], manualApproval: [following] },
        automatic(F.followers) | F.following,
      ],
      ["another URI", { automaticApproval: ["https://other.example/users/x"] }, automatic(F.unsupported_policy)],
      [
        "the account itself",
        { automaticApproval: ["$self"], manualApproval: ["$self"] },
        automatic(F.disabled) | F.disabled,
      ],
      ["itself and a flag", { automaticApproval: ["$self", AS_PUBLIC] }, automatic(F.public)],
      ["a duplicate", { automaticApproval: [followers, followers] }, automatic(F.followers)],
      ["not a string", { automaticApproval: [{ id: AS_PUBLIC }] }, automatic(F.unsupported_policy)],
      ["33 entries", { automaticApproval: [...filler, AS_PUBLIC] }, automatic(F.unsupported_policy)],
      [
        "32 entries",
        { automaticApproval: [...filler.slice(1), AS_PUBLIC] },
        automatic(F.public | F.unsupported_policy),
      ],
      ["an empty object", { automaticApproval: {} }, 0],
      ["an object", { automaticApproval: { a: 1 } }, automatic(F.unsupported_policy)],
      ["no halves", {}, 0],
      ["not an object", "Public", 0],
      ["none", undefined, 0],
    ] as const) {
      expect((await stored(t, canFeature)).policy, name).toBe(expected);
    }
    // A followers collection Kopje cannot read as Mastodon stores it (UNREADABLE): from it on, a string adds nothing
    // but public and the account itself, so no unsupported_policy and no following. A value that is not a string is
    // left over whatever Mastodon stores (Mastodon 4.7.5 gives unsupported_policy in both halves for the second
    // policy), so it still adds unsupported_policy, and the account itself beside it is not `disabled`; fails if a
    // value that is not a string past the collection adds nothing.
    const unreadable = { followers: "https://mastodon.example/users/u/followers\uFFFD" };
    const policy = { automaticApproval: [AS_PUBLIC, "https://other.example/x", following], manualApproval: ["$self"] };
    expect((await stored(t, policy, "u", unreadable)).policy).toBe(automatic(F.public) | F.disabled);
    const others = { automaticApproval: [7], manualApproval: ["$self", { id: AS_PUBLIC }] };
    expect((await stored(t, others, "u2", unreadable)).policy).toBe(
      automatic(F.unsupported_policy) | F.unsupported_policy,
    );
  });

  // The stored policy is read again by every store of the document (the actor's Update embedding it, here), with the
  // collections the stored document names, and kept by an input from an earlier build that read none (featurePolicy
  // undefined). Fails if an undefined policy is stored as 0, or if a store leaves the policy as it was.
  it("is set by every store of the actor's document, and kept when the input carries none", async () => {
    const t = await setup();
    const { actor, id } = await stored(t, { automaticApproval: [AS_PUBLIC] }, "keep");
    const policy = async () =>
      (await sql<{ p: number }>(t.store, "SELECT feature_policy AS p FROM accounts WHERE id = ?", id))[0]!.p;
    const update = async (n: number, interactionPolicy: unknown) => {
      const document = { ...actor.document, interactionPolicy };
      t.web.serve(actor.uri, document);
      await t.post(actor, {
        "@context": actor.document["@context"],
        id: `${actor.uri}#updates/${n}`,
        type: "Update",
        actor: actor.uri,
        object: document,
      });
    };
    await update(1, { canFeature: { manualApproval: ["Public", `${actor.uri}/followers`] } });
    expect(await policy()).toBe(F.public | F.followers);
    const input = (featurePolicy?: RemoteFeaturePolicyInput | null) => ({
      ...actorDefaults(),
      uri: actor.uri,
      ...confirmedAs("keep", "mastodon.example"),
      displayName: "keep",
      inboxUrl: `${actor.uri}/inbox`,
      movedTo: null,
      ...(featurePolicy === undefined ? {} : { featurePolicy }),
    });
    await runInDurableObject(t.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      expect(upsertRemoteActor(db, input(), "https://kopje.test", Date.now())).toBeDefined();
      expect(db.first("SELECT feature_policy AS p FROM accounts WHERE id = ?", id)).toEqual({
        p: F.public | F.followers,
      });
      upsertRemoteActor(db, input({ automatic: ["Public"], manual: [] }), "https://kopje.test", Date.now());
      expect(db.first("SELECT feature_policy AS p FROM accounts WHERE id = ?", id)).toEqual({ p: automatic(F.public) });
    });
    await update(2, undefined);
    expect(await policy()).toBe(0);
  });

  // feature_approval of a remote account: its halves' keys in Mastodon's order, and current_user by the viewer: alice
  // follows each actor, and each actor follows dave (stored()). missing and unknown are not overridden without a block,
  // and every answer reads denied across one. Fails if the policy is gated on mayFeatureSql (missing and unknown read
  // denied), if the followers or following test reads the other direction (alice and dave swap), or if the override
  // is dropped (the blocked answers read their policy's).
  it("presents the stored policy's keys and its answer to the viewer", async () => {
    const t = await setup();
    const answer = async (id: string, as: "alice" | "dave") =>
      (await t.api<{ feature_approval: Approval }>(`/api/v1/accounts/${id}`, as)).body.feature_approval;
    const byFollowers = await stored(t, { automaticApproval: ["$self/followers"], manualApproval: [AS_PUBLIC] });
    expect(await answer(byFollowers.id, "alice")).toEqual({
      automatic: ["followers"],
      manual: ["public"],
      current_user: "automatic",
    });
    expect((await answer(byFollowers.id, "dave")).current_user).toBe("manual");
    const byFollowing = await stored(t, { automaticApproval: ["$self/following"] });
    expect((await answer(byFollowing.id, "dave")).current_user).toBe("automatic");
    expect((await answer(byFollowing.id, "alice")).current_user).toBe("denied");
    const missing = await stored(t, undefined);
    expect(await answer(missing.id, "alice")).toEqual({ automatic: [], manual: [], current_user: "missing" });
    const unknown = await stored(t, { automaticApproval: ["https://other.example/x"], manualApproval: ["$self"] });
    expect(await answer(unknown.id, "alice")).toEqual({
      automatic: ["unsupported_policy"],
      manual: ["disabled"],
      current_user: "unknown",
    });
    const every = await stored(t, {
      automaticApproval: ["Public", "as:Public", "$self/followers", "$self/following"],
      manualApproval: ["$self"],
    });
    expect((await answer(every.id, "alice")).automatic).toEqual([
      "unsupported_policy",
      "public",
      "followers",
      "following",
    ]);
    // The whole stored bound (FEATURE_POLICY_MAX): every flag of both halves, presented as keys.
    await sql(t.store, "UPDATE accounts SET feature_policy = ? WHERE id = ?", 0xffff_ffff, every.id);
    const keys = ["unsupported_policy", "public", "followers", "following", "disabled"];
    expect(await answer(every.id, "alice")).toEqual({ automatic: keys, manual: keys, current_user: "automatic" });
    for (const { id } of [byFollowers, missing, unknown]) {
      await block(t.store, ALICE, id);
      expect((await answer(id, "alice")).current_user).toBe("denied");
    }
    await block(t.store, byFollowing.id, DAVE);
    expect((await answer(byFollowing.id, "dave")).current_user).toBe("denied");
    expect(await accountId(t.store, byFollowing.actor.uri)).toBe(byFollowing.id);
  });
});
