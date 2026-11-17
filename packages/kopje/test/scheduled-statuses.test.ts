import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { ANSWER_BYTES, jsonBytes } from "../src/domain/answer-budget";
import { expiredMedia } from "../src/domain/media";
import {
  DAILY_LIMIT,
  deleteScheduled,
  getScheduled,
  listScheduled,
  MAX_ATTEMPTS,
  MAX_PARAMS_BYTES,
  paramsReadSql,
  PUBLISH_ROUND,
  publishScheduled as publishOne,
  recordPublishFailure,
  RETRY_DELAYS_MS,
  SCHEDULED_PAGE,
  type ScheduledStatus,
  storedParams,
  TOTAL_LIMIT,
} from "../src/domain/scheduled-statuses";
import {
  MAX_MEDIA_DESCRIPTION_LENGTH,
  MAX_STATUS_MEDIA,
  MEDIA_URL_JSON_BYTES,
  MEDIA_URL_LIMIT,
} from "../src/domain/status-bounds";
import { publishScheduled } from "../src/jobs/scheduled";
import { parseScheduledAt } from "../src/mastodon/statuses";
import { utf8Length } from "../src/platform/dump-format";
import type { StoreOperation } from "../src/platform/store-kernel";
import { BLURHASH_BYTES } from "../src/platform/stored-bounds";
import { sha256Hex } from "../src/security/tokens";
import { type ApiHarness, bearer, json, login, settle, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { measuredStatements, observedSql } from "./read-helpers";
import {
  community,
  follow,
  getJson,
  ids,
  post,
  remoteAccount,
  remoteFollows,
  type Status,
  type User,
} from "./status-helpers";
import { blurhashOf } from "./stored-bounds-fixtures";

// Scheduled statuses (domain/scheduled-statuses.ts, mastodon/scheduled-statuses.ts), as Mastodon 4.5 has them:
// POST /api/v1/statuses with scheduled_at, the scheduled_statuses endpoints, ScheduledStatus's validations and limits,
// the media they hold, and the cron's publication through the path of an ordinary post.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Scheduled = {
  id: string;
  scheduled_at: string;
  params: Record<string, unknown>;
  media_attachments: { id: string }[];
};

const at = (ms: number) => new Date(ms).toISOString();

async function schedule(
  h: ApiHarness,
  user: User,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return h.request("/api/v1/statuses", bearer(user.token, json(body, { headers })));
}

