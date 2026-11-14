import { Db } from "../../src/db/sql";
import { contextOf } from "../../src/domain/auth";
import { getNotificationGroup, listGroupedNotifications } from "../../src/domain/notification-groups";
import { acceptNotificationRequest, listNotificationRequests } from "../../src/domain/notification-requests";
import { getNotification, listNotifications, mentionedStatus, notify } from "../../src/domain/notifications";
import { claimPushes } from "../../src/domain/push";
import { homeStatus, homeTimeline, listTimeline, tagTimeline } from "../../src/domain/timelines";

// The worlds and flows of the main-runtime witnesses (test/main-runtime/policy.witness.test.ts): every flow that runs
// a statement the cursor rule changed (the notification rule's statements, home's positioned read and the candidate
// windows of home, a list and a hashtag timeline; docs/engineering.md "Queries"), each in the worlds of the design:
// no suspend block, 100 that cover none of the accounts, and blocks that cover the original authors (the walks the
// rule reaches last), each with every candidate passing ("pass"), the viewer blocking or muting every sender first
// ("reject"), and the candidates at the caps the flows read ("max"). This module runs on main's code as on the
// rewrite's (test-node/witness-recording.test.ts records both): it names nothing only one of them has.

export const BLOCKS = ["none", "noncovering", "covering"] as const;
export const SHAPES = ["pass", "reject", "max"] as const;
export type World = { blocks: (typeof BLOCKS)[number]; shape: (typeof SHAPES)[number] };
export const WORLDS: World[] = BLOCKS.flatMap((blocks) => SHAPES.map((shape) => ({ blocks, shape })));
export const worldName = (world: World) => `${world.blocks}/${world.shape}`;

// The instant the worlds are built at and the flows run at. This module imports nothing of the Workers pool, so that
// the Node suites (test-node/witness-store.ts) build the same worlds on Node's SQLite.
const NOW = Date.parse("2026-10-12T00:00:00.000Z");

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(18 - prefix.length, "0")}`;

// The accounts: the viewer and another local account, and one remote account in each role, each on its own domain.
export const VIEWER = id("60", 1);
const BOB = id("60", 2);
const SENDER = id("70", 1);
const AUTHOR = id("70", 2);
const ORIGINAL = id("70", 3);
const QUOTED = id("70", 4);
const QUOTED_ORIGINAL = id("70", 5);
const REQUESTER = id("70", 6);
const FOLLOWER = id("70", 7);
const STRANGER = id("70", 8);
const REMOTES: [string, string][] = [
  [SENDER, "sender.example"],
  [AUTHOR, "author.example"],
  [ORIGINAL, "orig.example"],
  [QUOTED, "quoted.example"],
  [QUOTED_ORIGINAL, "qorig.example"],
  [REQUESTER, "requester.example"],
  [FOLLOWER, "follower.example"],
  [STRANGER, "stranger.example"],
];

// The statuses, by role.
const S = {
  own: id("80", 1),
  ownFresh: id("80", 2),
  senderBoost: id("80", 3),
  senderBoostFresh: id("80", 4),
  mention: id("80", 5),
  mentionFresh: id("80", 6),
  original: id("80", 7),
  authorBoost: id("80", 8),
  originalFresh: id("80", 9),
  authorBoostFresh: id("80", 10),
  quotedOriginal: id("80", 11),
  quotedBoost: id("80", 12),
  quoting: id("80", 13),
  authorPublic: id("80", 14),
  authorDirect: id("80", 15),
  ownBoost: id("80", 16),
  tagged: id("80", 17),
  requested: id("80", 18),
} as const;

// The caps the "max" worlds fill: a v1 page of 80 reads readWindow(80) = 240 candidates; a grouped page walks up to
// GROUP_WALK (2,000) rows; an accept job's batch reads REQUEST_JOB_WINDOW (500) of the sender's notifications; a fan-out
// notifies each local follower; a timeline stream reads streamWindow(20) = 40 of each followed account's or name's.
const MAX = { mentions: 300, favourites: 2_100, requested: 520, locals: 50, feed: 60 };
const TAGS = ["a", "b", "c", "d", "e"];

export type Context = { notification: string; group: string; request: string };

const iso = new Date(NOW).toISOString();

function status(sql: SqlStorage, sid: string, author: string, visibility: string, reblogOf: string | null = null) {
  sql.exec(
    `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sid,
    `https://kopje.test/s/${sid}`,
    author,
    reblogOf,
    visibility,
    reblogOf === null ? "<p>s</p>" : "",
    iso,
  );
}

