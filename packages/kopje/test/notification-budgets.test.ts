import { describe, expect, it } from "vitest";

import { ANSWER_BYTES } from "../src/domain/answer-budget";
import { type ApiHarness, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { answer, bigStatus, expectByteCutFirstPage, expectByteCutWalk, fallbackReports, walk } from "./budget-helpers";
import { community, mute, remoteAccount, seedStatus } from "./status-helpers";

// RES-3: the notification lists and the notification requests are id-cursor answers within ANSWER_BYTES: each
// notification or request is admitted whole, with its account and status, in traversal order, and a page cut by bytes
// continues from its last admitted item in both directions, before a candidate window's continuation too.

const run = (kind: "V" | "M", n: number) => Array.from({ length: n }, () => kind);
// A page of 10 reads a window of 40 candidates: from either end, 10 shown and 30 hidden, so the window is cut
// after the ten shown, which the budget cuts first (nine statuses of about 0.97 MB pass it).
const KINDS = [...run("V", 10), ...run("M", 35), ...run("V", 10), ...run("M", 10)].toReversed();

async function notification(h: ApiHarness, recipient: string, type: string, from: string, status: string | null) {
  const [row] = await sql<{ id: string }>(
    h.store,
    `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at)
		VALUES (?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
    recipient,
    type,
    from,
    status,
    new Date(NOW).toISOString(),
  );
  return row!.id;
}

describe("notification lists within ANSWER_BYTES (RES-3)", () => {
  it("walk every notification once in both directions, each cut by bytes, before a window continuation too", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const author = await remoteAccount(h.store, "big");
    const muted = await remoteAccount(h.store, "muted");
    await mute(h.store, alice.id, muted);
    const shown: string[] = [];
    for (const [i, kind] of KINDS.entries()) {
      if (kind === "V") {
        const status = await bigStatus(h, author, NOW - (KINDS.length - i) * 60_000);
        shown.push(await notification(h, alice.id, "mention", author, status));
      } else {
        const status = await seedStatus(h.store, { accountId: muted, visibility: "public" });
        await notification(h, alice.id, "mention", muted, status);
      }
    }
    const V = shown.toReversed();
    const size = (await answer<unknown>(h, `/api/v1/notifications/${V[0]!}`, alice.token)).bytes;
    const path = "/api/v1/notifications?limit=10";
    const older = await walk(h, path, "next", alice.token);
    expectByteCutWalk("notifications", older, V, "next", size);
    const newer = await walk(h, `${path}&min_id=0`, "prev", alice.token);
    expectByteCutWalk("notifications", newer, V.toReversed(), "prev", size);
    // The first pages from either end: shown notifications in a window cut at hidden ones, cut by bytes before
    // them, so the link continues from the last one shown.
    for (const [walked, rel] of [
      [older, "next"],
      [newer, "prev"],
    ] as const) {
      const first = walked.pages[0]!;
      expect(first.shown.length).toBeLessThan(10);
      expect(first.cursor).toBe(rel === "next" ? first.shown.at(-1) : first.shown[0]);
    }
    // since_id: a cut first page is a prefix of the uncut answer, its link in Mastodon's form.
    await expectByteCutFirstPage(h, "since", `${path}&since_id=${V[19]!}`, "next", alice.token, V.slice(0, 19), size);
    // The unread count and the marker do not change with admission.
    const unread = await answer<{ count: number }>(h, "/api/v1/notifications/unread_count", alice.token);
    expect(unread.body.count).toBe(20);
  }, 300_000);
});

describe("notification fallbacks within ANSWER_BYTES (RES-3)", () => {
  it("admits each notification with its fallback: a page that fits without them is cut with them", async () => {
    const h = await community(["owner", "alice"]);
    const { owner, alice } = h.users;
    const reports = 56;
    await fallbackReports(h, { id: owner.id, email: "owner@example.com" }, alice.id, reports);
    const author = await remoteAccount(h.store, "big");
    const half = (i: number) => bigStatus(h, author, NOW - 60_000 * (100 - i), {}, 2);
    const first = await notification(h, owner.id, "mention", author, await half(0));
    const bytes = async (path: string) => (await answer<unknown>(h, path, owner.token)).bytes;
    const big = await bytes(`/api/v1/notifications/${first}`);
    const [report] = (
      await answer<{ id: string }[]>(h, "/api/v1/notifications?types[]=admin.report&limit=1", owner.token)
    ).body;
    const plain = await bytes(`/api/v1/notifications/${report!.id}`);
    const shown = await bytes(`/api/v1/notifications/${report!.id}?supported_types[]=mention`);
    // A page of `k` mentions above the reports, as an array (the oldest ids are shorter by a digit or more).
    const page = (k: number, item: number) => 1 + k * (big + 1) + reports * (item + 1);
    const k = Array.from({ length: 80 - reports }, (_, i) => i + 1).find(
      (n) => page(n, plain) <= ANSWER_BYTES && page(n, shown) > ANSWER_BYTES,
    );
    expect(k).toBeDefined();
    for (let i = 1; i < k!; i++) {
      await notification(h, owner.id, "mention", author, await half(i));
    }
    const path = `/api/v1/notifications?limit=${k! + reports}`;
    const whole = await answer<{ id: string }[]>(h, path, owner.token);
    expect(whole.body.length).toBe(k! + reports);
    expect(whole.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    const cut = await answer<{ id: string; type: string; fallback?: unknown }[]>(
      h,
      `${path}&supported_types[]=mention`,
      owner.token,
    );
    expect(cut.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    expect(cut.body.length).toBeLessThan(k! + reports);
    expect(cut.bytes + shown + 1).toBeGreaterThan(ANSWER_BYTES);
    expect(cut.body.filter((n) => n.type === "admin.report").every((n) => n.fallback !== undefined)).toBe(true);
    expect(new URL(cut.next!, "https://kopje.test").searchParams.get("max_id")).toBe(cut.body.at(-1)!.id);
  }, 300_000);
});

describe("notification requests within ANSWER_BYTES (RES-3)", () => {
  it("walk every request once in both directions, each cut by bytes, before a window continuation too", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const shown: string[] = [];
    for (const [i, kind] of KINDS.entries()) {
      const sender = await remoteAccount(h.store, `sender${i}`);
      const status = kind === "V" ? await bigStatus(h, sender, NOW - (KINDS.length - i) * 60_000) : null;
      if (kind === "M") {
        // An unavailable sender's request is not listed.
        await sql(h.store, "UPDATE accounts SET deleted_at = ? WHERE id = ?", new Date(NOW).toISOString(), sender);
      }
      const [row] = await sql<{ id: string }>(
        h.store,
        `INSERT INTO notification_requests (account_id, from_account_id, last_status_id, notifications_count,
					created_at, updated_at)
				VALUES (?, ?, ?, 1, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
        alice.id,
        sender,
        status,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      );
      if (kind === "V") {
        shown.push(row!.id);
      }
    }
    const V = shown.toReversed();
    const one = await answer<{ last_status: unknown }>(h, `/api/v1/notifications/requests/${V[0]!}`, alice.token);
    expect(one.body.last_status).not.toBeNull();
    const path = "/api/v1/notifications/requests?limit=10";
    const older = await walk(h, path, "next", alice.token);
    expectByteCutWalk("requests", older, V, "next", one.bytes);
    const newer = await walk(h, `${path}&min_id=0`, "prev", alice.token);
    expectByteCutWalk("requests", newer, V.toReversed(), "prev", one.bytes);
    expect(older.pages[0]!.shown.length).toBeLessThan(10);
    expect(newer.pages[0]!.shown.length).toBeLessThan(10);
    for (const page of [...older.pages, ...newer.pages]) {
      expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    }
  }, 300_000);
});
