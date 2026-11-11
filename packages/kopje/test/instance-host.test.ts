import { describe, expect, it, vi } from "vitest";

import { handleQueue } from "../src/jobs/queue";
import { type ApiHarness, bearer, form, json, sql, userToken, withAlice } from "./api-helpers";
import { countingStore, harness, inboxDeps } from "./app-helpers";
import { fixtureKeyGen, seedLocalAccount } from "./federation-helpers";
import { BUILD, completeSetup, migratedStore } from "./helpers";
import { mastodonActor, RemoteWeb, signedInit } from "./inbox-helpers";
import { storeWith } from "./setup-helpers";

// WEB-6: once setup has fixed the domain, every route answers only on it. GET and HEAD on another host move to the
// same path and query on the domain (301); any other method is 421. The health check, the admin API, media and the
// root answer on any host, and before setup nothing changes. A spooled inbox delivery and a snapshot rescue judge the
// host too.

// Hosts the Worker may also answer on: its workers.dev address, another route, the domain with a port.
const OTHER_HOSTS = ["kopje.example.workers.dev", "other.kopje.test", "kopje.test:8443"] as const;

const AP = { accept: "application/activity+json" };

// Paths of every layer: the Mastodon API, OAuth, federation (setup-gated, self-gated, WebFinger), the public pages,
// and the web UI. The query keeps its spelling: escapes, repeats and an empty value.
const READS = [
  "/api/v1/instance",
  "/api/v2/instance?x=1",
  "/api/v1/timelines/public?local=true&limit=2&limit=3",
  "/api/v1/accounts/lookup?acct=alice%40kopje.test",
  "/oauth/authorize?response_type=code&client_id=x&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob&scope=read",
  "/.well-known/oauth-authorization-server",
  "/.well-known/webfinger?resource=acct%3Aalice%40kopje.test",
  "/.well-known/nodeinfo",
  "/nodeinfo/2.0",
  "/ap/users/alice",
  "/ap/users/alice/outbox?page=true",
  "/actor",
  "/actor/outbox",
  "/@alice",
  "/@alice/with_replies?max_id=9",
  "/about",
  "/tags/caf%C3%A9",
  "/login?return=%2Fsettings",
  "/settings",
  "/authorize_interaction?uri=https%3A%2F%2Fremote.example%2F%40bob",
  "/setup",
];

// Writes of every layer, each with what reaches its route on the instance domain.
function writes(token: string): [string, string, RequestInit][] {
  const inbox = {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify({ type: "Follow", actor: "https://remote.example/users/bob", object: "x" }),
  };
  return [
    ["POST", "/api/v1/statuses", bearer(token, json({ status: "hello" }))],
    ["PUT", "/api/v1/statuses/1", bearer(token, json({ status: "edit" }, { method: "PUT" }))],
    ["PATCH", "/api/v1/accounts/update_credentials", bearer(token, json({ note: "x" }, { method: "PATCH" }))],
    ["DELETE", "/api/v1/statuses/1", bearer(token, { method: "DELETE" })],
    ["POST", "/api/v1/apps", json({ client_name: "c", redirect_uris: "urn:ietf:wg:oauth:2.0:oob" })],
    ["POST", "/oauth/token", form({ grant_type: "client_credentials", client_id: "x", client_secret: "y" })],
    ["POST", "/oauth/revoke", form({ token: "x", client_id: "x", client_secret: "y" })],
    ["POST", "/inbox", inbox],
    ["POST", "/ap/users/alice/inbox", inbox],
    ["POST", "/logout", form({ csrf: "x" })],
    ["POST", "/setup/login", form({ token: "x" })],
    ["DELETE", "/ap/users/alice", { method: "DELETE" }],
  ];
}

async function instance(): Promise<ApiHarness & { aliceId: string; token: string }> {
  const h = await withAlice();
  return { ...h, token: await userToken(h, "alice@example.com", "read write") };
}

function at(h: ApiHarness, host: string, path: string, init: RequestInit = {}): Promise<Response> {
  return h.send(new Request(`https://${host}${path}`, init));
}

