import { runInDurableObject } from "cloudflare:test";
import jsonld from "jsonld/dist/jsonld.esm.js";
import { describe, expect, it } from "vitest";

import { rowHeapSql, selectSql } from "../src/db/columns";
import { Db, rowHeapBytes } from "../src/db/sql";
import { ACTOR_ROW_COLUMN_MAP, type ActorRow } from "../src/domain/actor-row";
import { actorSnapshot, moderationUpdate } from "../src/domain/actor-update";
import {
  ATTRIBUTION_DOMAIN_BYTES,
  BIO_JSON_BYTES,
  DISPLAY_NAME_LIMIT,
  DISPLAY_NAME_READ_BYTES,
  PROFILE_DESCRIPTION_BYTES,
  PROFILE_DESCRIPTION_LIMIT,
} from "../src/platform/stored-bounds";
import { bearer, json, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { LEGACY } from "./federation-helpers";
import { PNG_PLAIN } from "./fixtures/images";
import { bytes, mediaForm, TestCodec } from "./media-helpers";
import { rawBytes } from "./profile-fixtures";
import { contexts } from "./quote-helpers";
import { byText } from "./sort";
import { community, outbound, remoteAccount, remoteFollows } from "./status-helpers";
import { csrfOf, ORIGIN, signIn } from "./web-helpers";

// Profile changes reach other servers as Update(Person) through outbound delivery (VIS-3's "changes reach only the
// original audience" for an actor: its followers), and a later Update supersedes an earlier one.

const CREATED_AT = "2026-10-12T13:14:15.678Z";

async function setup() {
  const codec = new TestCodec();
  const h = await community(["alice"], "read write follow", { images: () => codec });
  await sql(h.store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
  // A creation time past midnight, so that a renderer publishing it instead of the day's midnight differs.
  await sql(h.store, "UPDATE accounts SET created_at = ? WHERE id = ?", CREATED_AT, h.users.alice.id);
  const fan = await remoteAccount(h.store, "fan", "fans.example");
  await remoteFollows(h.store, fan, h.users.alice.id);
  return h;
}

// An actor document with every key kept, in the form the Update's object and the actor endpoint agree on. The
// endpoint's is compacted JSON-LD from Fedify: a one-element array is its element and an empty one is left out, the
// key is re-exported as PEM with line breaks, and its key is typed CryptographicKey (which Mastodon's
// PublicKeySerializer, and so the Update, leaves out). Its own @context is not part of the object. `published` is
// compared as written: both write the creation day's midnight as `…T00:00:00Z` (actor-row.ts actorPublished).
function comparable(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.length === 1 ? comparable(value[0], key) : value.map((item) => comparable(item, key));
  }
  if (typeof value === "string") {
    return key === "publicKeyPem" ? value.replaceAll(/\s/g, "") : value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) =>
      k === "@context" ||
      (key === "publicKey" && k === "type" && v === "CryptographicKey") ||
      (Array.isArray(v) && v.length === 0)
        ? []
        : [[k, comparable(v, k)]],
    ),
  );
}

function patch(h: Awaited<ReturnType<typeof setup>>, body: unknown) {
  return h.request(
    "/api/v1/accounts/update_credentials",
    bearer(h.users.alice.token, { ...json(body), method: "PATCH" }),
  );
}

async function updates(h: Awaited<ReturnType<typeof setup>>) {
  const rows = await sql<{ superseded: number; body: string }>(
    h.store,
    "SELECT superseded, body FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Update' ORDER BY id",
  );
  return rows.map((row) => ({
    superseded: row.superseded === 1,
    activity: (JSON.parse(row.body) as { activity: Record<string, unknown> & { object: Record<string, unknown> } })
      .activity,
  }));
}

describe("the parity comparison", () => {
  it("equates only the forms the two renderers differ in", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";
    expect(
      comparable({
        alsoKnownAs: [],
        attachment: { type: "PropertyValue" },
        publicKey: { id: "k", type: "CryptographicKey", publicKeyPem: pem },
      }),
    ).toEqual(
      comparable({
        attachment: [{ type: "PropertyValue" }],
        publicKey: { id: "k", publicKeyPem: pem.replaceAll("\n", "") },
      }),
    );
    // Two spellings of one time, `published`'s included, and a key typed other than CryptographicKey, still differ.
    for (const key of ["name", "published"]) {
      expect(comparable({ [key]: "2026-11-14T00:00:00Z" })).not.toEqual(
        comparable({ [key]: "2026-11-14T00:00:00.000Z" }),
      );
    }
    expect(comparable({ publicKey: { id: "k", type: "Person" } })).not.toEqual(comparable({ publicKey: { id: "k" } }));
  });
});