async function scheduled(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<Scheduled> {
  const response = await schedule(h, user, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

function send(h: ApiHarness, user: User, method: string, path: string, body: Record<string, unknown> = {}) {
  return h.request(path, bearer(user.token, json(body, { method })));
}

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

// A completed, unattached upload of the user's, attachable for a day.
async function upload(h: ApiHarness, user: User, n: number): Promise<string> {
  const id = String(800000000000000000n + BigInt(n));
  await sql(
    h.store,
    `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
		VALUES (?, ?, 'image', ?, ?, 1, ?)`,
    id,
    user.id,
    `https://kopje.test/files/t${n}/full`,
    `t${n}`,
    at(NOW + DAY),
  );
  return id;
}

function round(h: ApiHarness, now: number, doorbell = vi.fn(() => Promise.resolve())) {
  return publishScheduled(h.env, { build: () => BUILD, now: () => now, store: () => h.store, doorbell });
}

// The publication of the scheduled status `id` at `now`, by the Store operation itself, with its answer.
function publishDirectly(h: ApiHarness, id: string, now: number) {
  return runInDurableObject(h.store, (_instance, state) =>
    publishOne.run(state.storage.sql, { id, now, objectId: crypto.randomUUID() }),
  );
}

async function count(h: ApiHarness, table: string): Promise<number> {
  return (await sql<{ n: number }>(h.store, `SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0;
}

describe("scheduling a status", () => {
  it("answers a ScheduledStatus, as REST::ScheduledStatusSerializer shows it, and shows it to its owner", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const parent = await post(h, alice, { status: "first" });
    const media = await upload(h, alice, 1);
    const when = at(NOW + HOUR);
    const created = await scheduled(h, alice, {
      status: "later",
      scheduled_at: when,
      in_reply_to_id: parent.id,
      media_ids: [media],
      language: "en",
      sensitive: "true",
    });
    expect(created).toEqual({
      id: expect.stringMatching(/^\d{18}$/),
      scheduled_at: when,
      params: {
        text: "later",
        poll: null,
        media_ids: [media],
        sensitive: true,
        spoiler_text: "",
        visibility: null,
        language: "en",
        scheduled_at: null,
        in_reply_to_id: parent.id,
        // The client_id of the app it was scheduled through.
        application_id: h.app.client_id,
        idempotency: null,
        with_rate_limit: false,
        allowed_mentions: null,
        quoted_status_id: null,
        // None was sent: alice's default, resolved when it was scheduled.
        quote_approval_policy: "public",
      },
      media_attachments: [expect.objectContaining({ id: media, type: "image" })],
    });
    expect(await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).toEqual({
      status: 200,
      body: created,
    });
    expect((await getJson(h, "/api/v1/scheduled_statuses", alice.token)).body).toEqual([created]);
    // Not a status: nothing new to read.
    expect((await getJson(h, `/api/v1/statuses/${created.id}`, alice.token)).status).toBe(404);
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([parent.id]);
  });

  it("posts at once when scheduled_at is not in the future, and refuses one too soon or unreadable", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const past = await schedule(h, alice, { status: "now", scheduled_at: at(NOW - MINUTE) });
    expect(await past.json()).toMatchObject({ content: "<p>now</p>", visibility: "public" });
    expect(await refusal(await schedule(h, alice, { status: "soon", scheduled_at: at(NOW + 5 * MINUTE) }))).toEqual({
      status: 422,
      body: { error: "Validation failed: Scheduled at date must be in the future" },
    });
    expect(await refusal(await schedule(h, alice, { status: "x", scheduled_at: "tomorrow" }))).toEqual({
      status: 422,
      body: { error: "Record invalid" },
    });
    expect((await schedule(h, alice, { status: "ok", scheduled_at: at(NOW + 5 * MINUTE + 1) })).status).toBe(200);
  });

  it("checks the post as an immediate one is checked", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const later = at(NOW + HOUR);
    const cases: [Record<string, unknown>, number, unknown][] = [
      [{ status: "x".repeat(501) }, 422, { error: "Validation failed: Text character limit of 500 exceeded" }],
      [{ status: " " }, 422, { error: "Validation failed: Text can't be blank" }],
      [
        { status: "x", visibility: "everyone" },
        422,
        { error: "Validation failed: Visibility is not included in the list" },
      ],
      [
        { status: "x", "poll[options][]": "a" },
        422,
        { error: "Validation failed: Deadline can't be blank, Choices must have more than one item" },
      ],
      [{ status: "x", media_ids: ["1", "2", "3", "4", "5"] }, 422, { error: "Cannot attach more than 4 files" }],
      [
        { status: "x", in_reply_to_id: "999999999999999999" },
        404,
        { error: "The post you are trying to reply to does not appear to exist." },
      ],
    ];
    for (const [body, status, error] of cases) {
      expect(await refusal(await schedule(h, alice, { ...body, scheduled_at: later })), JSON.stringify(body)).toEqual({
        status,
        body: error,
      });
    }
    expect(await count(h, "scheduled_statuses")).toBe(0);
  });

  it(`allows ${TOTAL_LIMIT} in all and ${DAILY_LIMIT} a day, with Mastodon's messages`, async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const day = Date.parse("2026-10-20T00:00:00.000Z");
    // DAILY_LIMIT - 1 on the day, the rest the days after.
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2,
				strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || (CASE WHEN i < ?4 THEN 0 ELSE i END) || ' days'), '{}' FROM n`,
      TOTAL_LIMIT - 2,
      alice.id,
      at(day + HOUR),
      DAILY_LIMIT - 1,
    );
    const onDay = (hours: number) => ({ status: "x", scheduled_at: at(day + hours * HOUR) });
    expect((await schedule(h, alice, onDay(23))).status).toBe(200);
    expect(await refusal(await schedule(h, alice, onDay(2)))).toEqual({
      status: 422,
      body: { error: `Validation failed: You have exceeded the limit of ${DAILY_LIMIT} scheduled posts for today` },
    });
    // The next UTC day has room; then the total is reached.
    expect((await schedule(h, alice, onDay(24))).status).toBe(200);
    expect(await refusal(await schedule(h, alice, onDay(-24 * 2)))).toEqual({
      status: 422,
      body: { error: `Validation failed: You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts` },
    });
    expect(await refusal(await schedule(h, alice, { status: "x", scheduled_at: at(NOW + MINUTE) }))).toEqual({
      status: 422,
      body: {
        error: `Validation failed: Scheduled at date must be in the future, You have exceeded the limit of ${TOTAL_LIMIT} scheduled posts`,
      },
    });
    // Another account's limits are its own.
    expect((await schedule(h, bob, onDay(2))).status).toBe(200);
  });

  it("answers a repeated Idempotency-Key with what the first request made", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const body = { status: "once", scheduled_at: at(NOW + 10 * MINUTE) };
    const first = await (await schedule(h, alice, body, { "Idempotency-Key": "k1" })).json<Scheduled>();
    const again = await (await schedule(h, alice, body, { "Idempotency-Key": "k1" })).json<Scheduled>();
    expect(again).toEqual(first);
    expect(await count(h, "scheduled_statuses")).toBe(1);
    // Once published, the repeat is answered with the status.
    await round(h, NOW + 10 * MINUTE);
    const published = await (await schedule(h, alice, body, { "Idempotency-Key": "k1" })).json<Status>();
    expect(published).toMatchObject({ content: "<p>once</p>" });
    expect(await count(h, "statuses")).toBe(1);
    expect(await count(h, "scheduled_statuses")).toBe(0);
  });
});

describe("an Idempotency-Key expires an hour after what it made", () => {
  const key = { "Idempotency-Key": "hour" };
  const keys = async (h: ApiHarness, table: string) =>
    (await sql<{ k: string | null }>(h.store, `SELECT client_key AS k FROM ${table} ORDER BY id`)).map((r) => r.k);

  it("answers the scheduled status within the hour; at the hour a repeat posts anew and frees the key", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const first = await (
      await schedule(h, alice, { status: "later", scheduled_at: at(NOW + 3 * HOUR) }, key)
    ).json<Scheduled>();
    h.now.mockReturnValue(NOW + HOUR - 1);
    expect(await (await schedule(h, alice, { status: "again" }, key)).json()).toEqual(first);
    h.now.mockReturnValue(NOW + HOUR);
    const fresh = await schedule(h, alice, { status: "again" }, key);
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ content: "<p>again</p>" });
    const hash = await sha256Hex("hour");
    expect(await keys(h, "scheduled_statuses")).toEqual([null]);
    expect(await keys(h, "statuses")).toEqual([hash]);
    // The older scheduled status publishes without the key, which stays with the new status.
    await round(h, NOW + 3 * HOUR);
    expect(await count(h, "scheduled_statuses")).toBe(0);
    expect(await keys(h, "statuses")).toEqual([hash, null]);
    h.now.mockReturnValue(NOW + HOUR + 1);
    expect(await (await schedule(h, alice, { status: "third" }, key)).json()).toMatchObject({
      content: "<p>again</p>",
    });
  });

  it("a repeat that schedules again replaces the expired key without a unique error", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await scheduled(h, alice, { status: "one", scheduled_at: at(NOW + 3 * HOUR) });
    await schedule(h, alice, { status: "one", scheduled_at: at(NOW + 3 * HOUR) }, key);
    h.now.mockReturnValue(NOW + HOUR);
    const again = await schedule(h, alice, { status: "two", scheduled_at: at(NOW + 4 * HOUR) }, key);
    expect(again.status).toBe(200);
    expect(await keys(h, "scheduled_statuses")).toEqual([null, null, await sha256Hex("hour")]);
  });

  it("keeps the key on a status published within the hour until an hour after the publication", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await schedule(h, alice, { status: "soon", scheduled_at: at(NOW + 10 * MINUTE) }, key);
    await round(h, NOW + 10 * MINUTE);
    expect(await keys(h, "statuses")).toEqual([await sha256Hex("hour")]);
    h.now.mockReturnValue(NOW + 10 * MINUTE + HOUR - 1);
    expect(await (await schedule(h, alice, { status: "repeat" }, key)).json()).toMatchObject({
      content: "<p>soon</p>",
    });
    h.now.mockReturnValue(NOW + 10 * MINUTE + HOUR);
    expect(await (await schedule(h, alice, { status: "repeat" }, key)).json()).toMatchObject({
      content: "<p>repeat</p>",
    });
    expect(await keys(h, "statuses")).toEqual([null, await sha256Hex("hour")]);
  });

  it("publishes a status without the key when the key expired before the publication", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await schedule(h, alice, { status: "late", scheduled_at: at(NOW + 3 * HOUR) }, key);
    await round(h, NOW + 3 * HOUR);
    expect(await keys(h, "statuses")).toEqual([null]);
    expect(await (await schedule(h, alice, { status: "repeat" }, key)).json()).toMatchObject({
      content: "<p>repeat</p>",
    });
  });

  it("publishes without the key a row whose stored created_at is not a time, or is exactly an hour old", async () => {
    const stored: [string, string, number][] = [
      ["now", "'now'", NOW + 10 * MINUTE],
      ["an embedded NUL", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || char(0) || 'x'", NOW + 10 * MINUTE],
      ["an hour old", "created_at", NOW + HOUR],
      ["an hour old less a millisecond", "created_at", NOW + HOUR - 1],
    ];
    for (const [name, value, publishedAt] of stored) {
      const h = await community(["alice"]);
      const { alice } = h.users;
      const created = await scheduled(h, alice, { status: name, scheduled_at: at(NOW + 10 * MINUTE) });
      // The key is set directly: no repeated request clears it before the publication.
      await sql(
        h.store,
        `UPDATE scheduled_statuses SET client_key = 'direct', created_at = ${value} WHERE id = ?`,
        created.id,
      );
      const publication = await publishDirectly(h, created.id, publishedAt);
      expect(publication, name).toMatchObject({ status: "published" });
      expect(await keys(h, "statuses"), name).toEqual([publishedAt === NOW + HOUR - 1 ? "direct" : null]);
    }
  });

  it("counts a restored created_at that is not a time Kopje writes as expired", async () => {
    for (const stored of ["'now'", "'not a time'", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') || char(0) || 'x'"]) {
      const h = await community(["alice"]);
      const { alice } = h.users;
      await schedule(h, alice, { status: "kept", scheduled_at: at(NOW + 3 * HOUR) }, key);
      await sql(h.store, `UPDATE scheduled_statuses SET created_at = ${stored}`);
      const repeat = await schedule(h, alice, { status: "anew" }, key);
      expect(await repeat.json(), stored).toMatchObject({ content: "<p>anew</p>" });
      expect(await keys(h, "scheduled_statuses")).toEqual([null]);
      // Published, it carries no key.
      await round(h, NOW + 3 * HOUR);
      expect(await keys(h, "statuses")).toEqual([await sha256Hex("hour"), null]);
    }
  });
});

describe("an Idempotency-Key shared by an immediate and a scheduled post", () => {
  it("answers a post without scheduled_at with the scheduled status the key reserved, and publishes once", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const key = { "Idempotency-Key": "shared" };
    const first = await (
      await schedule(h, alice, { status: "once", scheduled_at: at(NOW + 10 * MINUTE) }, key)
    ).json<Scheduled>();
    const now = await (await schedule(h, alice, { status: "once" }, key)).json<Scheduled>();
    expect(now).toEqual(first);
    expect(await count(h, "statuses")).toBe(0);
    await round(h, NOW + 10 * MINUTE);
    await round(h, NOW + 15 * MINUTE);
    expect(await count(h, "statuses")).toBe(1);
    expect(await (await schedule(h, alice, { status: "once" }, key)).json()).toMatchObject({ content: "<p>once</p>" });
    expect(await count(h, "statuses")).toBe(1);
  });

  it("answers a scheduled post with the status the key already made, and schedules nothing", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const key = { "Idempotency-Key": "shared" };
    const posted = await (await schedule(h, alice, { status: "once" }, key)).json<Status>();
    const again = await (await schedule(h, alice, { status: "once", scheduled_at: at(NOW + HOUR) }, key)).json();
    expect(again).toMatchObject({ id: posted.id, content: "<p>once</p>" });
    expect(await count(h, "scheduled_statuses")).toBe(0);
    await round(h, NOW + HOUR);
    expect(await count(h, "statuses")).toBe(1);
  });
});

describe("the scheduled_statuses endpoints", () => {
  it("pages by id, newest first, with Link headers", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push((await scheduled(h, alice, { status: `s${i}`, scheduled_at: at(NOW + (i + 1) * HOUR) })).id);
    }
    const newest = [...made].toReversed();
    const first = await h.request("/api/v1/scheduled_statuses?limit=2", bearer(alice.token));
    expect((await first.json<Scheduled[]>()).map((s) => s.id)).toEqual(newest.slice(0, 2));
    expect(first.headers.get("link")).toBe(
      `<https://kopje.test/api/v1/scheduled_statuses?limit=2&max_id=${newest[1]}>; rel="next", ` +
        `<https://kopje.test/api/v1/scheduled_statuses?limit=2&min_id=${newest[0]}>; rel="prev"`,
    );
    expect(await ids(h, `/api/v1/scheduled_statuses?max_id=${newest[1]}`, alice.token)).toEqual(newest.slice(2));
    expect(await ids(h, `/api/v1/scheduled_statuses?min_id=${made[0]}&limit=2`, alice.token)).toEqual([
      made[2],
      made[1],
    ]);
    expect(await ids(h, `/api/v1/scheduled_statuses?since_id=${made[2]}`, alice.token)).toEqual(newest.slice(0, 2));
  });

  it("changes scheduled_at only, with the validations run again", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await scheduled(h, alice, { status: "move me", scheduled_at: at(NOW + HOUR) });
    const moved = await send(h, alice, "PUT", `/api/v1/scheduled_statuses/${created.id}`, {
      scheduled_at: at(NOW + 2 * HOUR),
      status: "ignored",
    });
    expect(await moved.json()).toEqual({ ...created, scheduled_at: at(NOW + 2 * HOUR) });
    const patched = await send(h, alice, "PATCH", `/api/v1/scheduled_statuses/${created.id}`, {
      scheduled_at: "2026-10-12T03:00:00+02:00",
    });
    expect(await patched.json()).toMatchObject({ scheduled_at: "2026-10-12T01:00:00.000Z" });
    expect(
      await refusal(await send(h, alice, "PUT", `/api/v1/scheduled_statuses/${created.id}`, { scheduled_at: at(NOW) })),
    ).toEqual({ status: 422, body: { error: "Validation failed: Scheduled at date must be in the future" } });
    expect(
      await refusal(await send(h, alice, "PUT", `/api/v1/scheduled_statuses/${created.id}`, { scheduled_at: "soon" })),
    ).toEqual({ status: 422, body: { error: "Record invalid" } });
    expect((await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).body).toMatchObject({
      scheduled_at: "2026-10-12T01:00:00.000Z",
      params: { text: "move me" },
    });
  });

  it("refuses a date the calendar does not have, on POST and PUT, as Mastodon does", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await scheduled(h, alice, { status: "x", scheduled_at: "2028-02-29T10:00:00Z" });
    expect(created.scheduled_at).toBe("2028-02-29T10:00:00.000Z");
    const path = `/api/v1/scheduled_statuses/${created.id}`;
    for (const invalid of [
      "2027-02-29T10:00:00Z",
      "2026-11-31T10:00:00Z",
      "2026-12-01T24:30:00Z",
      "2026-12-01T10:60:00Z",
    ]) {
      const invalidBody = { status: 422, body: { error: "Record invalid" } };
      expect(await refusal(await schedule(h, alice, { status: "x", scheduled_at: invalid })), invalid).toEqual(
        invalidBody,
      );
      expect(await refusal(await send(h, alice, "PUT", path, { scheduled_at: invalid })), invalid).toEqual(invalidBody);
    }
    // Ruby reads 24:00:00 as the next day's midnight.
    const midnight = await send(h, alice, "PUT", path, { scheduled_at: "2026-12-01T24:00:00Z" });
    expect(await midnight.json()).toMatchObject({ scheduled_at: "2026-12-02T00:00:00.000Z" });
    expect(await count(h, "scheduled_statuses")).toBe(1);
  });

  it("never shows or changes another account's scheduled status", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const created = await scheduled(h, alice, { status: "mine", scheduled_at: at(NOW + HOUR) });
    const path = `/api/v1/scheduled_statuses/${created.id}`;
    const notFound = { status: 404, body: { error: "Record not found" } };
    expect(await getJson(h, path, bob.token)).toEqual(notFound);
    expect(await refusal(await send(h, bob, "PUT", path, { scheduled_at: at(NOW + 2 * HOUR) }))).toEqual(notFound);
    expect(await refusal(await send(h, bob, "DELETE", path))).toEqual(notFound);
    expect(await ids(h, "/api/v1/scheduled_statuses", bob.token)).toEqual([]);
    expect((await getJson<Scheduled>(h, path, alice.token)).body).toEqual(created);
  });

  it("deletes a scheduled status and detaches its media, attachable again for a day", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = await upload(h, alice, 1);
    const created = await scheduled(h, alice, { status: "x", media_ids: [media], scheduled_at: at(NOW + HOUR) });
    const deleted = await send(h, alice, "DELETE", `/api/v1/scheduled_statuses/${created.id}`);
    expect([deleted.status, await deleted.json()]).toEqual([200, {}]);
    expect(await sql(h.store, "SELECT scheduled_status_id, gc_at FROM media_attachments")).toEqual([
      { scheduled_status_id: null, gc_at: at(NOW + DAY) },
    ]);
    expect(await post(h, alice, { status: "again", media_ids: [media] })).toMatchObject({
      media_attachments: [expect.objectContaining({ id: media })],
    });
  });

  it("holds its media: not swept as unattached, not attached elsewhere, not made a profile image, not deleted", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = await upload(h, alice, 1);
    await scheduled(h, alice, { status: "x", media_ids: [media], scheduled_at: at(NOW + 3 * DAY) });
    expect(await sql(h.store, "SELECT gc_at FROM media_attachments")).toEqual([{ gc_at: null }]);
    const due = await runInDurableObject(h.store, (_instance, state) =>
      expiredMedia.run(state.storage.sql, { now: NOW + 2 * DAY, limit: 100 }),
    );
    expect(due).toEqual([]);
    expect(await refusal(await schedule(h, alice, { status: "other", media_ids: [media] }))).toEqual({
      status: 422,
      body: { error: `Media ${media} not found or already attached to another post` },
    });
    expect(await count(h, "statuses")).toBe(0);
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "write", now: NOW } as const;
    expect(
      await h.store.updateCredentials(BUILD, {
        credential,
        changes: {},
        images: { avatar: media },
        present: { origin: "https://kopje.test" },
        now: NOW,
      }),
    ).toMatchObject({
      status: "ok",
      value: { status: "upload_gone" },
    });
    expect(await refusal(await send(h, alice, "DELETE", `/api/v1/media/${media}`))).toEqual({
      status: 422,
      body: { error: "Media attachment is currently used by a status" },
    });
    expect(await sql(h.store, "SELECT gc_at FROM media_attachments")).toEqual([{ gc_at: null }]);
  });
});

