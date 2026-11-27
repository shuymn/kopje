import { expect } from "vitest";

import type { UserCredential } from "../src/domain/auth";
import type { MentionGate, MentionStart, ResolvedAddress } from "../src/domain/mention-addresses";
import { type FetchBudget, mentionBudget } from "../src/federation/loader";
import { createAddressResolver } from "../src/federation/resolve";
import type { StoreStub } from "../src/platform/store-client";
import type { KeyGen } from "../src/security/key-wrap";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { countingStore, harness, NOW, seedInstanceKey } from "./app-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { mastodonActor, type RemoteWeb, serveWebFinger, type TestActor } from "./inbox-helpers";
import { setup, type Setup } from "./inbox-status-helpers";

// The world of the mention resolution tests (#1558, domain/mention-addresses.ts): alice and dave of kopje.test, an
// in-memory web of remote servers, and the app over a Store whose calls are recorded (countingStore), each DNS check
// recorded and refused for the hosts in `refusedHosts` (NET-1). The instance key is stored unless `cold`.

// A Store wrapped by a test (a call held or made to fail).
export type StoreWrap = (store: StoreStub) => StoreStub;

export type MentionWorldOptions = {
  clock?: { now: number };
  cold?: boolean;
  keygen?: KeyGen;
  timeoutMs?: number;
  // Runs once the named Store call has answered (countingStore's `answered`).
  answered?: (name: string) => void;
  // Wraps the counted Store (a call held or made to fail).
  wrap?: StoreWrap;
};

export async function mentionWorld(options: MentionWorldOptions = {}) {
  const clock = options.clock ?? { now: NOW };
  const t = await setup(clock);
  if (options.cold !== true) {
    await seedInstanceKey(t.store);
  }
  const counting = countingStore(t.store, options.answered);
  const dns: string[] = [];
  const refusedHosts = new Set<string>();
  const loader = {
    fetch: t.web.fetch,
    checkHost: (url: URL) => {
      dns.push(url.hostname);
      return refusedHosts.has(url.hostname)
        ? Promise.reject(new Error("Invalid or private address: 10.0.0.1"))
        : Promise.resolve();
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const stub = options.wrap === undefined ? counting.stub : options.wrap(counting.stub);
  const h = harness(stub, {}, BUILD, { keygen: options.keygen ?? fixtureKeyGen, loader }, () => clock.now);
  const send = (method: string, path: string, body: unknown, token: string, headers: Record<string, string> = {}) =>
    h.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}, token = t.tokens.alice) =>
    send("POST", "/api/v1/statuses", body, token, headers);
  const edit = (id: string, body: Record<string, unknown>, token = t.tokens.alice) =>
    send("PUT", `/api/v1/statuses/${id}`, body, token);
  // The request's own calls: the day's activity stamp is a session write made after the answer (mastodon/activity.ts).
  const calls = () => counting.calls.filter((name) => name !== "noteActivity");
  // The answers of the gate calls, and the `resolved` each write was given.
  const gates = () =>
    counting.records
      .filter((r) => r.name === "postMentionGate" || r.name === "editMentionGate")
      .map((r) => r.answer as MentionGate | undefined);
  const resolvedSent = () =>
    counting.records
      .filter((r) => r.name === "postStatus" || r.name === "editStatus")
      .map((r) => ((r.args[1] as { resolved?: ResolvedAddress[] }).resolved ?? []).map((a) => a.key));
  const reset = () => {
    counting.calls.length = 0;
    counting.records.length = 0;
    dns.length = 0;
    t.web.fetched.length = 0;
    t.web.signers.length = 0;
  };
  const credential = async (token = t.tokens.alice): Promise<UserCredential> => ({
    tokenHash: await sha256Hex(token),
    scope: "write:statuses",
    now: clock.now,
  });
  // The post gate's answer, by the Store operation itself.
  const postGate = async (text: string, extra: Record<string, unknown> = {}) =>
    t.store.postMentionGate(BUILD, {
      credential: await credential(),
      now: clock.now,
      text,
      spoilerText: "",
      mediaIds: [],
      ...extra,
    });
  // A resolver of its own over the counted Store and this world's loader, its budget at its start `budget` (by default
  // mentionBudget's), the budget it made kept in `made`.
  const made: FetchBudget[] = [];
  const resolver = (budget: (now: number) => FetchBudget = mentionBudget) =>
    createAddressResolver({
      build: () => BUILD,
      store: () => stub,
      now: () => clock.now,
      keygen: options.keygen ?? fixtureKeyGen,
      loader,
      budget: (now) => {
        const value = budget(now);
        made.push(value);
        return value;
      },
    });
  // The start the post gate answers for `text`, which must be one.
  const start = async (text: string): Promise<MentionStart> => {
    const answer = await postGate(text);
    if (answer.status !== "ok" || answer.value.kind !== "prepared") {
      throw new Error(`no resolution for ${text}: ${JSON.stringify(answer)}`);
    }
    return answer.value;
  };
  return {
    t,
    clock,
    counting,
    calls,
    gates,
    resolvedSent,
    dns,
    refusedHosts,
    post,
    edit,
    reset,
    h,
    credential,
    postGate,
    resolver,
    made,
    start,
  };
}

