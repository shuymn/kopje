import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

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
import { expectBeside, expectGrowth, PlanWitness, type Run, STATISTICS, type Statistics } from "./plan-witness";

// RES-7 witnesses of the emoji, media, announcement-reaction and admin trend reads that a pin rewrote, each run beside
// main's statement by test/plan-witness.ts (WITNESS: main's audited SQL and its rewrite's pins or form), under the plan
// audit's singleton statistics and after ANALYZE. Each case names main's statements it runs, every one in order; each
// rewrite returns main's rows (and deletes the same ids) and reads no more than main after ANALYZE. Its reads stay the
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

// The statements the rewrites wrote, each of which must be a baseline's rewrite: a variant of one (another LIMIT, a
// condition more) fails the case rather than running unpaired.
const FAMILY = new RegExp(
  [
    /SELECT m\.file_token AS token, a\.uri/,
    /SELECT a\.uri FROM media_attachments m/,
    /FROM custom_emojis e INDEXED BY \S+\s+CROSS JOIN media_attachments m INDEXED BY \S+ ON m\.id = e\.id WHERE e\.id = \?$/,
    /SELECT e\.id, e\.shortcode, e\.created_at, m\.content_type/,
    /WHERE e\.id > \?1 ORDER BY e\.id/,
    /visible_in_picker = 1 ORDER BY e\.shortcode/,
    /FROM json_each\(\?1\) j\s+CROSS JOIN custom_emojis e/,
    /min\(id\) AS first/,
    /DELETE FROM announcement_reactions INDEXED BY/,
    /FROM trend_statuses t\s+CROSS JOIN statuses s/,
  ]
    .map((pattern) => `(?:${pattern.source})`)
    .join("|"),
);