function mention(sql: SqlStorage, sid: string, account: string) {
  sql.exec(
    `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
		SELECT id, ?, 0, visibility IN ('direct', 'limited'), account_id FROM statuses WHERE id = ?`,
    account,
    sid,
  );
}

function tags(sql: SqlStorage, sid: string, names: readonly string[]) {
  for (const name of names) {
    sql.exec(
      "INSERT INTO status_tags (status_id, name, public) SELECT id, ?, visibility = 'public' FROM statuses WHERE id = ?",
      name,
      sid,
    );
  }
}

function local(sql: SqlStorage, account: string, name: string) {
  sql.exec("INSERT INTO accounts (id, uri, username) VALUES (?, ?, ?)", account, `https://kopje.test/u/${name}`, name);
  sql.exec(
    "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'k')",
    account,
    `${name}@example.com`,
  );
}

// `n` remote accounts from `base` on `domain`, each with a public status of its own (ids from `statusBase`).
function remotes(sql: SqlStorage, base: string, n: number, domain: string, statusBase: string, visibility = "public") {
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT ?2 || printf('%016d', k), 'https://' || ?3 || '/u/' || k, 'u' || k, ?3 FROM i`,
    n,
    base,
    domain,
  );
  sql.exec(
    `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT ?4 || printf('%016d', k), 'https://' || ?3 || '/s/' || k, ?2 || printf('%016d', k), ?5, '<p>s</p>', ?6 FROM i`,
    n,
    base,
    domain,
    statusBase,
    visibility,
    iso,
  );
}

// Builds `world` in an empty migrated Store, and returns the keys its read flows name.
export function buildWorld(sql: SqlStorage, world: World): Context {
  const db = new Db(sql);
  sql.exec("INSERT INTO instance_settings (name, value) VALUES ('domain', 'kopje.test')");
  local(sql, VIEWER, "viewer");
  local(sql, BOB, "bob");
  sql.exec(
    "INSERT INTO oauth_clients (id, secret, name, redirect_uris, scopes) VALUES ('app', 's', 'app', 'urn:ietf:wg:oauth:2.0:oob', 'read write push')",
  );
  sql.exec(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES ('viewer', 'access', 'app', ?, 'read write push')",
    VIEWER,
  );
  sql.exec(
    `INSERT INTO push_subscriptions (id, token_hash, endpoint, key_p256dh, key_auth, alerts)
		VALUES (1, 'viewer', 'https://push.example/e', 'k', 'a', json_object('mention', json('true'), 'status', json('true'),
			'reblog', json('true'), 'follow', json('true'), 'favourite', json('true'), 'quoted_update', json('true')))`,
  );
  for (const [account, domain] of REMOTES) {
    sql.exec(
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, ?)",
      account,
      `https://${domain}/u/x`,
      "x",
      domain,
    );
  }
  for (const target of [SENDER, AUTHOR, QUOTED]) {
    sql.exec("INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", VIEWER, target);
  }
  sql.exec("INSERT INTO lists (id, account_id, title) VALUES ('650000000000000001', ?, 'l')", VIEWER);
  sql.exec("INSERT INTO list_accounts (list_id, account_id) VALUES ('650000000000000001', ?)", AUTHOR);
  sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'a')", VIEWER);
  sql.exec("INSERT INTO notification_policies (account_id, for_not_following) VALUES (?, 'filter')", VIEWER);

  status(sql, S.own, VIEWER, "public");
  status(sql, S.ownFresh, VIEWER, "public");
  status(sql, S.senderBoost, SENDER, "public", S.own);
  status(sql, S.senderBoostFresh, SENDER, "public", S.ownFresh);
  status(sql, S.mention, SENDER, "public");
  mention(sql, S.mention, VIEWER);
  status(sql, S.mentionFresh, SENDER, "public");
  mention(sql, S.mentionFresh, VIEWER);
  status(sql, S.original, ORIGINAL, "public");
  status(sql, S.authorBoost, AUTHOR, "public", S.original);
  status(sql, S.originalFresh, ORIGINAL, "public");
  status(sql, S.authorBoostFresh, AUTHOR, "public", S.originalFresh);
  status(sql, S.quotedOriginal, QUOTED_ORIGINAL, "public");
  status(sql, S.quotedBoost, QUOTED, "public", S.quotedOriginal);
  status(sql, S.quoting, VIEWER, "public");
  sql.exec(
    `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
		VALUES (?, 'https://kopje.test/q', ?, ?, 'accepted', ?)`,
    S.quoting,
    S.quotedBoost,
    QUOTED,
    iso,
  );
  status(sql, S.authorPublic, AUTHOR, "public");
  tags(sql, S.authorPublic, TAGS);
  status(sql, S.authorDirect, AUTHOR, "direct");
  mention(sql, S.authorDirect, VIEWER);
  status(sql, S.ownBoost, VIEWER, "public", S.original);
  status(sql, S.tagged, STRANGER, "public");
  tags(sql, S.tagged, TAGS);
  status(sql, S.requested, REQUESTER, "public");
  mention(sql, S.requested, VIEWER);

  const notifications: [string, "mention" | "favourite" | "reblog" | "status" | "quoted_update" | "follow", string][] =
    [
      [SENDER, "mention", S.mention],
      [SENDER, "favourite", S.own],
      [SENDER, "reblog", S.own],
      [AUTHOR, "status", S.authorBoost],
      [QUOTED, "quoted_update", S.quoting],
      [SENDER, "follow", ""],
      [REQUESTER, "mention", S.requested],
    ];
  for (const [from, type, statusId] of notifications) {
    notify(db, { recipientId: VIEWER, type, fromId: from, statusId: statusId === "" ? null : statusId, now: NOW });
  }

  if (world.shape === "max") {
    // Mentions of the viewer, each from an account of its own (followed: not filtered).
    remotes(sql, "71", MAX.mentions, "many.example", "81");
    sql.exec(
      `INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE id GLOB '71*'`,
      VIEWER,
    );
    sql.exec(
      `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT id, ?, 0, 0, account_id FROM statuses WHERE id GLOB '81*'`,
      VIEWER,
    );
    for (const row of sql.exec<{ id: string; a: string }>(
      "SELECT id, account_id AS a FROM statuses WHERE id GLOB '81*'",
    )) {
      notify(db, { recipientId: VIEWER, type: "mention", fromId: row.a, statusId: row.id, now: NOW });
    }
    // Favourites of the viewer's status, one group.
    remotes(sql, "72", MAX.favourites, "fans.example", "82");
    sql.exec(
      `INSERT INTO follows (account_id, target_account_id, state) SELECT ?, id, 'accepted' FROM accounts WHERE id GLOB '72*'`,
      VIEWER,
    );
    for (const row of sql.exec<{ id: string }>("SELECT id FROM accounts WHERE id GLOB '72*'")) {
      notify(db, { recipientId: VIEWER, type: "favourite", fromId: row.id, statusId: S.own, now: NOW });
    }
    // The requester's filtered mentions, past an accept job's batch.
    sql.exec(
      `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			SELECT '83' || printf('%016d', k), 'https://requester.example/s/' || k, ?2, 'public', '<p>s</p>', ?3 FROM i`,
      MAX.requested,
      REQUESTER,
      iso,
    );
    sql.exec(
      `INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id)
			SELECT id, ?, 0, 0, account_id FROM statuses WHERE id GLOB '83*'`,
      VIEWER,
    );
    for (const row of sql.exec<{ id: string }>("SELECT id FROM statuses WHERE id GLOB '83*'")) {
      notify(db, { recipientId: VIEWER, type: "mention", fromId: REQUESTER, statusId: row.id, now: NOW });
    }
    // Local followers of the author, for a fan-out.
    for (let n = 0; n < MAX.locals; n++) {
      local(sql, id("61", n), `l${n}`);
    }
    // Feeds: each followed account's and each name's statuses past a stream's window.
    for (const [base, author] of [
      ["84", AUTHOR],
      ["85", SENDER],
      ["86", STRANGER],
    ] as const) {
      sql.exec(
        `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k < ?1 - 1)
				INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
				SELECT ?2 || printf('%016d', k), 'https://kopje.test/f/' || ?2 || k, ?3, 'public', '<p>s</p>', ?4 FROM i`,
        MAX.feed,
        base,
        author,
        iso,
      );
      for (const name of TAGS) {
        sql.exec(
          `INSERT INTO status_tags (status_id, name, public) SELECT id, ?, 1 FROM statuses WHERE id GLOB ? || '*'`,
          name,
          base,
        );
      }
    }
  }

  if (world.shape === "reject") {
    // Every sender blocked by the viewer after it notified, the author muted with its notifications.
    for (const target of [SENDER, QUOTED, REQUESTER, STRANGER]) {
      sql.exec("INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", VIEWER, target);
    }
    sql.exec("INSERT INTO mutes (account_id, target_account_id, hide_notifications) VALUES (?, ?, 1)", VIEWER, AUTHOR);
  }
  if (world.blocks !== "none") {
    const domains =
      world.blocks === "covering"
        ? ["orig.example", "qorig.example"]
        : Array.from({ length: 100 }, (_, n) => `b${n}.example`);
    for (const domain of domains) {
      sql.exec(
        "INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, 'suspend', ?, ?)",
        domain,
        iso,
        iso,
      );
    }
  }
  const one = (query: string, ...params: SqlStorageValue[]) =>
    sql.exec<{ v: string }>(query, ...params).toArray()[0]?.v ?? "";
  return {
    notification: one(
      "SELECT CAST(id AS TEXT) AS v FROM notifications WHERE account_id = ? AND type = 'status'",
      VIEWER,
    ),
    group: one(
      "SELECT group_key AS v FROM notifications WHERE account_id = ? AND type = 'favourite' AND group_key IS NOT NULL",
      VIEWER,
    ),
    request: one("SELECT CAST(id AS TEXT) AS v FROM notification_requests WHERE account_id = ?", VIEWER),
  };
}

