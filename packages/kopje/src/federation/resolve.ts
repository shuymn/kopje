import { FetchError } from "@fedify/fedify";

import type { ResolutionStart } from "../domain/inbox";
import type { DocumentRevision, RemoteActorInput } from "../domain/remote-actors";
import { type Resolved, resolutionTarget, webfingerUrl } from "../domain/remote-statuses";
import { readConfig, userKek } from "../platform/config";
import { hostDomain, normalizeDomain } from "../platform/domain-name";
import { scanAlternate } from "../platform/html-scan";
import { sameOrigin } from "../platform/http-url";
import { withinJsonBounds } from "../platform/json-bounds";
import { parseLinkHeader } from "../platform/link-header";
import { callStore, type StoreResolver } from "../platform/store-client";
import { goneSettler } from "./actor-gone";
import {
  afterRevisionRead,
  createRemoteLoaders,
  type FederationDeps,
  type FederationState,
  type RemoteLoaders,
  type ResolveLoader,
} from "./federation";
import { typeIs } from "./json-shapes";
import {
  type FetchBudget,
  type OtherAnswer,
  RefusedFetchError,
  type ResolveAnswer,
  requestBudget,
  TransientFetchError,
  UnusableDocumentError,
} from "./loader";
import { type FetchedActor, fetchActor } from "./remote-actor";
import { ACTOR_TYPES, CONVERTED_TYPES, idOf, parseRemoteStatus, STATUS_TYPES } from "./remote-status";

// Search resolution (GET /api/v2/search?resolve=true, and GET /api/v1/accounts/search?resolve=true for addresses):
// a URL or a user@domain address is fetched through the safe loader (NET-1), signed by the instance actor and never
// served from the signed-document cache (NET-4), within one request's fetch budget (RES-6), and parsed as inbound
// documents are (ID-2, ID-8, RES-2). The Store then stores it with inbound validation
// and answers only what the viewer may see (resolveSearch). Only authenticated requests get here (resolveQuery in
// mastodon/search.ts checks the token first).
//
// As Mastodon's ResolveURLService and ResolveAccountService, with these differences: a URL that answers 200 with
// another type is followed to its alternate as FetchResourceService follows it (alternateOf: the Link header's, then a
// text/html page's first <link rel="alternate">, whose differences docs/mastodon-deviations.md lists under Search), and
// an address is stored under the host of the actor its WebFinger names (no second WebFinger round trip to confirm a
// split domain). An actor's revision is
// read from the Store before its document is fetched (a URL naming an actor is fetched again after that read,
// actorAfterRevision), and the document is stored only while it holds (ID-1, domain/remote-actors.ts DocumentRevision):
// the probe, and the WebFinger that follows the fetch on a host another server may name, can delay the store past a
// newer one. A URL is first read as a stored actor's id, before any probe: such a URL is resolved as that actor, so a
// 410 at it deletes the actor under the revision read before the fetch (ID-1, actor-gone.ts); a probe's 410 deletes
// nothing, having no revision read before it.

// requestJobs: asks for a jobs round (a gone actor's purge, actor-gone.ts); absent, cron runs it. budget: the request's
// fetch budget (RES-6) at its start; absent, requestBudget's (a test passes one with prior use).
export type ResolverDeps = {
  build: (env: Env) => string;
  store: StoreResolver;
  now: () => number;
  keygen: FederationDeps["keygen"];
  loader: FederationDeps["loader"];
  requestJobs?: (env: Env) => Promise<unknown>;
  budget?: (now: number) => FetchBudget;
};

// start: what the Store's resolution gate answered before any network work (domain/inbox.ts resolutionGate), its
// preparation serving the first request (its verdict) and every signed fetch (its signer); absent (the interaction
// look-up), the domain is read here and the loaders read their signer and verdicts themselves.
export type Resolver = (env: Env, query: string, start?: ResolutionStart) => Promise<Resolved>;

const NONE: Resolved = { kind: "none" };

