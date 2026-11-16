import { describe, expect, it } from "vitest";

import { ACCOUNT_COLUMN_MAP } from "../src/domain/account-columns";
import { MAX_NOTE } from "../src/domain/accounts";
import { htmlToPlainText } from "../src/domain/plain-text";
import { MAX_RAW_LENGTH, noteLength } from "../src/domain/status-text";
import { utf8Length } from "../src/platform/dump-format";
import { BIO_JSON_BYTES, DISPLAY_NAME_LIMIT, DISPLAY_NAME_READ_BYTES } from "../src/platform/stored-bounds";
import { bearer, json, sql } from "./api-helpers";
import { WIDEST_NOTE } from "./note-fills";
import { community, remoteAccount, seedStatus } from "./status-helpers";

// RES-3: an Account's display name and note as an import may hold them, in malformed UTF-8 that passes the triggers of
// 0048_stored_bounds and decodes past their bounds. Three units, which are not interchangeable for such bytes: the
// stored bytes read (SQL octet_length of the projected value), and the presented JSON (UTF-8 of the answer), where one
// stored byte decodes to a U+FFFD of three.

// 0xFF (a lead byte, when `lead`) and `continuation` bytes of 0x80: one character to SQLite's length and substr with
// the lead, `continuation` characters without; each byte decodes to one U+FFFD.
function malformed(lead: boolean, continuation: number): ArrayBuffer {
  const bytes = new Uint8Array(continuation + (lead ? 1 : 0)).fill(0x80);
  if (lead) {
    bytes[0] = 0xff;
  }
  return bytes.buffer;
}

// A display name of 1 MiB that 0048's character cut (displayNameSql, 2,048) passes whole, and a note of 65,534 bytes
// that its JSON bound (noteSql, BIO_JSON_BYTES) passes: json_quote copies the bytes as they are.
const NAME_BYTES = 1_048_576;
const NOTE_BYTES = 65_534;
const W = "𠀀";

async function setup() {
  const h = await community(["alice"]);
  const remote = await remoteAccount(h.store, "bob");
  const local = h.users.alice.id;
  const statuses = {
    [remote]: await seedStatus(h.store, { accountId: remote, visibility: "public" }),
    [local]: await seedStatus(h.store, { accountId: local, visibility: "public" }),
  };
  const get = async <T>(path: string) => {
    const response = await h.request(path, bearer(h.users.alice.token));
    expect(response.status).toBe(200);
    return response.json<T>();
  };
  // The Account of `id` as its own read, a status's author and (the local one) verify_credentials show it.
  const presented = async (id: string) => {
    const account = await get<{ display_name: string; note: string }>(`/api/v1/accounts/${id}`);
    const status = await get<{ account: { display_name: string; note: string } }>(`/api/v1/statuses/${statuses[id]}`);
    return [account, status.account];
  };
  const credential = () =>
    get<{ display_name: string; note: string; source: { note: string } }>("/api/v1/accounts/verify_credentials");
  // What the Account's read takes of the display name out of SQLite, in stored bytes.
  const readBytes = async (id: string) => {
    const [row] = await sql<{ read: number; stored: number }>(
      h.store,
      `SELECT octet_length(${ACCOUNT_COLUMN_MAP.display_name}) AS read, octet_length(a.display_name) AS stored
			FROM accounts a WHERE a.id = ?`,
      id,
    );
    return row;
  };
  return { h, remote, local, presented, credential, readBytes };
}

describe("an Account's display name and note (RES-3)", () => {
  it("presents a malformed import within its bounds", async () => {
    const { h, remote, local, presented, credential, readBytes } = await setup();
    // An import as a dump holds it: the trigger accounts_bounds_update passes both values.
    await sql(
      h.store,
      "UPDATE accounts SET display_name = CAST(? AS TEXT), note = CAST(? AS TEXT) WHERE id IN (?, ?)",
      malformed(true, NAME_BYTES - 1),
      malformed(false, NOTE_BYTES),
      remote,
      local,
    );
    const name = "\uFFFD".repeat(DISPLAY_NAME_LIMIT);
    for (const id of [remote, local]) {
      // Stored whole, and read as its first DISPLAY_NAME_READ_BYTES (8,192), which decode to 8,192 U+FFFD.
      expect(await readBytes(id)).toEqual({ read: DISPLAY_NAME_READ_BYTES, stored: NAME_BYTES });
      for (const account of await presented(id)) {
        // 2,048 U+FFFD, 6,146 JSON bytes, where the whole value presented 3,145,730; the note '', where it presented
        // 196,604.
        expect(account.display_name).toBe(name);
        expect(utf8Length(JSON.stringify(account.display_name))).toBe(6_146);
        expect(account.note).toBe("");
      }
    }
    const own = await credential();
    expect({ name: own.display_name, note: own.note, source: own.source.note }).toEqual({ name, note: "", source: "" });
  });

  it("presents a writer's display name and a note at the JSON bound whole", async () => {
    const { h, remote, local, presented, credential, readBytes } = await setup();
    // 2,048 four-byte characters (8,192 bytes): the most a writer stores (storedDisplayName). A note whose JSON string
    // (json_quote, as noteSql measures it) is exactly BIO_JSON_BYTES: U+0001 escapes to six bytes.
    const name = W.repeat(DISPLAY_NAME_LIMIT);
    const note = `<p>${"\u0001".repeat(10_000)}${"x".repeat(5_527)}</p>`;
    await sql(h.store, "UPDATE accounts SET display_name = ?, note = ? WHERE id IN (?, ?)", name, note, remote, local);
    const [quoted] = await sql<{ bytes: number }>(
      h.store,
      "SELECT octet_length(json_quote(note)) AS bytes FROM accounts WHERE id = ?",
      remote,
    );
    expect(quoted?.bytes).toBe(BIO_JSON_BYTES);
    for (const id of [remote, local]) {
      expect(await readBytes(id)).toEqual({ read: DISPLAY_NAME_READ_BYTES, stored: DISPLAY_NAME_READ_BYTES });
      for (const account of await presented(id)) {
        expect({ name: account.display_name, note: account.note }).toEqual({ name, note });
      }
    }
    const own = await credential();
    expect(own.source.note).toBe(htmlToPlainText(note));
    expect(own.source.note).toHaveLength(15_527);
  });

  // The writer's worst note (E5 of #1606): MAX_RAW_LENGTH code units, each at most six bytes once stored as HTML and
  // quoted as JSON (`"` as `&quot;`, a control character as \u00XX), with <p></p> and json_quote's quotes around them.
  // Within BIO_JSON_BYTES, which migration 0048's trigger and noteSql enforce, so a note the writer stores is presented
  // whole. The witness is the widest note noteLength counts as MAX_NOTE (test/note-fills.ts).
  it("a counted note stays within the note's stored bound", async () => {
    const { h, local } = await setup();
    const worst = 6 * MAX_RAW_LENGTH + 9;
    expect(worst).toBeLessThanOrEqual(BIO_JSON_BYTES);
    expect([WIDEST_NOTE.length, noteLength(WIDEST_NOTE)]).toEqual([MAX_RAW_LENGTH, MAX_NOTE]);
    const response = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(h.users.alice.token, json({ note: WIDEST_NOTE }, { method: "PATCH" })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: { note: WIDEST_NOTE } });
    const [stored] = await sql<{ bytes: number }>(
      h.store,
      "SELECT octet_length(json_quote(note)) AS bytes FROM accounts WHERE id = ?",
      local,
    );
    expect(stored!.bytes).toBe(47_588);
    expect(stored!.bytes).toBeLessThanOrEqual(worst);
  });
});
