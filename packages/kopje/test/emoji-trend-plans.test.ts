import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { deleteAnnouncement, listAnnouncements, streamedAnnouncementReaction } from "../src/domain/announcements";
import { localEmojiSnapshot } from "../src/domain/custom-emojis";
import { adminEmojis, completeEmoji, customEmojis, localEmojiObjectOf } from "../src/domain/local-emojis";
import { completeMedia } from "../src/domain/media";
import { adminTrendStatuses } from "../src/domain/trends";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { ACCESS, ensureAdmin } from "./ops-helpers";
import { statementId } from "./plan-audit";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// RES-7 witnesses of the emoji, media, announcement-reaction and admin trend reads that a pin rewrote, each run side by
// side with main's statement (MAIN: main's audited SQL, each guarded by its audit identity) with the same parameters,
// in a savepoint rolled back before the rewrite runs, under the plan audit's singleton statistics and after ANALYZE.
// Each rewrite returns main's rows (and deletes as many) and reads no more than main after ANALYZE. Its reads stay the
// same as its neighbours grow on both sides of its keys (accounts, media, emoji, announcements, reactions and statuses
// whose ids sort below and above the subject's) and as the subject's own key grows past what it reads (the emoji past
// an admin page's cursor); a read that walks its own population (an announcement's own reactions, the enabled emoji,
// the trend list, the last two within their stored caps) grows by at most its stated rows per row walked. The own keys
// grow in a world small enough that they are most of their table. The import-shaped rows main's writers do not
// produce: reactions sharing a name (a name's group shows its first reaction's emoji), and trend scores that tie.

const OWNER = "600000000000000001";
const OWNER_URI = "https://kopje.test/ap/users/owner";
const SUBJECT = "550000000000000000";
const PENDING = "550000000000000001";
const PENDING_TOKEN = "p".repeat(32);
const ANNOUNCEMENT = "550000000000000002";
const OTHER_ANNOUNCEMENT = "550000000000000003";
const AT = new Date(NOW).toISOString();
const STATISTICS = ["singleton", "analyzed"] as const;

// main's audited statements (origin/main as of #1468 group 7), by their audit identity.
const MAIN = {
  // completeMedia
  "4ec0ae054c56140a":
    "SELECT m.file_token AS token, a.uri, m.processed, m.url, m.created_at FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.account_id = ?",
  // completeEmoji's uploader
  b2ba7bd7c87d186e:
    "SELECT a.uri FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.file_token = ? AND m.processed = 0 AND m.created_at > ? AND m.status_id IS NULL AND m.scheduled_status_id IS NULL",
  // emojiById
  "80b7909111a47fc3":
    "SELECT e.id, e.shortcode, m.url, e.category, e.visible_in_picker, e.disabled, e.created_at FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?",
  // localEmojiObjectOf
  "8f2413f482d1c147":
    "SELECT e.id, e.shortcode, e.created_at, m.content_type, m.url FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?",
  // adminEmojis
  "8d54bf10c382eb21":
    "SELECT e.id, e.shortcode, m.url, e.category, e.visible_in_picker, e.disabled, e.created_at FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id > ?1 ORDER BY e.id LIMIT ?2",
  // customEmojis
  "9ce2b4bc7b5d421c":
    "SELECT e.shortcode, e.category, m.url FROM custom_emojis e INDEXED BY custom_emojis_enabled JOIN media_attachments m ON m.id = e.id WHERE e.disabled = 0 AND e.visible_in_picker = 1 ORDER BY e.shortcode LIMIT ?",
  // localEmojiSnapshot
  "8a60356d41a087d5":
    "SELECT j.key AS i, e.shortcode, m.url FROM json_each(?1) j CROSS JOIN custom_emojis e INDEXED BY custom_emojis_enabled ON e.shortcode = j.value AND e.disabled = 0 JOIN media_attachments m ON m.id = e.id",
  // reactionRows with a name
  cf99c3ed84341d2c:
    "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 AND name = ?3 GROUP BY name) g JOIN announcement_reactions r ON r.id = g.first LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id ORDER BY g.first LIMIT 8",
  // reactionRows
  "4b444c31c87c91ff":
    "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 GROUP BY name) g JOIN announcement_reactions r ON r.id = g.first LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id ORDER BY g.first LIMIT 8",
  // deleteAnnouncement's reactions
  "8b964bbf6af22772": "DELETE FROM announcement_reactions WHERE announcement_id = ?",
  // adminStatusRows, a page
  bae3ad0bc2fa20e3:
    "SELECT t.status_id AS id, CASE WHEN length(CAST(s.url AS BLOB)) <= 4096 THEN s.url END AS url, s.account_id, CAST(substr(CAST(CASE WHEN length(CAST(a.username AS BLOB)) = length(a.username) AND a.username NOT GLOB '*[^A-Za-z0-9_.-]*' THEN CASE WHEN length(CAST(a.username AS BLOB)) <= 255 THEN a.username ELSE substr(a.username, 1, 255) END ELSE substr(a.username, 1, 42) END AS BLOB), 1, 255) AS TEXT) AS username, CAST(substr(CAST(a.domain AS BLOB), 1, 253) AS TEXT) AS domain, (CASE WHEN length(CAST(s.published_at AS BLOB)) = 24 AND substr(s.published_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at) = s.published_at THEN s.published_at END) AS published_at, CASE WHEN s.language IN (SELECT value FROM json_each(?1)) THEN s.language END AS language, t.score, (SELECT v.trendable FROM status_trend_reviews v WHERE v.status_id = t.status_id) AS status_review, (SELECT v.trendable FROM account_trend_reviews v WHERE v.account_id = t.account_id) AS account_review, CAST(substr(CAST(s.content AS BLOB), 1, 4000) AS TEXT) AS content FROM trend_statuses t CROSS JOIN statuses s ON s.id = t.status_id CROSS JOIN accounts a ON a.id = t.account_id WHERE 1 ORDER BY t.score DESC, t.status_id DESC LIMIT ?2 OFFSET ?3",
} as const;