export function createResolver(deps: ResolverDeps): Resolver {
  return async (env, query, start) => {
    const build = deps.build(env);
    const store = () => deps.store(env);
    const domain = start === undefined ? await callStore(() => store().instanceDomain(build)) : start.domain;
    if (domain === null) {
      return NONE;
    }
    const config = readConfig(env);
    const state: FederationState = {
      resolvedUsername: null,
      source: null,
      storeError: null,
      ticket: start?.prefetch?.ticket ?? null,
    };
    const budget = (deps.budget ?? requestBudget)(Date.now());
    const loaders = createRemoteLoaders(
      {
        domain,
        build,
        store,
        kek: config.ok ? userKek(config.config) : "",
        now: deps.now,
        keygen: deps.keygen,
        loader: deps.loader,
      },
      state,
      null,
      budget,
      start?.prefetch?.signer,
    );
    // The verdict that comes with the revision serves the actor's fetch, the next request, alone (refusesHost).
    const revisionOf = async (uri: string) => {
      const read = await callStore(() => store().actorRevision(build, { uri }));
      state.ticket = read.ticket;
      return read.revision;
    };
    const settle = goneSettler(store, build, deps.now);
    const settleGone: Resolving["settleGone"] = async (fetched, uri, revision) => {
      if ((await settle(fetched, uri, revision)).jobsPending) {
        await deps.requestJobs?.(env);
      }
    };
    const resolved = await resolveWith({ ...loaders, revisionOf, settleGone, budget }, query.trim(), domain);
    if (state.storeError !== null) {
      throw state.storeError;
    }
    return resolved;
  };
}

// The loaders, the Store read of an actor's revision, what a gone actor's document does (actor-gone.ts), and the
// request's fetch budget (RES-6), whose deadline bounds a page's scan.
type Resolving = RemoteLoaders & {
  resolve: ResolveLoader;
  revisionOf: (uri: string) => Promise<DocumentRevision>;
  settleGone: (fetched: FetchedActor, uri: string, revision: DocumentRevision) => Promise<void>;
  budget: FetchBudget;
};

// An actor's document, fetched after its revision was read (`revision`, when the caller read it already) with a memo
// of its own (afterRevisionRead): the request's loader may already hold a response for that URL fetched before the
// read (the URL's own probe), which must not be stored under it; the refetch costs one more fetch of the budget
// (RES-6).
async function actorAfterRevision(
  loaders: Resolving,
  uri: string,
  read?: DocumentRevision,
): Promise<{ fetched: FetchedActor; revision: DocumentRevision }> {
  const revision = read === undefined ? await loaders.revisionOf(uri) : read;
  return { fetched: await fetchActor(uri, afterRevisionRead(loaders).document, loaders.context), revision };
}

// A local address or URL is answered from stored data (resolveSearch's lookup by uri).
async function resolveWith(loaders: Resolving, query: string, domain: string): Promise<Resolved> {
  const target = resolutionTarget(query, domain);
  if (target === null) {
    return NONE;
  }
  return target.kind === "address"
    ? resolveAddress(loaders, target.username, target.domain)
    : resolveUrl(loaders, target.href);
}

// An actor, with the canonical address its host declares (declaredDomain), and its revision before the fetch (`read`,
// when the caller read it already). A 410 at its URI deletes a stored actor under that revision (actor-gone.ts).
async function resolveAccount(loaders: Resolving, uri: string, read?: DocumentRevision): Promise<Resolved> {
  const { fetched, revision } = await actorAfterRevision(loaders, uri, read);
  if (fetched.kind === "gone") {
    await loaders.settleGone(fetched, uri, revision);
  }
  if (fetched.kind !== "ok" || fetched.input === null) {
    return NONE;
  }
  const actor = fetched.input;
  const confirmed = await declaredDomain(loaders, actor);
  return {
    kind: "account",
    actor: confirmed === undefined ? actor : { ...actor, confirmedDomain: confirmed },
    revision,
  };
}

type WebFinger = { subject: string | null; self: string | null };

// A WebFinger (RFC 7033) answer for acct:username@host: its subject and the actor its self link names; 'missing'
// when the server answers that there is no such account (404 or 410, an authoritative negative); null when there is no
// usable answer (a network error, a timeout, a 5xx, the fetch budget, or a document that cannot be read), which
// proves nothing either way.
async function webfingerAt(
  loaders: RemoteLoaders,
  username: string,
  host: string,
): Promise<WebFinger | "missing" | null> {
  let jrd: unknown;
  try {
    jrd = (await loaders.webfinger(webfingerUrl(username, host))).document;
  } catch (error) {
    const status = error instanceof FetchError ? error.response?.status : undefined;
    return status === 404 || status === 410 ? "missing" : null;
  }
  if (!withinJsonBounds(jrd) || typeof jrd !== "object" || jrd === null) {
    return null;
  }
  const { subject, links } = jrd as { subject?: unknown; links?: unknown };
  const self = (Array.isArray(links) ? links : []).find(
    (link): link is { href: string } =>
      typeof link === "object" &&
      link !== null &&
      (link as { rel?: unknown }).rel === "self" &&
      typeof (link as { href?: unknown }).href === "string" &&
      typeof (link as { type?: unknown }).type === "string" &&
      /^application\/(activity\+json|ld\+json)/.test((link as { type: string }).type),
  );
  return { subject: typeof subject === "string" ? subject : null, self: self?.href ?? null };
}

