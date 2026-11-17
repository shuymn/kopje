import { describe, expect, it } from "vitest";

import { type ApiHarness, bearer, form, json, sql } from "./api-helpers";
import { act, community, getJson, remoteAccount, seedStatus, type User } from "./status-helpers";

// Rails' blank and presence decisions on Mastodon API parameters (#1734): each route decides with railsBlank (Rails'
// String#blank?, White_Space: U+0085 is blank, U+FEFF is not) at the stage Mastodon 4.7.5 decides, after Ruby's strip
// (rubyStrip) where Mastodon strips first, and keeps a value that is not blank as sent. Each case pairs U+0085 (blank,
// which JavaScript's \s does not match) with U+FEFF (not blank, which \s and String#trim do match), and a value that is
// not blank shows the decision's other branch ran.

const NEL = "\u0085";
// Written by its code point: the formatter would write the character itself, which no reader sees.
const BOM = String.fromCodePoint(0xfeff);

type Answer = { status: number; body: unknown };

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

function send(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown>) {
  return h.request(path, bearer(user.token, json(body, { method })));
}

function sendForm(h: ApiHarness, user: User, method: string, path: string, pairs: [string, string][]) {
  return h.request(path, bearer(user.token, form(pairs, { method })));
}

describe("filters (PB1)", () => {
  it("judges a title, a keyword and a v1 phrase blank as Rails does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const titleBlank = { status: 422, body: { error: "Validation failed: Title can't be blank" } };
    expect(await answer(await act(h, alice, "/api/v2/filters", { title: NEL, context: ["home"] }))).toEqual(titleBlank);
    const created = await answer(
      await sendForm(h, alice, "POST", "/api/v2/filters", [
        ["title", BOM],
        ["context[]", "home"],
      ]),
    );
    expect(created).toMatchObject({ status: 200, body: { title: BOM, context: ["home"] } });
    const id = (created.body as { id: string }).id;
    expect(await answer(await send(h, alice, "PUT", `/api/v2/filters/${id}`, { title: NEL }))).toEqual(titleBlank);
    expect(await sql(h.store, "SELECT title FROM filters")).toEqual([{ title: BOM }]);

    const keywords = `/api/v2/filters/${id}/keywords`;
    expect(await answer(await act(h, alice, keywords, { keyword: NEL }))).toEqual({
      status: 422,
      body: { error: "Validation failed: Keyword can't be blank" },
    });
    expect(await answer(await act(h, alice, keywords, { keyword: BOM }))).toMatchObject({
      status: 200,
      body: { keyword: BOM },
    });

    // The v1 layer: a blank phrase answers as an empty one does.
    const v1 = async (phrase: string) => answer(await act(h, alice, "/api/v1/filters", { phrase, context: ["home"] }));
    expect(await v1(NEL)).toEqual(await v1(""));
    expect((await v1(NEL)).status).toBe(422);
    expect(await v1(BOM)).toMatchObject({ status: 200, body: { phrase: BOM } });
  });

  // CustomFilter normalizes context with `map(&:strip).filter_map(&:presence)`: Ruby's strip (NUL and ASCII
  // whitespace, not U+FEFF), then Rails' blank.
  it("strips each context as Ruby does and drops the blank ones", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(
      await answer(
        await sendForm(h, alice, "POST", "/api/v2/filters", [
          ["title", "t"],
          ["context[]", " home\t"],
          ["context[]", NEL],
          ["context[]", "\u0000public\u0000"],
        ]),
      ),
    ).toMatchObject({ status: 200, body: { context: ["home", "public"] } });
    expect(await answer(await act(h, alice, "/api/v2/filters", { title: "t", context: [`${BOM}home${BOM}`] }))).toEqual(
      { status: 422, body: { error: "Validation failed: Context None or invalid context supplied" } },
    );
    expect(await answer(await act(h, alice, "/api/v2/filters", { title: "t", context: [NEL, " "] }))).toEqual({
      status: 422,
      body: { error: "Validation failed: Context can't be blank, Context None or invalid context supplied" },
    });
  });

  // accepts_nested_attributes_for: an entry whose id is blank adds a keyword, unless every attribute is blank
  // (reject_if: :all_blank); any other id names a keyword of the filter, else Record not found.
  it("reads a nested keyword's id and its all-blank entry as Rails does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await answer(await act(h, alice, "/api/v2/filters", { title: "t", context: ["home"] }));
    const id = (created.body as { id: string }).id;
    const update = async (entries: Record<string, unknown>[]) =>
      answer(await send(h, alice, "PUT", `/api/v2/filters/${id}`, { keywords_attributes: entries }));
    const keywords = () => sql(h.store, "SELECT keyword FROM filter_keywords ORDER BY id");

    expect(await update([{ keyword: NEL, whole_word: NEL }])).toMatchObject({ status: 200, body: { keywords: [] } });
    expect(await keywords()).toEqual([]);
    expect(await update([{ id: NEL, keyword: "added" }])).toMatchObject({
      status: 200,
      body: { keywords: [{ keyword: "added" }] },
    });
    expect(await update([{ id: BOM, keyword: "named" }])).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    expect(await update([{ keyword: BOM }])).toMatchObject({ status: 200 });
    expect(await keywords()).toEqual([{ keyword: "added" }, { keyword: BOM }]);
  });

  // CustomFilterStatus belongs to its status: a blank status_id names none, as an id that names no status.
  it("refuses a blank status_id as one that names no status", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    const created = await answer(await act(h, alice, "/api/v2/filters", { title: "t", context: ["home"] }));
    const path = `/api/v2/filters/${(created.body as { id: string }).id}/statuses`;
    const missing = { status: 422, body: { error: "Validation failed: Status must exist" } };
    expect(await answer(await act(h, alice, path, { status_id: NEL }))).toEqual(missing);
    expect(await answer(await act(h, alice, path, { status_id: BOM }))).toEqual(missing);
    expect(await answer(await act(h, alice, path, { status_id: status }))).toMatchObject({
      status: 200,
      body: { status_id: status },
    });
  });
});