// main's audited statements (origin/main as of #1468 group 7), by their audit identity, each with its rewrite: the
// pins it adds (an index named, CROSS JOIN for JOIN), or, for the reaction groups (each group's first reaction read by
// a correlated lookup), its form exactly. The delete's write: the ids of the reactions it removes.
const WITNESS = new PlanWitness(
  {
    // completeMedia
    "4ec0ae054c56140a": {
      sql: "SELECT m.file_token AS token, a.uri, m.processed, m.url, m.created_at FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.account_id = ?",
      pins: (text) =>
        text.replace(
          " INDEXED BY sqlite_autoindex_media_attachments_1 CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON",
          " JOIN accounts a ON",
        ),
    },
    // completeEmoji's uploader
    b2ba7bd7c87d186e: {
      sql: "SELECT a.uri FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.file_token = ? AND m.processed = 0 AND m.created_at > ? AND m.status_id IS NULL AND m.scheduled_status_id IS NULL",
      pins: (text) =>
        text.replace(
          " INDEXED BY sqlite_autoindex_media_attachments_1 CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON",
          " JOIN accounts a ON",
        ),
    },
    // emojiById
    "80b7909111a47fc3": {
      sql: "SELECT e.id, e.shortcode, m.url, e.category, e.visible_in_picker, e.disabled, e.created_at FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?",
      pins: (text) =>
        text.replace(
          " INDEXED BY sqlite_autoindex_custom_emojis_1 CROSS JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON",
          " JOIN media_attachments m ON",
        ),
    },
    // localEmojiObjectOf
    "8f2413f482d1c147": {
      sql: "SELECT e.id, e.shortcode, e.created_at, m.content_type, m.url FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id = ?",
      pins: (text) =>
        text.replace(
          " INDEXED BY sqlite_autoindex_custom_emojis_1 CROSS JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON",
          " JOIN media_attachments m ON",
        ),
    },
    // adminEmojis
    "8d54bf10c382eb21": {
      sql: "SELECT e.id, e.shortcode, m.url, e.category, e.visible_in_picker, e.disabled, e.created_at FROM custom_emojis e JOIN media_attachments m ON m.id = e.id WHERE e.id > ?1 ORDER BY e.id LIMIT ?2",
      pins: (text) =>
        text.replace(
          " INDEXED BY sqlite_autoindex_custom_emojis_1 CROSS JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON",
          " JOIN media_attachments m ON",
        ),
    },
    // customEmojis
    "9ce2b4bc7b5d421c": {
      sql: "SELECT e.shortcode, e.category, m.url FROM custom_emojis e INDEXED BY custom_emojis_enabled JOIN media_attachments m ON m.id = e.id WHERE e.disabled = 0 AND e.visible_in_picker = 1 ORDER BY e.shortcode LIMIT ?",
      pins: (text) =>
        text.replace(
          " CROSS JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON",
          " JOIN media_attachments m ON",
        ),
    },
    // localEmojiSnapshot
    "8a60356d41a087d5": {
      sql: "SELECT j.key AS i, e.shortcode, m.url FROM json_each(?1) j CROSS JOIN custom_emojis e INDEXED BY custom_emojis_enabled ON e.shortcode = j.value AND e.disabled = 0 JOIN media_attachments m ON m.id = e.id",
      pins: (text) =>
        text.replace(
          " CROSS JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON",
          " JOIN media_attachments m ON",
        ),
    },
    // reactionRows with a name
    cf99c3ed84341d2c: {
      sql: "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 AND name = ?3 GROUP BY name) g JOIN announcement_reactions r ON r.id = g.first LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id ORDER BY g.first LIMIT 8",
      text: "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 AND name = ?3 GROUP BY name) g LEFT JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON m.id = (SELECT r.custom_emoji_id FROM announcement_reactions r WHERE r.id = g.first) ORDER BY g.first LIMIT 8",
    },
    // reactionRows
    "4b444c31c87c91ff": {
      sql: "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 GROUP BY name) g JOIN announcement_reactions r ON r.id = g.first LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id ORDER BY g.first LIMIT 8",
      text: "SELECT g.name, g.count, g.me, m.url FROM (SELECT name, count(*) AS count, max(account_id = ?2) AS me, min(id) AS first FROM announcement_reactions INDEXED BY announcement_reactions_name WHERE announcement_id = ?1 GROUP BY name) g LEFT JOIN media_attachments m INDEXED BY sqlite_autoindex_media_attachments_1 ON m.id = (SELECT r.custom_emoji_id FROM announcement_reactions r WHERE r.id = g.first) ORDER BY g.first LIMIT 8",
    },
    // deleteAnnouncement's reactions
    "8b964bbf6af22772": {
      sql: "DELETE FROM announcement_reactions WHERE announcement_id = ?",
      pins: (text) => text.replace(" INDEXED BY announcement_reactions_name", ""),
      writes: "SELECT CAST(id AS TEXT) AS id FROM announcement_reactions ORDER BY id",
    },
    // adminStatusRows, a page
    bae3ad0bc2fa20e3: {
      sql: "SELECT t.status_id AS id, CASE WHEN length(CAST(s.url AS BLOB)) <= 4096 THEN s.url END AS url, s.account_id, CAST(substr(CAST(CASE WHEN length(CAST(a.username AS BLOB)) = length(a.username) AND a.username NOT GLOB '*[^A-Za-z0-9_.-]*' THEN CASE WHEN length(CAST(a.username AS BLOB)) <= 255 THEN a.username ELSE substr(a.username, 1, 255) END ELSE substr(a.username, 1, 42) END AS BLOB), 1, 255) AS TEXT) AS username, CAST(substr(CAST(a.domain AS BLOB), 1, 253) AS TEXT) AS domain, (CASE WHEN length(CAST(s.published_at AS BLOB)) = 24 AND substr(s.published_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', s.published_at) = s.published_at THEN s.published_at END) AS published_at, CASE WHEN s.language IN (SELECT value FROM json_each(?1)) THEN s.language END AS language, t.score, (SELECT v.trendable FROM status_trend_reviews v WHERE v.status_id = t.status_id) AS status_review, (SELECT v.trendable FROM account_trend_reviews v WHERE v.account_id = t.account_id) AS account_review, CAST(substr(CAST(s.content AS BLOB), 1, 4000) AS TEXT) AS content FROM trend_statuses t CROSS JOIN statuses s ON s.id = t.status_id CROSS JOIN accounts a ON a.id = t.account_id WHERE 1 ORDER BY t.score DESC, t.status_id DESC LIMIT ?2 OFFSET ?3",
      pins: (text) =>
        text
          .replace(" CROSS JOIN statuses s INDEXED BY sqlite_autoindex_statuses_1 ON", " CROSS JOIN statuses s ON")
          .replace(" CROSS JOIN accounts a INDEXED BY sqlite_autoindex_accounts_1 ON", " CROSS JOIN accounts a ON"),
    },
  },
  FAMILY,
);