// The username and domain of a WebFinger subject: acct:<username>@<domain>, exactly one @ and no empty part, with
// the domain normalized (normalizeDomain); null otherwise.
function splitAcct(subject: string | null): { username: string; domain: string } | null {
  const parts = (subject ?? "").replace(/^acct:/, "").split("@");
  if (parts.length !== 2) {
    return null;
  }
  const [username = "", raw = ""] = parts;
  const domain = normalizeDomain(raw);
  return username === "" || domain === null ? null : { username, domain };
}

// The canonical domain of an actor's address, as Mastodon's ActivityPub::ProcessAccountService#check_webfinger! and
// ResolveAccountService#process_webfinger! decide it (v4.7.5): the actor's own host declares the address in the subject
// of its WebFinger for acct:<preferredUsername>@<host>, and a subject on another domain is only a candidate, which
// that domain must confirm: its WebFinger for the subject names the same actor id as self. Confirmed: the candidate;
// the host's answer naming the actor under its own name, or any answer that does not confirm: the host. undefined
// when the host gives no usable answer (the Store then keeps what it has for this exact username, accountDomain).
// The address a search was made with plays no part: an alias never sets or replaces the canonical domain.
async function declaredDomain(loaders: RemoteLoaders, actor: RemoteActorInput): Promise<string | undefined> {
  // The actor's host, in the normalized form; an actor id with a port (or that does not normalize) is not checked:
  // the Store keeps what it has for this username (accountDomain).
  const host = normalizeDomain(hostDomain(actor.uri));
  if (host === null) {
    return undefined;
  }
  const declared = await webfingerAt(loaders, actor.username, host);
  if (declared === null) {
    return undefined;
  }
  if (declared === "missing") {
    return host;
  }
  const subject = splitAcct(declared.subject);
  if (subject === null || subject.username.toLowerCase() !== actor.username.toLowerCase()) {
    return host;
  }
  if (subject.domain === host) {
    return declared.self === actor.uri ? host : undefined;
  }
  // A transient failure at the candidate keeps what is stored for this username; only an authoritative answer
  // (missing, or naming another subject or actor) gives the host.
  const candidate = await webfingerAt(loaders, subject.username, subject.domain);
  if (candidate === null) {
    return undefined;
  }
  const confirmed = candidate === "missing" ? null : splitAcct(candidate.subject);
  return candidate !== "missing" &&
    candidate.self === actor.uri &&
    confirmed?.username.toLowerCase() === subject.username.toLowerCase() &&
    confirmed.domain === subject.domain
    ? subject.domain
    : host;
}

// An address: the actor its WebFinger names, found by its actor id. Its canonical address is the one its host
// declares (declaredDomain), never the address searched for.
async function resolveAddress(loaders: Resolving, username: string, domain: string): Promise<Resolved> {
  const found = await webfingerAt(loaders, username, domain);
  const href = found === null || found === "missing" ? null : found.self;
  return href === null ? NONE : resolveAccount(loaders, href);
}

// A URL: an actor, or a status with its author (the author has the status's origin, as for inbound objects). A stored
// remote actor's id is resolved as that actor, under the revision read here before any fetch (ID-1); any other URL is
// probed, and a 200 answer that is not ActivityPub is followed to the document its alternate names (alternateOf).
async function resolveUrl(loaders: Resolving, url: string): Promise<Resolved> {
  const stored = await loaders.revisionOf(url);
  if (stored !== null) {
    return resolveAccount(loaders, url, stored);
  }
  let document: unknown;
  try {
    const answer = await loaders.resolve(url, false);
    document = answer.kind === "document" ? answer.remote.document : await alternateOf(loaders, answer);
  } catch {
    return NONE;
  }
  if (typeof document !== "object" || document === null) {
    return NONE;
  }
  const type = (document as { type?: unknown }).type;
  const id = idOf(document);
  if (typeIs(type, ACTOR_TYPES)) {
    return id === null ? NONE : resolveAccount(loaders, id);
  }
  const status = parseRemoteStatus(document);
  if (status === null || status.attributedTo === null) {
    return NONE;
  }
  if (!sameOrigin(status.attributedTo, status.uri)) {
    return NONE;
  }
  const { fetched: author, revision } = await actorAfterRevision(loaders, status.attributedTo);
  return author.kind === "ok" && author.input !== null
    ? { kind: "status", status, author: author.input, revision }
    : NONE;
}

