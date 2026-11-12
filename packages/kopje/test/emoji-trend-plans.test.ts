import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { deleteAnnouncement, streamedAnnouncementReaction } from "../src/domain/announcements";
import { localEmojiSnapshot } from "../src/domain/custom-emojis";
import { adminEmojis, completeEmoji, customEmojis, localEmojiObjectOf } from "../src/domain/local-emojis";
import { completeMedia } from "../src/domain/media";
import { adminTrendStatuses } from "../src/domain/trends";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { migratedStore } from "./helpers";
import { ACCESS, ensureAdmin } from "./ops-helpers";
import { singletonStatistics } from "./plan-audit-store";
import { type SqlRow, watchedCursor } from "./read-helpers";

// RES-7 witnesses of the emoji, media, announcement-reaction and admin trend reads that a pin rewrote, each run side by
// side with main's statement (the same parameters, in a savepoint rolled back before the rewrite runs) under the plan
// audit's singleton statistics and after ANALYZE. Each rewrite returns main's rows (and deletes as many), reads no
// more than main after ANALYZE, and reads the same rows as its neighbours grow on both sides of its keys (accounts,
// media, emoji, announcements, reactions and statuses whose ids sort below and above the subject's) and as its own
// key grows where it has one (the emoji past an admin page's cursor, the announcement's own reactions), in a world
// small enough that this key is most of its table. The import-shaped rows main's writers do not produce: reactions
// sharing a name (the reaction a name's group shows is its first), and trend scores that tie (by status id).