const FEW = 200;
const MANY = 400;

type Side = {
  query: string;
  mine: { rows: number; written: number; result: SqlRow[] };
  main: { rows: number; written: number; result: SqlRow[] };
};

const ROLLBACK = new Error("rolled back");

// A SqlStorage over `real` that, for each statement matching `pattern`, first runs `main(statement)` with the same
// parameters in a nested transaction it rolls back, then the statement itself, recording both one `Side`.
function sideBySide(
  real: SqlStorage,
  transact: <T>(fn: () => T) => T,
  pattern: RegExp,
  main: (query: string) => string,
  sides: Side[],
): SqlStorage {
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      if (!pattern.test(query)) {
        return real.exec(query, ...params);
      }
      const side: Side = {
        query,
        mine: { rows: 0, written: 0, result: [] },
        main: { rows: 0, written: 0, result: [] },
      };
      try {
        transact(() => {
          const cursor = real.exec<SqlRow>(main(query), ...params);
          side.main.result = cursor.toArray();
          side.main.rows = cursor.rowsRead;
          side.main.written = cursor.rowsWritten;
          throw ROLLBACK;
        });
      } catch (error) {
        if (error !== ROLLBACK) {
          throw error;
        }
      }
      sides.push(side);
      const cursor = real.exec<SqlRow>(query, ...params);
      return watchedCursor(
        cursor,
        () => {
          side.mine.rows += cursor.rowsRead;
          side.mine.written = cursor.rowsWritten;
        },
        (rows) => (side.mine.result = rows),
      );
    },
  } as unknown as SqlStorage;
}

