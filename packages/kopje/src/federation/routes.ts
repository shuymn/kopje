import { nodeInfoToJson } from "@fedify/fedify";
import type { Context, Handler } from "hono";
import { routePath } from "hono/route";

import type { NodeInfoUsage } from "../domain/actors";
import type { EmojiTag } from "../domain/custom-emojis";
import type { QuoteAuthorization } from "../domain/quotes";
import type { SnapshotSource } from "../domain/snapshot";
import { readConfig, userKek } from "../platform/config";
import { callStore, type StoreResolver, type StoreStub } from "../platform/store-client";
import type { KeyGen } from "../security/key-wrap";
import {
  createKopjeFederation,
  type FederationDeps,
  type FederationPreload,
  type FederationState,
  nodeInfo,
} from "./federation";
import type { LoaderDeps } from "./loader";
import { notSetUp } from "./setup-gate";
import { createSnapshotSaver, snapshotKey } from "./snapshot";

const QUOTE_AUTHORIZATION_ROUTE = "/ap/users/:username/quote_authorizations/:authorization_id";

// The federation GETs. All but the collections are always served (app/gate.ts) and kept as snapshots.
export const FEDERATION_GET_ROUTES = [
  "/.well-known/webfinger",
  "/.well-known/nodeinfo",
  "/nodeinfo/2.0",
  "/nodeinfo/2.1",
  "/actor",
  "/actor/outbox",
  "/ap/users/:username",
  "/ap/users/:username/followers",
  "/ap/users/:username/following",
  "/ap/users/:username/outbox",
  "/ap/users/:username/collections/featured",
  "/ap/users/:username/collections/tags",
  "/ap/o/:uuid",
  QUOTE_AUTHORIZATION_ROUTE,
  "/emojis/:id",
];

// The routes whose handler makes the request's one Store read, which also decides setup (domain/federation-reads.ts,
// SETUP-1): the setup gate passes their GETs and HEADs (app/app.ts). Every other federation GET reads the domain in the
// gate first.
export const SELF_GATED_ROUTES: ReadonlySet<string> = new Set([
  "/.well-known/nodeinfo",
  "/nodeinfo/2.0",
  "/nodeinfo/2.1",
  "/actor/outbox",
  QUOTE_AUTHORIZATION_ROUTE,
  "/emojis/:id",
]);

export type FederationRouteDeps = {
  build: (env: Env) => string;
  now: () => number;
  store: StoreResolver;
  keygen: KeyGen;
  loader: Omit<LoaderDeps, "userAgent">;
};

// The domain of a route outside SELF_GATED_ROUTES comes from the setup gate (setup-gate.ts), which has already read it
// from the Store.
type FederationEnv = { Bindings: Env; Variables: { domain: string } };

const NODEINFO_20 = "http://nodeinfo.diaspora.software/ns/schema/2.0";
const NODEINFO_21 = "http://nodeinfo.diaspora.software/ns/schema/2.1";

export function federationHandler(deps: FederationRouteDeps): Handler<FederationEnv> {
  const saveSnapshot = createSnapshotSaver(deps.now);
  return async (c) => {
    const url = new URL(c.req.url);
    // Taken before rendering: the Store refuses a save rendered earlier than the one it keeps.
    const renderedAt = deps.now();
    const answer = await respond(c, deps, url);
    if (answer === null) {
      return notSetUp(c);
    }
    const { response, source } = answer;
    const key = snapshotKey(url);
    if (source === null || key === null || response.status !== 200 || response.body === null) {
      return response;
    }
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "application/json";
    c.executionCtx.waitUntil(
      saveSnapshot(deps.store(c.env), deps.build(c.env), key, { contentType, body }, source, renderedAt),
    );
    return new Response(body, response);
  };
}

// source: what the answer was rendered from, or null when the answer is not kept. Only canonical requests are kept:
// WebFinger keeps only the acct: URI and the actor URI of the stored username, so the rows stay bounded by the number
// of actors.
type Answer = { response: Response; source: SnapshotSource | null };

