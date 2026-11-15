import { FetchError } from "@fedify/fedify";

import type { ResolutionStart } from "../domain/inbox";
import type { ActorState, DocumentRevision, Handle, RemoteActorInput } from "../domain/remote-actors";
import { type Resolved, resolutionTarget, webfingerUrl } from "../domain/remote-statuses";
import { readConfig, userKek } from "../platform/config";
import { normalizeDomain } from "../platform/domain-name";
import { scanAlternate } from "../platform/html-scan";
import { sameOrigin } from "../platform/http-url";
import { isRemoteUsername } from "../platform/identity-bounds";
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
  isTransientLoadError,
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
// text/html page's first <link rel="alternate">, whose differences docs/mastodon-deviations.md lists under Search),
// and an actor is stored under the handle its document claims once WebFinger confirms it for the actor
// (confirmHandle), never under the address searched for. An actor's state is read from the Store before its document
// is fetched (a URL naming an actor, directly or through an alternate, is fetched again after that read,
// actorAfterRevision), and the document is stored only while its revision holds (ID-1, domain/remote-actors.ts
// DocumentRevision): the probe, an alternate's fetch and the WebFinger that confirms the claim can delay the store
// past a newer one. A URL is first read as a stored actor's id, before any probe: such a URL is resolved as that actor,
// so a 410 at it deletes the actor under the revision read before the fetch (ID-1, actor-gone.ts); a 410 at the probe
// or at an alternate deletes nothing, having no revision read before it.

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
    // The verdict that comes with the state serves the actor's fetch, the next request, alone (refusesHost).
    const stateOf = async (uri: string) => {
      const read = await callStore(() => store().actorState(build, { uri }));
      state.ticket = read.ticket;
      return read.state;
    };
    const settle = goneSettler(store, build, deps.now);
    const settleGone: Resolving["settleGone"] = async (fetched, uri, revision) => {
      if ((await settle(fetched, uri, revision)).jobsPending) {
        await deps.requestJobs?.(env);
      }
    };
    const resolved = await resolveWith({ ...loaders, stateOf, domain, settleGone, budget }, query.trim());
    if (state.storeError !== null) {
      throw state.storeError;
    }
    return resolved;
  };
}

// The loaders, the Store read of an actor's state, this instance's domain, what a gone actor's document does
// (actor-gone.ts), and the request's fetch budget (RES-6), whose deadline bounds a page's scan.
type Resolving = RemoteLoaders & {
  resolve: ResolveLoader;
  stateOf: (uri: string) => Promise<ActorState>;
  domain: string;
  settleGone: (fetched: FetchedActor, uri: string, revision: DocumentRevision) => Promise<void>;
  budget: FetchBudget;
};

// An actor's document, fetched after its state was read (`read`, when the caller read it already) with a memo of its
// own (afterRevisionRead): the request's loader may already hold a response for that URL fetched before the read (the
// URL's own probe), which must not be stored under it; the refetch costs one more fetch of the budget (RES-6).
async function actorAfterRevision(
  loaders: Resolving,
  uri: string,
  read?: ActorState,
): Promise<{ fetched: FetchedActor; state: ActorState }> {
  const state = read ?? (await loaders.stateOf(uri));
  return { fetched: await fetchActor(uri, afterRevisionRead(loaders).document, loaders.context), state };
}

// A document fetched after its actor's state was read, with its claim confirmed (confirmedInput); null when the actor
// cannot be stored: no usable document, or a new actor whose claim WebFinger did not confirm.
async function storable(
  loaders: Resolving,
  fetched: FetchedActor,
  state: ActorState,
): Promise<{ actor: RemoteActorInput; revision: DocumentRevision } | null> {
  if (fetched.kind !== "ok" || fetched.input === null) {
    return null;
  }
  const checked = await confirmedInput(loaders, fetched.input, state.handle, loaders.domain);
  return state.handle === null && checked.outcome !== "confirmed"
    ? null
    : { actor: checked.input, revision: state.revision };
}

// A local address or URL is answered from stored data (resolveSearch's lookup by uri).
async function resolveWith(loaders: Resolving, query: string): Promise<Resolved> {
  const target = resolutionTarget(query, loaders.domain);
  if (target === null) {
    return NONE;
  }
  return target.kind === "address"
    ? resolveAddress(loaders, target.username, target.domain)
    : resolveUrl(loaders, target.href);
}

// An actor, under the handle WebFinger confirmed for it, and its revision before the fetch (`read`, when the caller
// read its state already). A 410 at its URI deletes a stored actor under that revision (actor-gone.ts).
async function resolveAccount(loaders: Resolving, uri: string, read?: ActorState): Promise<Resolved> {
  const { fetched, state } = await actorAfterRevision(loaders, uri, read);
  if (fetched.kind === "gone") {
    await loaders.settleGone(fetched, uri, state.revision);
  }
  const found = await storable(loaders, fetched, state);
  return found === null ? NONE : { kind: "account", ...found };
}

type WebFinger = { subject: string | null; self: string | null };