describe("Update(Person)", () => {
  it("sends the changed profile to the followers, the latest edit only", async () => {
    const h = await setup();
    // Image descriptions (published only with an image, which alice has none of) and display settings are stored.
    await sql(
      h.store,
      `UPDATE accounts SET avatar_description = 'A cat', header_description = 'A field', show_featured = 0,
				show_media = 0, show_media_replies = 0 WHERE id = ?`,
      h.users.alice.id,
    );
    expect((await patch(h, { display_name: "First" })).status).toBe(200);
    expect(
      (
        await patch(h, {
          display_name: "Second",
          note: "bio",
          fields_attributes: [{ name: "Site", value: "https://alice.example/" }],
        })
      ).status,
    ).toBe(200);
    const sent = await updates(h);
    // The first edit's Update was still waiting: the second replaced it, and nothing of it remains.
    expect(sent.map((u) => u.superseded)).toEqual([false]);
    const latest = sent[0]?.activity;
    expect(latest).toMatchObject({
      type: "Update",
      actor: `${ORIGIN}/ap/users/alice`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: `${ORIGIN}/ap/users/alice`,
        type: "Person",
        name: "Second",
        summary: "<p>bio</p>",
        attachment: [{ type: "PropertyValue", name: "Site" }],
        showFeatured: false,
        showMedia: false,
        showRepliesInMedia: false,
        publicKey: { id: `${ORIGIN}/ap/users/alice#main-key`, publicKeyPem: LEGACY.pubkey },
      },
    });
    // Only the latest is delivered, as an Update (never turned into a Create), to the follower's server.
    const deliveries = await sql<{ type: string; name: string; inbox_url: string }>(
      h.store,
      `SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.object.name') AS name,
				d.inbox_url FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id`,
    );
    expect(deliveries).toEqual([{ type: "Update", name: "Second", inbox_url: "https://fans.example/inbox" }]);
    // The same document the actor endpoint publishes.
    const actor = await (
      await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<Record<string, unknown>>();
    expect(comparable(latest?.object ?? {})).toEqual(comparable(actor));
    expect([latest?.object.published, actor.published]).toEqual(["2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z"]);
  });

  it("sends nothing when the published profile does not change", async () => {
    const h = await setup();
    await patch(h, { source: { privacy: "unlisted" } });
    await patch(h, { display_name: "" });
    expect(await updates(h)).toEqual([]);
    expect(await outbound(h.store)).toEqual([]);
  });

  it("sends one Update when the account hides or shows its network, and none when the setting stays", async () => {
    for (const [stored, asked] of [
      [0, true],
      [1, false],
    ] as const) {
      const h = await setup();
      await sql(h.store, "UPDATE local_accounts SET hide_collections = ?", stored);
      // The same value as stored: nothing changes.
      expect((await patch(h, { hide_collections: !asked })).status).toBe(200);
      expect(await updates(h)).toEqual([]);
      expect((await patch(h, { hide_collections: asked })).status).toBe(200);
      const sent = await updates(h);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.activity).toMatchObject({ type: "Update", object: { id: `${ORIGIN}/ap/users/alice` } });
      // Asked again, it records nothing more.
      expect((await patch(h, { hide_collections: asked })).status).toBe(200);
      expect(await updates(h)).toEqual(sent);
    }
  });

  it("sends attributionDomains when the account sets them, and an Update without them when it clears them", async () => {
    const h = await setup();
    expect((await patch(h, { attribution_domains: ["writer.example"] })).status).toBe(200);
    let sent = await updates(h);
    expect(sent.at(-1)?.activity.object.attributionDomains).toEqual(["writer.example"]);
    expect(JSON.stringify(sent.at(-1)?.activity["@context"])).toContain("toot:attributionDomains");
    expect((await patch(h, { attribution_domains: [] })).status).toBe(200);
    sent = await updates(h);
    expect(sent.at(-1)?.activity.object).not.toHaveProperty("attributionDomains");
    expect(sent.at(-1)?.activity.object).toMatchObject({ type: "Person", preferredUsername: "alice" });
    // The same list again changes nothing published.
    expect((await patch(h, { attribution_domains: [] })).status).toBe(200);
    expect(await updates(h)).toHaveLength(sent.length);
  });

  // An import may hold any JSON array (0024's CHECK): the endpoint and the Update read it through attributionDomainsSql
  // and present it through presentedAttributionDomains alike.
  it("sends the same document as the endpoint for imported attribution domains past their bounds", async () => {
    const h = await setup();
    const actor = async () =>
      (await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })).json<
        Record<string, unknown>
      >();
    const imported = async (sqlValue: string, name: string) => {
      await sql(h.store, `UPDATE local_accounts SET attribution_domains = ${sqlValue}`);
      expect((await patch(h, { display_name: name })).status).toBe(200);
      const object = (await updates(h)).at(-1)?.activity.object;
      expect(object).toMatchObject({ name });
      expect(comparable(object)).toEqual(comparable(await actor()));
      return object;
    };
    // An entry past ATTRIBUTION_DOMAIN_BYTES among compliant ones: dropped by both.
    const entries = await imported(
      `json_array('a.example', '${"y".repeat(ATTRIBUTION_DOMAIN_BYTES + 1)}', 'b.example')`,
      "First",
    );
    expect(entries?.attributionDomains).toEqual(["a.example", "b.example"]);
    // One element of 1 MiB: read as '[]', so neither publishes the key.
    const oversized = await imported("json_array(hex(zeroblob(524288)))", "Second");
    expect(oversized).not.toHaveProperty("attributionDomains");
    expect(await actor()).not.toHaveProperty("attributionDomains");
  });

  // ActivityPub::ActorSerializer's show_featured, show_media and show_media_replies with their profile_settings terms,
  // a suspended actor's too; a JSON-LD processor reads each under its toot: IRI in both contexts.
  it("carries the display settings with their terms, in a suspension's Update too", async () => {
    const h = await setup();
    await sql(h.store, "UPDATE accounts SET show_featured = 0, show_media = 1, show_media_replies = 0");
    expect((await patch(h, { display_name: "Alice A" })).status).toBe(200);
    const suspension = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      db.run("UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
      return moderationUpdate(db, h.users.alice.id, NOW);
    });
    for (const activity of [(await updates(h)).at(-1)?.activity, suspension?.activity as Record<string, unknown>]) {
      const [expanded] = await jsonld.expand(activity, { documentLoader: contexts });
      const object = (
        expanded?.["https://www.w3.org/ns/activitystreams#object"] as Record<string, unknown>[] | undefined
      )?.[0];
      const read = (term: string) =>
        (object?.[`http://joinmastodon.org/ns#${term}`] as { "@value": unknown }[] | undefined)?.map(
          (v) => v["@value"],
        );
      expect([read("showFeatured"), read("showMedia"), read("showRepliesInMedia")]).toEqual([[false], [true], [false]]);
    }
    expect(suspension?.activity).toMatchObject({ object: { suspended: true, showFeatured: false } });
  });

  it("declares the handle in webfinger with its named context, in a suspension's Update too (FEP-2c59)", async () => {
    const h = await setup();
    expect((await patch(h, { display_name: "Alice A" })).status).toBe(200);
    const [sent] = await updates(h);
    expect(sent?.activity.object.webfinger).toBe("alice@kopje.test");
    expect(sent?.activity["@context"]).toContain("https://purl.archive.org/socialweb/webfinger");
    const suspension = await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      db.run(
        "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE account_id = ?",
        h.users.alice.id,
      );
      return moderationUpdate(db, h.users.alice.id, NOW);
    });
    const activity = suspension?.activity as { "@context": unknown[]; object: Record<string, unknown> };
    expect(activity.object).toMatchObject({ webfinger: "alice@kopje.test", suspended: true });
    expect(activity["@context"]).toContain("https://purl.archive.org/socialweb/webfinger");
  });

  it("names the handle at its actor id's host in both documents, whatever domain is stored (ID-5)", async () => {
    const h = await setup();
    // An operator moved the domain (/admin/config) after alice's actor id was fixed on kopje.test; the API and the
    // actor endpoint answer only on the stored domain (WEB-6).
    await setSetting(h.store, "domain", "other.workers.dev");
    const other = (path: string, init: RequestInit) => h.send(new Request(`https://other.workers.dev${path}`, init));
    const edit = { ...json({ display_name: "Alice A" }), method: "PATCH" };
    expect((await other("/api/v1/accounts/update_credentials", bearer(h.users.alice.token, edit))).status).toBe(200);
    const [sent] = await updates(h);
    const served = await (
      await other("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<Record<string, unknown>>();
    // Without it, the Update names its kopje.test actor alice@other.workers.dev, a handle off the actor id's origin.
    expect([sent?.activity.object ?? {}, served].map((document) => [document.id, document.webfinger])).toEqual([
      [`${ORIGIN}/ap/users/alice`, "alice@kopje.test"],
      ["https://other.workers.dev/ap/users/alice", "alice@other.workers.dev"],
    ]);
  });

  it("sends the new avatar from the settings page", async () => {
    const h = await setup();
    const browser = await signIn(h);
    const form = mediaForm(bytes(PNG_PLAIN), { csrf: await csrfOf(h, browser) }, "p.png", "image/png");
    const response = await h.request("/settings/avatar", {
      method: "POST",
      headers: { cookie: browser.cookie, origin: ORIGIN },
      body: form,
    });
    expect(response.status).toBe(303);
    const [avatar] = await sql<{ avatar_url: string }>(
      h.store,
      "SELECT avatar_url FROM accounts WHERE username = 'alice'",
    );
    const sent = await updates(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.activity.object).toMatchObject({ icon: { type: "Image", url: avatar?.avatar_url } });
  });

  it("keeps unrelated and leased deliveries and lane order, with partly expanded targets", async () => {
    const h = await setup();
    const { alice } = h.users;
    // 150 more followers, each on its own server: one activity's targets take more than one expansion step.
    for (let i = 0; i < 150; i++) {
      await remoteFollows(h.store, await remoteAccount(h.store, `f${i}`, `f${i}.example`), alice.id);
    }
    expect((await patch(h, { display_name: "One" })).status).toBe(200);
    const [first] = await updates(h);
    const firstId = await activityId(h, "One");
    // Some of the first Update's deliveries are leased (possibly already POSTed); its other targets wait.
    await h.store.claimDeliveries(h.env.CF_VERSION_METADATA.id, { now: NOW, leaseToken: "round-1" });
    const leased = await sql<{ id: number; lane: string }>(
      h.store,
      "SELECT id, lane FROM deliveries WHERE state = 'leased' AND activity_id = ?",
      firstId,
    );
    expect(leased.length).toBeGreaterThan(0);
    expect(first?.activity.object).toMatchObject({ name: "One" });
    // A status in between, then the second edit.
    const status = await h.request("/api/v1/statuses", bearer(alice.token, json({ status: "hello" })));
    expect(status.status).toBe(200);
    expect((await patch(h, { display_name: "Two" })).status).toBe(200);
    const secondId = await activityId(h, "Two");
    const createId = (
      await sql<{ id: number }>(
        h.store,
        "SELECT id FROM outbound_activities WHERE json_extract(body, '$.activity.type') = 'Create'",
      )
    )[0]?.id;

    // The first Update keeps exactly its leased deliveries and no waiting targets.
    const firstLeft = await sql<{ id: number; state: string }>(
      h.store,
      "SELECT id, state FROM deliveries WHERE activity_id = ?",
      firstId,
    );
    expect(firstLeft.map((d) => d.id).toSorted(byText)).toEqual(leased.map((d) => d.id).toSorted(byText));
    expect(await targetsOf(h, firstId)).toBe(firstLeft.length);
    // The status and the second Update reach every follower's server (151 each, expanded or still waiting).
    expect(await targetsOf(h, createId ?? 0)).toBe(151);
    expect(await targetsOf(h, secondId)).toBe(151);
    // Lane order holds where the leased first Update is still in its lane: it, then the status, then the second.
    for (const { lane } of leased) {
      const order = await sql<{ activity_id: number }>(
        h.store,
        "SELECT activity_id FROM deliveries WHERE lane = ? ORDER BY id",
        lane,
      );
      const ids = order.map((d) => d.activity_id);
      expect(ids[0], lane).toBe(firstId);
      expect(ids.filter((id) => id !== firstId)).toEqual(ids.filter((id) => id !== firstId).toSorted((x, y) => x - y));
    }
  }, 30_000);
});