// The owner (local, the uploader of every image), `n` local accounts on each side of the subject's ids, each with a
// kept PNG upload and an enabled emoji of it (shortcodes a… and z…, a third out of the picker), a reaction to the other
// announcement, and the first n / 4 of each side a trending status with a tied score (at most 250 in all,
// trend_statuses_cap); between the sides, the subject emoji (m_subject), a pending upload of the owner, and the
// announcement and the other one.
async function world(n: number): Promise<StoreStub> {
  const store = await migratedStore();
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    const local = (id: string, name: string, uri: string) => {
      sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)", id, uri, name);
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')`,
        id,
        `${name}@example.com`,
      );
    };
    local(OWNER, "owner", OWNER_URI);
    sql.exec(
      "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write')",
    );
    sql.exec(
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('owner', 'access', 'app', ?, 'read write')",
      OWNER,
    );
    const image = (id: string, owner: string, token: string, processed: number) =>
      sql.exec(
        `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta, processed,
					gc_at, created_at)
				VALUES (?1, ?2, 'image', ?3, ?3, ?4, 'image/png', '{"original":{"width":16,"height":16}}', ?5, NULL, ?6)`,
        id,
        owner,
        processed === 1 ? `https://kopje.test/media/${token}/full.png` : "",
        token,
        processed,
        AT,
      );
    for (const sql_ of [
      `INSERT INTO announcements (id, text, published, published_at, created_at, updated_at) VALUES ('${ANNOUNCEMENT}', 'a', 1, '${AT}', '${AT}', '${AT}')`,
      `INSERT INTO announcements (id, text, published, published_at, created_at, updated_at) VALUES ('${OTHER_ANNOUNCEMENT}', 'b', 1, '${AT}', '${AT}', '${AT}')`,
    ]) {
      sql.exec(sql_);
    }
    const side = (base: bigint, prefix: string) => {
      for (let i = 0; i < n; i++) {
        const id = String(base + BigInt(i));
        local(id, `${prefix}${i}`, `https://kopje.test/ap/users/${prefix}${i}`);
        image(id, id, `${prefix}${i}`.padEnd(32, "t"), 1);
        sql.exec(
          "INSERT INTO custom_emojis (id, shortcode, visible_in_picker, created_at) VALUES (?, ?, ?, ?)",
          id,
          `${prefix}${i}`,
          i % 3 === 0 ? 0 : 1,
          AT,
        );
        sql.exec(
          "INSERT INTO announcement_reactions (announcement_id, account_id, name) VALUES (?, ?, ?)",
          OTHER_ANNOUNCEMENT,
          id,
          "\u{1F600}",
        );
        if (i < n / 4) {
          const status = String(base + 500_000_000_000_000n + BigInt(i));
          sql.exec(
            "INSERT INTO statuses (id, uri, account_id, visibility, published_at, content) VALUES (?, ?, ?, 'public', ?, '<p>t</p>')",
            status,
            `https://kopje.test/ap/o/${status}`,
            id,
            AT,
          );
          sql.exec("INSERT INTO trend_statuses (status_id, account_id, score) VALUES (?, ?, 5)", status, id);
        }
      }
    };
    side(400_000_000_000_000_000n, "a");
    image(SUBJECT, OWNER, "s".repeat(32), 1);
    sql.exec("INSERT INTO custom_emojis (id, shortcode, created_at) VALUES (?, 'm_subject', ?)", SUBJECT, AT);
    image(PENDING, OWNER, PENDING_TOKEN, 0);
    side(700_000_000_000_000_000n, "z");
  });
  await ensureAdmin(store);
  return store;
}

