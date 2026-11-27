import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedAddress } from "../src/domain/mention-addresses";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { blockDomain } from "./domain-block-helpers";
import { fixtureKeyGen } from "./federation-helpers";
import { BUILD } from "./helpers";
import { mastodonActor } from "./inbox-helpers";
import { ALICE } from "./inbox-status-helpers";
import {
  accountAt,
  accountCount,
  mentionWorld,
  type MentionWorld,
  type StoreWrap,
  plainActor,
  posted,
  webfinger,
} from "./mention-helpers";
import { block } from "./status-helpers";

// Races of a post's mention resolution (#1558), each actor held at an explicit await on the production path (a
// remote response, a Store call) while the other commits (docs/engineering.md, "Tests"): what the write judges again
// (R17, ID-1, the address's holder, the credential, the key), and what each address of one resolution owns or shares
// (its verdict, VIS-30; the signer; its Store refusals).

const MINUTE = 60_000;
const holds: { release: () => void }[] = [];
afterEach(() => {
  for (const held of holds.splice(0)) {
    held.release();
  }
});
function hold(w: MentionWorld, url: string, options: { snapshot?: boolean } = {}) {
  const held = w.t.web.hold(url, options);
  holds.push(held);
  return held;
}

const search = (w: MentionWorld, address: string) =>
  w.t.api(`/api/v2/search?resolve=true&type=accounts&q=${encodeURIComponent(address)}`);

// The world with the named Store call held at its start until released: `reached` once it is called, with its input.
function holding(name: string) {
  let reached!: (input: unknown) => void;
  let release!: () => void;
  const arrived = new Promise<unknown>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const wrap: StoreWrap = (store) =>
    new Proxy(store, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (property !== name || held || typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]) => {
          held = true;
          reached(args[1]);
          await gate;
          return (value as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      },
    });
  holds.push({ release: () => release() });
  return { wrap, reached: arrived, release: () => release() };
}

describe("what the write judges again", () => {
  it("does not mention an account the author blocks, or whose domain it blocks, while its fetch is held (R1)", async () => {
    for (const blocks of ["account", "domain"] as const) {
      const w = await mentionWorld();
      const bob = await plainActor(w.t.web, "bob");
      const held = hold(w, bob.uri);
      const response = w.post({ status: "@bob@mastodon.example" });
      await held.reached;
      if (blocks === "account") {
        // Stored by a search meanwhile, then blocked.
        expect((await search(w, "bob@mastodon.example")).status).toBe(200);
        await block(w.t.store, ALICE, (await accountAt(w.t.store, "bob", "mastodon.example"))!.id);
      } else {
        await sql(w.t.store, "INSERT INTO domain_blocks (account_id, domain) VALUES (?, 'mastodon.example')", ALICE);
      }
      held.release();
      const status = await posted(response);
      expect(status.mentions, blocks).toEqual([]);
      // The guarded branch ran: the account was resolved and handed to the write.
      expect(w.resolvedSent(), blocks).toEqual([["bob@mastodon.example"]]);
    }
  });

  it("stores the actor only under the revision read before its fetch (R2, ID-1)", async () => {
    const w = await mentionWorld();
    const bob = await plainActor(w.t.web, "bob");
    const held = hold(w, bob.uri, { snapshot: true });
    const response = w.post({ status: "@bob@mastodon.example" });
    await held.reached;
    // The actor moves its inbox and key, and a search stores the new document.
    const moved = await mastodonActor(w.t.web, "bob", {
      key: 1,
      extra: { inbox: "https://mastodon.example/moved/inbox" },
    });
    expect((await search(w, "bob@mastodon.example")).status).toBe(200);
    held.release();
    const status = await posted(response);
    expect(status.mentions.map((m) => m.acct)).toEqual(["bob@mastodon.example"]);
    expect(await sql(w.t.store, "SELECT inbox_url FROM accounts WHERE uri = ?", bob.uri)).toEqual([
      { inbox_url: "https://mastodon.example/moved/inbox" },
    ]);
    const keys = await sql<{ pem: string }>(
      w.t.store,
      "SELECT k.pem FROM remote_keys k JOIN accounts a ON a.id = k.account_id WHERE a.uri = ?",
      bob.uri,
    );
    expect(keys.map((k) => k.pem)).toEqual([moved.pem]);
  });

  it("mentions the account that took the address before the write, never invalidating it (R3)", async () => {
    for (const taken of [true, false]) {
      const write = holding("postStatus");
      const w = await mentionWorld({ wrap: write.wrap });
      const a = await plainActor(w.t.web, "bob", "peer.example");
      const response = w.post({ status: "@bob@peer.example" });
      const input = (await write.reached) as { resolved: ResolvedAddress[] };
      expect(input.resolved.map((r) => r.actor.uri)).toEqual([a.uri]);
      let b: string | undefined;
      if (taken) {
        // B now holds bob@peer.example, as its WebFinger confirms, stored by a search.
        b = (
          await mastodonActor(w.t.web, "bob", { origin: "https://peer.example", uri: "https://peer.example/users/b" })
        ).uri;
        expect((await search(w, "bob@peer.example")).status).toBe(200);
      }
      write.release();
      const status = await posted(response);
      const holder = await accountAt(w.t.store, "bob", "peer.example");
      expect(holder?.uri).toBe(taken ? b : a.uri);
      expect(status.mentions.map((m) => m.id)).toEqual([holder!.id]);
      expect(await accountCount(w.t.store, a.uri)).toBe(taken ? 0 : 1);
    }
  });

  it("answers 401 for a token that expired while the WebFinger was awaited, and stamps the later time (R5)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    await sql(
      w.t.store,
      "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes, expires_at) VALUES (?, 'access', 'test', ?, 'read write follow', ?)",
      await sha256Hex("short"),
      ALICE,
      new Date(NOW + MINUTE).toISOString(),
    );
    for (const token of ["short", w.t.tokens.alice]) {
      w.clock.now = NOW;
      const held = hold(w, webfinger("bob", "mastodon.example"));
      const response = w.post({ status: "@bob@mastodon.example" }, {}, token);
      await held.reached;
      w.clock.now = NOW + 2 * MINUTE;
      held.release();
      const answer = await response;
      if (token === "short") {
        expect(answer.status).toBe(401);
      } else {
        expect(answer.status).toBe(200);
        expect((await answer.json<{ created_at: string }>()).created_at).toBe(new Date(NOW + 2 * MINUTE).toISOString());
      }
    }
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 1 }]);
  });

  it("answers the status a key repeat committed while the WebFinger was awaited (R6)", async () => {
    const w = await mentionWorld();
    await plainActor(w.t.web, "bob");
    const held = hold(w, webfinger("bob", "mastodon.example"));
    const response = w.post({ status: "@bob@mastodon.example" }, { "idempotency-key": "k" });
    await held.reached;
    const repeat = await posted(w.post({ status: "plain" }, { "idempotency-key": "k" }));
    held.release();
    expect((await posted(response)).id).toBe(repeat.id);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM statuses")).toEqual([{ n: 1 }]);
  });
});

