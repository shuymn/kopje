import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { getLocalNote } from "../src/domain/local-notes";
import { claimPushes } from "../src/domain/push";
import { statusByUri } from "../src/domain/remote-status-reads";
import { STATUS_COLUMN_MAP } from "../src/domain/status-rows";
import { editTarget, getStatus, statusHistory, statusSource, TOO_LONG } from "../src/domain/statuses";
import { utf8Length } from "../src/platform/dump-format";
import {
  CONTENT_JSON_BYTES,
  SPOILER_CUT_LIMIT,
  SPOILER_JSON_BYTES,
  SPOILER_READ_BYTES,
} from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { VAPID } from "./push-helpers";
import { observedSql } from "./read-helpers";
import { act, community, outbound, post } from "./status-helpers";

// RES-3: a status's content, source text and content warning as an import may hold them, in malformed UTF-8 that
// passes the triggers of 0048_stored_bounds and decodes past their bounds ("Status text as presented" in
// platform/stored-bounds.ts). Three units, which are not interchangeable for such bytes: the stored bytes read (SQL
// octet_length), the code points of the warning's cut, and the presented JSON (UTF-8 of the answer), where one stored
// byte decodes to a U+FFFD of three.

// 0xFF (a lead byte, when `lead`) and `continuation` bytes of 0x80: one character to SQLite's length and substr with
// the lead, `continuation` characters without; each byte decodes to one U+FFFD.
function malformed(lead: boolean, continuation: number): ArrayBuffer {
  const bytes = new Uint8Array(continuation + (lead ? 1 : 0)).fill(0x80);
  if (lead) {
    bytes[0] = 0xff;
  }
  return bytes.buffer;
}

// W1: content and source text of 131,070 bytes, whose json_quote is 131,072, within contentSql's bound; decoded, a
// JSON string of 393,212 bytes. W3: a warning of 1 MiB, one character to spoilerSql's cut, so its trigger passes it.
const W1 = malformed(true, CONTENT_JSON_BYTES - 3);
const W3 = malformed(true, 1_048_575);
const C = "\u0001";
const FFFD = "�";
const AP = { headers: { accept: "application/activity+json" } };
const jsonBytes = (value: unknown) => utf8Length(JSON.stringify(value));

type Texts = { content: string; spoiler: string };

