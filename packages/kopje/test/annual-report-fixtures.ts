import {
  REPORT_FOLLOWERS,
  REPORT_HASHTAG_BYTES,
  REPORT_HASHTAG_USES,
  REPORT_TAG_CANDIDATES,
  REPORT_YEAR_STATUSES,
} from "../src/domain/annual-reports";
import { MAX_TAG_LENGTH, TAG_NAME_BYTES } from "../src/domain/status-bounds";

// Fixtures of the annual report tests and bench, written with SQL: an account's statuses at chosen ids of a year, their
// hashtags and polls, its followers, and the all-caps witness (every input the year's reads take at its cap at once).

export const YEAR = 2026;
// A time in the 2026 campaign (December 10 to 31, UTC).
export const IN_CAMPAIGN = Date.UTC(2026, 11, 20, 12);

// The id at `offset` past the start of `year`'s id range (the year's first millisecond << 16), as 18-digit TEXT; a
// negative offset is before the year.
export function idIn(year: number, offset: number | bigint): string {
  return ((BigInt(Date.UTC(year, 0, 1)) << 16n) + BigInt(offset)).toString();
}

// The first id of the year after `year`: the range's exclusive end.
export function yearEnd(year: number): string {
  return idIn(year + 1, 0);
}

export type Post = {
  id: string;
  account: string;
  visibility?: "public" | "unlisted" | "private" | "direct" | "limited";
  reblogOf?: string;
  // in_reply_to_uri, in_reply_to_id (a status that exists, or null: unresolved) and in_reply_to_account_id.
  reply?: { id: string | null; account: string | null };
  withdrawn?: boolean;
  replies?: number;
  reblogs?: number;
  favourites?: number;
  // Names as text, or as raw bytes (an import's malformed UTF-8).
  tags?: readonly (string | Uint8Array)[];
  poll?: boolean;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const utf8 = (text: string) => new TextEncoder().encode(text);

// Writes `post` as a statuses row (and its tags and poll).
export function insertPost(sql: SqlStorage, post: Post): void {
  sql.exec(
    `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id, in_reply_to_uri,
			in_reply_to_id, in_reply_to_account_id, withdrawn, replies_count, reblogs_count, favourites_count)
		VALUES (?1, 'https://kopje.test/ap/o/' || ?1, ?2, ?3, ?4, '2026-06-01T00:00:00.000Z', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    post.id,
    post.account,
    post.visibility ?? "public",
    post.reblogOf === undefined ? "<p>post</p>" : "",
    post.reblogOf ?? null,
    post.reply === undefined ? null : `https://kopje.test/ap/o/${post.reply.id ?? "unknown"}`,
    post.reply?.id ?? null,
    post.reply?.account ?? null,
    post.withdrawn === true ? 1 : 0,
    post.replies ?? 0,
    post.reblogs ?? 0,
    post.favourites ?? 0,
  );
  for (const tag of post.tags ?? []) {
    sql.exec(
      "INSERT INTO status_tags (status_id, name) VALUES (?, CAST(unhex(?) AS TEXT))",
      post.id,
      hex(typeof tag === "string" ? utf8(tag) : tag),
    );
  }
  if (post.poll === true) {
    sql.exec(
      `INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
			VALUES (?, '["a","b"]', '[0,0]', 0, 0, NULL)`,
      post.id,
    );
  }
}

// `count` remote accounts with ids from `base` (each its own row), as followers or anything else that needs accounts.
export function insertAccounts(sql: SqlStorage, count: number, base: bigint): void {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT CAST(?2 + i AS TEXT), 'https://r.example/users/f' || (?2 + i), 'f' || i, 'r.example' FROM n`,
    count,
    String(base),
  );
}

// Follows of `target` by the accounts from `base` on (insertAccounts'), `count` of them in `state`, created at `at`.
export function insertFollows(
  sql: SqlStorage,
  target: string,
  count: number,
  base: bigint,
  state: "accepted" | "pending",
  at: string,
): void {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO follows (account_id, target_account_id, state, created_at)
		SELECT CAST(?2 + i AS TEXT), ?3, ?4, ?5 FROM n`,
    count,
    String(base),
    target,
    state,
    at,
  );
}

