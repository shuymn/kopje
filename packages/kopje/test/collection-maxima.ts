import { USERNAME_LIMIT } from "../src/domain/profile-bounds";
import { MAX_TAG_LENGTH } from "../src/domain/status-bounds";
import { TREND_LANGUAGES } from "../src/domain/trend-languages";
import { ACTOR_URI_LIMIT, REMOTE_USERNAME_LIMIT } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import {
  COLLECTION_DESCRIPTION_LENGTH,
  COLLECTION_NAME_LENGTH,
  COLLECTION_URI_BYTES,
  COLLECTION_URL_BYTES,
  MAX_TAGGED_COLLECTIONS,
} from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";

let sequence = 840_000_000_000_000_000n;
const nextId = () => String(sequence++);

// `count` remote collections at their maxima as a sync stores them (#1589's D26), and their ids: their owner on
// o.example with its actor id and username at their bounds in ASCII (ACTOR_URI_LIMIT bytes, which the reads take with
// each collection, and REMOTE_USERNAME_LIMIT characters), each id and web address on its origin with the rest of its
// bound in `"` (escaped to two bytes), its name and description at their bounds in `unit` (a character JSON escapes
// to six bytes, or one of four UTF-8 bytes), the longest language, a hashtag at its bound, and the 25 accepted items of
// 25 members a listing stores (each with its uri, so R45 shows it). Presented, each is COLLECTION_JSON_MAX less its
// origin's bytes in its id and url. `restored`: as a restored dump may hold them, each text a tag reads that can be
// malformed at the most the read takes of it, decoded at its widest (`malformed`): the owner's actor id at
// ACTOR_URI_LIMIT bytes (actorUriSql), and the name, description and tag at their CHECKs' bytes; its username, which no
// read takes, at USERNAME_LIMIT. The other columns the read takes are ASCII or digits by their CHECKs. None is shown.
export async function maximalCollectionRows(
  store: StoreStub,
  unit: string,
  count: number,
  restored = false,
): Promise<string[]> {
  const origin = "https://o.example";
  const owner = nextId();
  await sql(
    store,
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, CAST(?2 AS TEXT), CAST(?3 AS TEXT), 'o.example')",
    owner,
    restored ? malformed(ACTOR_URI_LIMIT, owner) : `${origin}/users/${owner}/`.padEnd(ACTOR_URI_LIMIT, "a"),
    restored ? malformed(USERNAME_LIMIT, owner) : `o${owner}`.padEnd(REMOTE_USERNAME_LIMIT, "o"),
  );
  const members = Array.from({ length: 25 }, () => nextId());
  for (const [i, member] of members.entries()) {
    await sql(
      store,
      "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'm.example')",
      member,
      `https://m.example/users/m${i}`,
      `m${i}`,
    );
  }
  const text = (length: number) => unit.repeat(length);
  const quoted = (path: string, bytes: number) => `${origin}/${path}/`.padEnd(bytes, '"');
  const language = [...TREND_LANGUAGES].reduce((a, b) => (b.length > a.length ? b : a));
  const at = new Date(NOW).toISOString();
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const id = nextId();
    await sql(
      store,
      `INSERT INTO collections (id, account_id, local, name, description, language, sensitive, discoverable, tag, uri,
				url, total_items, created_at, updated_at)
			VALUES (?, ?, 0, CAST(?3 AS TEXT), CAST(?4 AS TEXT), ?, 0, 0, CAST(?6 AS TEXT), ?, ?, 25, ?9, ?9)`,
      id,
      owner,
      restored ? malformed(4 * COLLECTION_NAME_LENGTH.remote) : text(COLLECTION_NAME_LENGTH.remote),
      restored ? malformed(4 * COLLECTION_DESCRIPTION_LENGTH.remote) : text(COLLECTION_DESCRIPTION_LENGTH.remote),
      language,
      restored ? malformed(4 * MAX_TAG_LENGTH) : "\u{20000}".repeat(MAX_TAG_LENGTH),
      quoted(`c${n}`, COLLECTION_URI_BYTES),
      quoted(`w${n}`, COLLECTION_URL_BYTES),
      at,
    );
    for (const [i, member] of members.entries()) {
      await sql(
        store,
        `INSERT INTO collection_items (id, collection_id, account_id, state, position, uri, created_at, updated_at)
				VALUES (?, ?, ?, 1, ?, ?, ?6, ?6)`,
        nextId(),
        id,
        member,
        i + 1,
        `${origin}/items/${n}/${i}`,
        at,
      );
    }
    ids.push(id);
  }
  return ids;
}

// `bytes` stored bytes of restored text decoded at their widest: 0xC0, which no well-formed sequence starts with, then
// continuation bytes, `seed`'s digits among them so that two owners differ. Decoding gives one code point for each
// well-formed sequence, of as many UTF-8 bytes, and one U+FFFD, three bytes, for each malformed sequence of at least
// one byte, so no b bytes decode to more than 3b; here each byte is a malformed sequence of its own, 3b. SQLite counts
// the whole as one character, so it is within each character bound the read or a CHECK applies (usernameSql's cut).
export function malformed(bytes: number, seed = ""): ArrayBuffer {
  const out = new Uint8Array(bytes).fill(0x80);
  out[0] = 0xc0;
  for (const [i, digit] of [...seed].entries()) {
    out[1 + i] = 0x80 + Number(digit);
  }
  return out.buffer;
}

// MAX_TAGGED_COLLECTIONS of maximalCollectionRows' collections tagged by each of `statuses`, each status its own.
export async function maximalCollections(
  store: StoreStub,
  unit: string,
  statuses: readonly string[],
  restored = false,
): Promise<void> {
  const ids = await maximalCollectionRows(store, unit, MAX_TAGGED_COLLECTIONS * statuses.length, restored);
  for (const [n, id] of ids.entries()) {
    const status = statuses[Math.floor(n / MAX_TAGGED_COLLECTIONS)]!;
    await sql(store, "INSERT INTO status_collections (status_id, collection_id) VALUES (?, ?)", status, id);
  }
}
