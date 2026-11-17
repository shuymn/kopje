import { describe, expect, it } from "vitest";

import type { StoreStub } from "../src/platform/store-client";
import {
  type ApiHarness,
  bearer,
  consentPage,
  form,
  json,
  registerApp,
  setSetting,
  sql,
  userToken,
} from "./api-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { bytes, mediaForm, multipartForm, uploaded } from "./media-helpers";
import { act, community, getJson, post, remoteAccount, seedStatus, type User } from "./status-helpers";

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

// A query value of each kind, percent-encoded.
const Q = { NEL: encodeURIComponent(NEL), BOM: encodeURIComponent(BOM) };

// The Store calls the app makes, by name with their input (the second argument), across every request of a harness.
function recording() {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const wrapStore = (store: StoreStub): StoreStub =>
    new Proxy(store, {
      get: (target, name) => {
        const value = Reflect.get(target, name) as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push({ name: String(name), input: structuredClone(args[1]) as Record<string, unknown> });
              return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[String(name)]!(...args);
            }
          : value;
      },
    });
  // The request's own calls: the day's activity stamp is a session write made after the answer (mastodon/activity.ts).
  const names = () => calls.map((call) => call.name).filter((name) => name !== "noteActivity");
  return { calls, wrapStore, names };
}

describe("search and peers (PB4)", () => {
  // Api::V2::SearchController: params.require(:q) refuses a blank q (400, after the token); SearchService then strips
  // it as Ruby does and answers nothing for one that is blank, before any resolution; a blank type is every type.
  it("refuses a blank q on /api/v2/search and answers nothing for one blank once stripped", async () => {
    const recorder = recording();
    const h = await community(["alice"], "read write follow", { wrapStore: recorder.wrapStore });
    const { alice } = h.users;
    const search = async (query: string, token = alice.token) =>
      answer(await h.request(`/api/v2/search?${query}`, bearer(token)));
    const missing = { status: 400, body: { error: "Missing parameter q" } };
    expect(await search(`q=${Q.NEL}`)).toEqual(missing);
    expect((await search(`q=${Q.NEL}`, "not-a-token")).status).toBe(401);
    const none = { accounts: [], statuses: [], hashtags: [], collections: [] };
    recorder.calls.length = 0;
    expect(await search("q=%00%20&resolve=true")).toEqual({ status: 200, body: none });
    expect(recorder.names()).toEqual(["instanceDomain", "checkCredential"]);
    recorder.calls.length = 0;
    expect((await search(`q=${Q.BOM}`)).status).toBe(200);
    expect(recorder.names()).toContain("search");
    // A URL query only once Ruby's strip leaves it one: U+FEFF stays, so nothing is resolved.
    recorder.calls.length = 0;
    expect((await search(`q=${Q.BOM}https://remote.example/@bob&resolve=true`)).status).toBe(200);
    expect(recorder.names()).not.toContain("resolutionGate");
    recorder.calls.length = 0;
    expect((await search("q=%20https://remote.example/@bob&resolve=true")).status).toBe(200);
    expect(recorder.names()).toContain("resolutionGate");

    const accounts = async (type: string) =>
      ((await search(`q=alice&type=${type}`)).body as { accounts: { id: string }[] }).accounts.map((a) => a.id);
    expect(await accounts(Q.NEL)).toEqual([alice.id]);
    expect(await accounts(Q.BOM)).toEqual([]);
  });

  // AccountSearchService strips q as Ruby does and drops one leading @; a query then blank finds nothing.
  it("answers the account search nothing for a q blank once stripped, without searching", async () => {
    const recorder = recording();
    const h = await community(["alice"], "read write follow", { wrapStore: recorder.wrapStore });
    const { alice } = h.users;
    const search = async (query: string) => {
      recorder.calls.length = 0;
      return answer(await h.request(`/api/v1/accounts/search?${query}`, bearer(alice.token)));
    };
    for (const q of [Q.NEL, "%20%40", `%00${Q.NEL}`]) {
      expect(await search(`q=${q}`)).toEqual({ status: 200, body: [] });
      expect(recorder.names()).not.toContain("searchAccounts");
    }
    expect(await search(`q=${Q.BOM}`)).toEqual({ status: 200, body: [] });
    expect(recorder.names()).toContain("searchAccounts");
    expect(await search("q=%20%40alice")).toMatchObject({ status: 200, body: [{ id: alice.id }] });
  });

  // Both services search with q as Ruby's strip leaves it, NUL at either end removed.
  it("searches accounts with q as Ruby's strip leaves it, on both search APIs", async () => {
    const h = await community(["alice"], "read write follow");
    const { alice } = h.users;
    const v1 = async (q: string) =>
      (await getJson<{ id: string }[]>(h, `/api/v1/accounts/search?q=${q}`, alice.token)).body.map((a) => a.id);
    const v2 = async (q: string) =>
      (
        await getJson<{ accounts: { id: string }[] }>(h, `/api/v2/search?q=${q}&type=accounts`, alice.token)
      ).body.accounts.map((a) => a.id);
    for (const q of ["alice", "%00alice%00"]) {
      expect(await v1(q), q).toEqual([alice.id]);
      expect(await v2(q), q).toEqual([alice.id]);
    }
  });

  // Api::V1::Peers::SearchController: a blank q (Rails' blank?) is null; any other is then stripped as Ruby strips
  // (TagManager#normalize_domain), so U+FEFF stays and is no host.
  it("answers the peer search null for a blank q only", async () => {
    const h = await community(["alice"]);
    await remoteAccount(h.store, "bob", "mastodon.example");
    const peers = async (query: string) => answer(await h.request(`/api/v1/peers/search?${query}`));
    expect(await peers(`q=${Q.NEL}`)).toEqual({ status: 200, body: null });
    expect(await peers("q=%20")).toEqual({ status: 200, body: null });
    expect(await peers(`q=${Q.BOM}`)).toEqual({ status: 200, body: [] });
    expect(await peers("q=%00masto%20")).toEqual({ status: 200, body: ["mastodon.example"] });
  });
});