// ---- The all-caps witness

export type WitnessVariant = "admissible-32nd" | "admissible-33rd" | "all-refused";

// What the witness holds, by input (the report test names each with its constant).
export type Witness = {
  // The owner's year rows (REPORT_YEAR_STATUSES): originals, replies, boosts, polls and withdrawn rows of every
  // visibility, the only counted public one last in id order.
  statuses: number;
  // Of those, the rows that count (not withdrawn) and their archetype counts.
  counted: number;
  standalone: number;
  replies: number;
  reblogs: number;
  polls: number;
  // The owner's tag rows (REPORT_HASHTAG_USES) and their name bytes (REPORT_HASHTAG_BYTES).
  uses: number;
  bytes: number;
  // The names ranked above the admissible one, each refused by listedTagName (NUL or malformed UTF-8).
  refused: number;
  // The name the report stores, or null.
  admissible: string | null;
  // The last row, the only counted public one (the report's top status).
  top: string;
  // Accepted followers (REPORT_FOLLOWERS), those whose request lies in the year, and the pending requests.
  followers: number;
  followersInYear: number;
  pending: number;
};

// The refused groups' uses, the admissible group's, and every other name's (each used once, a group of its own).
const REFUSED_USES = 3;
const ADMISSIBLE_USES = 2;

// A name of exactly `bytes` UTF-8 bytes beginning with `head`, filled with astral characters (four bytes, one character
// as SQLite counts) and up to three ASCII bytes, within tagNameSql's bound (TAG_NAME_BYTES, MAX_TAG_LENGTH).
function nameOf(head: Uint8Array, bytes: number): Uint8Array {
  const astral = utf8("😀");
  const fill = bytes - head.length;
  const quads = Math.floor(fill / 4);
  const out = new Uint8Array(bytes);
  out.set(head, 0);
  for (let i = 0; i < quads; i++) {
    out.set(astral, head.length + 4 * i);
  }
  out.fill(0x61, head.length + 4 * quads);
  if (bytes > TAG_NAME_BYTES || head.length + quads + (fill - 4 * quads) > MAX_TAG_LENGTH) {
    throw new Error(`witness name of ${bytes} bytes is past tagNameSql's bound`);
  }
  return out;
}