const FEW = 200;
const MANY = 400;

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
  // main's statements the case runs, in order, by identity.
  main: readonly string[];
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
    main: ["4ec0ae054c56140a"],
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
    // The emoji looked up by its id before the upload is read, and again after it is stored.
    main: ["80b7909111a47fc3", "b2ba7bd7c87d186e", "80b7909111a47fc3"],
    count: NEIGHBOURS,
    run: (sql, transact) =>
      completeEmoji.run(sql, { ...EMOJI_UPLOAD, authority: ACCESS, id: PENDING, shortcode: "fresh" }, transact),
  },
  "an emoji by id": {
    main: ["80b7909111a47fc3"],
    count: NEIGHBOURS,
    run: (sql, transact) =>
      completeEmoji.run(
        sql,
        { ...EMOJI_UPLOAD, authority: ACCESS, id: SUBJECT, token: "s".repeat(32), shortcode: "m_subject" },
        transact,
      ),
  },
  "an emoji's federation object": {
    main: ["8f2413f482d1c147"],
    count: NEIGHBOURS,
    run: (sql) => localEmojiObjectOf(new Db(sql), SUBJECT, "https://kopje.test"),
  },
  // The emoji past the cursor (the owner's subject emoji) grown: `n` more of the owner's, all after it; a page reads
  // its 20 whatever their number.
  "the admin emoji page": {
    main: ["8d54bf10c382eb21"],
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
    main: ["9ce2b4bc7b5d421c"],
    count: "SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0",
    walks: 2,
    run: (sql) => customEmojis.run(sql, undefined, (fn) => fn()),
  },
  "a local status's emoji snapshot": {
    main: ["8a60356d41a087d5"],
    count: "SELECT count(*) AS n FROM custom_emojis WHERE disabled = 0",
    run: (sql) => localEmojiSnapshot(new Db(sql), [":m_subject: :a1: :z1:"], 100_000),
  },
  // The announcement's own reactions grown: eight names, each of `n` accounts, all counted (one row each).
  "an announcement's reaction groups": {
    main: ["cf99c3ed84341d2c"],
    count: `SELECT count(*) AS n FROM announcement_reactions WHERE announcement_id = '${ANNOUNCEMENT}'`,
    walks: 1,
    run: (sql) => streamedAnnouncementReaction(new Db(sql), JSON.stringify([ANNOUNCEMENT, "m_subject"])),
    own: ownReactions,
  },
  "an announcement's reaction groups, every name": {
    main: ["4b444c31c87c91ff", "4b444c31c87c91ff"],
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
    main: ["8b964bbf6af22772"],
    count: `SELECT count(*) AS n FROM announcement_reactions WHERE announcement_id = '${ANNOUNCEMENT}'`,
    walks: 2,
    run: (sql, transact) => deleteAnnouncement.run(sql, { authority: ACCESS, id: ANNOUNCEMENT, now: NOW }, transact),
    own: ownReactions,
  },
  // The trend list, at most 250 (trend_statuses_cap), each row before the page's sort read with its status and author
  // by key and its language checked against the trend languages: four rows per trend.
  "the admin trend statuses": {
    main: ["bae3ad0bc2fa20e3"],
    count: "SELECT count(*) AS n FROM trend_statuses",
    walks: 4,
    run: (sql) => adminTrendStatuses.run(sql, { authority: ACCESS, offset: 0, limit: 20 }, (fn) => fn()),
  },
};

async function sides(statistics: Statistics, n: number, c: Case): Promise<Run> {
  const store = await world(c.own === undefined ? n : OWN_WORLD);
  return runInDurableObject(store, (_instance, state) => {
    c.own?.(state.storage.sql, n);
    return WITNESS.measure(state, { statistics, expected: c.main, populations: { grown: c.count }, run: c.run });
  });
}

describe("main's statements", () => {
  it("are main's audited ones", async () => {
    await WITNESS.expectAudited();
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
      for (const run of [few, many]) {
        expectBeside(statistics, run);
      }
      // The population grew between the worlds; each statement reads the same rows but for its walk of it.
      expectGrowth(few, many, {
        populations: ["grown"],
        perSide: { "*": { population: "grown", perRun: c.walks ?? 0 } },
      });
    },
    120_000,
  );
});