// The announcement's own reactions: `n` local accounts of their own, each reacting with eight names (a custom emoji's
// among them), each name shared by all of them.
function ownReactions(sql: SqlStorage, n: number) {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username) SELECT CAST(580000000000000000 + i AS TEXT), 'https://kopje.test/ap/users/r' || i, 'r' || i FROM n`,
    n,
  );
  sql.exec(
    `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey)
		SELECT id, username || '@example.com', X'00', X'00', 'k' FROM accounts WHERE id GLOB '58*'`,
  );
  const names = [
    "m_subject",
    "\u{1F601}",
    "\u{1F602}",
    "\u{1F603}",
    "\u{1F604}",
    "\u{1F605}",
    "\u{1F606}",
    "\u{1F607}",
  ];
  for (const [i, name] of names.entries()) {
    sql.exec(
      `INSERT INTO announcement_reactions (announcement_id, account_id, name, custom_emoji_id)
			SELECT ?1, account_id, ?2, ?3 FROM local_accounts WHERE account_id GLOB '58*'`,
      ANNOUNCEMENT,
      name,
      i === 0 ? SUBJECT : null,
    );
  }
}

const credential = { tokenHash: "owner", scope: "write" as const, now: NOW };

type Case = {
  pattern: RegExp;
  // main's statement for the rewrite's (one of MAIN).
  main: (query: string) => string;
  run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
  // The population that grows between the worlds (the neighbours, or the subject's own key), as SQL returning `n`.
  count: string;
  // The rewrite's rows read per row of `count` past the first world, for a read that walks it; absent: none.
  walks?: number;
  // The subject's own key grown to `n` (FEW, then MANY, or `sizes`), in a world of OWN_WORLD per side.
  own?: (sql: SqlStorage, n: number) => void;
  sizes?: readonly [number, number];
};

const OWN_WORLD = 20;
const NEIGHBOURS = "SELECT count(*) AS n FROM local_accounts";
const EMOJI_UPLOAD = {
  token: PENDING_TOKEN,
  category: null,
  visibleInPicker: true,
  replace: false,
  contentType: "image/png",
  original: { width: 16, height: 16 },
  small: { width: 16, height: 16 },
  now: NOW,
};

const CASES: Record<string, Case> = {
  "an upload's completion": {
    pattern: /SELECT m\.file_token AS token, a\.uri/,
    main: () => MAIN["4ec0ae054c56140a"],
    count: NEIGHBOURS,
    run: (sql, transact) =>
      completeMedia.run(
        sql,
        {
          credential,
          id: PENDING,
          contentType: "image/png",
          original: { width: 16, height: 16 },
          small: { width: 16, height: 16 },
          animated: false,
          blurhash: null,
          description: "",
          focus: { x: 0, y: 0 },
          now: NOW,
        },
        transact,
      ),
  },
  "an emoji upload's uploader": {
    pattern: /SELECT a\.uri FROM media_attachments m/,
    main: () => MAIN["b2ba7bd7c87d186e"],
    count: NEIGHBOURS,
    run: (sql, transact) =>
      completeEmoji.run(sql, { ...EMOJI_UPLOAD, authority: ACCESS, id: PENDING, shortcode: "fresh" }, transact),
  },
  "an emoji by id": {
    pattern:
      /FROM custom_emojis e INDEXED BY \S+\s+CROSS JOIN media_attachments m INDEXED BY \S+ ON m\.id = e\.id WHERE e\.id = \?$/,
    main: () => MAIN["80b7909111a47fc3"],
    count: NEIGHBOURS,
    run: (sql, transact) =>
      completeEmoji.run(
        sql,
        { ...EMOJI_UPLOAD, authority: ACCESS, id: SUBJECT, token: "s".repeat(32), shortcode: "m_subject" },
        transact,
      ),
  },
  "an emoji's federation object": {
    pattern: /SELECT e\.id, e\.shortcode, e\.created_at, m\.content_type/,
    main: () => MAIN["8f2413f482d1c147"],
    count: NEIGHBOURS,
    run: (sql) => localEmojiObjectOf(new Db(sql), SUBJECT, "https://kopje.test"),
  },
  // The emoji past the cursor (the owner's subject emoji) grown: `n` more of the owner's, all after it; a page reads
  // its 20 whatever their number.
  "the admin emoji page": {
    pattern: /WHERE e\.id > \?1 ORDER BY e\.id/,
    main: () => MAIN["8d54bf10c382eb21"],
    count: "SELECT count(*) AS n FROM custom_emojis WHERE id > '550000000000000000'",
    run: (sql) => adminEmojis.run(sql, { after: SUBJECT, limit: 20 }, (fn) => fn()),
    own: (sql, n) => {
      for (let i = 0; i < n; i++) {
        const id = String(560_000_000_000_000_000n + BigInt(i));
        sql.exec(
          `INSERT INTO media_attachments (id, account_id, type, url, preview_url, file_token, content_type, meta, processed,
						gc_at, created_at)
					VALUES (?1, ?2, 'image', ?3, ?3, ?4, 'image/png', '{"original":{"width":16,"height":16}}', 1, NULL, ?5)`,
          id,
          OWNER,
          `https://kopje.test/media/${`o${i}`.padEnd(32, "t")}/full.png`,
          `o${i}`.padEnd(32, "t"),
          AT,
        );
        sql.exec(
          "INSERT INTO custom_emojis (id, shortcode, disabled, created_at) VALUES (?, ?, 1, ?)",
          id,
          `o${i}`,
          AT,
        );
      }
    },
  },
  // The enabled emoji, at most MAX_ENABLED_EMOJIS (custom_emojis_enabled_insert), each of the picker's read with its
  // image: two rows per emoji in the picker.
  "the emoji picker": {
    pattern: /visible_in_picker = 1 ORDER BY e\.shortcode/,
    main: () => MAIN["9ce2b4bc7b5d421c"],
    count: "SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0",
    walks: 2,
    run: (sql) => customEmojis.run(sql, undefined, (fn) => fn()),
  },
  "a local status's emoji snapshot": {
    pattern: /FROM json_each\(\?1\) j\s+CROSS JOIN custom_emojis e/,
    main: () => MAIN["8a60356d41a087d5"],
    count: "SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0",
    run: (sql) => localEmojiSnapshot(new Db(sql), [":m_subject: :a1: :z1:"], 100_000),
  },
  // The announcement's own reactions grown: eight names, each of `n` accounts, all counted (one row each).
  "an announcement's reaction groups": {
    pattern: /min\(id\) AS first/,
    main: (query) => (query.includes("AND name = ?3") ? MAIN["cf99c3ed84341d2c"] : MAIN["4b444c31c87c91ff"]),
    count: `SELECT count(*) AS n FROM announcement_reactions WHERE announcement_id = '${ANNOUNCEMENT}'`,
    walks: 1,
    run: (sql) => streamedAnnouncementReaction(new Db(sql), JSON.stringify([ANNOUNCEMENT, "m_subject"])),
    own: ownReactions,
  },
  "an announcement's reaction groups, every name": {
    pattern: /min\(id\) AS first/,
    main: (query) => (query.includes("AND name = ?3") ? MAIN["cf99c3ed84341d2c"] : MAIN["4b444c31c87c91ff"]),
    count: `SELECT count(*) AS n FROM announcement_reactions WHERE announcement_id = '${ANNOUNCEMENT}'`,
    walks: 1,
    run: (sql) =>
      listAnnouncements.run(
        sql,
        { credential: { tokenHash: "owner", scope: "read" as const, now: NOW }, origin: "https://kopje.test" },
        (fn) => fn(),
      ),
    own: ownReactions,
  },
  // Every one of the announcement's own reactions goes, each read by its index entry and its row. Within
  // ANNOUNCEMENT_DELETE_ROWS (4,096) counting main's rolled-back delete beside it: 800, then 1,600 reactions.
  "an announcement's delete": {
    sizes: [100, 200],
    pattern: /DELETE FROM announcement_reactions INDEXED BY/,
    main: () => MAIN["8b964bbf6af22772"],
    count: `SELECT count(*) AS n FROM announcement_reactions WHERE announcement_id = '${ANNOUNCEMENT}'`,
    walks: 2,
    run: (sql, transact) => deleteAnnouncement.run(sql, { authority: ACCESS, id: ANNOUNCEMENT, now: NOW }, transact),
    own: ownReactions,
  },
  // The trend list, at most 250 (trend_statuses_cap), each row before the page's sort read with its status and author
  // by key and its language checked against the trend languages: four rows per trend.
  "the admin trend statuses": {
    pattern: /FROM trend_statuses t\s+CROSS JOIN statuses s/,
    main: () => MAIN["bae3ad0bc2fa20e3"],
    count: "SELECT count(*) AS n FROM trend_statuses",
    walks: 4,
    run: (sql) => adminTrendStatuses.run(sql, { authority: ACCESS, offset: 0, limit: 20 }, (fn) => fn()),
  },
};

