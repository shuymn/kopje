import { runInDurableObject } from "cloudflare:test";

import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";

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
//         hashtag common: audienceSql reads its original, and tagged=rare rejects it after the media probe passed;
//       reply: an original reply to PARTNER with one shown attachment and the hashtags rare and common: only
//         exclude_replies rejects it, after the media and tag probes passed.
//   - the hashtag cats, with the names TAG_ANY and TAG_ALL and x on every row: a match is an original with one shown
//     attachment, alternately by `local` and REMOTE. A rejected row is, by `tagKind`:
//       remote: REMOTE's, without media, with the hashtag y: local, only_media, all=[x] (it lacks x) and none=[y]
//         reject it;
//       local: `local`'s, otherwise as remote: remote=true rejects it;
//       none: `local`'s, with media and y: only none=[y] rejects it, after every all probe passed;
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

export type AccountKind = "plain" | "boost" | "reply";
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
      ...(accountKind === "plain"
        ? { reply: true, tags: ["common"] }
        : accountKind === "boost"
          ? { boost: true, withMedia: true, tags: ["common"] }
          : { reply: true, withMedia: true, tags: ["rare", "common"] }),
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