// Builds the witness of `owner`'s year `year` in `sql` (the caps of src/domain/annual-reports.ts at once):
// - REPORT_YEAR_STATUSES own rows, interleaved in id order with `other`'s rows of the same range, and own rows just
//   outside the year on both sides; every 10th own row withdrawn, then boosts of `other`'s rows, replies, polls and
//   originals in turn, private, direct and limited, but the last row: the only counted public status, with a boost;
// - REPORT_HASHTAG_USES tag rows on the counted rows whose names sum to exactly REPORT_HASHTAG_BYTES, every name within
//   tagNameSql's bound, so every one is grouped: the refused groups (REFUSED_USES each, NUL or malformed UTF-8),
//   then the admissible group (ADMISSIBLE_USES, ranked REPORT_TAG_CANDIDATES-th, one past it, or used once), then
//   distinct names used once each, as many groups as the uses allow;
// - REPORT_FOLLOWERS accepted follows of the owner, half requested in the year and a tenth with a malformed time, and
//   as many pending requests, by accounts from `followerBase`.
export function buildWitness(
  sql: SqlStorage,
  owner: string,
  other: string,
  variant: WitnessVariant,
  options: { year?: number; followerBase?: bigint } = {},
): Witness {
  const year = options.year ?? YEAR;
  const S = REPORT_YEAR_STATUSES;
  const own = (i: number) => idIn(year, 2 * i);
  // The other account's rows first: the boosts point at them.
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
		SELECT CAST(?2 + 2 * i + 1 AS TEXT), 'https://kopje.test/ap/o/' || (?2 + 2 * i + 1), ?3, 'public', '<p>x</p>',
			'2026-06-01T00:00:00.000Z' FROM n`,
    S,
    idIn(year, 0),
    other,
  );
  // Each own row's kind by i % 10: 0 withdrawn (a private original), 1-2 a boost, 3-4 a reply to `other` (resolved),
  // 5 a poll, 6 a self-reply, 7-9 an original; visibilities cycle private, direct, limited.
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO statuses (id, uri, account_id, visibility, content, published_at, reblog_of_id, in_reply_to_uri,
			in_reply_to_id, in_reply_to_account_id, withdrawn)
		SELECT CAST(?2 + 2 * i AS TEXT), 'https://kopje.test/ap/o/' || (?2 + 2 * i), ?3,
			CASE i % 3 WHEN 0 THEN 'private' WHEN 1 THEN 'direct' ELSE 'limited' END,
			CASE WHEN i % 10 IN (1, 2) THEN '' ELSE '<p>x</p>' END, '2026-06-01T00:00:00.000Z',
			CASE WHEN i % 10 IN (1, 2) THEN CAST(?2 + 2 * i + 1 AS TEXT) END,
			CASE WHEN i % 10 IN (3, 4) THEN 'https://kopje.test/ap/o/' || (?2 + 2 * i + 1)
				WHEN i % 10 = 6 THEN 'https://kopje.test/ap/o/self' END,
			CASE WHEN i % 10 IN (3, 4) THEN CAST(?2 + 2 * i + 1 AS TEXT) END,
			CASE WHEN i % 10 IN (3, 4) THEN ?4 WHEN i % 10 = 6 THEN ?3 END,
			CASE WHEN i % 10 = 0 THEN 1 ELSE 0 END
		FROM n`,
    S - 1,
    idIn(year, 0),
    owner,
    other,
  );
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
		INSERT INTO polls (status_id, options, tallies, votes_count, voters_count, expires_at)
		SELECT CAST(?2 + 2 * i AS TEXT), '["a","b"]', '[0,0]', 0, 0, NULL FROM n WHERE i % 10 = 5`,
    S - 1,
    idIn(year, 0),
  );
  const top = own(S - 1);
  insertPost(sql, { id: top, account: owner, visibility: "public", reblogs: 1 });
  // Own rows just outside the year, and the other account's.
  insertPost(sql, { id: idIn(year, -1), account: owner, visibility: "public", tags: ["outside"] });
  insertPost(sql, { id: yearEnd(year), account: owner, visibility: "public", tags: ["outside"] });
  // The counts of the S - 1 generated rows and the last.
  let counted = 1;
  let standalone = 1;
  let replies = 0;
  let reblogs = 0;
  let polls = 0;
  for (let i = 0; i < S - 1; i++) {
    const kind = i % 10;
    if (kind === 0) {
      continue;
    }
    counted++;
    if (kind === 1 || kind === 2) {
      reblogs++;
    } else if (kind === 3 || kind === 4) {
      replies++;
    } else {
      standalone++;
      polls += kind === 5 ? 1 : 0;
    }
  }
  // The counted rows that carry tags, in id order.
  const tagged: string[] = [];
  for (let i = 0; i < S; i++) {
    if (i % 10 !== 0) {
      tagged.push(own(i));
    }
  }
  const { names, admissible } = witnessNames(variant);
  // Tag uses in order: each name's uses on consecutive counted rows (distinct statuses), round-robin.
  const rows: [string, Uint8Array][] = names.map((name, k) => [tagged[k % tagged.length]!, name]);
  for (let at = 0; at < rows.length; at += 500) {
    sql.exec(
      `INSERT INTO status_tags (status_id, name)
			SELECT json_extract(value, '$[0]'), CAST(unhex(json_extract(value, '$[1]')) AS TEXT) FROM json_each(?)`,
      JSON.stringify(rows.slice(at, at + 500).map(([id, name]) => [id, hex(name)])),
    );
  }
  // Other accounts' uses of the same names are not the owner's (a growth witness grows them).
  const followers = REPORT_FOLLOWERS;
  const base = options.followerBase ?? 700000000000000000n;
  insertAccounts(sql, 2 * followers, base);
  const inYear = Math.floor(followers / 2);
  const malformed = Math.floor(followers / 10);
  insertFollows(sql, owner, inYear, base, "accepted", `${year}-03-01T00:00:00.000Z`);
  insertFollows(sql, owner, malformed, base + BigInt(inYear), "accepted", "garbage");
  insertFollows(
    sql,
    owner,
    followers - inYear - malformed,
    base + BigInt(inYear + malformed),
    "accepted",
    `${year - 1}-03-01T00:00:00.000Z`,
  );
  insertFollows(sql, owner, followers, base + BigInt(followers), "pending", `${year}-03-01T00:00:00.000Z`);
  return {
    statuses: S,
    counted,
    standalone,
    replies,
    reblogs,
    polls,
    uses: rows.length,
    bytes: rows.reduce((sum, [, name]) => sum + name.length, 0),
    refused: refusedGroups(variant),
    admissible: variant === "admissible-32nd" ? admissible : null,
    top,
    followers,
    followersInYear: inYear,
    pending: followers,
  };
}

function refusedGroups(variant: WitnessVariant): number {
  return variant === "admissible-32nd"
    ? REPORT_TAG_CANDIDATES - 1
    : variant === "admissible-33rd"
      ? REPORT_TAG_CANDIDATES
      : REPORT_TAG_CANDIDATES + 1;
}

// The admissible group's name (its head; the witness fills it to its bytes).
export const ADMISSIBLE_HEAD = "kopjeadmissible";

// Every tag row's name, in order, REPORT_HASHTAG_USES of them summing to REPORT_HASHTAG_BYTES, and the admissible
// group's name.
function witnessNames(variant: WitnessVariant): { names: Uint8Array[]; admissible: string } {
  const T = REPORT_HASHTAG_USES;
  const refused = refusedGroups(variant);
  const admissibleUses = variant === "all-refused" ? 1 : ADMISSIBLE_USES;
  // Each row's byte length: the bytes spread evenly, the remainder on the first rows.
  const size = (row: number) => Math.floor(REPORT_HASHTAG_BYTES / T) + (row < REPORT_HASHTAG_BYTES % T ? 1 : 0);
  const heads: Uint8Array[] = [];
  for (let g = 0; g < refused; g++) {
    // Refused by listedTagName, admitted by tagNameSql: a NUL, or a byte that is not UTF-8. Their names sort before
    // the admissible one, so ties by uses do not reorder them.
    const head =
      g % 2 === 0
        ? utf8(`a${String(g).padStart(3, "0")}\u0000`)
        : new Uint8Array([0x61, 0xff, ...utf8(String(g).padStart(3, "0"))]);
    for (let u = 0; u < REFUSED_USES; u++) {
      heads.push(head);
    }
  }
  for (let u = 0; u < admissibleUses; u++) {
    heads.push(utf8(ADMISSIBLE_HEAD));
  }
  for (let k = heads.length; k < T; k++) {
    heads.push(utf8(`s${k.toString(36)}-`));
  }
  // A name's bytes are fixed per group: every use of a group takes its first row's size.
  const names: Uint8Array[] = [];
  const firstSize = new Map<string, number>();
  let total = 0;
  heads.forEach((head, row) => {
    const key = hex(head);
    const bytes = firstSize.get(key) ?? size(row);
    firstSize.set(key, bytes);
    names.push(nameOf(head, bytes));
    total += bytes;
  });
  // Group uses share their first row's size; the last singleton absorbs the difference, so the sum is exact.
  const last = names.length - 1;
  const lastBytes = names[last]!.length + (REPORT_HASHTAG_BYTES - total);
  names[last] = nameOf(heads[last]!, lastBytes);
  const admissible = names[REFUSED_USES * refused]!;
  return { names, admissible: new TextDecoder().decode(admissible) };
}