describe("admin accounts and account actions (PB5)", () => {
  async function adminWorld() {
    const recorder = recording();
    const h = await community(["owner", "alice"], "read write", { wrapStore: recorder.wrapStore });
    await setSetting(h.store, "admin_email", "owner@example.com");
    const token = await userToken(h, "owner@example.com", "read write admin:read admin:write");
    const carol = await remoteAccount(h.store, "carol", "remote.example");
    const dave = await remoteAccount(h.store, "dave", "other.example");
    const ids = async (path: string) => {
      const response = await h.request(path, bearer(token));
      expect(response.status, path).toBe(200);
      return (await response.json<{ id: string }[]>()).map((account) => account.id).toSorted();
    };
    const filter = () => recorder.calls.findLast((call) => call.name === "adminAccounts")?.input.filter;
    return { h, token, carol, dave, ids, filter };
  }

  // AccountFilter: a parameter is applied when its raw value is present, then read as its attribute reads it, so
  // by_domain=%00 (NUL is not blank; Ruby's strip removes it) is `where(domain: '')`, which no account matches.
  it("keeps a search attribute present as sent, whatever its normalization leaves", async () => {
    const { h, carol, dave, ids, filter } = await adminWorld();
    const remote = [carol, dave].toSorted();
    expect(await ids("/api/v2/admin/accounts?origin=remote")).toEqual(remote);
    expect(await ids("/api/v2/admin/accounts?origin=remote&by_domain=remote.example")).toEqual([carol]);
    expect(await ids("/api/v2/admin/accounts?origin=remote&by_domain=%00")).toEqual([]);
    expect(filter()).toMatchObject({ origin: null, byDomain: "" });
    expect(await ids(`/api/v2/admin/accounts?origin=remote&by_domain=${Q.NEL}`)).toEqual(remote);
    expect(filter()).toMatchObject({ origin: "remote", byDomain: null });
    expect(await ids(`/api/v2/admin/accounts?origin=remote&by_domain=${Q.BOM}`)).toEqual([]);
    expect(filter()).toMatchObject({ byDomain: BOM });
    expect(await ids("/api/v1/admin/accounts?remote=1")).toEqual(remote);
    expect(await ids("/api/v1/admin/accounts?remote=1&by_domain=%00")).toEqual([]);
    expect(await ids(`/api/v1/admin/accounts?remote=${Q.NEL}`)).toEqual(await ids("/api/v1/admin/accounts"));
    // username and display_name stripped as Ruby strips; ip as sent (AccountFilter does not strip it).
    expect(await ids("/api/v2/admin/accounts?username=%00%40owner%20")).toEqual([h.users.owner.id]);
    expect(filter()).toMatchObject({ username: "owner" });
    expect(await ids(`/api/v2/admin/accounts?display_name=${Q.NEL}&origin=remote`)).toEqual(remote);
    expect(filter()).toMatchObject({ displayName: null });
    expect(await ids("/api/v2/admin/accounts?ip=%201.2.3.4%20")).toEqual([]);
    expect(filter()).toMatchObject({ ip: " 1.2.3.4 " });
  });

  // An array parameter's scalar form is read when present (Rails' blank?), and each item of `name[]` as sent.
  it("reads role_ids sent as a scalar when it is not blank", async () => {
    const { h, carol, dave, ids } = await adminWorld();
    const every = [h.users.owner.id, h.users.alice.id, carol, dave].toSorted();
    expect(await ids("/api/v2/admin/accounts")).toEqual(every);
    expect(await ids(`/api/v2/admin/accounts?role_ids=${Q.NEL}`)).toEqual(every);
    expect(await ids("/api/v2/admin/accounts?role_ids=3")).toEqual([h.users.owner.id]);
    expect(await ids(`/api/v2/admin/accounts?role_ids=${Q.BOM}`)).toEqual([]);
  });

  // Admin::AccountAction: type, report_id and warning_preset_id are read with present?.
  it("reads an action's type, report and preset blank as Rails does", async () => {
    const { h, token } = await adminWorld();
    const action = async (body: Record<string, unknown>) =>
      answer(await h.request(`/api/v1/admin/accounts/${h.users.alice.id}/action`, bearer(token, json(body))));
    const warnings = () => sql(h.store, "SELECT count(*) AS n FROM account_warnings");
    expect(await action({ type: NEL })).toEqual(await action({}));
    expect((await action({ type: NEL })).status).toBe(422);
    expect(await action({ type: BOM })).toEqual({
      status: 422,
      body: { error: "Validation failed: Type is not included in the list" },
    });
    const unknown = await action({ type: "none", warning_preset_id: "1" });
    expect(unknown.status).toBe(404);
    expect(await action({ type: "none", warning_preset_id: BOM })).toEqual(unknown);
    expect(await action({ type: "none", report_id: BOM })).toEqual(unknown);
    expect(await warnings()).toEqual([{ n: 0 }]);
    expect(await action({ type: "none", warning_preset_id: NEL, report_id: NEL, text: "w" })).toEqual({
      status: 200,
      body: {},
    });
    expect(await warnings()).toEqual([{ n: 1 }]);
  });
});