describe("publication", () => {
  it("publishes a due status once, through the path of an ordinary post", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await follow(h, bob, alice.id);
    await remoteFollows(h.store, await remoteAccount(h.store, "dave"), alice.id);
    const media = await upload(h, alice, 1);
    const created = await scheduled(h, alice, {
      status: "hello @bob #cats",
      media_ids: [media],
      scheduled_at: at(NOW + HOUR),
    });
    const doorbell = vi.fn(() => Promise.resolve());
    // Not due yet.
    await round(h, NOW + HOUR - 1, doorbell);
    expect(await count(h, "statuses")).toBe(0);
    expect(doorbell).not.toHaveBeenCalled();
    // Two overlapping runs, then a third: one status.
    const publishedAt = NOW + HOUR + 3 * MINUTE;
    await Promise.all([round(h, publishedAt, doorbell), round(h, publishedAt, doorbell)]);
    await round(h, publishedAt + 5 * MINUTE, doorbell);
    expect(doorbell).toHaveBeenCalledTimes(1);
    const [status] = (await getJson<Status[]>(h, "/api/v1/timelines/home", bob.token)).body;
    expect(status).toMatchObject({
      account: { id: alice.id },
      visibility: "public",
      created_at: at(publishedAt),
      mentions: [expect.objectContaining({ id: bob.id })],
      tags: [expect.objectContaining({ name: "cats" })],
      media_attachments: [expect.objectContaining({ id: media })],
    });
    expect(await count(h, "statuses")).toBe(1);
    expect((await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).status).toBe(404);
    expect(await sql(h.store, "SELECT type, from_account_id FROM notifications WHERE type = 'mention'")).toEqual([
      { type: "mention", from_account_id: alice.id },
    ]);
    expect(
      (await sql<{ body: string }>(h.store, "SELECT body FROM outbound_activities")).map(
        (row) => (JSON.parse(row.body) as { activity: { type: string } }).activity.type,
      ),
    ).toEqual(["Create"]);
  });

  it("publishes media with a poll, scheduled through the API or restored, as Mastodon 4.6 takes them", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const [sent, restored] = [await upload(h, alice, 1), await upload(h, alice, 2)];
    const poll = { options: ["a", "b"], expires_in: "600", multiple: false, hide_totals: false };
    const created = await scheduled(h, alice, {
      status: "both",
      media_ids: [sent],
      poll: { options: ["a", "b"], expires_in: 600 },
      scheduled_at: at(NOW + HOUR),
    });
    expect(created.params).toMatchObject({ media_ids: [sent], poll });
    expect(created.media_attachments).toEqual([expect.objectContaining({ id: sent })]);
    expect(await sql(h.store, "SELECT scheduled_status_id, gc_at FROM media_attachments WHERE id = ?", sent)).toEqual([
      { scheduled_status_id: created.id, gc_at: null },
    ]);
    // A row restored with both, its upload held, as the API writes it.
    const params = { ...created.params, text: "restored", media_ids: [restored] };
    await sql(
      h.store,
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES ('600000000000000001', ?, ?, ?)`,
      alice.id,
      at(NOW + HOUR),
      JSON.stringify(params),
    );
    await sql(
      h.store,
      "UPDATE media_attachments SET scheduled_status_id = '600000000000000001', gc_at = NULL WHERE id = ?",
      restored,
    );
    for (const id of [created.id, "600000000000000001"]) {
      expect(await publishDirectly(h, id, NOW + HOUR), id).toMatchObject({ status: "published" });
    }
    const statuses = (
      await getJson<(Status & { media_attachments: { id: string }[]; poll: unknown })[]>(
        h,
        `/api/v1/accounts/${alice.id}/statuses`,
        alice.token,
      )
    ).body;
    expect(
      statuses.map((s) => ({ text: s.content, media: s.media_attachments.map((m) => m.id), poll: s.poll })),
    ).toEqual(
      [
        ["<p>restored</p>", restored],
        ["<p>both</p>", sent],
      ].map(([text, media]) => ({
        text,
        media: [media],
        poll: expect.objectContaining({ options: [expect.objectContaining({ title: "a" }), expect.anything()] }),
      })),
    );
  });

  it("schedules a blank text with its CW as its text, and publishes a row an earlier release scheduled as stored", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const created = await scheduled(h, alice, { status: "", spoiler_text: "cw", scheduled_at: at(NOW + HOUR) });
    expect(created.params).toMatchObject({ text: "cw", spoiler_text: "", sensitive: true });
    expect(
      (await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token)).body.params,
    ).toMatchObject({ text: "cw", spoiler_text: "", sensitive: true });
    // Its length is that of the text it becomes: 500 characters as a warning, 504 as text.
    expect(
      await refusal(
        await schedule(h, alice, {
          status: "",
          spoiler_text: `${"x".repeat(480)} https://example.com`,
          scheduled_at: at(NOW + HOUR),
        }),
      ),
    ).toEqual({ status: 422, body: { error: "Validation failed: Text character limit of 500 exceeded" } });
    expect(await count(h, "scheduled_statuses")).toBe(1);
    // A row an earlier release scheduled with a blank text, a CW and media, its upload held.
    const media = await upload(h, alice, 1);
    const earlier = "600000000000000001";
    await sql(
      h.store,
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)`,
      earlier,
      alice.id,
      at(NOW + HOUR),
      JSON.stringify({ ...created.params, text: "", spoiler_text: "cw", sensitive: null, media_ids: [media] }),
    );
    await sql(
      h.store,
      "UPDATE media_attachments SET scheduled_status_id = ?, gc_at = NULL WHERE id = ?",
      earlier,
      media,
    );
    for (const id of [created.id, earlier]) {
      expect(await publishDirectly(h, id, NOW + HOUR), id).toMatchObject({ status: "published" });
    }
    expect(
      await sql(h.store, "SELECT content, source_text, spoiler_text, sensitive FROM statuses ORDER BY id"),
    ).toEqual([
      { content: "<p>cw</p>", source_text: "cw", spoiler_text: "", sensitive: 1 },
      { content: "", source_text: "", spoiler_text: "cw", sensitive: 1 },
    ]);
  });

  it("applies the author's defaults at the time of publication", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await scheduled(h, alice, { status: "later", scheduled_at: at(NOW + HOUR) });
    await sql(h.store, "UPDATE local_accounts SET default_visibility = 'unlisted' WHERE account_id = ?", alice.id);
    await round(h, NOW + HOUR);
    expect(await sql(h.store, "SELECT visibility FROM statuses")).toEqual([{ visibility: "unlisted" }]);
  });

  it("drops a post that no longer passes, as PublishScheduledStatusWorker does, and frees its media", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const parent = await post(h, alice, { status: "parent" });
    const media = await upload(h, alice, 1);
    await scheduled(h, alice, {
      status: "reply",
      in_reply_to_id: parent.id,
      media_ids: [media],
      scheduled_at: at(NOW + HOUR),
    });
    await scheduled(h, bob, { status: "suspended later", scheduled_at: at(NOW + HOUR) });
    expect((await send(h, alice, "DELETE", `/api/v1/statuses/${parent.id}`)).status).toBe(200);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", at(NOW), bob.id);
    // The parent is withdrawn, not gone yet, when the reply's time comes: the reply is dropped all the same.
    await round(h, NOW + HOUR);
    expect(await sql(h.store, "SELECT id, withdrawn FROM statuses")).toEqual([{ id: parent.id, withdrawn: 1 }]);
    await settle(h.store);
    expect(await count(h, "statuses")).toBe(0);
    expect(await count(h, "scheduled_statuses")).toBe(0);
    expect(await sql(h.store, "SELECT status_id, scheduled_status_id, gc_at FROM media_attachments")).toEqual([
      { status_id: null, scheduled_status_id: null, gc_at: at(NOW + HOUR + DAY) },
    ]);
  });

  it("refuses to schedule unusable media, and drops a post whose held media is gone when it is due", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect(
      await refusal(await schedule(h, alice, { status: "x", media_ids: ["7"], scheduled_at: at(NOW + HOUR) })),
    ).toEqual({ status: 422, body: { error: "Media 7 not found or already attached to another post" } });
    expect(await count(h, "scheduled_statuses")).toBe(0);
    const media = await upload(h, alice, 1);
    const held = await scheduled(h, alice, { status: "x", media_ids: [media], scheduled_at: at(NOW + HOUR) });
    await sql(h.store, "DELETE FROM media_attachments WHERE id = ?", media);
    // As PublishScheduledStatusWorker loses a post whose validate_media! raises.
    const publication = await publishDirectly(h, held.id, NOW + HOUR);
    expect(publication).toEqual({ status: "dropped", reason: "invalid" });
    expect(await count(h, "statuses")).toBe(0);
    expect(await count(h, "scheduled_statuses")).toBe(0);
  });

  it("keeps allowed_mentions as sent and checks it when it publishes, dropping a post it refuses", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const when = at(NOW + HOUR);
    const cases: [string, Record<string, unknown> | string, unknown, boolean][] = [
      ["absent", { status: "@bob absent", scheduled_at: when }, null, true],
      ["null", { status: "@bob null", scheduled_at: when, allowed_mentions: null }, null, true],
      ["listed", { status: "@bob listed", scheduled_at: when, allowed_mentions: [bob.id] }, [bob.id], true],
      ["JSON []", { status: "@bob json", scheduled_at: when, allowed_mentions: [] }, [], false],
      ["form []=", `status=%40bob%20form&scheduled_at=${encodeURIComponent(when)}&allowed_mentions[]=`, [""], false],
    ];
    const made = new Map<string, Scheduled>();
    for (const [name, body, shown] of cases) {
      const response =
        typeof body === "string"
          ? await h.request(
              "/api/v1/statuses",
              bearer(alice.token, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body,
              }),
            )
          : await schedule(h, alice, body);
      expect(response.status, name).toBe(200);
      const created = await response.json<Scheduled>();
      expect(created.params.allowed_mentions, name).toEqual(shown);
      const read = await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token);
      expect(read.body.params.allowed_mentions, name).toEqual(shown);
      made.set(name, created);
    }
    const media = await upload(h, alice, 1);
    const refused = await scheduled(h, alice, {
      status: "@bob with media",
      media_ids: [media],
      scheduled_at: when,
      allowed_mentions: [],
    });
    const publish = (id: string) => publishDirectly(h, id, NOW + HOUR);
    for (const [name, , , publishes] of cases) {
      const publication = await publish(made.get(name)!.id);
      expect(publication, name).toMatchObject(
        publishes ? { status: "published" } : { status: "dropped", reason: "unexpected_mentions" },
      );
    }
    expect(await publish(refused.id)).toEqual({ status: "dropped", reason: "unexpected_mentions" });
    expect((await sql<{ content: string }>(h.store, "SELECT content FROM statuses ORDER BY id")).length).toBe(3);
    expect(await count(h, "scheduled_statuses")).toBe(0);
    expect(await sql(h.store, "SELECT status_id, scheduled_status_id, gc_at FROM media_attachments")).toEqual([
      { status_id: null, scheduled_status_id: null, gc_at: at(NOW + HOUR + DAY) },
    ]);
  });

  it("keeps numbers in allowed_mentions as strings, and publishes an imported media id with leading zeros", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const created = await scheduled(h, alice, {
      status: `@bob numbers`,
      scheduled_at: at(NOW + HOUR),
      allowed_mentions: [Number(bob.id.slice(0, 15))],
    });
    expect(created.params.allowed_mentions).toEqual([bob.id.slice(0, 15)]);
    const read = await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token);
    expect(read.body.params.allowed_mentions).toEqual([bob.id.slice(0, 15)]);
    const imported = "000000000000000123";
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
			VALUES (?, ?, 'image', 'https://kopje.test/files/z/full', 'z', 1, ?)`,
      imported,
      alice.id,
      at(NOW + DAY),
    );
    const held = await scheduled(h, alice, { status: "zeros", media_ids: [imported], scheduled_at: at(NOW + HOUR) });
    expect(held.params.media_ids).toEqual([imported]);
    await round(h, NOW + HOUR);
    expect(
      await sql(h.store, "SELECT status_id IS NOT NULL AS attached FROM media_attachments WHERE id = ?", imported),
    ).toEqual([{ attached: 1 }]);
  });

  it("publishes a restored row without allowed_mentions, and drops one with another shape as params", async () => {
    const h = await community(["alice", "bob"]);
    const { alice } = h.users;
    const restored: [string, (params: Record<string, unknown>) => void, string][] = [
      ["absent", (params) => delete params.allowed_mentions, "published"],
      ["null", (params) => (params.allowed_mentions = null), "published"],
      ["a string", (params) => (params.allowed_mentions = "x"), "params"],
      ["numbers", (params) => (params.allowed_mentions = [1]), "params"],
    ];
    for (const [name, change, outcome] of restored) {
      const created = await scheduled(h, alice, { status: `@bob ${name}`, scheduled_at: at(NOW + HOUR) });
      const params = { ...created.params };
      change(params);
      await sql(h.store, "UPDATE scheduled_statuses SET params = ? WHERE id = ?", JSON.stringify(params), created.id);
      const publication = await publishDirectly(h, created.id, NOW + HOUR);
      expect(publication, name).toMatchObject(
        outcome === "published" ? { status: "published" } : { status: "dropped", reason: "params" },
      );
    }
  });

  it("publishes through the app it was scheduled through, kept as stored when the app is gone", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const client = h.app.client_id;
    const second = await login(h, { email: "alice@example.com", scope: "read write follow" });
    const viaSecond = { id: alice.id, token: second.token };
    const kept = await scheduled(h, alice, { status: "kept", scheduled_at: at(NOW + HOUR) });
    const orphaned = await scheduled(h, viaSecond, { status: "orphaned", scheduled_at: at(NOW + HOUR) });
    expect(orphaned.params.application_id).toBe(second.app.client_id);
    // The second app is removed before the publication (its tokens go with it).
    await sql(h.store, "DELETE FROM oauth_clients WHERE id = ?", second.app.client_id);
    const publish = async (id: string) => {
      const publication = await publishDirectly(h, id, NOW + HOUR);
      expect(publication).toMatchObject({ status: "published" });
      return (publication as { statusId: string }).statusId;
    };
    const keptId = await publish(kept.id);
    const orphanedId = await publish(orphaned.id);
    // The dangling id is stored as the params held it, and presents no app.
    const stored = async (id: string) =>
      (
        await sql<{ application_id: string | null }>(h.store, "SELECT application_id FROM statuses WHERE id = ?", id)
      )[0];
    expect(await stored(keptId)).toEqual({ application_id: client });
    expect(await stored(orphanedId)).toEqual({ application_id: second.app.client_id });
    const shown = async (id: string) => (await getJson<Status>(h, `/api/v1/statuses/${id}`)).body;
    expect(await shown(keptId)).toHaveProperty("application", { name: "Test Client", website: "https://client.test" });
    expect(await shown(orphanedId)).toHaveProperty("application", null);
  });

  it("publishes a restored row whose application_id the bound refuses without an app", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const restored: [string, unknown][] = [
      ["a number", 42],
      ["65 characters", "a".repeat(65)],
      ["outside base64url", "client*one"],
      ["absent", undefined],
    ];
    for (const [name, value] of restored) {
      const created = await scheduled(h, alice, { status: name, scheduled_at: at(NOW + HOUR) });
      const params = { ...created.params, application_id: value };
      await sql(h.store, "UPDATE scheduled_statuses SET params = ? WHERE id = ?", JSON.stringify(params), created.id);
      const publication = await publishDirectly(h, created.id, NOW + HOUR);
      expect(publication, name).toMatchObject({ status: "published" });
      const statusId = (publication as { statusId: string }).statusId;
      expect(await sql(h.store, "SELECT application_id FROM statuses WHERE id = ?", statusId), name).toEqual([
        { application_id: null },
      ]);
    }
  });

  it("waits while the Store is readonly, then publishes", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await scheduled(h, alice, { status: "later", scheduled_at: at(NOW + HOUR) });
    expect(await h.store.setMaintenance(BUILD, true)).toEqual({ maintenance: true });
    await expect(round(h, NOW + HOUR)).rejects.toThrow("store unavailable: maintenance");
    expect(await count(h, "scheduled_statuses")).toBe(1);
    await h.store.setMaintenance(BUILD, false);
    await round(h, NOW + HOUR);
    expect(await count(h, "statuses")).toBe(1);
  });

  it(`backs off what keeps failing, so later schedules publish, and drops it after ${MAX_ATTEMPTS} attempts`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await upload(h, alice, 1);
    // An error that is not a refusal of the post: the Store rolls the publication back.
    await sql(
      h.store,
      `CREATE TRIGGER fail_publication BEFORE INSERT ON statuses WHEN NEW.source_text LIKE 'fail%'
			BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2, strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || i || ' seconds'),
				json_object('text', 'fail ' || i, 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL,
					'in_reply_to_id', NULL, 'media_ids', NULL)
			FROM n`,
      PUBLISH_ROUND,
      alice.id,
      at(NOW + HOUR),
    );
    await sql(h.store, "UPDATE media_attachments SET scheduled_status_id = '600000000000000000', gc_at = NULL");
    // Due after them; written directly, as the rows above already fill the day's limit.
    const healthy = "600000000000000999";
    await sql(
      h.store,
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, json_object('text',
				'healthy', 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL, 'in_reply_to_id', NULL,
				'media_ids', NULL))`,
      healthy,
      alice.id,
      at(NOW + HOUR + MINUTE),
    );
    let t = NOW + HOUR + MINUTE;
    await round(h, t);
    expect(await count(h, "statuses")).toBe(0);
    t += 5 * MINUTE;
    await round(h, t);
    expect(await sql(h.store, "SELECT content FROM statuses")).toEqual([{ content: "<p>healthy</p>" }]);
    expect((await getJson(h, `/api/v1/scheduled_statuses/${healthy}`, alice.token)).status).toBe(404);
    // The failures back off and are retried, each failing again, until the last attempt drops them and frees the media.
    const attempts = await sql<{ attempts: number }>(h.store, "SELECT attempts FROM scheduled_statuses");
    expect(attempts.length).toBe(PUBLISH_ROUND);
    expect(attempts.every((row) => row.attempts >= 1 && row.attempts <= 2)).toBe(true);
    for (let run = 0; run < MAX_ATTEMPTS + 1; run++) {
      t += RETRY_DELAYS_MS.at(-1) ?? 0;
      await round(h, t);
    }
    expect(await count(h, "scheduled_statuses")).toBe(0);
    expect(await count(h, "statuses")).toBe(1);
    const [freed] = await sql<{ scheduled_status_id: string | null; gc_at: string | null }>(
      h.store,
      "SELECT scheduled_status_id, gc_at FROM media_attachments",
    );
    expect(freed?.scheduled_status_id).toBeNull();
    expect(Date.parse(freed?.gc_at ?? "")).toBeGreaterThan(t);
  });

  it(`publishes at most ${PUBLISH_ROUND} a run, the earliest first`, async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
			SELECT CAST(600000000000000000 + i AS TEXT), ?2, strftime('%Y-%m-%dT%H:%M:%fZ', ?3, '+' || i || ' seconds'),
				json_object('text', 'n' || i, 'spoiler_text', '', 'sensitive', NULL, 'language', NULL, 'visibility', NULL,
					'in_reply_to_id', NULL, 'media_ids', NULL)
			FROM n`,
      PUBLISH_ROUND + 5,
      alice.id,
      at(NOW),
    );
    await round(h, NOW + HOUR);
    expect(await count(h, "statuses")).toBe(PUBLISH_ROUND);
    expect(await sql(h.store, "SELECT min(id) AS first FROM scheduled_statuses")).toEqual([
      { first: String(600000000000000000n + BigInt(PUBLISH_ROUND)) },
    ]);
    await round(h, NOW + HOUR);
    expect(await count(h, "statuses")).toBe(PUBLISH_ROUND + 5);
  });
});

