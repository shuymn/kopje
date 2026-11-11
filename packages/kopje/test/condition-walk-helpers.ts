import { runInDurableObject } from "cloudflare:test";

import type { StoreStub } from "../src/platform/store-client";
import type { StoreOperation } from "../src/platform/store-kernel";
import type { ApiHarness } from "./api-helpers";
import { NOW } from "./app-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";

// The most rounds a condition walk (walkedWindow, src/domain/windows.ts) runs for a page, over limits 1 to 40 and 1 to
// 5 streams: derived by test/condition-walk.test.ts (a limit of 1 on one stream: 40, 40, 80, 160, 320, 640, 720).
export const CONDITION_WALK_ROUNDS = 7;

// Worlds for the reads with request conditions (account statuses' only_media, tagged and exclude_replies; a hashtag
// timeline's local, remote, only_media, all and none). Two sections, each with `older` matches below `rejected` rows
// and `newer` matches above them, every row public and within every viewer's audience:
//   - the account's statuses (author `account`, local): a match is an original with one shown attachment and the
//     hashtags rare and common, not a reply. A rejected row is, by `accountKind`:
//       plain: an original reply to PARTNER without media, tagged common: every condition rejects it alone;
//       boost: a boost of a public original of PARTNER's (each original its own), with one shown attachment and the
//         hashtag common: audienceSql reads its original, and tagged=rare rejects it;
//       reply: an original reply to PARTNER with one shown attachment and the hashtags rare and common: only
//         exclude_replies rejects it;
//       untagged: an original with one shown attachment and the hashtag common: only tagged=rare rejects it;
//       bare: an original with the hashtags rare and common, without media: only only_media rejects it.
//     Which probes a rejection runs depends on the order the plan tests the conditions in (the reply check, a
//     column test, comes first): the last three each reject by one condition, so one of them takes the costliest path.
//   - the hashtag cats, with the names TAG_ANY and TAG_ALL and x on every row: a match is an original with one shown
//     attachment, alternately by `local` and REMOTE. A rejected row is, by `tagKind`:
//       remote: REMOTE's, without media, with the hashtag y: local, only_media, all=[x] (it lacks x) and none=[y]
//         reject it;
//       local: `local`'s, otherwise as remote: remote=true rejects it;
//       none: `local`'s, with media and y: only none (y among four names) rejects it, after every all probe passed;
//       author: REMOTE's, with media and without y: only local=true rejects it, after every name probe passed.
export const REMOTE = "700000000000000003";
export const PARTNER = "700000000000000004";
export const TAG_ANY = ["n1", "n2", "n3", "n4"];
export const TAG_ALL = ["a1", "a2", "a3", "a4"];

export const ACCOUNT_OLDER = 100000000000000000n;
export const ACCOUNT_REJECTED = 300000000000000000n;
export const ACCOUNT_NEWER = 400000000000000000n;
export const TAG_OLDER = 500000000000000000n;
export const TAG_REJECTED = 600000000000000000n;
export const TAG_NEWER = 700000000000000000n;
// PARTNER's originals that `boost` rows boost.
const BOOSTED = 800000000000000000n;
const MEDIA = 900000000000000000n;

export type AccountKind = "plain" | "boost" | "reply" | "untagged" | "bare";
export type TagKind = "remote" | "local" | "none" | "author";

export type ConditionWorld = {
  account: string;
  local: string;
  rejected: number;
  older?: number;
  newer?: number;
  accountKind?: AccountKind;
  tagKind?: TagKind;
};

export const statusIds = (base: bigint, count: number) =>
  Array.from({ length: count }, (_, i) => String(base + BigInt(count - 1 - i)));