describe("domain blocks (PB6)", () => {
  // AccountDomainBlock and DomainBlock validate the domain's presence (Rails' blank?) before Kopje's normalizer.
  it("refuses a blank domain as blank and any other that is no domain as invalid", async () => {
    const h = await community(["owner"], "read write follow");
    const { owner } = h.users;
    const block = async (domain: string) =>
      answer(await h.request("/api/v1/domain_blocks", bearer(owner.token, form([["domain", domain]]))));
    expect(await block(NEL)).toEqual({ status: 422, body: { error: "Validation failed: Domain can't be blank" } });
    expect(await block(BOM)).toEqual({ status: 422, body: { error: "Validation failed: Domain is invalid" } });
    expect((await getJson(h, "/api/v1/domain_blocks", owner.token)).body).toEqual([]);
    expect(await block(" Blocked.Example ")).toEqual({ status: 200, body: {} });
    expect((await getJson(h, "/api/v1/domain_blocks", owner.token)).body).toEqual(["blocked.example"]);

    await setSetting(h.store, "admin_email", "owner@example.com");
    const token = await userToken(h, "owner@example.com", "admin:read admin:write");
    const adminBlock = async (domain: string) =>
      answer(await h.request("/api/v1/admin/domain_blocks", bearer(token, json({ domain, severity: "suspend" }))));
    const blank = await adminBlock("");
    expect(blank).toEqual({ status: 422, body: { error: "Validation failed: Domain can't be blank" } });
    expect(await adminBlock(NEL)).toEqual(blank);
    const invalid = await adminBlock("a b");
    expect(invalid).toEqual({ status: 422, body: { error: expect.stringMatching(/^Validation failed: Domain is /) } });
    expect(invalid).not.toEqual(blank);
    expect(await adminBlock(BOM)).toEqual(invalid);
    expect((await getJson(h, "/api/v1/admin/domain_blocks", token)).body).toEqual([]);
    expect(await adminBlock(" Admin.Example ")).toMatchObject({ status: 200, body: { domain: "admin.example" } });
  });
});

