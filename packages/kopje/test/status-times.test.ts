import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getOutbox } from "../src/domain/local-notes";
import { isoTimeSql, statusEditedSql, statusPublishedSql } from "../src/platform/stored-bounds";
import { bearer, json, sql } from "./api-helpers";
import { freshStore } from "./helpers";
import { act, community, getJson, outbound, post, remoteAccount, remoteFollows, type Status } from "./status-helpers";

// statuses.published_at and edited_at have no stored bound (docs/threat-model.md RES-2, "status times"): a converted
// or imported row may hold any value there, and every read that copies one into an answer, a document or another row
// takes statusPublishedSql or statusEditedSql (src/platform/stored-bounds.ts), the stored form or a fallback.

const T = "2026-10-22T00:00:00.000Z";
const ARRIVAL = "2026-10-21T12:00:00.000Z";
const EPOCH = "1970-01-01T00:00:00.000Z";
// Past the answer budget as JSON (six bytes each), as the issue's oversized time.
const OVERSIZED = "\u0001".repeat(1_500_000);
const blob = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

// The two projections of a row holding `published`, `edited` and `created` (published_at, edited_at, created_at).
function projected(
  sqlStorage: SqlStorage,
  [published, edited, created]: readonly SqlStorageValue[],
): { p: SqlStorageValue; e: SqlStorageValue; t: string } {
  return sqlStorage
    .exec<{ p: SqlStorageValue; e: SqlStorageValue; t: string }>(
      `SELECT ${statusPublishedSql("s")} AS p, ${statusEditedSql("s")} AS e, typeof(${statusPublishedSql("s")}) AS t
			FROM (SELECT ?1 AS published_at, ?2 AS edited_at, ?3 AS created_at) s`,
      published ?? null,
      edited ?? null,
      created ?? null,
    )
    .one();
}

describe("status times as read (RES-2)", () => {
  // [published_at, edited_at, created_at] as stored, and the publication and edit times read.
  const CASES: [string, SqlStorageValue[], [string, string | null]][] = [
    ["in the stored form, not edited", [T, null, ARRIVAL], [T, null]],
    [
      "at each end of years 0 to 9999",
      ["0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", ARRIVAL],
      ["0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"],
    ],
    ["past 150 KB, its edit too", [T + "x".repeat(150_000), T + "x".repeat(150_000), ARRIVAL], [ARRIVAL, ARRIVAL]],
    ["past the answer budget as JSON", [OVERSIZED, OVERSIZED, ARRIVAL], [ARRIVAL, ARRIVAL]],
    ["one byte past the form", [`${T}Z`, null, ARRIVAL], [ARRIVAL, null]],
    [
      "with a space and no fraction, and with a zone offset",
      ["2026-10-22 01:02:03", "2026-10-22T10:00:00+09:00", ARRIVAL],
      ["2026-10-22T01:02:03.000Z", "2026-10-22T01:00:00.000Z"],
    ],
    [
      "an hour of 24, and a fraction rounded but never past .999",
      ["2026-10-22T24:00:00Z", "2026-10-22T23:59:59.9999Z", ARRIVAL],
      ["2026-10-23T00:00:00.000Z", "2026-10-22T23:59:59.999Z"],
    ],
    ["a longer fraction, rounded", ["2026-10-22T00:00:00.1239Z", null, ARRIVAL], ["2026-10-22T00:00:00.124Z", null]],
    [
      "negative years, as toISOString and strftime write them",
      ["-000001-06-01T00:00:00.000Z", "-001-06-01T00:00:00.000Z", ARRIVAL],
      [ARRIVAL, ARRIVAL],
    ],
    [
      "outside years 0 to 9999 once its zone applies",
      ["0000-01-01T00:00:00+01:00", "9999-12-31T23:00:00-02:00", ARRIVAL],
      [ARRIVAL, ARRIVAL],
    ],
    ["a NUL inside the form, and after it", [`${T.slice(0, 23)}\u0000`, `${T}\u0000`, ARRIVAL], [ARRIVAL, ARRIVAL]],
    ["a Julian day and a number", ["2461000.5", 1_700_000_000, ARRIVAL], [ARRIVAL, ARRIVAL]],
    ["a BLOB of the stored form", [blob(T), blob(T), ARRIVAL], [T, T]],
    ["readable, edited unreadably: the edit reads as the publication", [T, "soon", ARRIVAL], [T, T]],
    ["unreadable, with an arrival in another format", ["yesterday", null, "2026-10-21 12:00:00"], [ARRIVAL, null]],
    ["unreadable, with an unreadable arrival", ["yesterday", "soon", "unknown"], [EPOCH, EPOCH]],
  ];

  it("reads each stored value as the stored form, else its arrival, else the epoch", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      for (const [name, row, [p, e]] of CASES) {
        expect(projected(state.storage.sql, row), name).toEqual({ p, e, t: "text" });
      }
    });
  });

  it("reads every value as a time isoTimeSql accepts, and an edit as NULL only when none is stored", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sqlStorage = state.storage.sql;
      const accepted = (value: SqlStorageValue) =>
        sqlStorage.exec<{ v: number }>(`SELECT (${isoTimeSql("?1")}) IS ?1 AS v`, value).one().v === 1;
      const digits = (n: number) => fc.stringMatching(new RegExp(`^[0-9]{${n}}$`));
      const shaped = fc
        .tuple(digits(4), digits(2), digits(2), digits(2), digits(2), digits(2), fc.stringMatching(/^[0-9]{0,6}$/))
        .map(([y, mo, d, h, mi, s, f]) => `${y}-${mo}-${d}T${h}:${mi}:${s}${f === "" ? "" : `.${f}`}Z`);
      const value = fc.oneof(
        shaped,
        fc.string({ unit: "binary", maxLength: 40 }),
        fc.constant(null),
        fc.integer().map((n) => n as SqlStorageValue),
      );
      fc.assert(
        fc.property(value, value, value, (published, edited, created) => {
          const { p, e } = projected(sqlStorage, [published, edited, created]);
          expect(accepted(p)).toBe(true);
          expect(e === null).toBe(edited === null);
          if (e !== null) {
            expect(accepted(e)).toBe(true);
          }
        }),
        { numRuns: 500 },
      );
    });
  }, 60_000);
});

