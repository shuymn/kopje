import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { credentialAccount } from "../src/domain/accounts";
import { actorDocument, moderationUpdate } from "../src/domain/actor-update";
import { localActorOf } from "../src/domain/actors";
import { utf8Length } from "../src/platform/dump-format";
import {
  ATTRIBUTION_DOMAIN_BYTES,
  ATTRIBUTION_DOMAINS_BYTES,
  ATTRIBUTION_DOMAINS_JSON_MAX,
  MAX_ATTRIBUTION_DOMAINS,
  presentedAttributionDomains,
} from "../src/platform/stored-bounds";
import { bearer, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { LEGACY } from "./federation-helpers";
import { observedSql } from "./read-helpers";
import { community } from "./status-helpers";

// Attribution domains as presented (CredentialAccount's source, the actor endpoint, the Update): read within
// ATTRIBUTION_DOMAINS_BYTES stored bytes (attributionDomainsSql) and presented as at most MAX_ATTRIBUTION_DOMAINS
// strings that pass withinAttributionDomainBound. Migration 0024's CHECK holds only the column's shape, so an import
// may hold anything that is a JSON array.

const ORIGIN = "https://kopje.test";

async function setup() {
  const h = await community(["alice"]);
  const alice = h.users.alice;
  // A key the actor endpoint can publish.
  await sql(h.store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
  const store = async (value: string | ArrayBuffer) =>
    sql(
      h.store,
      "UPDATE local_accounts SET attribution_domains = CAST(? AS TEXT) WHERE account_id = ?",
      value,
      alice.id,
    );
  const source = async () => {
    const response = await h.request("/api/v1/accounts/verify_credentials", bearer(alice.token));
    expect(response.status).toBe(200);
    return (await response.json<{ source: { attribution_domains: string[] } }>()).source.attribution_domains;
  };
  const actor = async () => {
    const response = await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } });
    expect(response.status).toBe(200);
    return response.json<Record<string, unknown>>();
  };
  return { h, alice, store, source, actor };
}

// A JSON array of `domains`, `spaces` spaces after its bracket (json_valid passes them).
const arrayOf = (domains: readonly string[], spaces = 0) => `[${" ".repeat(spaces)}${JSON.stringify(domains).slice(1)}`;
// MAX_ATTRIBUTION_DOMAINS entries of ATTRIBUTION_DOMAIN_BYTES ASCII bytes each.
const FULL = Array.from({ length: MAX_ATTRIBUTION_DOMAINS }, (_, i) => `d${i}.`.padEnd(ATTRIBUTION_DOMAIN_BYTES, "a"));