// Nothing of a scheduled status is shown, notified or delivered before its publication (R26, VIS-1): whatever is
// scheduled, by whom, mentioning whom and with which visibility, every other table stays as it was, and each account's
// scheduled statuses are its own.
describe("nothing leaks before publication", () => {
  const TABLES = [
    "statuses",
    "status_mentions",
    "status_tags",
    "notifications",
    "outbound_activities",
    "outbound_targets",
    "deliveries",
    "push_deliveries",
    "favourites",
    "bookmarks",
  ];

  async function snapshot(h: ApiHarness): Promise<unknown> {
    const tables: Record<string, unknown> = {};
    for (const table of TABLES) {
      tables[table] = await sql(h.store, `SELECT * FROM ${table} ORDER BY 1, 2`);
    }
    tables.accounts = await sql(h.store, "SELECT id, statuses_count FROM accounts ORDER BY id");
    return tables;
  }

  it("writes nothing but the scheduled status, and shows it to its owner alone", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const users = [h.users.alice, h.users.bob, h.users.carol];
    await follow(h, h.users.bob, h.users.alice.id);
    await follow(h, h.users.carol, h.users.alice.id);
    const parent = await post(h, h.users.alice, { status: "parent #cats" });
    const before = await snapshot(h);
    const actionArb = fc.record({
      author: fc.integer({ min: 0, max: 2 }),
      mentions: fc.subarray([0, 1, 2]),
      visibility: fc.constantFrom("public", "unlisted", "private", "direct"),
      reply: fc.boolean(),
      offset: fc.integer({ min: 6, max: 60 * 24 * 3 }),
    });
    const names = ["alice", "bob", "carol"];
    const owned: string[][] = [[], [], []];
    await fc.assert(
      fc.asyncProperty(actionArb, async (action) => {
        const author = users[action.author] as User;
        const text = `${action.mentions.map((m) => `@${names[m]}`).join(" ")} later #cats`;
        const created = await scheduled(h, author, {
          status: text,
          visibility: action.visibility,
          scheduled_at: at(NOW + action.offset * MINUTE),
          ...(action.reply ? { in_reply_to_id: parent.id } : {}),
        });
        owned[action.author]?.push(created.id);
        expect(await snapshot(h)).toEqual(before);
        for (const [i, user] of users.entries()) {
          expect((await ids(h, "/api/v1/scheduled_statuses?limit=40", user.token)).toSorted()).toEqual(
            [...(owned[i] ?? [])].toSorted(),
          );
          expect((await getJson(h, `/api/v1/scheduled_statuses/${created.id}`, user.token)).status).toBe(
            user === author ? 200 : 404,
          );
          expect((await getJson(h, `/api/v1/statuses/${created.id}`, user.token)).status).toBe(404);
          expect(await ids(h, "/api/v1/timelines/home", user.token)).toEqual([parent.id]);
        }
        expect(await ids(h, "/api/v1/timelines/public")).toEqual([parent.id]);
        expect(await ids(h, "/api/v1/timelines/tag/cats")).toEqual([parent.id]);
      }),
      { numRuns: 12, seed: 20261015 },
    );
  }, 60_000);
});