// A WebFinger (RFC 7033) answer for acct:username@host: its subject and the actor its self link names; 'transient'
// when another try may answer (isTransientLoadError: a network error, a timeout, a 5xx, the fetch budget or deadline);
// 'refused' for any other failure (404 or 410, any other refusal, or a document that cannot be read).
async function webfingerAt(
  loaders: Pick<RemoteLoaders, "webfinger">,
  username: string,
  host: string,
): Promise<WebFinger | "transient" | "refused"> {
  let jrd: unknown;
  try {
    jrd = (await loaders.webfinger(webfingerUrl(username, host))).document;
  } catch (error) {
    return isTransientLoadError(error) ? "transient" : "refused";
  }
  if (!withinJsonBounds(jrd) || typeof jrd !== "object" || jrd === null) {
    return "refused";
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

// The outcome of confirming a claimed handle (confirmHandle): the handle confirmed, in the spelling of the subject that
// confirmed it; refused (the claim is not this actor's, or an answer refused it); or transient (another try may
// answer).
export type Confirmation = { kind: "confirmed"; handle: Handle } | { kind: "refused" } | { kind: "transient" };

// Whether two handles are one address: the username case-insensitively, the normalized domain exactly.
function sameHandle(a: Handle, b: Handle): boolean {
  return a.username.toLowerCase() === b.username.toLowerCase() && a.domain === b.domain;
}

// D3, Mastodon 4.7.5's ActivityPub::ProcessAccountService#check_webfinger!: the handle an actor document claims
// (remote-actor.ts claimedHandle) is the actor's only when WebFinger at that address names this actor id. WebFinger
// acct:<claim>, unsigned, through the request's webfinger loader (its fetch budget and deadline, RES-6): a subject
// equal to the claim (sameHandle) whose self link is exactly the actor id confirms the claim; another subject is
// followed once, and must answer with an equal subject and the same self link, confirming that answer's subject. The
// username confirmed passes isRemoteUsername (Mastodon's USERNAME_ONLY_RE). A claim or a subject on this instance's
// domain is refused without a fetch: no remote actor holds a local address (ID-3). The self equalities and the second
// subject's equality are what keep an actor from taking a handle on a domain it does not control: that domain's
// WebFinger must name this actor id. At most two WebFinger loads.
async function confirmHandle(
  loaders: Pick<RemoteLoaders, "webfinger">,
  uri: string,
  claim: Handle,
  instanceDomain: string,
): Promise<Confirmation> {
  if (claim.domain === instanceDomain) {
    return { kind: "refused" };
  }
  const first = await webfingerAt(loaders, claim.username, claim.domain);
  if (first === "transient" || first === "refused") {
    return { kind: first };
  }
  const subject = splitAcct(first.subject);
  if (subject === null || !isRemoteUsername(subject.username)) {
    return { kind: "refused" };
  }
  if (sameHandle(subject, claim)) {
    return first.self === uri ? { kind: "confirmed", handle: claim } : { kind: "refused" };
  }
  if (subject.domain === instanceDomain) {
    return { kind: "refused" };
  }
  const second = await webfingerAt(loaders, subject.username, subject.domain);
  if (second === "transient" || second === "refused") {
    return { kind: second };
  }
  const confirmed = splitAcct(second.subject);
  return confirmed !== null &&
    sameHandle(confirmed, subject) &&
    second.self === uri &&
    isRemoteUsername(confirmed.username)
    ? { kind: "confirmed", handle: confirmed }
    : { kind: "refused" };
}

// D4: a document about to be stored, with its claim confirmed unless it equals the stored handle (the username exactly,
// the domain equal), as ProcessAccountService skips check_webfinger! for an unchanged handle. stored: the actor's
// stored handle as read before the fetch (actorState), null when it has no row. The outcome: 'kept' (not looked up),
// or confirmHandle's. Only a confirmed handle is set in the input; the Store keeps a stored row's handle otherwise, and
// stores no new actor without one (domain/remote-actors.ts acceptedHandle), so a wrong skip can only keep a handle.
export async function confirmedInput(
  loaders: Pick<RemoteLoaders, "webfinger">,
  input: RemoteActorInput,
  stored: Handle | null,
  instanceDomain: string,
): Promise<{ input: RemoteActorInput; outcome: "kept" | Confirmation["kind"] }> {
  if (stored !== null && input.claim.username === stored.username && input.claim.domain === stored.domain) {
    return { input: { ...input, confirmed: null }, outcome: "kept" };
  }
  const confirmation = await confirmHandle(loaders, input.uri, input.claim, instanceDomain);
  return {
    input: { ...input, confirmed: confirmation.kind === "confirmed" ? confirmation.handle : null },
    outcome: confirmation.kind,
  };
}

// An address: the actor its WebFinger names, found by its actor id. It is stored under the handle its document claims
// and WebFinger confirms (confirmHandle), never under the address searched for.
async function resolveAddress(loaders: Resolving, username: string, domain: string): Promise<Resolved> {
  const found = await webfingerAt(loaders, username, domain);
  const href = typeof found === "string" ? null : found.self;
  return href === null ? NONE : resolveAccount(loaders, href);
}

// A URL: an actor, or a status with its author (the author has the status's origin, as for inbound objects). A stored
// remote actor's id is resolved as that actor, under the revision read here before any fetch (ID-1); any other URL is
// probed, and a 200 answer that is not ActivityPub is followed to the document its alternate names (alternateOf).
async function resolveUrl(loaders: Resolving, url: string): Promise<Resolved> {
  const stored = await loaders.stateOf(url);
  if (stored.revision !== null) {
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
  const { fetched, state } = await actorAfterRevision(loaders, status.attributedTo);
  const author = await storable(loaders, fetched, state);
  return author === null ? NONE : { kind: "status", status, author: author.actor, revision: author.revision };
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
  const supported = Array.isArray(context)
    ? context.some((entry) => entry === ACTIVITYSTREAMS)
    : context === ACTIVITYSTREAMS;
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