describe("app registration (PB7)", () => {
  // Doorkeeper validates the name's presence (Rails' blank?); Mastodon stores it as sent.
  it("judges client_name blank as Rails does and stores it as sent", async () => {
    const h = await community([]);
    const register = async (name: string) =>
      answer(
        await h.request(
          "/api/v1/apps",
          form([
            ["client_name", name],
            ["redirect_uris", "urn:ietf:wg:oauth:2.0:oob"],
          ]),
        ),
      );
    const empty = await register("");
    expect(empty.status).toBe(422);
    expect(await register(NEL)).toEqual(empty);
    expect(await register(" App\t")).toMatchObject({ status: 200, body: { name: " App\t" } });
    expect(await register(BOM)).toMatchObject({ status: 200, body: { name: BOM } });
    expect(
      await sql(h.store, "SELECT name FROM oauth_clients WHERE name IN (?, ?) ORDER BY name", " App\t", BOM),
    ).toEqual([{ name: " App\t" }, { name: BOM }]);
  });
});

describe("statuses (PB8)", () => {
  // StatusesController looks up in_reply_to_id and quoted_status_id only when present? (before validating the post),
  // and Api::InteractionPoliciesConcern reads quote_approval_policy with presence.
  it("looks a reply or quote target up only for an id that is not blank", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const posted = async (body: Record<string, unknown>) => answer(await act(h, alice, "/api/v1/statuses", body));
    expect(await posted({ status: "a", in_reply_to_id: NEL })).toMatchObject({
      status: 200,
      body: { in_reply_to_id: null },
    });
    const noReply = await posted({ status: "b", in_reply_to_id: "1" });
    expect(noReply.status).toBe(404);
    expect(await posted({ status: "c", in_reply_to_id: BOM })).toEqual(noReply);
    expect(await posted({ status: "", in_reply_to_id: BOM })).toEqual(noReply);
    expect((await posted({ status: "", in_reply_to_id: NEL })).status).toBe(422);
    expect(await posted({ status: "d", quoted_status_id: NEL })).toMatchObject({ status: 200, body: { quote: null } });
    const noQuote = await posted({ status: "e", quoted_status_id: "1" });
    expect(noQuote.status).toBe(404);
    expect(await posted({ status: "f", quoted_status_id: BOM })).toEqual(noQuote);
  });

  it("reads a blank quote_approval_policy as none, on a post, an edit and the policy route", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const policy = (status: unknown) => (status as { quote_approval: unknown }).quote_approval;
    const plain = await post(h, alice, { status: "plain" });
    const blank = await answer(await act(h, alice, "/api/v1/statuses", { status: "p", quote_approval_policy: NEL }));
    expect(blank.status).toBe(200);
    expect(policy(blank.body)).toEqual(policy(plain));
    expect(await answer(await act(h, alice, "/api/v1/statuses", { status: "q", quote_approval_policy: BOM }))).toEqual({
      status: 422,
      body: { error: "Record invalid" },
    });

    const nobody = await post(h, alice, { status: "n", quote_approval_policy: "nobody" });
    expect(policy(nobody)).not.toEqual(policy(plain));
    const edited = await answer(
      await send(h, alice, "PUT", `/api/v1/statuses/${nobody.id}`, { status: "n2", quote_approval_policy: NEL }),
    );
    expect(edited.status).toBe(200);
    expect(policy(edited.body)).toEqual(policy(nobody));
    const path = `/api/v1/statuses/${nobody.id}/interaction_policy`;
    const updated = await answer(await send(h, alice, "PUT", path, { quote_approval_policy: NEL }));
    expect(updated.status).toBe(200);
    expect(policy(updated.body)).toEqual(policy(plain));
  });
});