// null: setup has not fixed the domain (a self-gated route's read answered not_set_up). A Store refusal propagates to
// app.onError, which answers the always-served routes from their snapshot.
async function respond(c: Context<FederationEnv>, deps: FederationRouteDeps, url: URL): Promise<Answer | null> {
  // As mastodon/context.ts storeCall: the answer typed from the RPC, not inferred from the stub's union.
  const read = <F extends (store: StoreStub, build: string) => unknown>(call: F) =>
    callStore(() => Promise.resolve(call(deps.store(c.env), deps.build(c.env))) as Promise<Awaited<ReturnType<F>>>);
  const route = routePath(c);
  if (SELF_GATED_ROUTES.has(route) && !spelled(route, url.pathname)) {
    // Hono matched the decoded path ('/.well-known/%6eodeinfo'); Fedify answers the raw one (404), from the domain alone.
    const site = await read((s, b) => s.apSite(b));
    return site.status === "ok" ? viaFedify(c, deps, site.domain, url) : null;
  }
  switch (route) {
    case "/.well-known/nodeinfo": {
      const site = await read((s, b) => s.apSite(b));
      return site.status === "ok" ? { response: nodeInfoLinks(site.domain), source: { kind: "static" } } : null;
    }
    case "/nodeinfo/2.0":
    case "/nodeinfo/2.1": {
      const now = deps.now();
      const info = await read((s, b) => s.apNodeInfo(b, { now }));
      if (info.status !== "ok") {
        return null;
      }
      if (url.pathname === "/nodeinfo/2.0") {
        return {
          response: nodeInfo20(info.usage),
          source: { kind: "nodeinfo", now, rendered: JSON.stringify(info.usage) },
        };
      }
      return viaFedify(c, deps, info.domain, url, { nodeInfo: { now, usage: info.usage } });
    }
    case "/actor/outbox": {
      const site = await read((s, b) => s.apSite(b));
      if (site.status !== "ok") {
        return null;
      }
      // Its ids and links are built from the request URL (federation.ts, the instance actor's outbox).
      const cursor = url.searchParams.get("cursor");
      const canonical = new URL(url.pathname, url);
      if (cursor !== null) {
        canonical.searchParams.set("cursor", cursor);
      }
      return viaFedify(c, deps, site.domain, canonical);
    }
    case QUOTE_AUTHORIZATION_ROUTE: {
      const stamp = STAMP.exec(url.pathname)!;
      const input = { username: stamp[1]!, authorizationId: stamp[2]! };
      const answer = await read((s, b) => s.apQuoteAuthorization(b, input));
      return answer.status === "ok" ? { response: quoteAuthorization(answer.stamp), source: null } : null;
    }
    case "/emojis/:id": {
      const id = EMOJI.exec(url.pathname)?.[1];
      const answer =
        id === undefined
          ? { ...(await read((s, b) => s.apSite(b))), emoji: null }
          : await read((s, b) => s.apEmoji(b, { id }));
      return answer.status === "ok" ? { response: emojiObject(answer.emoji), source: null } : null;
    }
    default:
      return LEGACY_OBJECT.test(url.pathname) ? objectOrAlias(c, deps, url) : viaFedify(c, deps, c.get("domain"), url);
  }
}

// Whether the raw path is one a self-gated route answers itself; any other spelling Hono matches goes to Fedify.
function spelled(route: string, path: string): boolean {
  switch (route) {
    case QUOTE_AUTHORIZATION_ROUTE:
      return STAMP.test(path);
    case "/emojis/:id":
      return path.startsWith("/emojis/");
    default:
      return path === route;
  }
}

const STAMP = /^\/ap\/users\/([A-Za-z0-9_]{1,64})\/quote_authorizations\/([0-9a-f]{32})$/;

// FEP-044f's QuoteAuthorization of an accepted quote of a local status (Mastodon's QuoteAuthorizationsController,
// QuoteAuthorizationSerializer), from the request's one read (quotes.ts quoteAuthorizationOf): 404 unless it is the current
// authorization, never retired, of a public or unlisted status of an available `username`. It names only ids, all of
// public objects, so it is served unsigned to anyone. no-store: a revoke ends it at once, and no cache may answer 200
// after that (VIS-28); it is never kept as a snapshot either.
function quoteAuthorization(stamp: QuoteAuthorization | null): Response {
  if (stamp === null) {
    return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  const body = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      {
        gts: "https://gotosocial.org/ns#",
        QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
        interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
        interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
      },
    ],
    id: stamp.id,
    type: "QuoteAuthorization",
    attributedTo: stamp.attributedTo,
    interactingObject: stamp.interactingObject,
    interactionTarget: stamp.interactionTarget,
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/activity+json", "cache-control": "no-store" },
  });
}

const EMOJI = /^\/emojis\/(\d{18})$/;

// A local custom emoji as its Emoji object (Mastodon's EmojisController#show,
// app/controllers/emojis_controller.rb:8-17; domain/local-emojis.ts localEmojiObjectOf), one primary-key read: any local
// emoji, disabled ones included. It names only public data, so it is served unsigned to anyone, cached for three
// minutes as Mastodon's (expires_in 3.minutes, public: true), and never kept as a snapshot. Any other id, or an emoji
// whose time is not an instant (custom-emojis.ts emojiInstant), answers 404.
function emojiObject(emoji: EmojiTag | null): Response {
  if (emoji === null) {
    return new Response("Not Found", { status: 404 });
  }
  const body = { "@context": ["https://www.w3.org/ns/activitystreams", EMOJI_CONTEXT], ...emoji };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/activity+json", "cache-control": "public, max-age=180" },
  });
}