describe("attribution domains as presented", () => {
  it("presents an oversized import as [], and reads no more of it than its bound", async () => {
    const { h, alice, source, actor } = await setup();
    // One element of 1 MiB, which 0024's CHECK passes (workerd's SQLite stores no value past 2 MB).
    await sql(
      h.store,
      "UPDATE local_accounts SET attribution_domains = json_array(hex(zeroblob(524288))) WHERE account_id = ?",
      alice.id,
    );
    const [stored] = await sql<{ bytes: number }>(
      h.store,
      "SELECT octet_length(attribution_domains) AS bytes FROM local_accounts WHERE account_id = ?",
      alice.id,
    );
    expect(stored?.bytes).toBe(1024 * 1024 + 4);
    expect(await source()).toEqual([]);
    expect(await actor()).not.toHaveProperty("attributionDomains");
    // What each reader takes out of SQLite: the projection's '[]', never the stored value.
    const read = await runInDurableObject(h.store, (_instance, state) => {
      const values: unknown[] = [];
      const db = new Db(
        observedSql(state.storage.sql, (rows) => {
          for (const row of rows) {
            if ("attribution_domains" in row) {
              values.push(row.attribution_domains);
            }
          }
        }),
      );
      const credential = credentialAccount(db, alice.id, { origin: ORIGIN });
      const local = localActorOf(db, "alice");
      const document = actorDocument(db, alice.id);
      const update = moderationUpdate(db, alice.id, NOW);
      return {
        values,
        presented: [credential?.source.attribution_domains, local?.attributionDomains],
        documents: [document, update?.activity.object as Record<string, unknown> | undefined],
      };
    });
    // credentialAccount's local row, localActorOf's, actorDocument's and moderationUpdate's actor rows.
    expect(read.values).toEqual(["[]", "[]", "[]", "[]"]);
    expect(read.presented).toEqual([[], []]);
    for (const document of read.documents) {
      expect(document).toMatchObject({ type: "Person" });
      expect(document).not.toHaveProperty("attributionDomains");
    }
  });

  it("presents a list at its bound whole, and none one byte past it", async () => {
    const { store, source, actor } = await setup();
    expect(utf8Length(arrayOf(FULL))).toBe(ATTRIBUTION_DOMAINS_JSON_MAX);
    // ATTRIBUTION_DOMAINS_JSON_MAX, then ATTRIBUTION_DOMAINS_BYTES stored bytes: presented whole, as JSON of
    // ATTRIBUTION_DOMAINS_JSON_MAX.
    for (const spaces of [0, 1]) {
      await store(arrayOf(FULL, spaces));
      expect(utf8Length(arrayOf(FULL, spaces))).toBe(ATTRIBUTION_DOMAINS_JSON_MAX + spaces);
      const shown = await source();
      expect(shown).toEqual(FULL);
      expect(utf8Length(JSON.stringify(shown))).toBe(ATTRIBUTION_DOMAINS_JSON_MAX);
      expect((await actor()).attributionDomains).toEqual(FULL);
    }
    expect(ATTRIBUTION_DOMAINS_JSON_MAX + 1).toBe(ATTRIBUTION_DOMAINS_BYTES);
    // One stored byte past ATTRIBUTION_DOMAINS_BYTES: read as '[]'.
    await store(arrayOf(FULL, 2));
    expect(await source()).toEqual([]);
    expect(await actor()).not.toHaveProperty("attributionDomains");
  });

  it("presents the first MAX_ATTRIBUTION_DOMAINS entries", async () => {
    const { store, source } = await setup();
    const many = Array.from({ length: MAX_ATTRIBUTION_DOMAINS + 1 }, (_, i) => `d${i}.example`);
    await store(JSON.stringify(many));
    expect(await source()).toEqual(many.slice(0, MAX_ATTRIBUTION_DOMAINS));
  });

  it("drops each entry past its bound or not a string, keeping its neighbours", async () => {
    const { store, source } = await setup();
    const encoder = new TextEncoder();
    const raw = (n: number) => new Uint8Array(n).fill(0x80);
    // A JSON array whose strings are given as bytes: an entry of lone continuation bytes, which decode to one U+FFFD
    // each (three UTF-8 bytes).
    const bytesOf = (parts: readonly (string | Uint8Array)[]) => {
      const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
      const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
      }
      return all.buffer;
    };
    const atBound = "y".repeat(ATTRIBUTION_DOMAIN_BYTES);
    const control = (n: number) => "\u0001".repeat(n);
    // Escaped: 170 controls are 1,022 JSON bytes, 171 are 1,028 (171 raw bytes, within ATTRIBUTION_DOMAIN_BYTES).
    // Malformed: 340 bytes decode to 1,020 UTF-8 bytes, 341 to 1,023.
    await store(
      bytesOf([
        `["a.example",${JSON.stringify(atBound)},${JSON.stringify(`${atBound}y`)},"b.example",`,
        `${JSON.stringify(control(170))},${JSON.stringify(control(171))},"`,
        raw(340),
        '","',
        raw(341),
        '",1,{"a":"c.example"},null,["d.example"],true,"e.example"]',
      ]),
    );
    expect(await source()).toEqual([
      "a.example",
      atBound,
      "b.example",
      control(170),
      "\uFFFD".repeat(340),
      "e.example",
    ]);
  });

  it("presents [] for a value that is not a JSON array, without throwing", () => {
    for (const stored of ["", "{}", '"a.example"', "1", "null", "[", "\uFFFD"]) {
      expect(presentedAttributionDomains(stored)).toEqual([]);
    }
  });
});