describe("notifications and account statuses (PB9)", () => {
  // Notification.browserable: `from_account_id.present?`; AccountStatusesFilter#tagged?: `params[:tagged].present?`.
  it("filters by account_id and tagged only when they are not blank", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    await post(h, bob, { status: "@alice one" });
    await post(h, carol, { status: "@alice two" });
    const from = async (query: string) =>
      (await getJson<{ account: { id: string } }[]>(h, `/api/v1/notifications?${query}`, alice.token)).body
        .map((n) => n.account.id)
        .toSorted();
    const both = [bob.id, carol.id].toSorted();
    expect(await from(`account_id=${Q.NEL}`)).toEqual(both);
    expect(await from(`account_id=${Q.BOM}`)).toEqual([]);
    expect(await from(`account_id=${bob.id}`)).toEqual([bob.id]);
    const unread = async (query: string) =>
      (await getJson<{ count: number }>(h, `/api/v1/notifications/unread_count?${query}`, alice.token)).body.count;
    expect(await unread(`account_id=${Q.NEL}`)).toBe(2);
    expect(await unread(`account_id=${Q.BOM}`)).toBe(0);
    expect(await unread(`account_id=${bob.id}`)).toBe(1);
    // v2 reads no account_id.
    const groups = await getJson<{ notification_groups: unknown[] }>(
      h,
      `/api/v2/notifications?account_id=${Q.BOM}`,
      alice.token,
    );
    expect(groups.body.notification_groups).toHaveLength(2);

    await post(h, alice, { status: "#cats one" });
    await post(h, alice, { status: "two" });
    const tagged = async (value: string) =>
      (await getJson<unknown[]>(h, `/api/v1/accounts/${alice.id}/statuses?tagged=${value}`, alice.token)).body.length;
    expect(await tagged(Q.NEL)).toBe(2);
    expect(await tagged(Q.BOM)).toBe(0);
    expect(await tagged("cats")).toBe(1);
  });
});

describe("media (PB10)", () => {
  // MediaAttachment#focus=: a blank point changes nothing; any other is read as numbers (to_f: 0 for none).
  it("keeps the focus for a blank one, and keeps a text thumbnail a thumbnail", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), {}, "a.png", "image/png"));
    const update = async (pairs: [string, string][]) =>
      answer(await sendForm(h, alice, "PUT", `/api/v1/media/${media.id}`, pairs));
    expect(await update([["focus", "0.5,0.25"]])).toMatchObject({
      status: 200,
      body: { meta: { focus: { x: 0.5, y: 0.25 } } },
    });
    expect(await update([["focus", NEL]])).toMatchObject({
      status: 200,
      body: { meta: { focus: { x: 0.5, y: 0.25 } } },
    });
    expect(await update([["focus", BOM]])).toMatchObject({ status: 200, body: { meta: { focus: { x: 0, y: 0 } } } });
    // The same rule on a post's edit (media_attributes[][focus]).
    const attached = await uploaded(h, alice, mediaForm(bytes(PNG_PLAIN), { focus: "0.5,0.25" }, "b.png", "image/png"));
    const status = await post(h, alice, { status: "m", media_ids: [attached.id] });
    const edit = async (focus: string) => {
      const body = { status: "m", media_ids: [attached.id], media_attributes: [{ id: attached.id, focus }] };
      const edited = await answer(await send(h, alice, "PUT", `/api/v1/statuses/${status.id}`, body));
      return [
        edited.status,
        (edited.body as { media_attachments: { meta: { focus?: unknown } }[] }).media_attachments[0]?.meta.focus,
      ];
    };
    expect(await edit(NEL)).toEqual([200, { x: 0.5, y: 0.25 }]);
    expect(await edit(BOM)).toEqual([200, { x: 0, y: 0 }]);
    // Paperclip takes any text that is not empty as the thumbnail's input: not a blank decision.
    expect(await update([["thumbnail", NEL]])).toEqual({
      status: 422,
      body: { error: "Validation failed: Thumbnail must be blank" },
    });
  });
});