const EMOJI_CONTEXT = { toot: "http://joinmastodon.org/ns#", Emoji: "toot:Emoji" };

const LEGACY_OBJECT = /^\/ap\/o\/[0-9A-Za-z-]{1,64}$/;

// /ap/o/<uuid>: a local status's Note (Fedify), else a legacy alias the cutover kept (domain/activities.ts,
// getLegacyObject). A remote proxy alias moves to the original for any client; an image is a document for ActivityPub
// clients only, as a Note is. Neither is kept as a snapshot.
async function objectOrAlias(c: Context<FederationEnv>, deps: FederationRouteDeps, url: URL): Promise<Answer> {
  const answer = await viaFedify(c, deps, c.get("domain"), url);
  if (answer.response.status !== 404 && answer.response.status !== 406) {
    return answer;
  }
  const uuid = url.pathname.slice("/ap/o/".length);
  const origin = `https://${c.get("domain")}`;
  const alias = await callStore(() => deps.store(c.env).legacyObject(deps.build(c.env), { uuid, origin }));
  if (alias.location !== null) {
    return { response: new Response(null, { status: 301, headers: { location: alias.location } }), source: null };
  }
  if (alias.image !== null && answer.response.status === 404) {
    const response = new Response(alias.image, { headers: { "content-type": "application/activity+json" } });
    return { response, source: null };
  }
  return answer;
}

async function viaFedify(
  c: Context<FederationEnv>,
  deps: FederationRouteDeps,
  domain: string,
  url: URL,
  preload?: FederationPreload,
): Promise<Answer> {
  const config = readConfig(c.env);
  const { response, state } = await fetchFederation(
    {
      domain,
      build: deps.build(c.env),
      store: () => deps.store(c.env),
      kek: config.ok ? userKek(config.config) : "",
      now: deps.now,
      keygen: deps.keygen,
      loader: deps.loader,
    },
    c.req.raw,
    url,
    preload,
  );
  if (state.storeError !== null) {
    throw state.storeError;
  }
  // An actor path counts only once the dispatcher has matched a local actor; /actor and NodeInfo are fixed.
  // Fedify decodes the path and parses the resource its own way, so the raw request must spell the canonical form
  // exactly: '/ap/users/Ali%63e' or a trailing-slash variant would otherwise each add a row for the same actor.
  const canonical =
    url.pathname === "/.well-known/webfinger"
      ? canonicalWebFinger(url, domain, state.resolvedUsername)
      : url.pathname.startsWith("/ap/users/")
        ? state.resolvedUsername !== null && url.pathname === `/ap/users/${state.resolvedUsername}`
        : true;
  return { response, source: canonical ? state.source : null };
}

// One federation GET through Kopje's Fedify dispatchers, on the fixed domain. Shared by the Worker and the cutover's
// maintenance worker (src/maintenance-worker.ts), so both render actor documents and WebFinger the same way. A Store
// failure is left in state.storeError for the caller.
export async function fetchFederation(
  deps: FederationDeps,
  raw: Request,
  url: URL,
  preload?: FederationPreload,
): Promise<{ response: Response; state: FederationState }> {
  const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
  const federation = createKopjeFederation(deps, state, preload);
  // Fedify builds collection page links from the request URL, so the request is put on the fixed domain first.
  const request = new Request(new URL(`${url.pathname}${url.search}`, `https://${deps.domain}`), raw);
  const response = await federation.fetch(request, {
    contextData: state,
    onNotFound: () => new Response("Not Found", { status: 404 }),
    onNotAcceptable: () => new Response("Not Acceptable", { status: 406 }),
    // Only a page of a hidden followers or following collection is refused.
    onUnauthorized: () => new Response("Forbidden", { status: 403 }),
  });
  return { response, state };
}

function canonicalWebFinger(url: URL, domain: string, username: string | null): boolean {
  const resources = url.searchParams.getAll("resource");
  const resource = resources.length === 1 ? resources[0] : undefined;
  return (
    username !== null &&
    (resource === `acct:${username}@${domain}` || resource === `https://${domain}/ap/users/${username}`)
  );
}

function nodeInfoLinks(domain: string): Response {
  return Response.json({
    links: [
      { rel: NODEINFO_20, href: `https://${domain}/nodeinfo/2.0` },
      { rel: NODEINFO_21, href: `https://${domain}/nodeinfo/2.1` },
    ],
  });
}

// NodeInfo 2.0 is 2.1 without software.repository and software.homepage.
function nodeInfo20(usage: NodeInfoUsage): Response {
  const info = nodeInfo(usage);
  const json = nodeInfoToJson({ ...info, software: { name: info.software.name, version: info.software.version } });
  return new Response(JSON.stringify({ ...(json as object), $schema: `${NODEINFO_20}#`, version: "2.0" }), {
    headers: { "content-type": `application/json; profile="${NODEINFO_20}#"` },
  });
}