const OWNER = "600000000000000001";
const OWNER_URI = "https://kopje.test/ap/users/owner";
const SUBJECT = "550000000000000000";
const PENDING = "550000000000000001";
const PENDING_TOKEN = "p".repeat(32);
const ANNOUNCEMENT = "550000000000000002";
const OTHER_ANNOUNCEMENT = "550000000000000003";
const AT = new Date(NOW).toISOString();
const STATISTICS = ["singleton", "analyzed"] as const;
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
// kept PNG upload and a disabled emoji of it (shortcodes a… and z…), a reaction to the other announcement and one
// trending status with a tied score; between the sides, the subject emoji (m_subject, enabled), a pending upload of
// the owner, and the announcement and the other one.
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
          "INSERT INTO custom_emojis (id, shortcode, disabled, created_at) VALUES (?, ?, 1, ?)",
          id,
          `${prefix}${i}`,
          AT,
        );
        sql.exec(
          "INSERT INTO announcement_reactions (announcement_id, account_id, name) VALUES (?, ?, ?)",
          OTHER_ANNOUNCEMENT,
          id,
          "\u{1F600}",
        );
        if (i < 50) {
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

// The announcement's own reactions: `n` local accounts reacting with eight names (a custom emoji's among them), each
// name shared by many; the first reaction of each name is the owner's.
function ownReactions(sql: SqlStorage, n: number) {
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
			SELECT ?1, account_id, ?2, ?3 FROM (SELECT account_id FROM local_accounts ORDER BY account_id LIMIT ?4)`,
      ANNOUNCEMENT,
      name,
      i === 0 ? SUBJECT : null,
      n,
    );
  }
}

const credential = { tokenHash: "owner", scope: "write" as const, now: NOW };
const pin = / INDEXED BY \S+/g;

type Case = {
  pattern: RegExp;
  // main's statement from the rewrite.
  main: (query: string) => string;
  run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) => unknown;
  // The subject's own key grown to `n` (FEW, then MANY), in a world of OWN_WORLD per side.
  own?: (sql: SqlStorage, n: number) => void;
};

const OWN_WORLD = 20;
const unpin = (query: string) => query.replace(pin, "");
const joined = (table: string) => (query: string) =>
  unpin(query).replace(new RegExp(`CROSS JOIN ${table} `), `JOIN ${table} `);

const CASES: Record<string, Case> = {
  "an upload's completion": {
    pattern: /SELECT m\.file_token AS token, a\.uri/,
    main: joined("accounts"),
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
    main: joined("accounts"),
    run: (sql, transact) =>
      completeEmoji.run(
        sql,
        {
          authority: ACCESS,
          id: PENDING,
          token: PENDING_TOKEN,
          shortcode: "fresh",
          category: null,
          visibleInPicker: true,
          replace: false,
          contentType: "image/png",
          original: { width: 16, height: 16 },
          small: { width: 16, height: 16 },
          now: NOW,
        },
        transact,
      ),
  },
  "an emoji by id": {
    pattern:
      /FROM custom_emojis e INDEXED BY \S+\s+CROSS JOIN media_attachments m INDEXED BY \S+ ON m\.id = e\.id WHERE e\.id = \?$/,
    main: joined("media_attachments"),
    run: (sql, transact) =>
      completeEmoji.run(
        sql,
        {
          authority: ACCESS,
          id: SUBJECT,
          token: "s".repeat(32),
          shortcode: "m_subject",
          category: null,
          visibleInPicker: true,
          replace: false,
          contentType: "image/png",
          original: { width: 16, height: 16 },
          small: { width: 16, height: 16 },
          now: NOW,
        },
        transact,
      ),
  },
  "an emoji's federation object": {
    pattern: /SELECT e\.id, e\.shortcode, e\.created_at, m\.content_type/,
    main: joined("media_attachments"),
    run: (sql) => localEmojiObjectOf(new Db(sql), SUBJECT, "https://kopje.test"),
  },
  // The emoji past the cursor (the owner's subject emoji) grown: `n` more of the owner's, all after it.
  "the admin emoji page": {
    pattern: /WHERE e\.id > \?1 ORDER BY e\.id/,
    main: joined("media_attachments"),
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
  "the emoji picker": {
    pattern: /visible_in_picker = 1 ORDER BY e\.shortcode/,
    main: (query) => query.replace(/CROSS JOIN media_attachments m INDEXED BY \S+ ON/, "JOIN media_attachments m ON"),
    run: (sql) => customEmojis.run(sql, undefined, (fn) => fn()),
  },
  "a local status's emoji snapshot": {
    pattern: /FROM json_each\(\?1\) j\s+CROSS JOIN custom_emojis e/,
    main: (query) => query.replace(/CROSS JOIN media_attachments m INDEXED BY \S+ ON/, "JOIN media_attachments m ON"),
    run: (sql) => localEmojiSnapshot(new Db(sql), [":m_subject: :a1: :z1:"], 100_000),
  },
  // The announcement's own reactions grown: eight names, each of `n` accounts.
  "an announcement's reaction groups": {
    pattern: /min\(id\) AS first/,
    main: (query) =>
      query.replace(
        /LEFT JOIN media_attachments m INDEXED BY \S+\s+ON m\.id = \(SELECT r\.custom_emoji_id FROM announcement_reactions r WHERE r\.id = g\.first\)/,
        "JOIN announcement_reactions r ON r.id = g.first LEFT JOIN media_attachments m ON m.id = r.custom_emoji_id",
      ),
    run: (sql) => streamedAnnouncementReaction(new Db(sql), JSON.stringify([ANNOUNCEMENT, "m_subject"])),
    own: ownReactions,
  },
  "an announcement's delete": {
    pattern: /DELETE FROM announcement_reactions INDEXED BY/,
    main: unpin,
    run: (sql, transact) => deleteAnnouncement.run(sql, { authority: ACCESS, id: ANNOUNCEMENT, now: NOW }, transact),
    own: ownReactions,
  },
  "the admin trend statuses": {
    pattern: /FROM trend_statuses t\s+CROSS JOIN statuses s/,
    main: unpin,
    run: (sql) => adminTrendStatuses.run(sql, { authority: ACCESS, offset: 0, limit: 20 }, (fn) => fn()),
  },
};

async function sides(statistics: (typeof STATISTICS)[number], n: number, c: Case) {
  const store = await world(c.own === undefined ? n : OWN_WORLD);
  return runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    c.own?.(sql, n);
    if (statistics === "singleton") {
      singletonStatistics(sql);
    } else {
      sql.exec("ANALYZE");
    }
    const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
    const out: Side[] = [];
    transact(() => c.run(sideBySide(sql, transact, c.pattern, c.main, out), transact));
    return out;
  });
}

describe("emoji, media, reaction and trend reads beside main's (RES-7)", () => {
  it.each(STATISTICS.flatMap((statistics) => Object.keys(CASES).map((name) => [statistics, name] as const)))(
    "%s statistics: %s",
    async (statistics, name) => {
      const c = CASES[name]!;
      const few = await sides(statistics, FEW, c);
      const many = await sides(statistics, MANY, c);
      expect(few.length).toBeGreaterThan(0);
      for (const run of [few, many]) {
        for (const side of run) {
          expect(c.main(side.query), "main's statement differs from the rewrite").not.toBe(side.query);
          expect(side.mine.result, side.query).toEqual(side.main.result);
          expect(side.mine.written, side.query).toBe(side.main.written);
          if (statistics === "analyzed") {
            expect(side.mine.rows, side.query).toBeLessThanOrEqual(side.main.rows);
          }
        }
      }
      expect(many.map((s) => s.mine.rows)).toEqual(few.map((s) => s.mine.rows));
    },
    120_000,
  );
});