// A local public status of alice's in English, boosted by bob, with two recorded versions, and what each reader
// presents of its text: the status, the boost (its own row's warning and its original's text), each version of the
// history, the source, and the Note; and the redraft its delete answers, last.
async function setup() {
  const h = await community(["alice", "bob"]);
  const { alice, bob } = h.users;
  const status = await post(h, alice, { status: "original", language: "en" });
  const boosted = await act(h, bob, `/api/v1/statuses/${status.id}/reblog`);
  expect(boosted.status).toBe(200);
  const boost = (await boosted.json<{ id: string }>()).id;
  for (const at of [NOW - 120_000, NOW - 60_000]) {
    await sql(
      h.store,
      "INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at) VALUES (?, '', '', '[]', ?)",
      status.id,
      new Date(at).toISOString(),
    );
  }
  const get = async <T>(path: string, token = alice.token) => {
    const response = await h.request(path, bearer(token));
    expect(response.status, path).toBe(200);
    return response.json<T>();
  };
  // Writes the three columns of the status and of both versions, and the boost's own warning, as SQLite binds the
  // values (an ArrayBuffer as its bytes, cast to TEXT).
  const restore = async (
    content: string | ArrayBuffer,
    source: string | ArrayBuffer,
    spoiler: string | ArrayBuffer,
  ) => {
    await sql(
      h.store,
      `UPDATE statuses SET content = CAST(?1 AS TEXT), source_text = CAST(?2 AS TEXT), spoiler_text = CAST(?3 AS TEXT)
			WHERE id = ?4`,
      content,
      source,
      spoiler,
      status.id,
    );
    await sql(
      h.store,
      "UPDATE status_edits SET content = CAST(?1 AS TEXT), spoiler_text = CAST(?2 AS TEXT) WHERE status_id = ?3",
      content,
      spoiler,
      status.id,
    );
    await sql(h.store, "UPDATE statuses SET spoiler_text = CAST(? AS TEXT) WHERE id = ?", spoiler, boost);
  };
  // Each reader's [content or text, warning], by name.
  const presented = async (): Promise<Record<string, Texts>> => {
    const shown = await get<{ content: string; spoiler_text: string }>(`/api/v1/statuses/${status.id}`);
    const boostOf = await get<{ spoiler_text: string; reblog: { content: string; spoiler_text: string } }>(
      `/api/v1/statuses/${boost}`,
      bob.token,
    );
    const history = await get<{ content: string; spoiler_text: string }[]>(`/api/v1/statuses/${status.id}/history`);
    expect(history).toHaveLength(2);
    const source = await get<{ text: string; spoiler_text: string }>(`/api/v1/statuses/${status.id}/source`);
    const response = await h.request(new URL(status.uri as string).pathname, AP);
    expect(response.status).toBe(200);
    const note = await response.json<{ content: string; contentMap: { en: string }; summary: string | null }>();
    return {
      status: { content: shown.content, spoiler: shown.spoiler_text },
      boost: { content: boostOf.reblog.content, spoiler: boostOf.spoiler_text },
      reblog: { content: boostOf.reblog.content, spoiler: boostOf.reblog.spoiler_text },
      ...Object.fromEntries(history.map((v, i) => [`version ${i}`, { content: v.content, spoiler: v.spoiler_text }])),
      source: { content: source.text, spoiler: source.spoiler_text },
      note: { content: note.content, spoiler: note.summary ?? "" },
      contentMap: { content: note.contentMap.en, spoiler: note.summary ?? "" },
    };
  };
  const redraft = async (): Promise<Texts> => {
    const response = await h.request(`/api/v1/statuses/${status.id}`, bearer(alice.token, { method: "DELETE" }));
    expect(response.status).toBe(200);
    const deleted = await response.json<{ text: string; spoiler_text: string }>();
    return { content: deleted.text, spoiler: deleted.spoiler_text };
  };
  return { h, alice, status: status.id, boost, restore, presented, redraft };
}

// The warning's stored bytes and the bytes the presenter's read takes of it (SQL octet_length).
async function warningBytes(h: Awaited<ReturnType<typeof setup>>["h"], id: string) {
  const [row] = await sql<{ stored: number; read: number }>(
    h.store,
    `SELECT octet_length(s.spoiler_text) AS stored, octet_length(${STATUS_COLUMN_MAP.spoiler_text}) AS read
		FROM statuses s WHERE s.id = ?`,
    id,
  );
  return row;
}