describe("answering only on the instance domain (WEB-6)", () => {
  it("moves a GET or HEAD on another host to the same path and query on the domain", async () => {
    const h = await instance();
    for (const method of ["GET", "HEAD"]) {
      for (const host of OTHER_HOSTS) {
        for (const path of READS) {
          const headers = path.startsWith("/ap/") || path.startsWith("/actor") ? AP : {};
          const response = await at(h, host, path, { method, headers });
          const label = `${method} ${host}${path}`;
          expect(response.status, label).toBe(301);
          expect(response.headers.get("location"), label).toBe(`https://kopje.test${path}`);
          expect(response.headers.get("cache-control"), label).toBe("no-store");
          expect(await response.text(), label).toBe("");
        }
      }
      // The branch ran: on the domain the same requests reach their routes.
      for (const path of READS) {
        const headers = path.startsWith("/ap/") || path.startsWith("/actor") ? AP : {};
        const response = await at(h, "kopje.test", path, { method, headers });
        expect([301, 421], `${method} ${path}`).not.toContain(response.status);
      }
    }
  }, 60_000);

  it("answers 421 to any other method on another host, writing nothing", async () => {
    const h = await instance();
    for (const host of OTHER_HOSTS) {
      for (const [method, path, init] of writes(h.token)) {
        // A form's Origin is the host's own, so the web UI's and OAuth's Origin checks pass and the host is reached.
        const headers = { ...(init.headers as Record<string, string>), origin: `https://${host}` };
        const response = await at(h, host, path, { ...init, method, headers });
        expect(response.status, `${method} ${host}${path}`).toBe(421);
        expect(response.headers.get("location"), `${method} ${host}${path}`).toBeNull();
        expect(await response.text(), `${method} ${host}${path}`).toBe("Misdirected Request");
      }
    }
    expect(await sql(h.store, "SELECT 1 FROM statuses")).toEqual([]);
    expect(h.doorbell).not.toHaveBeenCalled();
    // The branch ran: on the domain a post is made.
    const [, path, init] = writes(h.token)[0]!;
    expect((await at(h, "kopje.test", path, init)).status).toBe(200);
    expect(await sql(h.store, "SELECT 1 FROM statuses")).toHaveLength(1);
  });

  it("refuses an OAuth decision posted on another host before verifying Access", async () => {
    const h = await instance();
    const response = await at(
      h,
      OTHER_HOSTS[0],
      "/oauth/authorize",
      form({ client_id: "x", decision: "approve" }, { headers: { origin: `https://${OTHER_HOSTS[0]}` } }),
    );
    expect(response.status).toBe(421);
  });

  it("keeps the domain's own spellings: case, the default port, and the Host header", async () => {
    const h = await instance();
    for (const origin of ["https://KOPJE.TEST", "https://Kopje.Test:443", "https://kopje.test:443"]) {
      const response = await h.send(new Request(`${origin}/api/v1/instance`));
      expect(response.status, origin).toBe(200);
    }
    // The URL decides; a Host header naming another host changes nothing, either way.
    const other = new Request("https://kopje.test/api/v1/instance", { headers: { host: OTHER_HOSTS[0] } });
    expect((await h.send(other)).status).toBe(200);
    const named = new Request(`https://${OTHER_HOSTS[0]}/api/v1/instance`, { headers: { host: "kopje.test" } });
    expect((await h.send(named)).status).toBe(301);
    // A port is dropped: the domain is served on 443.
    const ported = await at(h, "kopje.test:8443", "/about?x=%20");
    expect(ported.headers.get("location")).toBe("https://kopje.test/about?x=%20");
  });

  it("answers the health check, the admin API, media and paths no route serves on any host", async () => {
    const h = await instance();
    const counting = countingStore(h.store);
    const unrouted = harness(counting.stub, {}, undefined, undefined, undefined, OTHER_HOSTS[0]);
    const paths: [string, string][] = [
      ["GET", "/no/such/path?a=&b"],
      ["POST", "/settings"],
    ];
    for (const [method, path] of paths) {
      // The ordinary 404, and the Store is not read for it (on the domain neither).
      expect((await unrouted.request(path, { method })).status, `${method} ${path}`).toBe(404);
    }
    expect(counting.calls).toEqual([]);
    for (const host of OTHER_HOSTS) {
      const health = await at(h, host, "/health");
      expect(health.status, host).toBe(200);
      expect(await health.text(), host).toBe("ok");
      // Admin authenticates itself (Access or the import token) and answers its own refusal.
      const admin = await at(h, host, "/admin/health", { headers: { accept: "application/json" } });
      expect([301, 421], host).not.toContain(admin.status);
      expect(admin.status, host).toBe(await at(h, "kopje.test", "/admin/health").then((r) => r.status));
      for (const path of [`/media/${"a".repeat(43)}/original.png`, `/media/r/${"a".repeat(43)}/x.png`]) {
        const media = await at(h, host, path);
        expect(media.status, `${host}${path}`).toBe((await at(h, "kopje.test", path)).status);
        expect([301, 421], `${host}${path}`).not.toContain(media.status);
      }
    }
  });

  it("changes nothing before setup has fixed the domain", async () => {
    const store = await migratedStore();
    const paths: [string, RequestInit][] = [
      ["/setup", {}],
      ["/api/v1/instance", {}],
      ["/ap/users/alice", { headers: AP }],
      ["/nodeinfo/2.0", {}],
      ["/@alice", {}],
      ["/login", {}],
      ["/oauth/authorize", {}],
      ["/inbox", { method: "POST", headers: { "content-type": "application/activity+json" }, body: "{}" }],
      ["/api/v1/apps", json({ client_name: "c", redirect_uris: "urn:ietf:wg:oauth:2.0:oob" })],
    ];
    const answers = async (host: string) => {
      const { request } = harness(store, {}, undefined, undefined, undefined, host);
      const out: [string, number, string | null][] = [];
      for (const [path, init] of paths) {
        const response = await request(path, init);
        out.push([path, response.status, response.headers.get("location")]);
      }
      return out;
    };
    const domain = await answers("kopje.test");
    for (const host of OTHER_HOSTS) {
      expect(await answers(host), host).toEqual(domain.map(([path, status]) => [path, status, null]));
    }
    // The branch is the setup gate's: federation and sign-in answer 503 on every host.
    expect(domain.filter(([, status]) => status === 503).map(([path]) => path)).toEqual(
      expect.arrayContaining(["/ap/users/alice", "/nodeinfo/2.0", "/@alice", "/login", "/oauth/authorize", "/inbox"]),
    );
  });

  // The Store calls a request makes: one domain read before a route that does not read the domain itself, none
  // before one that does (federation, the public pages, the web UI and OAuth decide in their own first read).
  it("reads the domain once more only where the route does not read it", async () => {
    const h = await instance();
    const counting = countingStore(h.store);
    const { request } = harness(counting.stub, {}, undefined, undefined, undefined, "kopje.test");
    const calls = async (path: string, init: RequestInit = {}) => {
      counting.calls.length = 0;
      const response = await request(path, init);
      expect([301, 421], path).not.toContain(response.status);
      return [...counting.calls];
    };
    expect(await calls("/api/v1/accounts/verify_credentials", bearer(h.token))).toEqual([
      "instanceDomain",
      "verifyCredentials",
      "noteActivity",
    ]);
    expect(await calls("/api/v1/instance")).toEqual(["instanceDomain", "instanceInfo"]);
    expect(await calls("/ap/users/alice", { headers: AP })).toEqual(["instanceDomain", "localActor"]);
    expect(await calls("/nodeinfo/2.0")).toEqual(["apNodeInfo", "saveSnapshot"]);
    expect(await calls("/about")).toEqual(["webAbout"]);
    // Without a session: the gate's read, then the sign-in.
    expect(await calls("/settings")).toEqual(["webSite"]);
    // No Store read at all: the root's redirect, and a CORS preflight, which the CORS middleware answers first.
    expect(await calls("/")).toEqual([]);
    const preflight = { origin: "https://client.test", "access-control-request-method": "POST" };
    expect(await calls("/api/v1/statuses", { method: "OPTIONS", headers: preflight })).toEqual([]);
  });

  it("drops a spooled inbox request to another host at replay, applying nothing", async () => {
    const web = new RemoteWeb();
    const bob = await mastodonActor(web, "bob");
    const follow = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${bob.uri}#f`,
      type: "Follow",
      actor: bob.uri,
      object: "https://kopje.test/ap/users/alice",
    };
    const federation = { keygen: fixtureKeyGen, loader: web.loader };
    const replay = async (host: string) => {
      const store = await migratedStore();
      await completeSetup(store);
      await seedLocalAccount(store, "kopje.test", { id: "111111111111111111", username: "alice" });
      // The env in maintenance spools the delivery as it came, whatever its host.
      const h = harness(store, { MAINTENANCE: "readonly" }, BUILD, federation, undefined, host);
      expect((await h.request("/inbox", await signedInit(bob, "/inbox", follow))).status).toBe(202);
      expect(h.queue.pending).toHaveLength(1);
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await h.queue.deliver((batch) =>
          handleQueue(
            batch,
            { ...h.env, MAINTENANCE: "off" } as Env,
            inboxDeps(() => store, web.loader),
          ),
        );
        const refused = logs.mock.calls.filter(
          ([entry]) => (entry as { event?: string }).event === "kopje.inbox.refused",
        );
        return {
          pending: h.queue.pending.length,
          retries: h.queue.retries,
          refused,
          actors: await sql(store, "SELECT 1 FROM accounts WHERE domain IS NOT NULL"),
          follows: await sql(store, "SELECT 1 FROM follows"),
        };
      } finally {
        logs.mockRestore();
      }
    };
    const away = await replay(OTHER_HOSTS[0]);
    expect(away).toMatchObject({ pending: 0, retries: 0, actors: [], follows: [] });
    expect(away.refused).toEqual([[{ event: "kopje.inbox.refused", status: 421, reason: "other-host" }]]);
    // The branch ran: the same delivery spooled on the domain is applied.
    const domain = await replay("kopje.test");
    expect(domain).toMatchObject({ retries: 0, refused: [] });
    expect(domain.follows).toHaveLength(1);
  });

  it("serves a rescued snapshot only on the domain it records, or a legacy one on the stored domain", async () => {
    const store = await migratedStore();
    await completeSetup(store);
    await seedLocalAccount(store, "kopje.test", { id: "111111111111111111", username: "alice" });
    // A healthy request keeps the document, with the domain it was rendered on.
    expect((await harness(store).request("/nodeinfo/2.0")).status).toBe(200);
    const kept = await store.rescueSnapshot(BUILD, "path:/nodeinfo/2.0");
    expect(kept?.domain).toBe("kopje.test");
    // The Store refuses a Worker of another build, and the rescue answers.
    const rescued = (host: string, init: RequestInit = {}) =>
      harness(store, {}, "0.0.0-other", undefined, undefined, host).request("/nodeinfo/2.0", init);
    const onDomain = await rescued("kopje.test");
    expect(onDomain.status).toBe(200);
    expect(await onDomain.text()).toBe(kept?.body);
    for (const host of OTHER_HOSTS) {
      for (const method of ["GET", "HEAD"]) {
        const response = await rescued(host, { method });
        expect(response.status, `${method} ${host}`).toBe(301);
        expect(response.headers.get("location"), `${method} ${host}`).toBe("https://kopje.test/nodeinfo/2.0");
        expect(await response.text(), `${method} ${host}`).toBe("");
      }
    }
    // A snapshot kept before snapshots recorded their domain is judged by the stored domain, read through config().
    await sql(
      store,
      "UPDATE kopje_state SET value = json_remove(value, '$.domain') WHERE name = 'snapshot:path:/nodeinfo/2.0'",
    );
    expect((await store.rescueSnapshot(BUILD, "path:/nodeinfo/2.0"))?.domain).toBeNull();
    const legacy = await rescued("kopje.test");
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe(kept?.body);
    for (const host of OTHER_HOSTS) {
      const response = await rescued(host);
      expect(response.status, host).toBe(301);
      expect(response.headers.get("location"), host).toBe("https://kopje.test/nodeinfo/2.0");
    }
    // Without that domain it is not served: config() fails, or no domain is set.
    const failing = storeWith(store, { config: () => Promise.reject(new Error("config unavailable")) });
    for (const host of ["kopje.test", OTHER_HOSTS[0]]) {
      const response = await harness(failing, {}, "0.0.0-other", undefined, undefined, host).request("/nodeinfo/2.0");
      expect(response.status, host).toBe(503);
    }
    await sql(store, "DELETE FROM instance_settings WHERE name = 'domain'");
    expect((await rescued("kopje.test")).status).toBe(503);
    expect((await rescued(OTHER_HOSTS[0])).status).toBe(503);
  });
});
