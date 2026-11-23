import { describe, expect, it } from "vitest";

import { apiHarness, bearer, form, json, login, seedAccount, sql } from "./api-helpers";
import { LEGACY } from "./federation-helpers";

// Local profile fields (Mastodon's fields_attributes): at most four, stored as plain text, presented escaped with
// http(s) URLs linked (HTML-2, HTML-3), in the API and as the actor's PropertyValue attachments.

async function withAlice() {
  const h = await apiHarness();
  await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
  return h;
}

describe("profile fields over the API", () => {
  it("replaces fields from fields_attributes, at most four", async () => {
    const h = await withAlice();
    const { token } = await login(h, { scope: "read write" });
    const update = (body: unknown) =>
      h.request("/api/v1/accounts/update_credentials", bearer(token, { ...json(body), method: "PATCH" }));
    const ok = await update({ fields_attributes: [{ name: "a", value: "b" }] });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ fields: unknown[] }>()).fields).toEqual([{ name: "a", value: "b", verified_at: null }]);
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    expect((await update({ fields_attributes: five })).status).toBe(422);
    const cleared = await update({ fields_attributes: [] });
    expect((await cleared.json<{ fields: unknown[] }>()).fields).toEqual([]);
    // An empty JSON object is a sent, empty hash: it clears the fields too, as does an object of empty members.
    for (const empty of [{}, { 0: {} }]) {
      await update({ fields_attributes: [{ name: "a", value: "b" }] });
      const response = await update({ fields_attributes: empty });
      expect((await response.json<{ fields: unknown[] }>()).fields).toEqual([]);
    }
    // A body without fields_attributes keeps them.
    await update({ fields_attributes: [{ name: "a", value: "b" }] });
    expect((await (await update({ note: "n" })).json<{ fields: unknown[] }>()).fields).toHaveLength(1);
  });

  // Account#fields_attributes= drops a pair whose name and value are both blank by Rails (U+0085 is, U+FEFF is not) and
  // stores the rest as sent; Account::Field#sanitize reads each name and value stripped by Ruby (NUL, tab, LF, VT, FF,
  // CR and space) and cut to its first 255 characters, and a pair without a name or a value (nil, which sanitize
  // raises on) is not read back. Kopje stores what those reads give.
  it("strips and cuts fields as Account::Field", async () => {
    const h = await withAlice();
    const { token } = await login(h, { scope: "read write" });
    const long = `${"a".repeat(254)}\u{1F600}${"b".repeat(45)}`;
    expect([...long]).toHaveLength(300);
    const response = await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(token, {
        ...json({
          fields_attributes: [
            { name: " a ", value: "\u0000\t x\r\n" },
            { name: "", value: "\u0085" },
            { name: "\u00a0n\u0000m\u00a0", value: "\uFEFF" },
            { value: "no name" },
            { name: "no value" },
            { name: long, value: long },
          ],
        }),
        method: "PATCH",
      }),
    );
    expect(response.status).toBe(200);
    const cut = `${"a".repeat(254)}\u{1F600}`;
    const expected = [
      { name: "a", value: "x" },
      { name: "\u00a0n\u0000m\u00a0", value: "\uFEFF" },
      { name: cut, value: cut },
    ];
    const source = (await response.json<{ source: { fields: { name: string; value: string }[] } }>()).source.fields;
    expect(source.map(({ name, value }) => ({ name, value }))).toEqual(expected);
    const [row] = await sql<{ fields: string }>(h.store, "SELECT fields FROM local_accounts");
    expect(JSON.parse(row!.fields)).toEqual(expected);
  });

  // Account#fields_attributes= keeps a pair with a JSON null (nil) name or value beside a present one, and
  // Account#fields leaves it out of every read (sanitize raises on nil), so it is neither counted nor judged: a null
  // reads as a missing parameter, in an array or an indexed hash. Only JSON sends null; a form or multipart body's
  // empty name is a blank label.
  it("drops a field with a JSON null name or value, as Account#fields reads it", async () => {
    const h = await withAlice();
    const { token } = await login(h, { scope: "read write" });
    const update = (init: RequestInit) =>
      h.request("/api/v1/accounts/update_credentials", bearer(token, { ...init, method: "PATCH" }));
    const kept = Array.from({ length: 4 }, (_, i) => ({ name: `n${i}`, value: `v${i}` }));
    const sent = [{ name: null, value: "v" }, { name: "n", value: null }, { name: null, value: null }, ...kept];
    for (const fields of [sent, Object.fromEntries(sent.map((field, i) => [String(i), field]))]) {
      const response = await update(json({ fields_attributes: fields }));
      expect(response.status, JSON.stringify(fields)).toBe(200);
      const source = (await response.json<{ source: { fields: { name: string; value: string }[] } }>()).source.fields;
      expect(source.map(({ name, value }) => ({ name, value }))).toEqual(kept);
      const [row] = await sql<{ fields: string }>(h.store, "SELECT fields FROM local_accounts");
      expect(JSON.parse(row!.fields)).toEqual(kept);
    }
    const blank = { "fields_attributes[0][name]": "", "fields_attributes[0][value]": "v" };
    const multipart = new FormData();
    for (const [key, value] of Object.entries(blank)) {
      multipart.append(key, value);
    }
    for (const init of [form(blank), { body: multipart }]) {
      const refused = await update(init);
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        error: "Validation failed: Fields contains values with missing labels",
      });
    }
  });

  // EmptyProfileFieldNamesValidator: a field whose name, as read back, is blank by Rails and whose value is not.
  it("refuses a value without a label", async () => {
    const h = await withAlice();
    const { token } = await login(h, { scope: "read write" });
    const update = (fields: unknown[]) =>
      h.request(
        "/api/v1/accounts/update_credentials",
        bearer(token, { ...json({ fields_attributes: fields }), method: "PATCH" }),
      );
    for (const name of [" ", "\u0000", "\u00a0", "\u3000\t"]) {
      const refused = await update([
        { name: "a", value: "b" },
        { name, value: "x" },
      ]);
      expect(refused.status, JSON.stringify(name)).toBe(422);
      expect(await refused.json(), JSON.stringify(name)).toEqual({
        error: "Validation failed: Fields contains values with missing labels",
        details: {
          fields: [
            { error: "ERR_FIELDS_WITH_VALUES_MISSING_LABELS", description: "contains values with missing labels" },
          ],
        },
      });
    }
    expect(await sql(h.store, "SELECT fields FROM local_accounts")).toEqual([{ fields: "[]" }]);
    // A label without a value is a field.
    const labelled = await update([{ name: "a", value: " " }]);
    expect(labelled.status).toBe(200);
    expect(await sql(h.store, "SELECT fields FROM local_accounts")).toEqual([
      { fields: JSON.stringify([{ name: "a", value: "" }]) },
    ]);
  });

  it("publishes fields as PropertyValue attachments of the actor", async () => {
    const h = await withAlice();
    await sql(h.store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
    const { token } = await login(h, { scope: "read write" });
    await h.request(
      "/api/v1/accounts/update_credentials",
      bearer(token, {
        ...json({ fields_attributes: [{ name: "Site", value: "https://alice.example/" }] }),
        method: "PATCH",
      }),
    );
    const actor = await (
      await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<{ attachment: { type: string; name: string; value: string }[] }>();
    // An array even for one field, as Mastodon serves it and reads it (property_values): a single object is ignored.
    expect(actor.attachment).toHaveLength(1);
    expect(actor.attachment[0]).toMatchObject({ type: "PropertyValue", name: "Site" });
    expect(actor.attachment[0]!.value).toContain('href="https://alice.example/"');
  });
});