// The populations a world holds, each by its own predicate.
export const POPULATIONS = {
  notifications: `SELECT count(*) AS n FROM notifications WHERE account_id = '${VIEWER}'`,
  filtered: `SELECT count(*) AS n FROM notifications WHERE account_id = '${VIEWER}' AND filtered = 1`,
  suspends: "SELECT count(*) AS n FROM instance_domain_blocks WHERE severity = 'suspend'",
  pushes: "SELECT count(*) AS n FROM push_deliveries",
  locals: "SELECT count(*) AS n FROM local_accounts",
  feed: "SELECT count(*) AS n FROM statuses WHERE visibility = 'public'",
};

const PRESENT = { origin: "https://kopje.test" };
const credential = (scope: "read" | "write") => ({ tokenHash: "viewer", scope, now: NOW });
const viewer = () => contextOf(VIEWER, NOW);
type Run = (sql: SqlStorage, transact: <T>(fn: () => T) => T, context: Context) => unknown;
const page = (limit: number, extra: Record<string, string> = {}) => ({ limit, ...extra });

// Each flow: what it runs, and the rows its writes change (`writes`, a query read before and after the rewrite and
// main's statement on both sides).
export const FLOWS: Record<string, { run: Run; writes?: string }> = {
  ...Object.fromEntries(
    (
      [
        ["mention", SENDER, S.mentionFresh],
        ["favourite", SENDER, S.ownFresh],
        ["reblog", SENDER, S.ownFresh],
        ["status", AUTHOR, S.authorBoostFresh],
        ["quoted_update", QUOTED, S.quoting],
        ["follow", FOLLOWER, null],
      ] as const
    ).map(([type, from, statusId]) => [
      `notify ${type}`,
      {
        run: (sql: SqlStorage) => notify(new Db(sql), { recipientId: VIEWER, type, fromId: from, statusId, now: NOW }),
        writes: "SELECT CAST(id AS TEXT) AS id, type, filtered, group_key FROM notifications ORDER BY id",
      },
    ]),
  ),
  // A status notified to each local account (the author's local followers in a "max" world).
  "notify status fan-out": {
    run: (sql) => {
      const db = new Db(sql);
      // Read whole first: the witness rolls main's side of each pair back, which aborts an open cursor.
      const recipients = sql.exec<{ id: string }>("SELECT account_id AS id FROM local_accounts ORDER BY account_id");
      for (const row of recipients.toArray()) {
        notify(db, { recipientId: row.id, type: "status", fromId: AUTHOR, statusId: S.authorBoostFresh, now: NOW });
      }
    },
    writes: "SELECT CAST(id AS TEXT) AS id, account_id FROM notifications ORDER BY id",
  },
  "list v1": {
    run: (sql, transact) =>
      listNotifications.run(
        sql,
        {
          page: page(80),
          types: [],
          excludeTypes: [],
          accountId: null,
          includeFiltered: false,
          present: PRESENT,
          credential: credential("read"),
        },
        transact,
      ),
  },
  "by id": {
    run: (sql, transact, c) =>
      getNotification.run(sql, { id: c.notification, present: PRESENT, credential: credential("read") }, transact),
  },
  "group single": {
    run: (sql, transact, c) =>
      getNotificationGroup.run(sql, { groupKey: c.group, present: PRESENT, credential: credential("read") }, transact),
  },
  "grouped list": {
    run: (sql, transact) =>
      listGroupedNotifications.run(
        sql,
        {
          page: page(40, { maxId: "9223372036854775807" }),
          types: [],
          excludeTypes: [],
          groupedTypes: null,
          includeFiltered: false,
          expandAccounts: "full",
          present: PRESENT,
          credential: credential("read"),
        },
        transact,
      ),
  },
  "mentioned status": { run: (sql) => mentionedStatus(new Db(sql), viewer(), S.mention) },
  "request list": {
    run: (sql, transact) =>
      listNotificationRequests.run(sql, { page: page(40), present: PRESENT, credential: credential("read") }, transact),
  },
  "request accept": {
    run: (sql, transact, c) =>
      acceptNotificationRequest.run(sql, { id: c.request, now: NOW, credential: credential("write") }, transact),
    writes: "SELECT CAST(id AS TEXT) AS id, filtered FROM notifications ORDER BY id",
  },
  "push claim": {
    run: (sql, transact) => claimPushes.run(sql, { now: NOW + 1, leaseToken: "lease" }, transact),
    writes: "SELECT CAST(id AS TEXT) AS id, state FROM push_deliveries ORDER BY id",
  },
  ...Object.fromEntries(
    (
      [
        ["followed author", S.authorPublic],
        ["followed author's boost", S.authorBoost],
        ["own", S.own],
        ["own boost", S.ownBoost],
        ["mention", S.authorDirect],
        ["hashtag", S.tagged],
      ] as const
    ).map(([branch, statusId]) => [
      `home status: ${branch}`,
      { run: (sql: SqlStorage) => homeStatus(new Db(sql), viewer(), statusId) },
    ]),
  ),
  ...Object.fromEntries(
    (["max", "min"] as const).flatMap((edge) => {
      const at = edge === "max" ? { maxId: "999999999999999999" } : { minId: "1" };
      return [
        [
          `home window ${edge}`,
          {
            run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) =>
              homeTimeline.run(sql, { page: page(20, at), present: PRESENT, credential: credential("read") }, transact),
          },
        ],
        [
          `list window ${edge}`,
          {
            run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) =>
              listTimeline.run(
                sql,
                { id: "650000000000000001", page: page(20, at), present: PRESENT, credential: credential("read") },
                transact,
              ),
          },
        ],
        [
          `hashtag window ${edge}`,
          {
            run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) =>
              tagTimeline.run(
                sql,
                {
                  tag: "a",
                  any: TAGS.slice(1),
                  all: [],
                  none: [],
                  local: false,
                  remote: false,
                  onlyMedia: false,
                  page: page(20, at),
                  present: PRESENT,
                  credential: credential("read"),
                  now: NOW,
                },
                transact,
              ),
          },
        ],
        [
          `hashtag walked ${edge}`,
          {
            run: (sql: SqlStorage, transact: <T>(fn: () => T) => T) =>
              tagTimeline.run(
                sql,
                {
                  tag: "a",
                  any: TAGS.slice(1),
                  all: ["e"],
                  none: ["z"],
                  local: false,
                  remote: true,
                  onlyMedia: false,
                  page: page(20, at),
                  present: PRESENT,
                  credential: credential("read"),
                  now: NOW,
                },
                transact,
              ),
          },
        ],
      ];
    }),
  ),
};