// The local actor's document at the endpoint, in the Update a later profile change records, in a moderation Update
// and in actorSnapshot; with what ACTOR_ROW_COLUMN_MAP reads of the display name and the decoded row's heap against
// its rowHeapSql.
async function documents(h: Awaited<ReturnType<typeof setup>>, locked: boolean) {
  const id = h.users.alice.id;
  const from = "FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?";
  const [row] = await sql<ActorRow>(h.store, `SELECT ${selectSql(ACTOR_ROW_COLUMN_MAP)} ${from}`, id);
  const [bound] = await sql<{ read: number; heap: number }>(
    h.store,
    `SELECT octet_length(${ACTOR_ROW_COLUMN_MAP.display_name}) AS read, ${rowHeapSql(ACTOR_ROW_COLUMN_MAP)} AS heap
			${from}`,
    id,
  );
  expect((await patch(h, { locked })).status).toBe(200);
  const update = (await updates(h)).at(-1)?.activity.object;
  expect(update).toMatchObject({ manuallyApprovesFollowers: locked });
  const snapshot = await runInDurableObject(h.store, (_instance, state) =>
    actorSnapshot(new Db(state.storage.sql), id),
  );
  const moderation = await runInDurableObject(
    h.store,
    (_instance, state) => moderationUpdate(new Db(state.storage.sql), id, NOW)?.activity.object,
  );
  const endpoint = await (
    await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
  ).json<Record<string, unknown>>();
  for (const document of [update, moderation, JSON.parse(snapshot)]) {
    expect(comparable(document)).toEqual(comparable(endpoint));
  }
  return { endpoint, read: bound?.read, heap: { decoded: rowHeapBytes(row!), sql: bound?.heap } };
}

