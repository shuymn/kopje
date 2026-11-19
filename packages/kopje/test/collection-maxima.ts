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
// o.example with its actor id and username at their bounds in ASCII (ACTOR_URI_LIMIT bytes, REMOTE_USERNAME_LIMIT
// characters; the reads take both with each collection), each id and web address on its origin with the rest of its
// bound in `"` (escaped to two bytes), its name and description at their bounds in `unit` (a character JSON escapes
// to six bytes, or one of four UTF-8 bytes), the longest language, a hashtag at its bound, and the 25 accepted items of
// 25 members a listing stores (each with its uri, so R45 shows it). Presented, each is COLLECTION_JSON_MAX less its
// origin's bytes in its id and url.
export async function maximalCollectionRows(store: StoreStub, unit: string, count: number): Promise<string[]> {
  const origin = "https://o.example";
  const owner = nextId();
  await sql(
    store,
    "INSERT INTO accounts (id, uri, username, domain) VALUES (?, ?, ?, 'o.example')",
    owner,
    `${origin}/users/${owner}/`.padEnd(ACTOR_URI_LIMIT, "a"),
    `o${owner}`.padEnd(REMOTE_USERNAME_LIMIT, "o"),
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
			VALUES (?, ?, 0, ?, ?, ?, 0, 0, ?, ?, ?, 25, ?9, ?9)`,
      id,
      owner,
      text(COLLECTION_NAME_LENGTH.remote),
      text(COLLECTION_DESCRIPTION_LENGTH.remote),
      language,
      "\u{20000}".repeat(MAX_TAG_LENGTH),
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

// MAX_TAGGED_COLLECTIONS of maximalCollectionRows' collections tagged by each of `statuses`, each status its own.
export async function maximalCollections(store: StoreStub, unit: string, statuses: readonly string[]): Promise<void> {
  const ids = await maximalCollectionRows(store, unit, MAX_TAGGED_COLLECTIONS * statuses.length);
  for (const [n, id] of ids.entries()) {
    const status = statuses[Math.floor(n / MAX_TAGGED_COLLECTIONS)]!;
    await sql(store, "INSERT INTO status_collections (status_id, collection_id) VALUES (?, ?)", status, id);
  }
}