describe("lists, collections and markers (PB2)", () => {
  it("judges a list's title blank as Rails does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const blank = { status: 422, body: { error: "Validation failed: Title can't be blank" } };
    expect(await answer(await act(h, alice, "/api/v1/lists", { title: NEL }))).toEqual(blank);
    const created = await answer(await sendForm(h, alice, "POST", "/api/v1/lists", [["title", BOM]]));
    expect(created).toMatchObject({ status: 200, body: { title: BOM } });
    const id = (created.body as { id: string }).id;
    expect(await answer(await send(h, alice, "PUT", `/api/v1/lists/${id}`, { title: NEL }))).toEqual(blank);
    expect(await sql(h.store, "SELECT title FROM lists")).toEqual([{ title: BOM }]);
  });

  it("judges a collection's name and an item's account_id blank as Rails does", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await sql(h.store, "UPDATE accounts SET discoverable = 1 WHERE id IN (?, ?)", alice.id, bob.id);
    const collection = (body: Record<string, unknown>) =>
      act(h, alice, "/api/v1/collections", { sensitive: false, discoverable: true, ...body });
    expect(await answer(await collection({ name: NEL }))).toEqual({
      status: 422,
      body: {
        error: {
          error: "Validation failed: Name can't be blank",
          details: { name: [{ error: "ERR_BLANK", description: "can't be blank" }] },
        },
      },
    });
    const created = await answer(await collection({ name: BOM }));
    expect(created).toMatchObject({ status: 200, body: { collection: { name: BOM } } });
    const path = `/api/v1/collections/${(created.body as { collection: { id: string } }).collection.id}/items`;
    expect(await answer(await act(h, alice, path, { account_id: NEL }))).toEqual({
      status: 422,
      body: { error: "`account_id` parameter is missing" },
    });
    expect(await answer(await act(h, alice, path, { account_id: BOM }))).toEqual({
      status: 404,
      body: { error: "Record not found" },
    });
    expect((await act(h, alice, path, { account_id: bob.id })).status).toBe(200);
  });

  // Marker validates last_read_id's presence. Kopje keeps the value as a string where Mastodon casts it to a bigint,
  // so U+FEFF is kept as sent (Mastodon would read it as 0).
  it("judges a marker's last_read_id blank as Rails does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(await answer(await act(h, alice, "/api/v1/markers", { home: { last_read_id: NEL } }))).toEqual({
      status: 422,
      body: { error: "Validation failed: Last read can't be blank" },
    });
    expect(await answer(await act(h, alice, "/api/v1/markers", { home: { last_read_id: BOM } }))).toMatchObject({
      status: 200,
      body: { home: { last_read_id: BOM } },
    });
  });
});

describe("reports and private notes (PB3)", () => {
  // ReportService: `comment.presence || ''` and `category.presence || 'other'`.
  it("reads a blank category and comment as none, and keeps one that is not blank", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const carol = await remoteAccount(h.store, "carol");
    expect(
      await answer(await act(h, alice, "/api/v1/reports", { account_id: carol, comment: NEL, category: NEL })),
    ).toMatchObject({ status: 200, body: { category: "other", comment: "" } });
    expect(
      await answer(
        await sendForm(h, alice, "POST", "/api/v1/reports", [
          ["account_id", carol],
          ["comment", BOM],
        ]),
      ),
    ).toMatchObject({ status: 200, body: { category: "other", comment: BOM } });
    expect(await answer(await act(h, alice, "/api/v1/reports", { account_id: carol, category: BOM }))).toEqual({
      status: 422,
      body: { error: "Validation failed: Category is not included in the list" },
    });
    expect(await sql(h.store, "SELECT comment, category FROM reports ORDER BY id")).toEqual([
      { comment: "", category: "other" },
      { comment: BOM, category: "other" },
    ]);
  });

  // Accounts::NotesController: a blank comment deletes the note, any other is kept as sent.
  it("deletes the private note for a blank comment and keeps one that is not blank", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const note = async () =>
      (await getJson<{ note: string }[]>(h, `/api/v1/accounts/relationships?id[]=${bob.id}`, alice.token)).body[0]
        ?.note;
    const path = `/api/v1/accounts/${bob.id}/note`;
    expect((await act(h, alice, path, { comment: "kept" })).status).toBe(200);
    expect(await note()).toBe("kept");
    expect((await act(h, alice, path, { comment: NEL })).status).toBe(200);
    expect(await note()).toBe("");
    expect(await sql(h.store, "SELECT comment FROM account_notes")).toEqual([]);
    expect((await sendForm(h, alice, "POST", path, [["comment", BOM]])).status).toBe(200);
    expect(await note()).toBe(BOM);
  });
});