// RES-3: the local actor's display name and note as an import may hold them, in malformed UTF-8 that passes the
// triggers of 0048_stored_bounds and decodes past their bounds. The endpoint and every Update read the display name
// through displayNameReadSql (ACTOR_ROW_COLUMN_MAP) and present both through presentedDisplayName and presentedNote, as
// an Account does (test/account-text-bounds.test.ts).
describe("the actor's display name and note (RES-3)", () => {
  // 0xFF and 1,048,575 continuation bytes: one character to 0048's displayNameSql, 1,048,576 U+FFFD once decoded. 65,534
  // continuation bytes: within noteSql's BIO_JSON_BYTES, since json_quote copies them, and 196,604 JSON bytes decoded.
  const NAME_BYTES = 1_048_576;
  const NOTE_BYTES = 65_534;

  it("bounds a malformed display name and note alike at the endpoint and in the Update", async () => {
    const h = await setup();
    // An import as a dump holds them: the trigger accounts_bounds_update passes both values.
    await sql(
      h.store,
      "UPDATE accounts SET display_name = CAST(? AS TEXT), note = CAST(? AS TEXT) WHERE id = ?",
      rawBytes(`\u00ff${"\u0080".repeat(NAME_BYTES - 1)}`),
      rawBytes("\u0080".repeat(NOTE_BYTES)),
      h.users.alice.id,
    );
    const [stored] = await sql<{ name: number; note: number }>(
      h.store,
      "SELECT octet_length(display_name) AS name, octet_length(note) AS note FROM accounts WHERE id = ?",
      h.users.alice.id,
    );
    expect(stored).toEqual({ name: NAME_BYTES, note: NOTE_BYTES });
    const { endpoint, read, heap } = await documents(h, true);
    // 2,048 U+FFFD (6,146 JSON bytes), where the whole value published 3,145,730, and the note '', where it published
    // 196,604; the documents equal (above).
    expect(endpoint.name).toBe("\uFFFD".repeat(DISPLAY_NAME_LIMIT));
    expect(endpoint.summary ?? "").toBe("");
    // Read as its first DISPLAY_NAME_READ_BYTES stored bytes; the decoded row within the heap its SQL bound states.
    expect(read).toBe(DISPLAY_NAME_READ_BYTES);
    expect(heap.decoded).toBeLessThanOrEqual(heap.sql!);
    // Suspended, neither document carries a name or a summary.
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-01-01T00:00:00.000Z'");
    const suspended = await runInDurableObject(
      h.store,
      (_instance, state) => moderationUpdate(new Db(state.storage.sql), h.users.alice.id, NOW)?.activity.object,
    );
    const served = await (
      await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })
    ).json<Record<string, unknown>>();
    for (const document of [suspended, served]) {
      expect(document).toMatchObject({ suspended: true });
      expect(document).not.toHaveProperty("name");
      expect(document).not.toHaveProperty("summary");
    }
  });

  it("publishes a writer's display name and a note at the JSON bound whole", async () => {
    const h = await setup();
    // 2,048 four-byte characters (8,192 bytes), the most a writer stores (storedDisplayName), and a note whose JSON
    // string (json_quote, as noteSql measures it) is exactly BIO_JSON_BYTES: U+0001 escapes to six bytes.
    const name = "𠀀".repeat(DISPLAY_NAME_LIMIT);
    const note = `<p>${"\u0001".repeat(10_000)}${"x".repeat(5_527)}</p>`;
    await sql(h.store, "UPDATE accounts SET display_name = ?, note = ? WHERE id = ?", name, note, h.users.alice.id);
    const [quoted] = await sql<{ bytes: number }>(h.store, "SELECT octet_length(json_quote(?)) AS bytes", note);
    expect(quoted?.bytes).toBe(BIO_JSON_BYTES);
    const { endpoint, read } = await documents(h, true);
    expect({ name: endpoint.name, summary: endpoint.summary }).toEqual({ name, summary: note });
    expect(read).toBe(DISPLAY_NAME_READ_BYTES);
  });
});