async function sides(statistics: (typeof STATISTICS)[number], n: number, c: Case) {
  const store = await world(c.own === undefined ? n : OWN_WORLD);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    c.own?.(sql, n);
    const count = sql.exec<{ n: number }>(c.count).one().n;
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    const out: Side[] = [];
    transact(() => c.run(sideBySide(sql, transact, c.pattern, c.main, out), transact));
    return { sides: out, count };
  });
}

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    for (const [id, sql] of Object.entries(MAIN)) {
      expect(await statementId(sql), sql).toBe(id);
    }
  });
});

describe("emoji, media, reaction and trend reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const c = CASES[name]!;
      const [small, large] = c.sizes ?? [FEW, MANY];
      const few = await sides(statistics, small, c);
      const many = await sides(statistics, large, c);
      // The population grew between the worlds.
      expect(many.count).toBeGreaterThan(few.count);
      expect(few.sides.length).toBeGreaterThan(0);
      for (const run of [few.sides, many.sides]) {
        for (const side of run) {
          expect(side.mine.result, side.query).toEqual(side.main.result);
          expect(side.mine.written, side.query).toBe(side.main.written);
          if (statistics === "analyzed") {
            expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
          }
        }
      }
      const grown = many.sides.map((s, i) => s.mine.rows - few.sides[i]!.mine.rows);
      expect(grown.length).toBe(few.sides.length);
      for (const rows of grown) {
        expect(rows).toBeLessThanOrEqual((c.walks ?? 0) * (many.count - few.count));
        expect(rows).toBeGreaterThanOrEqual(0);
      }
    },
    120_000,
  );
});