// ---- RES-6: a scheduled status holds at most MAX_STATUS_MEDIA uploads (0109_scheduled_media_cap).

const HELD_REFUSED = /media_attachments: more media than a scheduled status may hold/;
const CAP_FILE = MIGRATIONS.find((m) => m.name === "0109_scheduled_media_cap")?.sql ?? "";

// Runs `write` as a Store before 0109 could (its triggers dropped), then the file's statements, as its upgrade runs
// them: the detach of the uploads past each scheduled status's first four, and the triggers made again.
async function beforeCap(h: ApiHarness, write: (sql: SqlStorage) => void): Promise<void> {
  await runInDurableObject(h.store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TRIGGER media_attachments_scheduled_cap_insert");
    sql.exec("DROP TRIGGER media_attachments_scheduled_cap_update");
    write(sql);
    state.storage.transactionSync(() => sql.exec(CAP_FILE).toArray());
  });
}

// The upload `i` of the restored scheduled status `n`.
const heldUpload = (n: number, i: number) => String(810000000000000000n + BigInt(n * 1_000 + i));

// A scheduled status `n` of `owner`, due a minute before NOW + HOUR, as a restore before 0109 may hold it: `held`
// uploads of the owner's at positions held - 1 down to 0, so the first by position are the last written, and params
// naming the first `named` by position; after `attempts` failed publications, the next due at NOW + HOUR.
async function restoredHolding(
  h: ApiHarness,
  owner: string,
  n: number,
  held: number,
  { named = 0, attempts = 0 }: { named?: number; attempts?: number } = {},
): Promise<string> {
  const id = String(740000000000000000n + BigInt(n));
  const byPosition = Array.from({ length: held }, (_, i) => heldUpload(n, held - 1 - i));
  await beforeCap(h, (sql) => {
    sql.exec(
      `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params, attempts, next_attempt_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      owner,
      at(NOW + HOUR - MINUTE),
      JSON.stringify({
        text: `held ${n}`,
        spoiler_text: "",
        sensitive: null,
        language: null,
        visibility: null,
        in_reply_to_id: null,
        media_ids: named === 0 ? null : byPosition.slice(0, named),
      }),
      attempts,
      attempts === 0 ? null : at(NOW + HOUR),
    );
    for (let i = 0; i < held; i++) {
      sql.exec(
        `INSERT INTO media_attachments (id, account_id, scheduled_status_id, position, type, url, file_token, processed)
				VALUES (?, ?, ?, ?, 'image', 'https://kopje.test/files/h/full', ?, 1)`,
        heldUpload(n, i),
        owner,
        id,
        held - 1 - i,
        `h${n}-${i}`,
      );
    }
  });
  return id;
}

const heldBy = async (h: ApiHarness, id: string) =>
  (
    await sql<{ id: string }>(
      h.store,
      "SELECT id FROM media_attachments WHERE scheduled_status_id = ? ORDER BY position, id",
      id,
    )
  ).map((row) => row.id);

describe("a scheduled status holds at most four media (RES-6)", () => {
  // Each caller of removeScheduled, on a scheduled status holding four after the upgrade, whatever it held before it
  // (4, 40, 400) and whatever the account's other scheduled statuses hold (2, 10 and 100 holding four each): the rows
  // each reads, the detach's among them, stay the same.
  it("detaches at most four uploads on a delete, a publication and a terminal failure, however many it or others held", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const credential = { tokenHash: await sha256Hex(alice.token), scope: "write", now: NOW } as const;
    const detach = /^UPDATE media_attachments SET scheduled_status_id = NULL/;
    const recount = /^UPDATE accounts SET statuses_count = /;
    const callers = {
      delete: (id: string) => measuredStatements(h, deleteScheduled, { credential, id, now: NOW }, true),
      publication: (id: string) =>
        measuredStatements(h, publishOne, { id, now: NOW + HOUR, objectId: crypto.randomUUID() }, true),
      failure: (id: string) => measuredStatements(h, recordPublishFailure, { id, now: NOW + HOUR }, true),
    };
    const outcomes = {
      delete: { status: "ok", value: true },
      publication: { status: "published" },
      failure: { status: "dropped" },
    };
    const reads: Record<string, number[][]> = { delete: [], publication: [], failure: [] };
    // The subjects' ids lie between the others', which grow on both sides of them.
    let n = 500;
    let others = 0;
    for (const [held, grown] of [
      [MAX_STATUS_MEDIA, 1],
      [40, 5],
      [400, 50],
    ] as const) {
      for (; others < grown; others++) {
        await restoredHolding(h, alice.id, others, MAX_STATUS_MEDIA);
        await restoredHolding(h, alice.id, 999 - others, MAX_STATUS_MEDIA);
      }
      for (const [name, run] of Object.entries(callers)) {
        const id = await restoredHolding(h, alice.id, ++n, held, {
          attempts: name === "failure" ? MAX_ATTEMPTS - 1 : 0,
        });
        const kept = await heldBy(h, id);
        expect(kept, name).toEqual(Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => heldUpload(n, held - 1 - i)));
        const { output, statements } = await run(id);
        expect(output, name).toMatchObject(outcomes[name as keyof typeof outcomes]);
        // The author's statuses count is taken again over its statuses, one more for each publication of the run.
        const rows = (only?: RegExp) =>
          statements
            .filter((s) => (only === undefined ? !recount.test(s.query) : only.test(s.query)))
            .reduce((sum, s) => sum + s.rows, 0);
        reads[name]?.push([rows(detach), rows()]);
        // Its four are detached, attachable for a day from the call.
        const freed = await sql<{ scheduled_status_id: string | null; gc_at: string }>(
          h.store,
          `SELECT scheduled_status_id, gc_at FROM media_attachments WHERE id IN (${kept.map(() => "?").join(", ")})`,
          ...kept,
        );
        expect(freed, name).toEqual(
          kept.map(() => ({ scheduled_status_id: null, gc_at: at((name === "delete" ? NOW : NOW + HOUR) + DAY) })),
        );
      }
    }
    expect(await count(h, "scheduled_statuses")).toBe(2 * others);
    for (const [name, measured] of Object.entries(reads)) {
      expect(measured[0]?.[0], name).toBeGreaterThan(0);
      expect(measured, name).toEqual([measured[0], measured[0], measured[0]]);
    }
  }, 120_000);

  it("holds four through the API, and refuses a fifth, held directly or moved, but not a reorder", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = [];
    for (let i = 1; i <= MAX_STATUS_MEDIA + 1; i++) {
      media.push(await upload(h, alice, i));
    }
    const four = media.slice(0, MAX_STATUS_MEDIA);
    const fifth = media[MAX_STATUS_MEDIA]!;
    const created = await scheduled(h, alice, { status: "four", media_ids: four, scheduled_at: at(NOW + HOUR) });
    expect(created.media_attachments.map((m) => m.id)).toEqual(four);
    const other = await scheduled(h, alice, { status: "one", media_ids: [fifth], scheduled_at: at(NOW + HOUR) });
    // Moved from another scheduled status or from none, or held by a new row, a fifth is refused.
    const move = (to: string, id: string) =>
      sql(h.store, "UPDATE media_attachments SET scheduled_status_id = ?, gc_at = NULL WHERE id = ?", to, id);
    await expect(move(created.id, fifth)).rejects.toThrow(HELD_REFUSED);
    const sixth = await upload(h, alice, 6);
    await expect(move(created.id, sixth)).rejects.toThrow(HELD_REFUSED);
    await expect(
      sql(
        h.store,
        `INSERT INTO media_attachments (id, account_id, scheduled_status_id, type, url, processed)
				VALUES ('819999999999999999', ?, ?, 'image', 'https://kopje.test/files/n/full', 1)`,
        alice.id,
        created.id,
      ),
    ).rejects.toThrow(HELD_REFUSED);
    // A write that keeps each upload's scheduled status passes: a reorder that ties two positions shows them by id.
    await sql(
      h.store,
      `UPDATE media_attachments SET scheduled_status_id = scheduled_status_id, position = 3 - position / 2
				WHERE scheduled_status_id = ?`,
      created.id,
    );
    const shown = await getJson<Scheduled>(h, `/api/v1/scheduled_statuses/${created.id}`, alice.token);
    expect(shown.body.media_attachments.map((m) => m.id)).toEqual([four[2], four[3], four[0], four[1]]);
    expect(await heldBy(h, other.id)).toEqual([fifth]);
  });

  it("drops a restored row whose media_ids name an upload the upgrade detached, as for media gone", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const past = await restoredHolding(h, alice.id, 1, MAX_STATUS_MEDIA + 1, { named: MAX_STATUS_MEDIA + 1 });
    const within = await restoredHolding(h, alice.id, 2, MAX_STATUS_MEDIA, { named: MAX_STATUS_MEDIA });
    // The first by position is the last written: the upgrade detached the first written of the five.
    expect(await heldBy(h, past)).toEqual(Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => heldUpload(1, 4 - i)));
    expect(
      await sql(h.store, "SELECT scheduled_status_id FROM media_attachments WHERE id = ?", heldUpload(1, 0)),
    ).toEqual([{ scheduled_status_id: null }]);
    expect(await publishDirectly(h, past, NOW + HOUR)).toEqual({ status: "dropped", reason: "invalid" });
    expect(await heldBy(h, past)).toEqual([]);
    const published = await publishDirectly(h, within, NOW + HOUR);
    expect(published).toMatchObject({ status: "published" });
    const statusId = (published as { statusId: string }).statusId;
    const shown = await getJson<Status & { media_attachments: { id: string }[] }>(h, `/api/v1/statuses/${statusId}`);
    expect(shown.body.media_attachments.map((m) => m.id)).toEqual(
      Array.from({ length: MAX_STATUS_MEDIA }, (_, i) => heldUpload(2, MAX_STATUS_MEDIA - 1 - i)),
    );
  });
});

// ---- RES-2: params that cannot be read (0110_scheduled_params).

const PARAMS_FILE = MIGRATIONS.find((m) => m.name === "0110_scheduled_params")?.sql ?? "";
const PAST_BOUND = /scheduled_statuses: a value past its stored bound/;

// `text` as a BLOB of its UTF-8 bytes.
const blob = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

// Runs `write` as a Store before 0110 could (its triggers dropped), then the file's statements, as its upgrade runs
// them.
async function beforeParamsBound(h: ApiHarness, write: (sql: SqlStorage) => void): Promise<void> {
  await runInDurableObject(h.store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TRIGGER scheduled_statuses_params_insert");
    sql.exec("DROP TRIGGER scheduled_statuses_params_update");
    write(sql);
    state.storage.transactionSync(() => sql.exec(PARAMS_FILE).toArray());
  });
}

describe("a scheduled status whose params cannot be read (RES-2)", () => {
  // Restored before 0110: params of a JSON object followed by a NUL (json_valid stops at it) and a BLOB of one, beside
  // a readable scheduled status, each due at NOW + HOUR but the BLOB's, a day later.
  it("is left out of the list, not found when shown or updated, deleted, and dropped as params when due", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const media = await upload(h, alice, 1);
    const held = await upload(h, alice, 2);
    const readable = await scheduled(h, alice, {
      status: "readable",
      media_ids: [media],
      scheduled_at: at(NOW + HOUR),
    });
    const [nul, binary] = ["740000000000000001", "740000000000000002"];
    const params = JSON.stringify({ text: "unreadable", spoiler_text: "", media_ids: [held] });
    await beforeParamsBound(h, (sql) => {
      const insert = "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)";
      sql.exec(insert, nul, alice.id, at(NOW + HOUR - MINUTE), `${params}\0tail`);
      sql.exec(insert, binary, alice.id, at(NOW + DAY), blob(params));
      sql.exec("UPDATE media_attachments SET scheduled_status_id = ?, gc_at = NULL WHERE id = ?", nul, held);
    });
    // Both are stored as written, past the CHECK of 0011_scheduled_statuses.
    expect(
      await sql(
        h.store,
        "SELECT id, typeof(params) AS type, length(CAST(params AS BLOB)) AS bytes FROM scheduled_statuses ORDER BY id",
      ),
    ).toEqual([
      { id: readable.id, type: "text", bytes: expect.any(Number) },
      { id: nul, type: "text", bytes: utf8Length(params) + 5 },
      { id: binary, type: "blob", bytes: utf8Length(params) },
    ]);
    // The list answers the readable one whole, and nothing of the others.
    const listed = await getJson<Scheduled[]>(h, "/api/v1/scheduled_statuses", alice.token);
    expect(listed).toEqual({ status: 200, body: [readable] });
    for (const id of [nul, binary]) {
      expect((await getJson(h, `/api/v1/scheduled_statuses/${id}`, alice.token)).status, id).toBe(404);
      const moved = await send(h, alice, "PUT", `/api/v1/scheduled_statuses/${id}`, {
        scheduled_at: at(NOW + 2 * DAY),
      });
      expect(moved.status, id).toBe(404);
    }
    expect((await getJson(h, `/api/v1/scheduled_statuses/${readable.id}`, alice.token)).body).toEqual(readable);
    // The due one is dropped as params in its first run, its upload detached, and no failure is recorded; the readable
    // one is published.
    expect(await publishDirectly(h, nul, NOW + HOUR)).toEqual({ status: "dropped", reason: "params" });
    await round(h, NOW + HOUR);
    expect(await sql(h.store, "SELECT id, attempts FROM scheduled_statuses")).toEqual([{ id: binary, attempts: 0 }]);
    expect(await count(h, "statuses")).toBe(1);
    expect(await sql(h.store, "SELECT scheduled_status_id, gc_at FROM media_attachments WHERE id = ?", held)).toEqual([
      { scheduled_status_id: null, gc_at: at(NOW + HOUR + DAY) },
    ]);
    // The BLOB one is deleted as any other.
    const deleted = await send(h, alice, "DELETE", `/api/v1/scheduled_statuses/${binary}`);
    expect([deleted.status, await deleted.json()]).toEqual([200, {}]);
    expect(await count(h, "scheduled_statuses")).toBe(0);
  });

  // A repeat of the Idempotency-Key that scheduled it answers as when nothing holds the key: the key is taken from the
  // unreadable row and the post is scheduled anew.
  it("answers a repeated Idempotency-Key as if it had made nothing", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const body = { status: "once", scheduled_at: at(NOW + HOUR) };
    const first = await (await schedule(h, alice, body, { "Idempotency-Key": "k1" })).json<Scheduled>();
    expect((await (await schedule(h, alice, body, { "Idempotency-Key": "k1" })).json<Scheduled>()).id).toBe(first.id);
    await beforeParamsBound(h, (sql) => {
      sql.exec("UPDATE scheduled_statuses SET params = params || char(0) WHERE id = ?", first.id);
    });
    const again = await schedule(h, alice, body, { "Idempotency-Key": "k1" });
    expect(again.status).toBe(200);
    const made = await again.json<Scheduled>();
    expect(made.id).not.toBe(first.id);
    expect(
      await sql(h.store, "SELECT id, client_key IS NOT NULL AS keyed FROM scheduled_statuses ORDER BY id"),
    ).toEqual([
      { id: first.id, keyed: 0 },
      { id: made.id, keyed: 1 },
    ]);
  });

  // Restored before 0110: 42 scheduled statuses of alice (…001 to …042), some with unreadable params. A page reads
  // toward its limit by the ids it read (Page.cut), so its Link header, from those ids, passes over the rows it leaves
  // out, and a walk either way reaches every readable row once, as Mastodon's walk over the same rows with the
  // unreadable ones absent does.
  it("pages on past the rows it leaves out, by the ids it read", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const id = (n: number) => String(740000000000000000n + BigInt(n));
    const newestFirst = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => id(from - i));
    const restore = (unreadable: (n: number) => boolean) =>
      beforeParamsBound(h, (sql) => {
        sql.exec("DELETE FROM scheduled_statuses");
        for (let n = 1; n <= 42; n++) {
          sql.exec(
            "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)",
            id(n),
            alice.id,
            at(NOW + HOUR + n * MINUTE),
            unreadable(n) ? "{}\0" : "{}",
          );
        }
      });
    // The pages a walk from `path` reaches by its `rel` link, until one links no further.
    const follow = async (path: string, rel: "next" | "prev") => {
      const pages: string[][] = [];
      let next: string | undefined = path;
      while (next !== undefined && pages.length < 10) {
        const response = await h.request(next, bearer(alice.token));
        pages.push((await response.json<Scheduled[]>()).map((s) => s.id));
        next = new RegExp(`<https://kopje\\.test([^>]+)>; rel="${rel}"`).exec(response.headers.get("link") ?? "")?.[1];
      }
      return pages;
    };
    const base = "/api/v1/scheduled_statuses?limit=40";
    const link = (max: number, min: number) =>
      `<https://kopje.test${base}&max_id=${id(max)}>; rel="next", <https://kopje.test${base}&min_id=${id(min)}>; rel="prev"`;
    const cases: { unreadable: (n: number) => boolean; first: string[]; readable: string[] }[] = [
      // The newest unreadable: the first page shows 39 and links next from …003, the 40th id it read. Mastodon, with
      // …042 absent, shows …041 to …002 and links next from …002; either walk then reaches …001.
      { unreadable: (n) => n === 42, first: newestFirst(41, 3), readable: newestFirst(41, 1) },
      // All but the oldest unreadable: the first page is empty and still links next from …003.
      { unreadable: (n) => n >= 2, first: [], readable: [id(1)] },
      // All but the newest unreadable: a min_id page of none still links prev from the newest id it read.
      { unreadable: (n) => n <= 41, first: [id(42)], readable: [id(42)] },
    ];
    for (const { unreadable, first, readable } of cases) {
      await restore(unreadable);
      const response = await h.request(base, bearer(alice.token));
      expect((await response.json<Scheduled[]>()).map((s) => s.id)).toEqual(first);
      expect(response.headers.get("link")).toBe(link(3, 42));
      expect((await follow(base, "next")).flat()).toEqual(readable);
      expect((await follow(`${base}&min_id=0`, "prev")).toReversed().flat()).toEqual(readable);
    }
    // The min_id page of …001 to …040, all unreadable: empty, linking prev from …040 and next from …001.
    const oldest = await h.request(`${base}&min_id=0`, bearer(alice.token));
    expect(await oldest.json()).toEqual([]);
    expect(oldest.headers.get("link")).toBe(link(1, 40));
  });

  // The decision moves from JSON.parse alone to the read's SQL prefilter and storedParams. Over the values on which
  // json_valid and JSON.parse disagree, and the forms near them: storedParams after paramsReadSql is null exactly where
  // JSON.parse throws on what workerd returns (or reads no object), for every value the CHECK lets a restore store,
  // and the trigger refuses only values JSON.parse would not read.
  it("reads params as JSON.parse reads them, over the values json_valid and JSON.parse disagree on", async () => {
    const h = await community(["alice"]);
    const nested = (depth: number) => `${'{"a":'.repeat(depth - 1)}{}${"}".repeat(depth - 1)}`;
    // [label, the value as SQL, whether the CHECK of 0011 passes it, whether JSON.parse reads an object from it]
    const cases: [string, string, boolean, boolean][] = [
      ["an object", `'{"a":1}'`, true, true],
      ["NUL after the object", `CAST(X'7B7D0078' AS TEXT)`, true, false],
      ["NUL inside a string", `CAST(X'7B2261223A2200227D' AS TEXT)`, false, false],
      ["NUL alone after it", `CAST(X'7B7D00' AS TEXT)`, true, false],
      ["a BLOB object", `X'7B7D'`, true, false],
      ["depth 1,000", `'${nested(1000)}'`, true, true],
      ["depth 1,001", `'${nested(1001)}'`, false, true],
      ["raw U+0001 in a string", `CAST(X'7B2261223A2201227D' AS TEXT)`, false, false],
      ["malformed UTF-8 in a string", `CAST(X'7B2261223A22FF227D' AS TEXT)`, true, true],
      ["malformed UTF-8 in a key", `CAST(X'7B22FF223A317D' AS TEXT)`, true, true],
      ["JSON5: a bare key", `'{a:1}'`, false, false],
      ["JSON5: a trailing comma", `'{"a":1,}'`, false, false],
      ["JSON5: a single-quoted string", `'{"a":''x''}'`, false, false],
      ["JSON5: a hexadecimal number", `'{"a":0x1}'`, false, false],
      ["form feed before it", `char(12) || '{}'`, false, false],
      ["NBSP before it", `char(160) || '{}'`, false, false],
      ["whitespace JSON allows", `char(9, 10, 13, 32) || '{}' || char(32)`, true, true],
      ["an array", `'[]'`, false, false],
    ];
    // Each value as a restore before 0110 stores it (the CHECK alone), read back as the Store reads params; then, with
    // the triggers made again, whether they refuse it.
    const decided = await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TRIGGER scheduled_statuses_params_insert");
      sql.exec("DROP TRIGGER scheduled_statuses_params_update");
      const insert = (id: string, value: string) =>
        sql.exec(
          `INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params)
					VALUES (?, ?, '2026-12-01T00:00:00.000Z', ${value})`,
          id,
          h.users.alice.id,
        );
      const stored = cases.map(([label, value], i) => {
        const id = String(760000000000000000n + BigInt(i));
        const { raw } = sql.exec<{ raw: SqlStorageValue }>(`SELECT ${value} AS raw`).one();
        let checked = true;
        try {
          insert(id, value);
        } catch {
          checked = false;
        }
        const read = checked
          ? sql
              .exec<{ read: string | null }>(
                `SELECT ${paramsReadSql("ss.params")} AS read FROM scheduled_statuses ss WHERE ss.id = ?`,
                id,
              )
              .one().read
          : null;
        let parsed = false;
        try {
          const value: unknown = JSON.parse(raw as string);
          parsed = typeof value === "object" && value !== null && !Array.isArray(value);
        } catch {
          parsed = false;
        }
        return { label, value, checked, parsed, read: storedParams(read) !== null };
      });
      state.storage.transactionSync(() => sql.exec(PARAMS_FILE).toArray());
      return stored.map((entry, i) => {
        let refused = false;
        try {
          insert(String(770000000000000000n + BigInt(i)), entry.value);
        } catch (error) {
          refused = PAST_BOUND.test(String(error));
        }
        return { ...entry, refused };
      });
    });
    expect(decided.map(({ label, checked, parsed }) => [label, checked, parsed])).toEqual(
      cases.map(([label, , checked, parsed]) => [label, checked, parsed]),
    );
    for (const { label, checked, parsed, read, refused } of decided) {
      // Where a restore can store it, the read reads it exactly where JSON.parse does.
      if (checked) {
        expect(read, label).toBe(parsed);
      }
      // The trigger refuses only what JSON.parse would not read.
      if (refused) {
        expect(parsed, label).toBe(false);
      }
    }
    // The trigger refuses exactly what the read's prefilter leaves out.
    expect(decided.filter((d) => d.refused).map((d) => d.label)).toEqual([
      "NUL after the object",
      "NUL inside a string",
      "NUL alone after it",
      "a BLOB object",
    ]);
  });
});