// Seeds the world into `store`, whose `account` and `local` accounts exist; adds REMOTE and PARTNER.
export async function seedConditionWorld(store: StoreStub, w: ConditionWorld): Promise<void> {
  const older = w.older ?? 30;
  const newer = w.newer ?? 0;
  const accountKind = w.accountKind ?? "plain";
  const tagKind = w.tagKind ?? "remote";
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const at = new Date(NOW).toISOString();
    for (const [account, name] of [
      [REMOTE, "remote"],
      [PARTNER, "partner"],
    ] as const) {
      sql.exec(
        "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'far.example')",
        account,
        `https://far.example/users/${name}`,
        name,
      );
    }
    let media = MEDIA;
    // `count` statuses from `base`: by `author` (or, with `alternate`, every other one by it), a reply to PARTNER or
    // a boost of PARTNER's original from BOOSTED + the same offset, with one shown attachment when `withMedia`, and
    // public rows of `tags`.
    const statuses = (
      base: bigint,
      count: number,
      row: {
        author: string;
        alternate?: string;
        reply?: boolean;
        boost?: boolean;
        withMedia?: boolean;
        tags: string[];
      },
    ) => {
      if (count === 0) {
        return;
      }
      const n = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)`;
      if (row.boost === true) {
        sql.exec(
          `${n} INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
					SELECT CAST(?2 + i AS TEXT), 'https://far.example/objects/' || (?2 + i), ?3, 'public', '<p>o</p>', ?4 FROM n`,
          count,
          String(BOOSTED + (base - ACCOUNT_REJECTED)),
          PARTNER,
          at,
        );
      }
      sql.exec(
        `${n} INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id, in_reply_to_uri,
					in_reply_to_account_id)
				SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/objects/' || (?2 + i),
					CASE WHEN ?4 IS NOT NULL AND i % 2 = 1 THEN ?4 ELSE ?3 END, 'public', iif(?7, '', '<p>s</p>'), ?5,
					CASE WHEN ?7 THEN CAST(?8 + i AS TEXT) END,
					CASE WHEN ?6 THEN 'https://far.example/objects/parent' END, CASE WHEN ?6 THEN ?9 END
				FROM n`,
        count,
        String(base),
        row.author,
        row.alternate ?? null,
        at,
        row.reply === true ? 1 : 0,
        row.boost === true ? 1 : 0,
        String(BOOSTED + (base - ACCOUNT_REJECTED)),
        PARTNER,
      );
      if (row.withMedia === true) {
        sql.exec(
          `${n} INSERT INTO media_attachments (id, account_id, status_id, type, url)
					SELECT CAST(?3 + i AS TEXT), s.account_id, s.id, 'image', 'https://kopje.test/m.png'
					FROM n CROSS JOIN statuses s ON s.id = CAST(?2 + i AS TEXT)`,
          count,
          String(base),
          String(media),
        );
        media += BigInt(count);
      }
      for (const tag of row.tags) {
        sql.exec(
          `${n} INSERT INTO status_tags (status_id, name, public) SELECT CAST(?2 + i AS TEXT), ?3, 1 FROM n`,
          count,
          String(base),
          tag,
        );
      }
    };
    const accountMatch = { author: w.account, withMedia: true, tags: ["rare", "common"] };
    statuses(ACCOUNT_OLDER, older, accountMatch);
    statuses(ACCOUNT_REJECTED, w.rejected, {
      author: w.account,
      ...{
        plain: { reply: true, tags: ["common"] },
        boost: { boost: true, withMedia: true, tags: ["common"] },
        reply: { reply: true, withMedia: true, tags: ["rare", "common"] },
        untagged: { withMedia: true, tags: ["common"] },
        bare: { tags: ["rare", "common"] },
      }[accountKind],
    });
    statuses(ACCOUNT_NEWER, newer, accountMatch);
    const names = ["cats", ...TAG_ANY];
    const tagMatch = { author: w.local, alternate: REMOTE, withMedia: true, tags: [...names, ...TAG_ALL, "x"] };
    statuses(TAG_OLDER, older, tagMatch);
    statuses(
      TAG_REJECTED,
      w.rejected,
      tagKind === "remote"
        ? { author: REMOTE, tags: [...names, ...TAG_ALL, "y"] }
        : tagKind === "local"
          ? { author: w.local, tags: [...names, ...TAG_ALL, "y"] }
          : tagKind === "none"
            ? { author: w.local, withMedia: true, tags: [...names, ...TAG_ALL, "x", "y"] }
            : { author: REMOTE, withMedia: true, tags: [...names, ...TAG_ALL, "x"] },
    );
    statuses(TAG_NEWER, newer, tagMatch);
  });
}

// The matches of the hashtag section, newest first: all of them, or those by the local or the remote author.
export function tagMatches(older: number, newer: number, by: "all" | "local" | "remote"): string[] {
  const keep = (base: bigint, count: number) =>
    statusIds(base, count).filter((id) => {
      const odd = (BigInt(id) - base) % 2n === 1n;
      return by === "all" || (by === "remote" ? odd : !odd);
    });
  return [...keep(TAG_NEWER, newer), ...keep(TAG_OLDER, older)];
}

export function accountMatches(older: number, newer: number): string[] {
  return [...statusIds(ACCOUNT_NEWER, newer), ...statusIds(ACCOUNT_OLDER, older)];
}

// The growth of a stale-statistics witness (RES-7), with ids above every other status: GROWTH of each kind of row the
// conditions reject, `account`'s public replies to another account without media and with the hashtag dogs, and other
// accounts' public posts with the hashtag `tag` (remote ones, which a local timeline rejects); 100 unrelated local and
// 100 remote accounts; other accounts' media posts; and public rows of other names, after `tag` (a walk down to the
// end of a name reads the entry just past it).
export const GROWTH = 2_100;
const GROWN_ACCOUNT = 960000000000000000n;
const GROWN_STATUS = 970000000000000000n;
const GROWN_MEDIA = 980000000000000000n;

export async function growConditionWorld(store: StoreStub, account: string, tag: string): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const at = new Date(NOW).toISOString();
    const n = (count: number) =>
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${count} - 1)`;
    sql.exec(
      `${n(200)} INSERT INTO accounts (id, uri, username, domain)
			SELECT CAST(?1 + i AS TEXT), 'https://' || iif(i % 2 = 0, 'grown.example', 'kopje.test') || '/users/g' || i, 'g' || i,
				iif(i % 2 = 0, 'grown.example', NULL)
			FROM n`,
      String(GROWN_ACCOUNT),
    );
    // ?1 the first id, ?2 the author (NULL: the grown accounts in turn), ?3 a reply's partner, ?4 the time.
    const statuses = (first: bigint, author: string | null, partner: string | null) =>
      sql.exec(
        `${n(GROWTH)} INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, in_reply_to_uri,
					in_reply_to_account_id)
				SELECT CAST(?1 + i AS TEXT), 'https://grown.example/objects/' || (?1 + i),
					coalesce(?2, CAST(?5 + (i % 100) * 2 AS TEXT)), 'public', '<p>g</p>', ?4,
					CASE WHEN ?3 IS NOT NULL THEN 'https://grown.example/objects/parent' END, ?3
				FROM n`,
        String(first),
        author,
        partner,
        at,
        String(GROWN_ACCOUNT),
      );
    const tags = (first: bigint, name: string) =>
      sql.exec(
        `${n(GROWTH)} INSERT INTO status_tags (status_id, name, public) SELECT CAST(?1 + i AS TEXT), ?2, 1 FROM n`,
        String(first),
        name,
      );
    const replies = GROWN_STATUS;
    const remote = GROWN_STATUS + 10_000n;
    const media = GROWN_STATUS + 20_000n;
    statuses(replies, account, String(GROWN_ACCOUNT));
    tags(replies, "dogs");
    statuses(remote, null, null);
    tags(remote, tag);
    tags(remote, "parrots");
    statuses(media, null, null);
    sql.exec(
      `${n(GROWTH)} INSERT INTO media_attachments (id, account_id, status_id, type, url)
			SELECT CAST(?1 + i AS TEXT), s.account_id, s.id, 'image', 'u' FROM n CROSS JOIN statuses s ON s.id = CAST(?2 + i AS TEXT)`,
      String(GROWN_MEDIA),
      String(media),
    );
  });
}

