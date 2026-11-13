import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ANSWER_BYTES, jsonBytes } from "../src/domain/answer-budget";
import {
  GROUP_ADMISSION_CANDIDATES,
  GROUP_ADMISSION_VISITS,
  GROUP_COUNT,
  GROUP_WALK,
  listGroupedNotifications,
  VISIT_CANDIDATES,
} from "../src/domain/notification-groups";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import {
  acceptQuote,
  type Answer,
  answer,
  bigStatus,
  expectByteCutWalk,
  maximalAccounts,
  ORIGIN,
  walkPages,
} from "./budget-helpers";
import { observedSql, remoteAccounts, watchedCursor } from "./read-helpers";
import { community, mute, remoteAccount, seedStatus, type User } from "./status-helpers";

// RES-3: a page of grouped notifications is within ANSWER_BYTES. Groups are admitted in discovery order, each with
// the accounts and statuses it adds; a page cut by bytes continues from its last admitted group's discovery position
// (never a group's member range), its range fields and cursors those of the groups kept, and a walk's continuation
// at GROUP_WALK is kept only when no group was left out by bytes before it.

type Group = {
  group_key: string;
  notifications_count: number;
  most_recent_notification_id: number;
  page_min_id: string;
  page_max_id: string;
  sample_account_ids: string[];
};

type Grouped = {
  accounts: { id: string }[];
  partial_accounts?: { id: string }[];
  statuses: { id: string }[];
  notification_groups: Group[];
};