describe("a status whose stored times are past the form (RES-2, RES-3)", () => {
  // The issue's symptom: a page whose head held such a status refused with an error instead of answering.
  it("answers a page headed by it, at its arrival", async () => {
    const h = await community(["bob"]);
    const { bob } = h.users;
    const status = await post(h, bob, { status: "hello" });
    await sql(h.store, "UPDATE statuses SET published_at = ?1, edited_at = ?1 WHERE id = ?2", OVERSIZED, status.id);
    const arrival = (
      await sql<{ arrival: string }>(h.store, "SELECT created_at AS arrival FROM statuses WHERE id = ?", status.id)
    )[0]!.arrival;
    const page = await getJson<Status[]>(h, `/api/v1/accounts/${bob.id}/statuses`, bob.token);
    expect(page.status).toBe(200);
    expect(page.body.map((s) => [s.id, s.created_at, s.edited_at])).toEqual([[status.id, arrival, arrival]]);
  });

  it("sends and serves 24-byte times: its Note, its Update and edit snapshot, a boost's Announce and its Undo", async () => {
    const h = await community(["bob"]);
    const { bob } = h.users;
    await remoteFollows(h.store, await remoteAccount(h.store, "carol"), bob.id);
    const status = await post(h, bob, { status: "hello", visibility: "public" });
    expect((await act(h, bob, `/api/v1/statuses/${status.id}/reblog`)).status).toBe(200);
    await sql(h.store, "UPDATE statuses SET published_at = ?1 WHERE account_id = ?2", OVERSIZED, bob.id);
    const arrival = (
      await sql<{ arrival: string }>(h.store, "SELECT created_at AS arrival FROM statuses WHERE id = ?", status.id)
    )[0]!.arrival;
    // The outbox: the status's Create (its Note) and the boost's Announce.
    const page = await runInDurableObject(h.store, (_instance, state) =>
      getOutbox.run(state.storage.sql, { username: "bob", before: "~" }),
    );
    const items = (page?.items ?? []).map((item) => JSON.parse(item) as Record<string, unknown>);
    expect(new Set(items.map((item) => item.type))).toEqual(new Set(["Announce", "Create"]));
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.published, String(item.type)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
      if (item.type === "Create") {
        expect((item.object as { published: string }).published).toBe(arrival);
      }
    }
    // An edit: its Update's Note and the first version's snapshot.
    const edited = await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(bob.token, json({ status: "edited" }, { method: "PUT" })),
    );
    expect(edited.status).toBe(200);
    expect(
      await sql(h.store, "SELECT created_at FROM status_edits WHERE status_id = ? ORDER BY id", status.id),
    ).toEqual([{ created_at: arrival }, expect.objectContaining({ created_at: expect.any(String) })]);
    const update = (await outbound(h.store)).find((o) => o.activity.type === "Update")!;
    expect((update.activity.object as { published: string }).published).toBe(arrival);
    // The boost's Undo, whose Announce carries the boost's time.
    expect((await act(h, bob, `/api/v1/statuses/${status.id}/unreblog`)).status).toBe(200);
    const undo = (await outbound(h.store)).find((o) => o.activity.type === "Undo")!;
    const announce = undo.activity.object as { type: string; published: string };
    expect(announce.type).toBe("Announce");
    expect(announce.published).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