describe("OAuth scopes (PB12)", () => {
  // Doorkeeper's presence of a request's scope: blank is the default (read); U+FEFF names no scope.
  it("reads a blank scope as the default on authorization and client credentials, not on registration", async () => {
    const h = await community(["alice"]);
    const oob = await registerApp(h, { scopes: "read", redirectUri: "urn:ietf:wg:oauth:2.0:oob" });
    expect((await consentPage(h, oob, { scope: NEL })).status).toBe(200);
    const refused = await consentPage(h, oob, { scope: BOM });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("invalid_scope");

    const token = async (scope: string) =>
      answer(
        await h.request(
          "/oauth/token",
          form({ grant_type: "client_credentials", client_id: oob.client_id, client_secret: oob.client_secret, scope }),
        ),
      );
    expect(await token(NEL)).toMatchObject({ status: 200, body: { scope: "read" } });
    expect(await token(BOM)).toMatchObject({ status: 400, body: { error: "invalid_scope" } });

    // A registration's scopes: absent or empty once trimmed is the default; anything else is split as sent.
    const register = async (scopes: string) =>
      answer(
        await h.request(
          "/api/v1/apps",
          form([
            ["client_name", "app"],
            ["redirect_uris", "urn:ietf:wg:oauth:2.0:oob"],
            ["scopes", scopes],
          ]),
        ),
      );
    expect(await register(" ")).toMatchObject({ status: 200, body: { scopes: ["read"] } });
    expect(await register(NEL)).toEqual(await register("nonsense"));
  });
});

describe("attribution domains (PB13)", () => {
  // Account::AttributionDomains: each value stripped, its http://, https:// and *. prefix removed, then dropped when
  // blank (presence), then unique; what is left is validated as a domain.
  it("drops each value blank once its prefix is removed, on every update route", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const stored = async () =>
      (
        await sql<{ d: string }>(
          h.store,
          "SELECT attribution_domains AS d FROM local_accounts WHERE account_id = ?",
          alice.id,
        )
      )[0]?.d;
    const shown = async () =>
      (
        await getJson<{ source: { attribution_domains: string[] } }>(
          h,
          "/api/v1/accounts/verify_credentials",
          alice.token,
        )
      ).body.source.attribution_domains;
    const mixed = await answer(
      await sendForm(h, alice, "PATCH", "/api/v1/accounts/update_credentials", [
        ["attribution_domains[]", "example.com"],
        ["attribution_domains[]", NEL],
        ["attribution_domains[]", `https://*.${NEL}`],
        ["attribution_domains[]", " example.com\t"],
      ]),
    );
    expect(mixed.status).toBe(200);
    expect(await shown()).toEqual(["example.com"]);
    expect(await stored()).toBe('["example.com"]');

    expect(
      (await send(h, alice, "PUT", "/api/v1/profile", { attribution_domains: [NEL, `http://${NEL}`] })).status,
    ).toBe(200);
    expect(await shown()).toEqual([]);
    expect(await stored()).toBe("[]");

    for (const value of [BOM, `https://*.${BOM}`]) {
      const refused = await h.request(
        "/api/v1/profile",
        bearer(alice.token, { method: "PATCH", body: multipartForm([["attribution_domains[]", value]]) }),
      );
      expect(refused.status, value).toBe(422);
      expect(await stored()).toBe("[]");
    }
  });
});

describe("featured hashtags and lookup (PB11)", () => {
  // params.require(:name), then FeaturedTag's `name.strip.delete_prefix('#')`, its presence and its format.
  it("judges a featured hashtag's name as Mastodon does at each stage", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const feature = async (name: string) => answer(await act(h, alice, "/api/v1/featured_tags", { name }));
    expect(await feature(NEL)).toEqual({
      status: 400,
      body: { error: "param is missing or the value is empty: name" },
    });
    expect(await feature(`#${NEL}`)).toEqual({
      status: 422,
      body: { error: "Validation failed: Name can't be blank" },
    });
    expect(await feature(`${BOM}cats`)).toEqual({ status: 422, body: { error: "Validation failed: Name is invalid" } });
    expect(await feature(" \u0000#cats\t")).toMatchObject({ status: 200, body: { name: "cats" } });
  });

  // ResolveAccountService strips acct as Ruby does (NUL, not U+FEFF) before dropping a leading @.
  it("strips the lookup's acct as Ruby does", async () => {
    const h = await community(["alice"]);
    expect((await getJson<{ id: string }>(h, "/api/v1/accounts/lookup?acct=%00%40alice%20")).body.id).toBe(
      h.users.alice.id,
    );
    expect((await getJson(h, `/api/v1/accounts/lookup?acct=${Q.BOM}alice`)).status).toBe(404);
  });
});