describe("what the addresses of one resolution own and share", () => {
  it("spends the gate's verdict on the first request only (R4, VIS-30)", async () => {
    for (const blocked of [true, false]) {
      const w = await mentionWorld();
      const bob = await plainActor(w.t.web, "bob");
      await plainActor(w.t.web, "carol");
      const held = hold(w, bob.uri);
      const response = w.post({ status: "@bob@mastodon.example @carol@mastodon.example" });
      await held.reached;
      if (blocked) {
        await blockDomain(w.t.store, "mastodon.example");
      }
      held.release();
      expect((await response).status).toBe(200);
      expect(w.t.web.fetched.includes(webfinger("carol", "mastodon.example")), `${blocked}`).toBe(!blocked);
    }
  });

  it("prepares the shared signer again after a failure: the second address signs (R7)", async () => {
    let calls = 0;
    const keygen = () => (++calls === 1 ? Promise.reject(new Error("keygen failed")) : fixtureKeyGen());
    const w = await mentionWorld({ cold: true, keygen });
    await plainActor(w.t.web, "bob");
    await plainActor(w.t.web, "carol", "other.example");
    const status = await posted(w.post({ status: "@bob@mastodon.example @carol@other.example" }));
    expect(status.mentions.map((m) => m.acct)).toEqual(["carol@other.example"]);
    expect(calls).toBe(2);
  });

  it("records a late Store refusal against the address that met it: the second address is kept (R8)", async () => {
    let reject!: (error: unknown) => void;
    let first = true;
    const wrap: StoreWrap = (store) =>
      new Proxy(store, {
        get: (target, property) => {
          const value = Reflect.get(target, property) as unknown;
          if (property === "fetchRefused" && first) {
            return () => {
              first = false;
              return new Promise((_resolve, fail) => (reject = fail));
            };
          }
          return value;
        },
      });
    const w = await mentionWorld({ wrap, timeoutMs: 300 });
    await plainActor(w.t.web, "bob");
    const carol = await plainActor(w.t.web, "carol", "other.example");
    const held = hold(w, carol.uri);
    const response = w.post({ status: "@bob@mastodon.example @carol@other.example" });
    await held.reached;
    // The first address's policy read, held past its load's timeout, now fails with a Store refusal.
    reject(new StoreUnavailableError("transient"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    held.release();
    const status = await posted(response);
    expect(status.mentions.map((m) => m.acct)).toEqual(["carol@other.example"]);
  });

  it("starts no second address when the instance key's creation is refused under readonly, and answers 503 (R9)", async () => {
    const w = await mentionWorld({ cold: true });
    await plainActor(w.t.web, "bob");
    await plainActor(w.t.web, "carol", "other.example");
    const held = hold(w, webfinger("bob", "mastodon.example"));
    const response = w.post({ status: "@bob@mastodon.example @carol@other.example" });
    await held.reached;
    await w.t.store.setMaintenance(BUILD, true);
    held.release();
    expect((await response).status).toBe(503);
    // The guarded branch: the key's creation was asked for, and refused.
    expect(w.calls()).toContain("ensureInstanceActorKey");
    expect(w.t.web.fetched).not.toContain(webfinger("carol", "other.example"));
    expect(w.dns).not.toContain("other.example");
  });
});
