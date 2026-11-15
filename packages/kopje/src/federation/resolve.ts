import type { ResolutionStart } from "../domain/inbox";
import type { ActorState, DocumentRevision, Handle, RemoteActorInput } from "../domain/remote-actors";
import { type Resolved, resolutionTarget, webfingerUrl } from "../domain/remote-statuses";
import { readConfig, userKek } from "../platform/config";
import { normalizeDomain } from "../platform/domain-name";
import { sameOrigin } from "../platform/http-url";
import { isRemoteUsername } from "../platform/identity-bounds";
import { withinJsonBounds } from "../platform/json-bounds";
import { callStore, type StoreResolver } from "../platform/store-client";
import {
  afterRevisionRead,
  createRemoteLoaders,
  type FederationDeps,
  type FederationState,
  type RemoteLoaders,
} from "./federation";
import { typeIs } from "./json-shapes";
import { isTransientLoadError, requestBudget } from "./loader";
import { fetchActor } from "./remote-actor";
import { ACTOR_TYPES, idOf, parseRemoteStatus } from "./remote-status";

// Search resolution (GET /api/v2/search?resolve=true, and GET /api/v1/accounts/search?resolve=true for addresses):
// a URL or a user@domain address is fetched through the safe loader (NET-1), signed by the instance actor and never
// served from the signed-document cache (NET-4), within one request's fetch budget (RES-6), and parsed as inbound
// documents are (ID-2, ID-8, RES-2). The Store then stores it with inbound validation
// and answers only what the viewer may see (resolveSearch). Only authenticated requests get here (resolveQuery in
// mastodon/search.ts checks the token first).
//
// As Mastodon's ResolveURLService and ResolveAccountService, with this difference: a URL must answer with an
// ActivityPub document itself (an HTML page's alternate link is not followed). An actor is stored under the handle its
// document claims once WebFinger confirms it for the actor (confirmHandle), never under the address searched for. An
// actor's state is read from the Store before its document is fetched (a URL naming an actor is fetched again after
// that read, actorAfterRevision), and the document is stored only while its revision holds (ID-1,
// domain/remote-actors.ts DocumentRevision): the probe, and the WebFinger that confirms the claim, can delay the store
// past a newer one.

export type ResolverDeps = {
  build: (env: Env) => string;
  store: StoreResolver;
  now: () => number;
  keygen: FederationDeps["keygen"];
  loader: FederationDeps["loader"];
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
      requestBudget(Date.now()),
      start?.prefetch?.signer,
    );
    // The verdict that comes with the state serves the actor's fetch, the next request, alone (refusesHost).
    const stateOf = async (uri: string) => {
      const read = await callStore(() => store().actorState(build, { uri }));
      state.ticket = read.ticket;
      return read.state;
    };
    const resolved = await resolveWith({ ...loaders, stateOf, domain }, query.trim());
    if (state.storeError !== null) {
      throw state.storeError;
    }
    return resolved;
  };
}

// The loaders, the Store read of an actor's state, and this instance's domain.
type Resolving = RemoteLoaders & { stateOf: (uri: string) => Promise<ActorState>; domain: string };

// An actor's document, fetched after its state was read with a memo of its own (afterRevisionRead): the request's
// loader may already hold a response for that URL fetched before the read (the URL's own probe), which must not be
// stored under it; the refetch costs one more fetch of the budget (RES-6). The document comes with its claim confirmed
// (confirmedInput); null when the actor cannot be stored: no usable document, or a new actor whose claim WebFinger did
// not confirm.
async function actorAfterRevision(
  loaders: Resolving,
  uri: string,
): Promise<{ actor: RemoteActorInput; revision: DocumentRevision } | null> {
  const state = await loaders.stateOf(uri);
  const fetched = await fetchActor(uri, afterRevisionRead(loaders).document, loaders.context);
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

// An actor, under the handle WebFinger confirmed for it, and its revision before the fetch.
async function resolveAccount(loaders: Resolving, uri: string): Promise<Resolved> {
  const found = await actorAfterRevision(loaders, uri);
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

// A URL: an actor, or a status with its author (the author has the status's origin, as for inbound objects).
async function resolveUrl(loaders: Resolving, url: string): Promise<Resolved> {
  let document: unknown;
  try {
    document = (await loaders.document(url)).document;
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
  const author = await actorAfterRevision(loaders, status.attributedTo);
  return author === null ? NONE : { kind: "status", status, author: author.actor, revision: author.revision };
}