export type MentionWorld = Awaited<ReturnType<typeof mentionWorld>>;

export const webfinger = (username: string, host: string) =>
  `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${host}`)}`;

// A Mastodon account `username` of `host`, its WebFinger confirming username@host: the plain path.
export function plainActor(web: RemoteWeb, username: string, host = "mastodon.example"): Promise<TestActor> {
  return mastodonActor(web, username, { origin: `https://${host}` });
}

// ali lives on social.example and declares ali@nice.example, which nice.example confirms (the split-domain fixture of
// test/inbox-canonical-address.test.ts).
export async function splitDomain(web: RemoteWeb, username = "ali"): Promise<TestActor> {
  const actor = await mastodonActor(web, username, { origin: "https://social.example", key: 3 });
  serveWebFinger(web, `acct:${username}@social.example`, `acct:${username}@nice.example`, actor.uri);
  serveWebFinger(web, `acct:${username}@nice.example`, `acct:${username}@nice.example`, actor.uri);
  return actor;
}

// The stored account of an address, or undefined.
export async function accountAt(store: StoreStub, username: string, domain: string) {
  const [row] = await sql<{ id: string; uri: string; username: string }>(
    store,
    "SELECT id, uri, username FROM accounts WHERE domain = ? AND lower(username) = lower(?)",
    domain,
    username,
  );
  return row;
}

export async function accountCount(store: StoreStub, uri: string): Promise<number> {
  const [row] = await sql<{ n: number }>(store, "SELECT count(*) AS n FROM accounts WHERE uri = ?", uri);
  return row?.n ?? 0;
}

// The inboxes outbound activities were written to: their targets, expanded or not.
export async function inboxes(store: StoreStub): Promise<string[]> {
  return (
    await sql<{ inbox: string }>(
      store,
      `SELECT json_extract(t.value, '$.inbox') AS inbox FROM outbound_targets o, json_each(o.targets) t
			UNION SELECT inbox_url FROM deliveries ORDER BY 1`,
    )
  ).map((row) => row.inbox);
}

export type PostedStatus = {
  id: string;
  content: string;
  mentions: { id: string; acct: string }[];
  visibility: string;
};

// A post's answer, expected 200.
export async function posted(response: Promise<Response> | Response): Promise<PostedStatus> {
  const answered = await response;
  expect(answered.status).toBe(200);
  return answered.json<PostedStatus>();
}

export const mentionLink = (url: string, username: string) =>
  `<span class="h-card"><a href="${url}" class="u-url mention">@<span>${username}</span></a></span>`;

export type { Setup };