// ---- RES-3: a scheduled status's maximum, and the list within ANSWER_BYTES.

const C = "\u0001";
// The positive double JavaScript prints in the most characters, 24 (0.00000 and 17 digits; 25 with a sign): a double
// at or past 1e21 or below 1e-6 prints in exponent form, at most 23 characters, and one between at most 21 digits.
const LONGEST_DOUBLE = 1.2345678901234567e-6;
// Stored params of MAX_PARAMS_BYTES that grow the most when presented (JSON.parse, then the answer's JSON): numbers
// that print as 21 characters from 4 ("1e20"), the most any number grows with its separator (22/5 a stored byte,
// "derives a scheduled status's maximum"). Escapes, whitespace and duplicate keys print as long or shorter, and a
// malformed byte decodes to U+FFFD (3 bytes).
const GROWING_PARAMS = (() => {
  const count = Math.floor((MAX_PARAMS_BYTES - '{"":[]}'.length + 1) / "1e20,".length);
  return `{"":[${Array.from({ length: count }, () => "1e20").join(",")}]}`;
})();
const PARAMS_JSON_MAX = Math.floor((22 * MAX_PARAMS_BYTES) / 5);

// What each column of a scheduled status presents at most: its id (18 digits, the CHECK of 0011_scheduled_statuses),
// its time (24 characters), params as above, and MAX_STATUS_MEDIA held attachments (the media read's LIMIT), each with
// an 18-digit id, the longest type, its four URLs at MEDIA_URL_JSON_BYTES (presentedMediaUrl), every number of its
// meta and focus at the longest a double prints, a description of MAX_MEDIA_DESCRIPTION_LENGTH code points escaped to
// six bytes each and a blurhash of BLURHASH_BYTES.
const SIZE_BOUND = {
  width: LONGEST_DOUBLE,
  height: LONGEST_DOUBLE,
  size: `${LONGEST_DOUBLE}x${LONGEST_DOUBLE}`,
  aspect: LONGEST_DOUBLE,
};
const MEDIA_BOUND = {
  id: "9".repeat(18),
  type: "unknown",
  url: "\\".repeat(MEDIA_URL_LIMIT),
  preview_url: "\\".repeat(MEDIA_URL_LIMIT),
  remote_url: "\\".repeat(MEDIA_URL_LIMIT),
  preview_remote_url: "\\".repeat(MEDIA_URL_LIMIT),
  text_url: null,
  meta: { original: SIZE_BOUND, small: SIZE_BOUND, focus: { x: -LONGEST_DOUBLE, y: -LONGEST_DOUBLE } },
  description: C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
  blurhash: "x".repeat(BLURHASH_BYTES),
};
const SCHEDULED_JSON_MAX =
  jsonBytes({
    id: "9".repeat(18),
    scheduled_at: "x".repeat(24),
    params: {},
    media_attachments: Array.from({ length: MAX_STATUS_MEDIA }, () => MEDIA_BOUND),
  }) -
  jsonBytes({}) +
  PARAMS_JSON_MAX;