// A favourite of `status` by `from`, in the status's group; its id.
async function favourite(h: ApiHarness, recipient: string, from: string, status: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    h.store,
    `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
		VALUES (?, 'favourite', ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
    recipient,
    from,
    status,
    new Date(NOW).toISOString(),
    `favourite-${status}-1`,
  );
  return row!.id;
}

// `count` notifications from `from`, each of its own type, which a mute with notifications hides.
async function hidden(h: ApiHarness, recipient: string, from: string, count: number): Promise<void> {
  await sql(
    h.store,
    `INSERT INTO notifications (account_id, type, from_account_id, created_at)
		WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?4 - 1)
		SELECT ?1, 'hidden' || i, ?2, ?3 FROM n`,
    recipient,
    from,
    new Date(NOW).toISOString(),
    count,
  );
}

// Walks the grouped list by its Link header, each group by its most recent notification's id.
async function walkGroups(h: ApiHarness, path: string, rel: "next" | "prev", token: string) {
  const groups: Group[][] = [];
  const walked = await walkPages<Grouped>(
    h,
    path,
    rel,
    token,
    (body) => body.notification_groups.map((group) => String(group.most_recent_notification_id)),
    20,
    (body) => groups.push(body.notification_groups),
  );
  return { ...walked, groups };
}

async function groupBytes(h: ApiHarness, user: User, key: string): Promise<number> {
  return (await answer<unknown>(h, `/api/v2/notifications/${key}`, user.token)).bytes;
}

async function markers(h: ApiHarness, user: User) {
  return (await answer<unknown>(h, "/api/v1/markers?timeline[]=notifications", user.token)).body;
}

describe("grouped notifications within ANSWER_BYTES (RES-3)", () => {
  it("walk every group once in both directions, cut by bytes before a walk continuation too", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    const muted = await remoteAccount(h.store, "muted");
    await mute(h.store, alice.id, muted);
    // Ten groups, more hidden notifications than a walk reads, ten groups: each group one favourite of a big status.
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      if (i === 10) {
        await hidden(h, alice.id, muted, GROUP_WALK + 100);
      }
      ids.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - (20 - i) * 60_000)));
    }
    const [first] = await sql<{ status_id: string }>(
      h.store,
      "SELECT status_id FROM notifications WHERE id = ?",
      ids[0]!,
    );
    const size = await groupBytes(h, alice, `favourite-${first!.status_id}-1`);
    const unread = await answer<{ count: number }>(h, "/api/v2/notifications/unread_count", alice.token);
    const marked = await markers(h, alice);
    const newest = ids.toReversed();
    const older = await walkGroups(h, "/api/v2/notifications?limit=20", "next", alice.token);
    expectByteCutWalk("grouped", older, newest, "next", size);
    const newer = await walkGroups(h, "/api/v2/notifications?limit=20&min_id=0", "prev", alice.token);
    expectByteCutWalk("grouped", newer, ids, "prev", size);
    for (const walked of [older, newer]) {
      // The first page found ten groups before the walk stopped at GROUP_WALK, and was cut by bytes before them:
      // its link continues from its last group, not from the walk's continuation.
      expect(walked.pages[0]!.shown.length).toBeLessThan(10);
      // The next page found the rest of those ten and stopped at GROUP_WALK: its link continues from the walk.
      const second = walked.pages[1]!;
      expect(second.shown.length + walked.pages[0]!.shown.length).toBe(10);
      expect(second.cursor).not.toBe(walked === older ? second.shown.at(-1) : second.shown[0]);
    }
    // Each group's range fields are its own notification.
    for (const group of older.groups.flat()) {
      expect(group.page_min_id).toBe(String(group.most_recent_notification_id));
      expect(group.page_max_id).toBe(String(group.most_recent_notification_id));
    }
    expect(await answer(h, "/api/v2/notifications/unread_count", alice.token)).toMatchObject({ body: unread.body });
    // The count's walk, oldest first, stops at GROUP_WALK past the oldest ten.
    expect(unread.body.count).toBe(10);
    expect(await markers(h, alice)).toEqual(marked);
  }, 600_000);

  it("continue from discovery positions with interleaved groups, the range fixed by the groups kept", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fans = await Promise.all(["f1", "f2", "f3", "f4"].map((name) => remoteAccount(h.store, name)));
    const big = async (minutes: number) => bigStatus(h, alice.id, NOW - minutes * 60_000);
    // Six groups below, then C, A, B, A again (A@100, B@95, A@90, C@80 from the newest), and six groups above:
    // eight groups of about 0.97 MB fit, the ninth does not.
    const pad = async () => favourite(h, alice.id, fans[0]!, await big(100));
    for (let i = 0; i < 6; i++) {
      await pad();
    }
    const [a, b, c] = [await big(90), await big(90), await big(90)];
    const c80 = await favourite(h, alice.id, fans[0]!, c);
    const a90 = await favourite(h, alice.id, fans[1]!, a);
    const b95 = await favourite(h, alice.id, fans[2]!, b);
    const a100 = await favourite(h, alice.id, fans[3]!, a);
    for (let i = 0; i < 6; i++) {
      await pad();
    }
    const groupOf = (page: Grouped, status: string) =>
      page.notification_groups.find((group) => group.group_key === `favourite-${status}-1`);
    // Newest first: six groups, A (at 100), B; C does not fit. The page continues from B's position, and A counts
    // both of its notifications up to the page's upper end, its oldest from B up.
    const down = await answer<Grouped>(h, "/api/v2/notifications?limit=20", alice.token);
    expect(down.body.notification_groups).toHaveLength(8);
    expect(groupOf(down.body, c)).toBeUndefined();
    expect(groupOf(down.body, a)).toMatchObject({
      notifications_count: 2,
      page_max_id: a100,
      page_min_id: a100,
      most_recent_notification_id: Number(a100),
    });
    expect(down.next).toContain(`max_id=${b95}`);
    // The next page finds A again (at 90) and C.
    const below = await answer<Grouped>(h, down.next!, alice.token);
    expect(groupOf(below.body, a)).toMatchObject({ notifications_count: 1, page_max_id: a90 });
    expect(groupOf(below.body, c)).toBeDefined();
    // Oldest first: six groups, C, A (at 90); B does not fit. The page continues from A's position, and its range
    // ends there: A counts its notification at 90 alone.
    const up = await answer<Grouped>(h, "/api/v2/notifications?limit=20&min_id=0", alice.token);
    expect(up.body.notification_groups).toHaveLength(8);
    expect(groupOf(up.body, b)).toBeUndefined();
    expect(groupOf(up.body, a)).toMatchObject({ notifications_count: 1, page_max_id: a90, page_min_id: a90 });
    expect(up.prev).toContain(`min_id=${a90}`);
    expect(groupOf(up.body, c)).toMatchObject({ page_max_id: c80 });
    const above = await answer<Grouped>(h, up.prev!, alice.token);
    expect(groupOf(above.body, b)).toMatchObject({ page_max_id: b95 });
    expect(groupOf(above.body, a)).toMatchObject({ notifications_count: 2, page_max_id: a100 });
    for (const page of [down, below, up, above]) {
      expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    }
  }, 300_000);

  it("drops the last groups when the range of the groups kept samples larger accounts", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    const large = await maximalAccounts(h, "large", 8);
    const small = await Promise.all(Array.from({ length: 8 }, (_, i) => remoteAccount(h.store, `small${i}`)));
    const a = await bigStatus(h, alice.id, NOW - 60_000);
    // A's seven oldest favourites, from large accounts, lie below min_id; then seven groups, A's eighth large
    // favourite, a group B, and eight favourites of A from small accounts.
    let min = "";
    for (const account of large.slice(0, 7)) {
      min = await favourite(h, alice.id, account, a);
    }
    const pads: string[] = [];
    for (let i = 0; i < 7; i++) {
      pads.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000)));
    }
    await favourite(h, alice.id, large[7]!, a);
    await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000));
    for (const account of small) {
      await favourite(h, alice.id, account, a);
    }
    // Walked up from min_id, B does not fit after the seven groups and A, which samples the small accounts up to
    // the walk's end. Over the range the kept groups fix, which ends at A's discovery position, A samples the eight
    // large accounts and no longer fits either: the page is the seven groups, continuing from the last.
    const up = await answer<Grouped>(h, `/api/v2/notifications?limit=20&min_id=${min}`, alice.token);
    expect(up.body.notification_groups.map((group) => String(group.most_recent_notification_id))).toEqual(
      pads.toReversed(),
    );
    expect(up.prev).toContain(`min_id=${pads.at(-1)!}`);
    expect(up.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
  }, 300_000);

  it("answers its first group alone after two passes over the kept groups still do not fit", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    const large = await maximalAccounts(h, "large", 8);
    const small = await Promise.all(Array.from({ length: 8 }, (_, i) => remoteAccount(h.store, `small${i}`)));
    // A, a quote of about 1.94 MB, and B, a small status. Below min_id, seven favourites of each from large
    // accounts. Above it, walked oldest first: six groups of about 0.97 MB, A's eighth large favourite and eight
    // small ones, B's eighth large favourite, a group C, and eight small favourites of B.
    const a = await bigStatus(h, alice.id, NOW - 60_000);
    await acceptQuote(h, a, await bigStatus(h, alice.id, NOW - 90_000));
    const b = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    let min = "";
    for (const account of large.slice(0, 7)) {
      await favourite(h, alice.id, account, a);
      min = await favourite(h, alice.id, account, b);
    }
    const pads: string[] = [];
    for (let i = 0; i < 6; i++) {
      pads.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000)));
    }
    await favourite(h, alice.id, large[7]!, a);
    for (const account of small) {
      await favourite(h, alice.id, account, a);
    }
    await favourite(h, alice.id, large[7]!, b);
    await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000));
    for (const account of small) {
      await favourite(h, alice.id, account, b);
    }
    // The first pass keeps the six groups, A and B (C does not fit). Over their range, ending at B's position, B
    // samples the large accounts and does not fit; over the range ending at A's, A samples them and does not fit
    // either. After those two passes the page is its first group alone.
    const up = await answer<Grouped>(h, `/api/v2/notifications?limit=20&min_id=${min}`, alice.token);
    expect(up.body.notification_groups.map((group) => String(group.most_recent_notification_id))).toEqual([pads[0]]);
    expect(up.body.notification_groups[0]).toMatchObject({ page_min_id: pads[0], page_max_id: pads[0] });
    expect(up.prev).toContain(`min_id=${pads[0]!}`);
    // It continues from there: the next page starts at the second group.
    const next = await answer<Grouped>(h, up.prev!, alice.token);
    expect(String(next.body.notification_groups.at(-1)!.most_recent_notification_id)).toBe(pads[1]);
  }, 300_000);

  it("refunds a partial account a later group promotes, so a page that fits only with the refund is whole", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    const [x, y] = await maximalAccounts(h, "promoted", 2);
    // Walked oldest first: G1 (x, then y: y shown whole, x partial), eight groups of about 0.97 MB, a group T whose
    // poll tunes the answer's size, and G2 (x alone), which shows x whole in place of its partial account.
    const s1 = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    await favourite(h, alice.id, x!, s1);
    await favourite(h, alice.id, y!, s1);
    for (let i = 0; i < 8; i++) {
      await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - 120_000));
    }
    const tuner = await bigStatus(h, alice.id, NOW - 120_000);
    const options = (texts: string[]) =>
      sql(h.store, "UPDATE polls SET options = ? WHERE status_id = ?", JSON.stringify(texts), tuner);
    await options(Array.from({ length: 100 }, () => ""));
    await favourite(h, alice.id, fan, tuner);
    const s2 = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    await favourite(h, alice.id, x!, s2);
    // Sized without emoji: the eight groups and T must leave G2 within the budget.
    await sql(h.store, "UPDATE statuses SET emojis = NULL");
    await sql(h.store, "UPDATE accounts SET emojis = NULL");
    const path = "/api/v2/notifications?limit=20&min_id=0&expand_accounts=partial_avatars";
    const groupsOf = (page: Answer<Grouped>) => page.body.notification_groups.map((group) => group.group_key);
    const before = await answer<Grouped>(h, path, alice.token);
    expect(groupsOf(before)).toContain(`favourite-${s2}-1`);
    // x's partial account, as G1 and the next group show it.
    const alone = await answer<Grouped>(
      h,
      "/api/v2/notifications?limit=2&min_id=0&expand_accounts=partial_avatars",
      alice.token,
    );
    const partial = jsonBytes(alone.body.partial_accounts!.find((account) => account.id === x));
    // Grow T's poll until the answer is within 100 bytes of ANSWER_BYTES: each choice's title adds its JSON bytes
    // (six for a control character, one for ASCII).
    const delta = ANSWER_BYTES - 100 - before.bytes;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(100 * 6 * 1_000);
    const each = Math.floor(delta / 100);
    const title = (bytes: number) => "\u0001".repeat(Math.floor(bytes / 6)) + "x".repeat(bytes % 6);
    await options(Array.from({ length: 100 }, (_, i) => title(each + (i === 0 ? delta - 100 * each : 0))));
    const after = await answer<Grouped>(h, path, alice.token);
    expect(after.bytes).toBe(ANSWER_BYTES - 100);
    // Counted without the refund, x's partial account would pass the budget and leave G2 out.
    expect(after.bytes + partial + 1).toBeGreaterThan(ANSWER_BYTES);
    expect(groupsOf(after)).toEqual(groupsOf(before));
    expect(after.body.accounts.map((account) => account.id)).toContain(x);
    expect(after.body.partial_accounts!.map((account) => account.id)).not.toContain(x);
  }, 300_000);

  it("reads one group's status at a time", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    for (let i = 0; i < 4; i++) {
      await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - (10 - i) * 60_000));
    }
    const tokenHash = await sha256Hex(alice.token);
    const most = await runInDurableObject(h.store, (_instance, state) => {
      let largest = 0;
      const counting = observedSql(state.storage.sql, (rows) => {
        largest = Math.max(largest, rows.filter((row) => "content" in row && !("poll_id" in row)).length);
      });
      listGroupedNotifications.run(counting, {
        credential: { tokenHash, scope: "read:notifications", now: NOW },
        page: { limit: 20 },
        types: [],
        excludeTypes: [],
        groupedTypes: null,
        includeFiltered: false,
        expandAccounts: "full",
        present: { origin: ORIGIN },
      } as never);
      return largest;
    });
    expect(most).toBe(1);
  }, 300_000);

  it("moves a partial account to the accounts when a later group shows it first", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const [x, y] = await maximalAccounts(h, "sampled", 2);
    const s1 = await bigStatus(h, alice.id, NOW - 60_000);
    const s2 = await bigStatus(h, alice.id, NOW - 120_000);
    // Newest first: G1 (y, then x), G2 (x alone).
    const g2 = await favourite(h, alice.id, x!, s2);
    await favourite(h, alice.id, x!, s1);
    await favourite(h, alice.id, y!, s1);
    const partial = await answer<Grouped>(h, "/api/v2/notifications?expand_accounts=partial_avatars", alice.token);
    expect(partial.body.notification_groups.map((group) => group.sample_account_ids)).toEqual([[y, x], [x]]);
    expect(partial.body.accounts.map((account) => account.id)).toEqual([y, x]);
    expect(partial.body.partial_accounts).toEqual([]);
    const full = await answer<Grouped>(h, "/api/v2/notifications", alice.token);
    expect(full.body.accounts.map((account) => account.id)).toEqual([y, x]);
    expect(full.body).not.toHaveProperty("partial_accounts");
    // Without G2, x stays partial, read with its partial columns only.
    const only = await answer<Grouped & { partial_accounts: Record<string, unknown>[] }>(
      h,
      `/api/v2/notifications?expand_accounts=partial_avatars&since_id=${g2}`,
      alice.token,
    );
    expect(only.body.notification_groups).toHaveLength(1);
    expect(only.body.partial_accounts.map((account) => Object.keys(account).toSorted())).toEqual([
      ["acct", "avatar", "avatar_static", "bot", "id", "locked", "url"],
    ]);
  }, 300_000);
});

// RES-7: a page of groups does its admission within one work budget, shared by every pass and the fallback.

// The most a page reads past its walk, its fallback's reserve included.
const MOST = { candidates: GROUP_ADMISSION_CANDIDATES + VISIT_CANDIDATES, visits: GROUP_ADMISSION_VISITS + 1 };

type PageInput = { limit: number; minId?: string; maxId?: string };

type GroupWork = {
  walk: number;
  candidates: number;
  visits: number;
  // The group key of each visit, in order.
  visited: string[];
  groups: string[];
  output: unknown;
};

// One run of the grouped list, its work counted from the statements it makes: the walk's candidates (windows of the
// viewer's notifications), the group reads' candidates (windows of one group through its index, rows before the rule,
// those of rejected groups and passes included) and the visits (one membersOf window each: every group here has a
// key); its groups, by their most recent notification, and its whole output, cursors included.
async function groupWork(
  h: ApiHarness,
  user: User,
  page: PageInput,
  expandAccounts: "full" | "partial_avatars",
): Promise<GroupWork> {
  const tokenHash = await sha256Hex(user.token);
  return runInDurableObject(h.store, (_instance, state) => {
    const work = { walk: 0, candidates: 0, visits: 0, visited: [] as string[] };
    const window = "SELECT CAST(n.id AS TEXT) AS id FROM main.notifications n INDEXED BY ";
    const real = state.storage.sql;
    const counting = {
      exec: (query: string, ...params: SqlStorageValue[]) =>
        watchedCursor(
          real.exec(query, ...params),
          () => {},
          (rows) => {
            if (!query.includes(window)) {
              return;
            }
            if (!query.includes(`${window}notifications_group`)) {
              work.walk += rows.length;
              return;
            }
            work.candidates += rows.length;
            if (query.includes("ORDER BY n.id DESC")) {
              work.visits += 1;
              work.visited.push(params[2] as string);
            }
          },
        ),
    } as unknown as SqlStorage;
    const result = listGroupedNotifications.run(counting, {
      credential: { tokenHash, scope: "read:notifications", now: NOW },
      page,
      types: [],
      excludeTypes: [],
      groupedTypes: null,
      includeFiltered: false,
      expandAccounts,
      present: { origin: ORIGIN },
    } as never) as { value: { notification_groups: Group[] } };
    const groups = result.value.notification_groups.map((group) => String(group.most_recent_notification_id));
    return { ...work, groups, output: result.value };
  });
}

// Within the walk's bound and the page's budget.
function expectWithinBudget(work: GroupWork) {
  expect(work.walk).toBeLessThanOrEqual(GROUP_WALK);
  expect(work.candidates).toBeLessThanOrEqual(MOST.candidates);
  expect(work.visits).toBeLessThanOrEqual(MOST.visits);
}

// A page cut by the budget to `cut.groups.length` groups answers what a page of that limit answers, cursors included,
// and that page is within the budget without a cut: one pass that visits each of its groups once.
async function expectAsLimit(
  h: ApiHarness,
  user: User,
  page: PageInput,
  expandAccounts: "full" | "partial_avatars",
  cut: GroupWork,
) {
  const limited = await groupWork(h, user, { ...page, limit: cut.groups.length }, expandAccounts);
  expect(limited.visits).toBe(cut.groups.length);
  expect(cut.output).toEqual(limited.output);
}

// The id of the viewer's newest notification.
async function newestId(h: ApiHarness): Promise<string> {
  const [row] = await sql<{ id: string }>(h.store, "SELECT CAST(max(id) AS TEXT) AS id FROM notifications");
  return row!.id;
}

// `count` remote accounts of one domain (remoteAccounts), the only accounts of it; the domain.
async function manyAccounts(h: ApiHarness, count: number): Promise<string> {
  const base = 510_000_000_000_000_000n;
  await remoteAccounts(h, 1, count, base);
  const [row] = await sql<{ domain: string }>(h.store, "SELECT domain FROM accounts WHERE id = ?", String(base));
  return row!.domain;
}

// The viewer mutes every account of `domain`, which hides their notifications (R15).
async function muteAll(h: ApiHarness, viewer: User, domain: string) {
  await sql(
    h.store,
    "INSERT INTO mutes (account_id, target_account_id) SELECT ?, id FROM accounts WHERE domain = ?",
    viewer.id,
    domain,
  );
}

// For each of `statuses`, favourites from the accounts of `domain`, `count` of them from `offset` in id order, in the
// status's group.
async function favouritesFrom(
  h: ApiHarness,
  viewer: User,
  domain: string,
  statuses: readonly string[],
  count: number,
  offset = 0,
) {
  for (const status of statuses) {
    await sql(
      h.store,
      `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
			SELECT ?1, 'favourite', id, ?2, ?3, ?4 FROM accounts WHERE domain = ?5 ORDER BY id LIMIT ?6 OFFSET ?7`,
      viewer.id,
      status,
      new Date(NOW).toISOString(),
      `favourite-${status}-1`,
      domain,
      count,
      offset,
    );
  }
}

async function smallStatuses(h: ApiHarness, viewer: User, count: number): Promise<string[]> {
  const statuses: string[] = [];
  for (let i = 0; i < count; i++) {
    statuses.push(await seedStatus(h.store, { accountId: viewer.id, visibility: "public" }));
  }
  return statuses;
}

// `count` favourite groups of small statuses of the viewer's, each of `members` favourites from many accounts (muted
// with `hidden`, R15), older than every group's newest, which is one from a fan, in the groups' order: walked either
// way, the newest are the groups' discovery positions, and a group reads its members and from a page's lower end up its
// newest alone. The newest ones' ids, and the id just below them.
async function headedGroups(h: ApiHarness, viewer: User, count: number, members: number, hidden: boolean) {
  const domain = await manyAccounts(h, members);
  if (hidden) {
    await muteAll(h, viewer, domain);
  }
  const statuses = await smallStatuses(h, viewer, count);
  await favouritesFrom(h, viewer, domain, statuses, members);
  const below = await newestId(h);
  const fan = await remoteAccount(h.store, "fan");
  const heads: string[] = [];
  for (const status of statuses) {
    heads.push(await favourite(h, viewer.id, fan, status));
  }
  return { heads, below };
}

// The pass's groups when the budget runs out, as the pre-check of each read allows: a group's GROUP_COUNT window is
// read while it still fits, and each visit reads `perVisit`.
function admissible(perVisit: number): number {
  return Math.floor((GROUP_ADMISSION_CANDIDATES - GROUP_COUNT) / perVisit) + 1;
}

describe("grouped notifications within one work budget (RES-7)", () => {
  it("answers whole a page whose reads fit the budget", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    // Forty groups of 150 favourites: 6,040 candidates in all, read 400 at a time.
    const { heads, below } = await headedGroups(h, alice, 40, 149, false);
    for (const expandAccounts of ["full", "partial_avatars"] as const) {
      for (const page of [{ limit: 40 }, { limit: 40, minId: below }]) {
        const work = await groupWork(h, alice, page, expandAccounts);
        expectWithinBudget(work);
        expect([work.visits, work.candidates, work.groups.length]).toEqual([40, 40 * 151, heads.length]);
      }
    }
  }, 300_000);

  it.each([
    ["150 favourites", 149, false],
    ["GROUP_COUNT, all but the newest hidden", GROUP_COUNT - 1, true],
  ] as const)(
    "keeps the groups a cut pass admitted when its reads hold for them, in both directions (80 groups of %s)",
    async (_name, members, hidden) => {
      const h = await community(["alice"]);
      const { alice } = h.users;
      const { heads, below } = await headedGroups(h, alice, 80, members, hidden);
      const kept = admissible(members + 2);
      expect(kept).toBeLessThan(heads.length);
      for (const expandAccounts of ["full", "partial_avatars"] as const) {
        for (const [page, expected] of [
          [{ limit: 80 }, heads.slice(-kept).toReversed()],
          [{ limit: 80, minId: below }, heads.slice(0, kept).toReversed()],
        ] as const) {
          const work = await groupWork(h, alice, page, expandAccounts);
          expectWithinBudget(work);
          // The groups of the pass, read once: nothing is read again for the shorter page.
          expect([work.visits, work.candidates, work.groups]).toEqual([kept, kept * (members + 2), expected]);
          await expectAsLimit(h, alice, page, expandAccounts, work);
        }
      }
    },
    300_000,
  );

  it("falls back to the first group when the reads do not hold for a shorter page, in both directions", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    // Twenty groups of GROUP_COUNT - 2 hidden favourites and, in the groups' order, two of each from two fans, older
    // then newer: on a shorter page, newest first, the last group's oldest lies below the page; oldest first, its
    // newer favourite lies above it.
    const domain = await manyAccounts(h, GROUP_COUNT - 2);
    await muteAll(h, alice, domain);
    const statuses = await smallStatuses(h, alice, 20);
    await favouritesFrom(h, alice, domain, statuses, GROUP_COUNT - 2);
    const below = await newestId(h);
    const [older, newer] = [await remoteAccount(h.store, "older"), await remoteAccount(h.store, "newer")];
    const pairs: [string, string][] = [];
    for (const status of statuses) {
      pairs.push([await favourite(h, alice.id, older, status), await favourite(h, alice.id, newer, status)]);
    }
    for (const expandAccounts of ["full", "partial_avatars"] as const) {
      for (const [page, first] of [
        [{ limit: 20 }, pairs.at(-1)![1]],
        [{ limit: 20, minId: below }, pairs[0]![0]],
      ] as const) {
        const work = await groupWork(h, alice, page, expandAccounts);
        expectWithinBudget(work);
        // The pass's visits, then the fallback's of the first group.
        expect(work.visits).toBeGreaterThan(1);
        expect(work.visited.at(-1)).toBe(work.visited[0]);
        expect(work.groups).toEqual([first]);
        await expectAsLimit(h, alice, page, expandAccounts, work);
      }
    }
  }, 300_000);

  it("keeps no group whose oldest the pass did not find shown, newest first", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    // Twenty groups as headedGroups makes them, all but the newest of each hidden; the newest group G also has
    // GROUP_COUNT hidden favourites right above the oldest group's newest and a shown one just below its own newest.
    // From the page's lower end G's GROUP_COUNT candidates are all hidden, so its oldest stands at its newest; on a
    // shorter page, from a higher lower end, it is the shown one.
    const domain = await manyAccounts(h, 2 * GROUP_COUNT);
    await muteAll(h, alice, domain);
    const statuses = await smallStatuses(h, alice, 20);
    await favouritesFrom(h, alice, domain, statuses, GROUP_COUNT - 1);
    const [fan, other] = [await remoteAccount(h.store, "fan"), await remoteAccount(h.store, "other")];
    const heads = [await favourite(h, alice.id, fan, statuses[0]!)];
    await favouritesFrom(h, alice, domain, statuses.slice(-1), GROUP_COUNT, GROUP_COUNT - 1);
    for (const status of statuses.slice(1, -1)) {
      heads.push(await favourite(h, alice.id, fan, status));
    }
    await favourite(h, alice.id, other, statuses.at(-1)!);
    heads.push(await favourite(h, alice.id, fan, statuses.at(-1)!));
    for (const expandAccounts of ["full", "partial_avatars"] as const) {
      const work = await groupWork(h, alice, { limit: 20 }, expandAccounts);
      expectWithinBudget(work);
      expect(work.visited.at(-1)).toBe(work.visited[0]);
      expect(work.groups).toEqual([heads.at(-1)]);
      await expectAsLimit(h, alice, { limit: 20 }, expandAccounts, work);
    }
  }, 300_000);

  it("walks every group once by its Link when the budget cuts its pages, in both directions", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const { heads, below } = await headedGroups(h, alice, 80, GROUP_COUNT - 1, true);
    const kept = admissible(GROUP_COUNT + 1);
    await sql(
      h.store,
      "INSERT INTO markers (account_id, timeline, last_read_id, updated_at) VALUES (?, 'notifications', ?, ?)",
      alice.id,
      below,
      new Date(NOW).toISOString(),
    );
    const unread = await answer<{ count: number }>(h, "/api/v2/notifications/unread_count", alice.token);
    const marked = await markers(h, alice);
    const ids = (body: Grouped) => body.notification_groups.map((group) => String(group.most_recent_notification_id));
    const path = "/api/v2/notifications?limit=80";
    const older = await walkPages<Grouped>(h, path, "next", alice.token, ids, 20);
    expect(older.ids).toEqual(heads.toReversed());
    expect(older.pages[0]).toMatchObject({ shown: heads.slice(-kept).toReversed(), cursor: heads.at(-kept) });
    const newer = await walkPages<Grouped>(h, `${path}&min_id=${below}`, "prev", alice.token, ids, 20);
    expect(newer.ids).toEqual(heads);
    expect(newer.pages[0]).toMatchObject({ shown: heads.slice(0, kept).toReversed(), cursor: heads[kept - 1] });
    // The unread count is of every group above the marker, not of a page, and reading pages moves no marker.
    expect(unread.body.count).toBe(heads.length);
    expect(await answer(h, "/api/v2/notifications/unread_count", alice.token)).toMatchObject({ body: unread.body });
    expect(await markers(h, alice)).toEqual(marked);
  }, 300_000);

  it("charges the passes a byte cut repeats to the same budget", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    const domain = await manyAccounts(h, 2 * GROUP_COUNT);
    // The measured worst case's shape, scaled: ten groups of big statuses (about 0.97 MB each, eight fit an answer),
    // each with GROUP_COUNT favourites below min_id, one from a fan above it, in the groups' order, and GROUP_COUNT
    // more above those. Walked up from min_id, the first pass is cut by bytes at the ninth group, and its eight are
    // admitted again over their own range until the budget runs out.
    const statuses: string[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push(await bigStatus(h, alice.id, NOW - (20 - i) * 60_000));
    }
    await favouritesFrom(h, alice, domain, statuses, GROUP_COUNT);
    const below = await newestId(h);
    const heads: string[] = [];
    for (const status of statuses) {
      heads.push(await favourite(h, alice.id, fan, status));
    }
    await favouritesFrom(h, alice, domain, statuses, GROUP_COUNT, GROUP_COUNT);
    const second = `favourite-${statuses[1]}-1`;
    for (const expandAccounts of ["full", "partial_avatars"] as const) {
      const page = { limit: heads.length, minId: below };
      const work = await groupWork(h, alice, page, expandAccounts);
      expectWithinBudget(work);
      // The first pass visits nine groups; the second visits the second group again.
      expect(work.visited.slice(0, 9)).toEqual(statuses.slice(0, 9).map((status) => `favourite-${status}-1`));
      expect(work.visited.filter((key) => key === second)).toHaveLength(2);
      expect(work.groups).toEqual(heads.slice(0, work.groups.length).toReversed());
      expect(work.groups.length).toBeLessThan(8);
      await expectAsLimit(h, alice, page, expandAccounts, work);
    }
  }, 300_000);

  it("visits at most GROUP_ADMISSION_VISITS groups in its passes", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan");
    // Sixty groups of one favourite each, of statuses of about 0.16 MB: about fifty fit an answer, and the groups
    // kept fit again, so two passes would visit about a hundred groups.
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(await favourite(h, alice.id, fan, await bigStatus(h, alice.id, NOW - (100 - i) * 60_000, {}, 6)));
    }
    for (const expandAccounts of ["full", "partial_avatars"] as const) {
      const work = await groupWork(h, alice, { limit: 80 }, expandAccounts);
      expectWithinBudget(work);
      expect(work.visits).toBe(GROUP_ADMISSION_VISITS);
      expect(work.groups).toEqual(ids.slice(-work.groups.length).toReversed());
      await expectAsLimit(h, alice, { limit: 80 }, expandAccounts, work);
    }
  }, 300_000);

  it("finds a group's oldest as one window of GROUP_COUNT candidates does, across its windows and at large ids", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const domain = await manyAccounts(h, GROUP_COUNT);
    await muteAll(h, alice, domain);
    const [z, older, newer] = [
      await remoteAccount(h.store, "z"),
      await remoteAccount(h.store, "older"),
      await remoteAccount(h.store, "newer"),
    ];
    // A group Z, then `run` hidden favourites of a group G, an older and a newer shown one: a page of two from G's newer
    // one down reads G's oldest from Z up, the older one if it is among the GROUP_COUNT candidates there, else its
    // newer one, which stands for it.
    const oldestAfter = async (run: number) => {
      await favourite(h, alice.id, z, await seedStatus(h.store, { accountId: alice.id, visibility: "public" }));
      const [status] = await smallStatuses(h, alice, 1);
      await favouritesFrom(h, alice, domain, [status!], run);
      const a = await favourite(h, alice.id, older, status!);
      const b = await favourite(h, alice.id, newer, status!);
      const page = await answer<Grouped>(h, `/api/v2/notifications?limit=2&max_id=${BigInt(b) + 1n}`, alice.token);
      const group = page.body.notification_groups.find((each) => each.group_key === `favourite-${status}-1`);
      return [run, group?.page_min_id, run < GROUP_COUNT ? a : b];
    };
    const runs = [0, 7, 8, 9, 15, 16, 17, 31, 32, 33, GROUP_COUNT - 1, GROUP_COUNT];
    for (const run of runs) {
      const [, found, expected] = await oldestAfter(run);
      expect([run, found]).toEqual([run, expected]);
    }
    // Ids past 2^53, which a double would round.
    await sql(
      h.store,
      `INSERT INTO notifications (id, account_id, type, from_account_id, created_at)
			VALUES (CAST(? AS INTEGER), ?, 'follow', ?, ?)`,
      "9007199254740993",
      alice.id,
      z,
      new Date(NOW).toISOString(),
    );
    for (const run of [8, GROUP_COUNT - 1, GROUP_COUNT]) {
      const [, found, expected] = await oldestAfter(run);
      expect(BigInt(String(expected))).toBeGreaterThan(9_007_199_254_740_993n);
      expect([run, found]).toEqual([run, expected]);
    }
  }, 300_000);
});