describe("a status's content, source text and content warning (RES-3)", () => {
  it("presents a malformed import within its bounds", async () => {
    const { h, status, restore, presented, redraft } = await setup();
    // An import as a dump holds it: the triggers statuses_bounds_update and status_edits_bounds_update pass all three.
    await restore(W1, W1, W3);
    // Stored whole, and read as its first SPOILER_READ_BYTES, which decode to 16,382 U+FFFD.
    expect(await warningBytes(h, status)).toEqual({ stored: 1_048_576, read: SPOILER_READ_BYTES });
    const warning = FFFD.repeat(SPOILER_CUT_LIMIT);
    for (const [reader, texts] of Object.entries(await presented())) {
      // '' where the content presented 393,212 JSON bytes; 2,730 U+FFFD, 8,192 JSON bytes, where the warning
      // presented 49,146 as read (3,145,730 as stored).
      expect(texts, reader).toEqual({ content: "", spoiler: warning });
      expect(jsonBytes(texts.spoiler), reader).toBe(8_192);
    }
    expect(await redraft()).toEqual({ content: "", spoiler: warning });
  });

  it("presents a writer's values at the bounds whole", async () => {
    const { h, status, restore, presented, redraft } = await setup();
    const cases: [name: string, content: string | ArrayBuffer, spoiler: string | ArrayBuffer, Texts][] = [
      // The escaped fill: 21,845 characters JSON escapes to six bytes (131,072 JSON bytes), and a warning of 2,730
      // (16,382).
      [
        "escaped",
        C.repeat(21_845),
        C.repeat(SPOILER_CUT_LIMIT),
        { content: C.repeat(21_845), spoiler: C.repeat(2730) },
      ],
      // The raw fill: ASCII at the byte bounds, 131,072 and 16,384 JSON bytes.
      [
        "raw",
        "x".repeat(CONTENT_JSON_BYTES - 2),
        "x".repeat(SPOILER_JSON_BYTES - 2),
        { content: "x".repeat(CONTENT_JSON_BYTES - 2), spoiler: "x".repeat(SPOILER_JSON_BYTES - 2) },
      ],
      // W2 and W4: malformed bytes whose decoded JSON is at the bound (131,072) or within it (16,382).
      [
        "malformed",
        malformed(false, 43_690),
        malformed(false, 5_460),
        { content: FFFD.repeat(43_690), spoiler: FFFD.repeat(5_460) },
      ],
    ];
    for (const [name, content, spoiler, expected] of cases) {
      await restore(content, content, spoiler);
      // No writer's warning is cut by the read.
      const bytes = await warningBytes(h, status);
      expect(bytes?.read, name).toBe(bytes?.stored);
      expect(jsonBytes(expected.content), name).toBe(CONTENT_JSON_BYTES);
      expect(jsonBytes(expected.spoiler), name).toBeLessThanOrEqual(SPOILER_JSON_BYTES);
      for (const [reader, texts] of Object.entries(await presented())) {
        expect(texts, `${name}: ${reader}`).toEqual(expected);
      }
    }
    // The last case's redraft: its source text whole.
    expect(await redraft()).toEqual(cases.at(-1)![3]);
  });

  it("refuses an edit that keeps an oversized malformed warning", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    // W3, read as 16,382 U+FFFD (past the counted length and, decoded, past SPOILER_BYTES), and 0xFF with 600
    // continuation bytes: 601 U+FFFD, past the counted length only (1,805 JSON bytes), so only the counted-length check
    // of the pair written refuses it.
    for (const warning of [W3, malformed(true, 600)]) {
      const status = await post(h, alice, { status: "original" });
      await sql(h.store, "UPDATE statuses SET spoiler_text = CAST(? AS TEXT) WHERE id = ?", warning, status.id);
      const stored = () =>
        sql<{ content: string; spoiler: string; source: string; edits: number }>(
          h.store,
          `SELECT hex(content) AS content, hex(spoiler_text) AS spoiler, hex(source_text) AS source,
					(SELECT COUNT(*) FROM status_edits WHERE status_id = ?1) AS edits
				FROM statuses WHERE id = ?1`,
          status.id,
        );
      const before = await stored();
      const updates = async () => (await outbound(h.store)).filter((o) => o.activity.type === "Update").length;
      // A blank text with a warning takes the warning sent as its text and keeps the stored one (keepsWarning).
      const response = await h.request(
        `/api/v1/statuses/${status.id}`,
        bearer(alice.token, json({ status: "", spoiler_text: "x" }, { method: "PUT" })),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: TOO_LONG });
      expect(await stored()).toEqual(before);
      expect(before[0]?.edits).toBe(0);
      expect(await updates()).toBe(0);
    }
  });

  it("keeps a short malformed warning's bytes on an edit", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await post(h, alice, { status: "original" });
    // FF 61 62: U+FFFD "ab" decoded, within every bound.
    await sql(
      h.store,
      "UPDATE statuses SET spoiler_text = CAST(? AS TEXT) WHERE id = ?",
      Uint8Array.from([0xff, 0x61, 0x62]).buffer,
      status.id,
    );
    const response = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "", spoiler_text: "new text" }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "<p>new text</p>", spoiler_text: `${FFFD}ab` });
    // The original, recorded before a first edit, and the edit: each a copy of the stored bytes, as the status keeps.
    const rows = await sql<{ source: string; spoiler: string }>(
      h.store,
      `SELECT source_text AS source, hex(spoiler_text) AS spoiler FROM statuses WHERE id = ?1
			UNION ALL SELECT NULL, hex(spoiler_text) FROM status_edits WHERE status_id = ?1`,
      status.id,
    );
    expect(rows).toEqual([
      { source: "new text", spoiler: "FF6162" },
      { source: null, spoiler: "FF6162" },
      { source: null, spoiler: "FF6162" },
    ]);
  });

  it("reads at most SPOILER_READ_BYTES of a warning wherever the Worker reads it", async () => {
    const h = await community(["alice", "bob"], "read write follow push", {}, { VAPID_JWK: VAPID.env });
    const { alice, bob } = h.users;
    const subscribed = await h.request(
      "/api/v1/push/subscription",
      bearer(
        alice.token,
        json({
          subscription: {
            endpoint: "https://push.example/a",
            keys: { p256dh: VAPID.publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
          },
          data: { alerts: { mention: true }, policy: "all" },
        }),
      ),
    );
    expect(subscribed.status).toBe(200);
    // bob's status mentions alice, so a push of it is queued for her subscription; it and a recorded version hold W3.
    const status = await post(h, bob, { status: "@alice hello" });
    await sql(
      h.store,
      "INSERT INTO status_edits (status_id, content, spoiler_text, media_json, created_at) VALUES (?, '', '', '[]', ?)",
      status.id,
      new Date(NOW).toISOString(),
    );
    await sql(h.store, "UPDATE statuses SET spoiler_text = CAST(? AS TEXT) WHERE id = ?", W3, status.id);
    await sql(h.store, "UPDATE status_edits SET spoiler_text = CAST(? AS TEXT) WHERE status_id = ?", W3, status.id);
    const credential = { tokenHash: await sha256Hex(bob.token), scope: "read" as const, now: NOW };
    const input = { credential, now: NOW, id: status.id, present: { origin: "https://kopje.test" } };
    const uri = status.uri as string;
    // The longest warning each reader takes out of SQLite, in code units (one per malformed byte).
    const read = await runInDurableObject(h.store, (_instance, state) => {
      let longest = 0;
      const observed = observedSql(state.storage.sql, (rows) => {
        for (const row of rows) {
          if (typeof row.spoiler_text === "string") {
            longest = Math.max(longest, row.spoiler_text.length);
          }
        }
      });
      const readers: Record<string, () => unknown> = {
        hydrate: () => getStatus.run(observed, input),
        editVersions: () => statusHistory.run(observed, input),
        statusSource: () => statusSource.run(observed, input),
        ownStatus: () => editTarget.run(observed, input),
        statusFacts: () => getLocalNote.run(observed, { uri }),
        statusByUri: () => statusByUri(new Db(observed), uri),
        push: () => claimPushes.run(observed, { now: NOW, leaseToken: "lease" }),
      };
      return Object.fromEntries(
        Object.entries(readers).map(([name, run]) => {
          longest = 0;
          run();
          return [name, longest];
        }),
      );
    });
    // Each reached the warning, and read its first SPOILER_READ_BYTES of the 1,048,576 stored.
    expect(read).toEqual({
      hydrate: SPOILER_READ_BYTES,
      editVersions: SPOILER_READ_BYTES,
      statusSource: SPOILER_READ_BYTES,
      ownStatus: SPOILER_READ_BYTES,
      statusFacts: SPOILER_READ_BYTES,
      statusByUri: SPOILER_READ_BYTES,
      push: SPOILER_READ_BYTES,
    });
  });
});