// A scheduled status of `owner` at its caps, as a restored row may hold it: GROWING_PARAMS, and `held` media of
// `remote` (a remote account's attachment shows remote_url and preview_remote_url), the first held the last by
// position, each with URLs of MEDIA_URL_LIMIT bytes of backslashes (two JSON bytes each), a description of
// MAX_MEDIA_DESCRIPTION_LENGTH control characters, a meta and focus of the longest doubles and a 5x5 blurhash; at
// `scheduledAt`, a time a day ahead by default.
async function maximalScheduled(
  h: ApiHarness,
  owner: string,
  remote: string,
  n: number,
  held: number = MAX_STATUS_MEDIA,
  scheduledAt: string = at(NOW + DAY + n * MINUTE),
): Promise<string> {
  const id = String(750000000000000000n + BigInt(n));
  const size = { width: LONGEST_DOUBLE, height: LONGEST_DOUBLE };
  const write = (sql: SqlStorage) => {
    sql.exec(
      "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)",
      id,
      owner,
      scheduledAt,
      GROWING_PARAMS,
    );
    for (let i = 0; i < held; i++) {
      sql.exec(
        `INSERT INTO media_attachments (id, account_id, scheduled_status_id, position, type, url, preview_url,
					description, meta, focus_x, focus_y, blurhash)
				VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?)`,
        String(760000000000000000n + BigInt(n * 100 + i)),
        remote,
        id,
        held - 1 - i,
        `https://m.example/${i}/?`.padEnd(MEDIA_URL_LIMIT, "\\"),
        `https://p.example/${i}/?`.padEnd(MEDIA_URL_LIMIT, "\\"),
        C.repeat(MAX_MEDIA_DESCRIPTION_LENGTH),
        JSON.stringify({ original: size, small: size }),
        -LONGEST_DOUBLE,
        -LONGEST_DOUBLE,
        blurhashOf(5, 5, "~"),
      );
    }
  };
  // Past MAX_STATUS_MEDIA, only a restore from before 0109 holds them, and its upgrade keeps the first four.
  if (held > MAX_STATUS_MEDIA) {
    await beforeCap(h, write);
  } else {
    await runInDurableObject(h.store, (_instance, state) => write(state.storage.sql));
  }
  return id;
}

const readCredential = async (user: User) =>
  ({ tokenHash: await sha256Hex(user.token), scope: "read", now: NOW }) as const;

// Runs `operation` and counts what leaves SQLite from the statements over scheduled statuses and their media: the rows
// and the UTF-8 bytes of their values (eight per number).
async function scheduledReads<I>(h: ApiHarness, operation: StoreOperation<I, unknown>, input: I) {
  return runInDurableObject(h.store, (_instance, state) => {
    let rows = 0;
    let bytes = 0;
    const observed = observedSql(state.storage.sql, (read, query) => {
      if (/scheduled_status/.test(query)) {
        for (const row of read) {
          rows++;
          for (const value of Object.values(row)) {
            bytes += typeof value === "string" ? utf8Length(value) : 8;
          }
        }
      }
    });
    return { output: operation.run(observed, input), rows, bytes };
  });
}