// The types Mastodon's ACTIVITY_STREAM_LINK_TYPES names, in the order process_link_headers tries them.
const ALTERNATE_TYPES = [
  "application/activity+json",
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

const ACTIVITYSTREAMS = "https://www.w3.org/ns/activitystreams";

// The types FetchResourceService#process_response takes (FetchRemoteActorService::SUPPORTED_TYPES, and expected_type?:
// Create's supported and converted types and FeaturedCollection, which Kopje does not resolve).
const TAKEN_TYPES = [...ACTOR_TYPES, ...STATUS_TYPES, ...CONVERTED_TYPES, "FeaturedCollection"];

// The document a 200 answer that is not ActivityPub names, as FetchResourceService#process_response follows it
// (v4.7.5): `process_link_headers(response) || process_html(response)`. The Link header's alternate (headerAlternate)
// first; when it ends in a nil answer, the page's (a text/html answer's first matching <link>, scanAlternate), whose
// body is read only then. Each alternate is fetched once, terminal (fetchAlternate). Undefined when neither yields a
// document; a raised failure (a transport error, the deadline, the budget, NET-1, the domain policy, a body past
// DOCUMENT_BODY_LIMIT, an href that is not an absolute http(s) URL) throws, ending the resolution with nothing. The
// body is cancelled when it is not read.
async function alternateOf(loaders: Resolving, answer: OtherAnswer): Promise<object | undefined> {
  try {
    const header = headerAlternate(answer.link);
    if (header !== null) {
      const fetched = await fetchAlternate(loaders, header);
      if (fetched !== undefined) {
        return fetched;
      }
    }
    if (answer.page === null) {
      return undefined;
    }
    const page = await answer.page();
    const scan = await scanAlternate(page.bytes, page.charset, ALTERNATE_TYPES, deadlineSignal(loaders.budget));
    const href = "failed" in scan ? null : (scan.link?.href ?? null);
    if (href === null) {
      return undefined;
    }
    return await fetchAlternate(loaders, href);
  } finally {
    answer.discard();
  }
}

// The two find_link calls of process_link_headers: the first link whose parameters include rel exactly "alternate"
// and type exactly application/activity+json, else the first with the ld+json profile type; null without one, or when
// the value is past the parser's bounds (platform/link-header.ts).
function headerAlternate(value: string | null): string | null {
  const links = value === null ? null : parseLinkHeader(value);
  for (const type of ALTERNATE_TYPES) {
    const found = links?.find(
      (link) =>
        link.params.some(([name, v]) => name === "rel" && v === "alternate") &&
        link.params.some(([name, v]) => name === "type" && v === type),
    );
    if (found !== undefined) {
      return found.href;
    }
  }
  return null;
}

// A signal that aborts at the request's deadline (RES-6).
function deadlineSignal(budget: FetchBudget): AbortSignal {
  return AbortSignal.timeout(Math.max(0, budget.deadline - Date.now()));
}

// One alternate, fetched as Mastodon's process(href, terminal: true): the loader's rules (NET-1, ID-2, the domain
// policy, the request's budget), Mastodon's Accept, no redirect, a 200 answer only. Its document when it is
// ActivityPub, of a context and type Mastodon takes, and its id is the href literally and the URL fetched (Mastodon's
// `json['id'] != @url || json['id'] != response.uri.to_s`); undefined for Mastodon's nil answers (another status, a
// redirect, another type, a body that is not a usable document, another context, type or id), on which a header
// alternate falls back to the page's as process_link_headers' nil does; a raised failure throws, an href
// that is not an absolute https URL included (the loader refuses it before any request, NET-1). No second hop, and a
// 410 is a nil answer: nothing is deleted or started.
async function fetchAlternate(loaders: Resolving, href: string): Promise<object | undefined> {
  let answer: ResolveAnswer;
  try {
    answer = await loaders.resolve(href, true);
  } catch (error) {
    if (isNilAnswer(error)) {
      return undefined;
    }
    throw error;
  }
  if (answer.kind === "other") {
    answer.discard();
    return undefined;
  }
  const { document, documentUrl } = answer.remote;
  if (typeof document !== "object" || document === null) {
    return undefined;
  }
  const record = document as { "@context"?: unknown; type?: unknown; id?: unknown };
  const context = record["@context"];
  const supported = Array.isArray(context) ? context.includes(ACTIVITYSTREAMS) : context === ACTIVITYSTREAMS;
  return supported && typeIs(record.type, TAKEN_TYPES) && record.id === href && documentUrl === href
    ? document
    : undefined;
}

// Whether a failed alternate fetch is one of Mastodon's nil answers rather than a raised failure: a status other than
// 200, a redirect's included (FetchError with the response), or a body that is no usable document
// (UnusableDocumentError).
function isNilAnswer(error: unknown): boolean {
  if (error instanceof UnusableDocumentError) {
    return true;
  }
  return (
    error instanceof FetchError &&
    !(error instanceof RefusedFetchError) &&
    !(error instanceof TransientFetchError) &&
    error.response !== undefined
  );
}