// The image descriptions as ActivityPub::ImageSerializer publishes them (summary only when present?), presented by
// presentedProfileDescription, alike at the endpoint and in the Update.
describe("the actor's image descriptions", () => {
  const AVATAR = "https://kopje.test/media/AAAA/full.webp";

  it("publishes a summary unless Rails judges the description blank, alike at the endpoint and in the Update", async () => {
    const h = await setup();
    await sql(h.store, "UPDATE accounts SET avatar_url = ? WHERE id = ?", AVATAR, h.users.alice.id);
    const actor = async () =>
      (await h.request("/ap/users/alice", { headers: { accept: "application/activity+json" } })).json<{
        icon: Record<string, unknown>;
      }>();
    // U+FEFF is not White_Space, so present?; U+0085 and U+3000 are, so blank (trim() reads U+FEFF as blank and leaves
    // U+0085). Each is written by a description-only change, which records an Update when the document changes.
    let last: unknown;
    for (const [description, summary, recorded] of [
      ["\uFEFF", "\uFEFF", true],
      ["\u0085", undefined, true],
      ["\u3000", undefined, false],
    ] as const) {
      expect((await patch(h, { avatar_description: description })).status).toBe(200);
      const sent = await updates(h);
      expect(sent.at(-1)?.activity.id !== last, description).toBe(recorded);
      last = sent.at(-1)?.activity.id;
      const served = await actor();
      expect(served.icon, description).toEqual({ type: "Image", url: AVATAR, ...(summary ? { summary } : {}) });
      expect(comparable(sent.at(-1)?.activity.object), description).toEqual(comparable(served));
    }
  });

  it("publishes an imported malformed description cut at PROFILE_DESCRIPTION_LIMIT, alike in both", async () => {
    const h = await setup();
    // 0xFF and 599 continuation bytes: one character to 0097's trigger, 600 U+FFFD once decoded.
    await sql(
      h.store,
      "UPDATE accounts SET avatar_url = ?, header_url = ?, avatar_description = CAST(? AS TEXT) WHERE id = ?",
      AVATAR,
      AVATAR,
      rawBytes(`\u00ff${"\u0080".repeat(PROFILE_DESCRIPTION_BYTES - 1)}`),
      h.users.alice.id,
    );
    const { endpoint } = await documents(h, true);
    expect(endpoint.icon).toEqual({ type: "Image", url: AVATAR, summary: "\uFFFD".repeat(PROFILE_DESCRIPTION_LIMIT) });
    expect(endpoint.image).toEqual({ type: "Image", url: AVATAR });
  });
});

async function activityId(h: Awaited<ReturnType<typeof setup>>, name: string): Promise<number> {
  const [row] = await sql<{ id: number }>(
    h.store,
    "SELECT id FROM outbound_activities WHERE json_extract(body, '$.activity.object.name') = ?",
    name,
  );
  return row?.id ?? 0;
}

// Deliveries written for an activity plus targets still waiting in its chunks.
async function targetsOf(h: Awaited<ReturnType<typeof setup>>, activityId: number): Promise<number> {
  const [row] = await sql<{ n: number }>(
    h.store,
    `SELECT (SELECT COUNT(*) FROM deliveries WHERE activity_id = ?1)
			+ (SELECT IFNULL(SUM(json_array_length(targets) - next), 0) FROM outbound_targets WHERE activity_id = ?1) AS n`,
    activityId,
  );
  return row?.n ?? 0;
}