describe("a scheduled status at its caps (RES-3)", () => {
  // docs/threat-model.md "Maxima of presented units", "Scheduled status, derived from its caps".
  it("derives a scheduled status's maximum from its caps, above a witness at them", async () => {
    // Every JSON number of at most 5 characters prints in at most 22/5 of its length with a separator, 1e20 at it; a
    // longer one prints in at most 25 (LONGEST_DOUBLE), under 22/5 of 7.
    const characters = "0123456789-.eE+";
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
    let tokens = [""];
    let most = 0;
    for (let length = 1; length <= 5; length++) {
      tokens = tokens.flatMap((token) => [...characters].map((c) => token + c));
      for (const token of tokens.filter((t) => number.test(t))) {
        const printed = String(Number(token)).length;
        expect(5 * (printed + 1), token).toBeLessThanOrEqual(22 * (length + 1));
        most = Math.max(most, (printed + 1) / (length + 1));
      }
    }
    expect([most, String(1e20).length]).toEqual([22 / 5, 21]);
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (d) => String(d).length <= 25));
    expect([String(LONGEST_DOUBLE).length, String(-LONGEST_DOUBLE).length]).toEqual([24, 25]);
    expect([jsonBytes(MEDIA_BOUND.url), jsonBytes(MEDIA_BOUND.description)]).toEqual([MEDIA_URL_JSON_BYTES, 60_002]);

    const h = await community(["alice"]);
    const { alice } = h.users;
    const id = await maximalScheduled(h, alice.id, await remoteAccount(h.store, "far"), 0);
    const { output, rows } = await scheduledReads(h, getScheduled, { credential: await readCredential(alice), id });
    const shown = (output as { status: string; value: ScheduledStatus }).value;
    // The bound has the presenter's keys, and the witness's columns are at the bound's, its URLs within their scheme,
    // host and path ("https://m.example/0/?", 21 bytes).
    const [media] = shown.media_attachments;
    expect(Object.keys(media ?? {})).toEqual(Object.keys(MEDIA_BOUND));
    expect(Object.keys(media?.meta ?? {})).toEqual(Object.keys(MEDIA_BOUND.meta));
    expect(Object.keys(media?.meta?.original ?? {})).toEqual(Object.keys(SIZE_BOUND));
    expect(
      shown.media_attachments.map((m) => [
        ...[m.url, m.preview_url, m.remote_url, m.preview_remote_url].map(jsonBytes),
        jsonBytes(m.description),
        jsonBytes(m.blurhash),
      ]),
    ).toEqual(
      Array.from({ length: MAX_STATUS_MEDIA }, () => [
        ...Array.from({ length: 4 }, () => MEDIA_URL_JSON_BYTES - 21),
        60_002,
        BLURHASH_BYTES + 2,
      ]),
    );
    expect(utf8Length(GROWING_PARAMS)).toBeLessThanOrEqual(MAX_PARAMS_BYTES);
    // Within the bound but for the 7 stored bytes that are no number (the object, its key, the array and one spare
    // byte), which the bound counts at 22/5 too: 24 bytes.
    expect(PARAMS_JSON_MAX - jsonBytes(shown.params)).toBe(24);
    expect({ params: jsonBytes(shown.params), witness: jsonBytes(shown), rows, derived: SCHEDULED_JSON_MAX }).toEqual({
      params: 576_692,
      witness: 884_345,
      rows: 1 + MAX_STATUS_MEDIA,
      derived: 884_889,
    });
    expect(SCHEDULED_JSON_MAX).toBeLessThanOrEqual(0.85 * ANSWER_BYTES);
  });

  // An imported scheduled_at that is no time passes the CHECK of 0011_scheduled_statuses: strftime cannot read it (the
  // CHECK is then NULL), and length() stops at its NUL, so it may hold any bytes. It is judged by its bytes in SQL and
  // shown as null, so the scheduled status stays within the derived maximum, listed or shown; an update must then send
  // a time, as one whose time is unreadable.
  it("shows no time for an imported scheduled_at that is no time, within the derived maximum", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const remote = await remoteAccount(h.store, "far");
    const notTime = "x".repeat(24) + "\0" + C.repeat(1_500_000);
    const id = await maximalScheduled(h, alice.id, remote, 0, MAX_STATUS_MEDIA, notTime);
    const timed = await maximalScheduled(h, alice.id, remote, 1);
    expect(
      await sql(
        h.store,
        "SELECT length(scheduled_at) AS n, octet_length(scheduled_at) AS bytes FROM scheduled_statuses ORDER BY id",
      ),
    ).toEqual([
      { n: 24, bytes: 1_500_025 },
      { n: 24, bytes: 24 },
    ]);
    const credential = await readCredential(alice);
    const one = await scheduledReads(h, getScheduled, { credential, id });
    const shown = (one.output as { status: string; value: ScheduledStatus }).value;
    expect(shown.scheduled_at).toBeNull();
    expect(jsonBytes(shown)).toBeLessThanOrEqual(SCHEDULED_JSON_MAX);
    // None of its bytes leaves SQLite: the row reads as one at a time does, its 24 bytes a NULL (counted 8).
    const other = await scheduledReads(h, getScheduled, { credential, id: timed });
    expect(one.bytes).toBe(other.bytes - 24 + 8);
    const listed = await h.request("/api/v1/scheduled_statuses", bearer(alice.token));
    const body = await listed.text();
    expect(listed.status).toBe(200);
    expect(utf8Length(body)).toBeLessThanOrEqual(2 * SCHEDULED_JSON_MAX + 3);
    expect((JSON.parse(body) as Scheduled[]).map((s) => [s.id, s.scheduled_at])).toEqual([
      [timed, at(NOW + DAY + MINUTE)],
      [id, null],
    ]);
    const path = `/api/v1/scheduled_statuses/${id}`;
    expect((await getJson<Scheduled>(h, path, alice.token)).body.scheduled_at).toBeNull();
    expect(await refusal(await send(h, alice, "PUT", path))).toEqual({
      status: 422,
      body: { error: "Record invalid" },
    });
    const moved = await send(h, alice, "PUT", path, { scheduled_at: at(NOW + 2 * HOUR) });
    expect([moved.status, (await moved.json<Scheduled>()).scheduled_at]).toEqual([200, at(NOW + 2 * HOUR)]);
  }, 120_000);

  // A restored row that held more keeps its first MAX_STATUS_MEDIA by (position, id) through the upgrade of
  // 0109_scheduled_media_cap, and the media read takes them through media_attachments_scheduled: it reads no more.
  it("shows the first 4 held media by position, reading as many entries however many it held", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const remote = await remoteAccount(h.store, "far");
    const credential = await readCredential(alice);
    const media = /FROM media_attachments m WHERE m\.scheduled_status_id/;
    const reads: number[] = [];
    for (const [n, held] of [MAX_STATUS_MEDIA, 10, 40].entries()) {
      const id = await maximalScheduled(h, alice.id, remote, n, held);
      const { output, statements } = await measuredStatements(h, getScheduled, { credential, id });
      const shown = (output as { status: string; value: ScheduledStatus }).value;
      // Inserted with positions held - 1 down to 0: the last inserted come first.
      expect(shown.media_attachments.map((m) => m.id)).toEqual(
        Array.from({ length: MAX_STATUS_MEDIA }, (_, i) =>
          String(760000000000000000n + BigInt(n * 100 + held - 1 - i)),
        ),
      );
      reads.push(statements.filter((s) => media.test(s.query)).reduce((sum, s) => sum + s.rows, 0));
    }
    expect(reads[0]).toBeGreaterThan(0);
    expect(reads).toEqual([reads[0], reads[0], reads[0]]);
  });
});

describe("the scheduled statuses list within ANSWER_BYTES (RES-3)", () => {
  async function walk(h: ApiHarness, user: User, first: string, rel: "next" | "prev") {
    const pages: string[][] = [];
    let path: string | undefined = first;
    while (path !== undefined) {
      const response = await h.request(path, bearer(user.token));
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(utf8Length(body)).toBeLessThanOrEqual(ANSWER_BYTES);
      const items = (JSON.parse(body) as Scheduled[]).map((s) => s.id);
      if (items.length === 0) {
        break;
      }
      pages.push(items);
      const link = new RegExp(`<https://kopje\\.test([^>]+)>; rel="${rel}"`).exec(response.headers.get("link") ?? "");
      path = link?.[1];
    }
    return pages;
  }

  it("admits whole scheduled statuses at their caps, the first always, a cut page linking on from its last", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const remote = await remoteAccount(h.store, "far");
    const made: string[] = [];
    for (let n = 0; n < SCHEDULED_PAGE.max; n++) {
      made.push(await maximalScheduled(h, alice.id, remote, n));
    }
    const newest = made.toReversed();
    const older = await walk(h, alice, `/api/v1/scheduled_statuses?limit=${SCHEDULED_PAGE.max}`, "next");
    expect(older.flat()).toEqual(newest);
    expect(older.length).toBeGreaterThan(1);
    // Each cut page links next from its last scheduled status (the walk follows those links).
    const response = await h.request(`/api/v1/scheduled_statuses?limit=${SCHEDULED_PAGE.max}`, bearer(alice.token));
    const first = (await response.json<Scheduled[]>()).map((s) => s.id);
    expect(first).toEqual(older[0]);
    expect(response.headers.get("link")).toContain(`max_id=${first.at(-1)}>; rel="next"`);
    // min_id pages from the oldest: each cut page links prev from its newest, and the walk reaches every one once.
    const newer = await walk(h, alice, `/api/v1/scheduled_statuses?limit=${SCHEDULED_PAGE.max}&min_id=0`, "prev");
    expect(newer.length).toBeGreaterThan(1);
    expect(newer.toReversed().flat()).toEqual(newest);
    // A page of small scheduled statuses is not cut.
    for (let i = 0; i < SCHEDULED_PAGE.max; i++) {
      await sql(
        h.store,
        "INSERT INTO scheduled_statuses (id, account_id, scheduled_at, params) VALUES (?, ?, ?, ?)",
        String(770000000000000000n + BigInt(i)),
        bob.id,
        at(NOW + DAY + i * MINUTE),
        JSON.stringify({ text: `s${i}`, spoiler_text: "", media_ids: null }),
      );
    }
    expect(await ids(h, `/api/v1/scheduled_statuses?limit=${SCHEDULED_PAGE.max}`, bob.token)).toHaveLength(
      SCHEDULED_PAGE.max,
    );
  }, 120_000);

  // The page reads ids only; past the budget it reads and presents the one scheduled status left out.
  it("reads one scheduled status past the budget", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const remote = await remoteAccount(h.store, "far");
    const made: string[] = [];
    for (let n = 0; n < SCHEDULED_PAGE.max; n++) {
      made.push(await maximalScheduled(h, alice.id, remote, n));
    }
    const credential = await readCredential(alice);
    const one = await scheduledReads(h, getScheduled, { credential, id: made[0] ?? "" });
    const page = { limit: SCHEDULED_PAGE.max };
    const listed = await scheduledReads(h, listScheduled, { credential, page });
    const shown = (listed.output as { status: string; value: { items: ScheduledStatus[]; cut?: boolean } }).value;
    expect(shown.cut).toBe(true);
    const admitted = shown.items.length;
    expect({ rows: listed.rows, bytes: listed.bytes }).toEqual({
      rows: SCHEDULED_PAGE.max + (admitted + 1) * one.rows,
      bytes: SCHEDULED_PAGE.max * 18 + (admitted + 1) * one.bytes,
    });
  }, 120_000);
});

describe("parseScheduledAt", () => {
  it("reads ISO 8601 times as Mastodon does, UTC when no offset is given", () => {
    expect(parseScheduledAt("2026-10-20T10:00:00Z")).toBe("2026-10-20T10:00:00.000Z");
    expect(parseScheduledAt("2026-10-20T10:00:00.123456+09:00")).toBe("2026-10-20T01:00:00.123Z");
    expect(parseScheduledAt("2026-10-20 10:00+0900")).toBe("2026-10-20T01:00:00.000Z");
    expect(parseScheduledAt("2026-10-20T10:00")).toBe("2026-10-20T10:00:00.000Z");
    expect(parseScheduledAt("2026-10-20")).toBe("2026-10-20T00:00:00.000Z");
    expect(parseScheduledAt("2028-02-29T10:00:00Z")).toBe("2028-02-29T10:00:00.000Z");
    expect(parseScheduledAt("2026-10-20T24:00:00+09:00")).toBe("2026-10-20T15:00:00.000Z");
    expect(parseScheduledAt("2026-10-20T10:00:60Z")).toBe("2026-10-20T10:00:59.000Z");
    for (const invalid of [
      "tomorrow",
      "2026-13-01T00:00:00Z",
      "2026-10-20T25:00:00Z",
      "2027-02-29T10:00:00Z",
      "2100-02-29T10:00:00Z",
      "2026-11-31T10:00:00Z",
      "2026-04-31",
      "2026-10-20T24:00:01Z",
      "2026-10-20T10:60:00Z",
      "2026-10-20T10:00:61Z",
      "x".repeat(100),
      "",
    ]) {
      expect(parseScheduledAt(invalid), invalid).toBeNull();
    }
  });
});