// The tables a condition walk's statements read, under the aliases they give them: none may be scanned (RES-7).
export const WALKED_TABLES = [
  "s",
  "pa",
  "t",
  "um",
  "ut",
  "st",
  "pm",
  "statuses",
  "accounts",
  "status_tags",
  "media_attachments",
];
// A walk's round statements, its condition statements, and the rule's over its candidates.
export const WALK_STATEMENTS =
  /INDEXED BY (?:statuses_account(?:_originals)?|status_tags_public)\b|FROM json_each\(\?\d\) c\s+CROSS JOIN (?:main\.)?statuses s\b/;

// The stale-statistics witness of a read with request conditions (RES-7): the plans and rows of its walk's statements
// on a small world ANALYZEd before growConditionWorld grows it. The caller asserts that no statement scans a walked
// table, that a round seeks `index`, and that the page below the fixed cursor reads the same rows before and after.
export async function staleWalk(
  h: Pick<ApiHarness, "store">,
  grow: { account: string; tag: string },
  index: RegExp,
  operation: StoreOperation<never, unknown>,
  input: unknown,
): Promise<{ before: number; after: number; scans: string[]; indexed: boolean[] }> {
  const scans: string[] = [];
  const indexed: boolean[] = [];
  const capture = async () => {
    const { plans } = await plannedRun(h, WALK_STATEMENTS, operation, input as never);
    for (const statement of plans) {
      scans.push(...scansOf(statement.plan, WALKED_TABLES));
    }
    indexed.push(plans.some((statement) => statement.plan.some((detail) => index.test(detail))));
    return plans.reduce((sum, statement) => sum + statement.rows, 0);
  };
  const { before, after } = await staleStatistics(h, {
    capture,
    grow: () => growConditionWorld(h.store, grow.account, grow.tag),
  });
  return { before, after, scans, indexed };
}
