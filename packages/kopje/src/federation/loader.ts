import {
  type DocumentLoader,
  FetchError,
  getRemoteDocument,
  preloadedContexts,
  type RemoteDocument,
  validatePublicUrl,
} from "@fedify/fedify";

import { readBoundedBody } from "../platform/body";
import { hostDomain } from "../platform/domain-name";
import { errorMessage } from "../platform/error-message";
import { type HtmlBody, readHtmlBody } from "../platform/html-body";
import { publicShapeRefusal } from "../platform/http-url";
import { isActivityPubMediaType, type MediaType, parseMediaType } from "../platform/media-type";
import { readableKeys } from "./key-entries";

// The document loader every remote fetch goes through, unsigned or signed. Fedify's default allows http, 16 MiB
// bodies and 10 s per call, so it is replaced. The rules, each from a legacy security fix:
//   - https only; localhost, single-label and literal-IP hosts are refused, and checkHost refuses names that resolve to
//     private addresses (Fedify's DNS check by default)
//   - the body is read bounded at 1 MiB, or a caller's tighter cap (DocumentCaps)
//   - the whole load, redirects and body included, ends after 5 s
//   - the origin is judged from the final response.url; a redirect to another origin is refused
//   - the document's id must have the origin of the URL it was fetched from
//   - a document is taken only as application/activity+json or ActivityStreams-profiled application/ld+json
//     (isActivityPubMediaType, GHSA-jhrq-qvrm-qr36); the context loader alone takes plain JSON-LD or JSON, since JSON-LD
//     contexts are served that way and a context is never trusted as an object
//   - a host the instance's domain policy covers (refusesHost, R38) is not requested at all
//   - a document's publicKey and assertionMethod entries are read as Mastodon 4.7 reads them: the first ten each, those
//     that wrap others or whose key cannot be imported left out (key-entries.ts readableKeys, ID-1)
//   - a signed request answered 400 or 401 (RETRY_STATUSES) is sent once more at once, signed with RFC 9421 by the same
//     key (Signing.retry), hop by hop: the hop so answered is sent again, and the next hop starts with draft-cavage.
//     Mastodon 4.7's Request#perform resends the whole request from its first URL instead (docs/mastodon-deviations.md,
//     "Outbound HTTP signatures"); here each hop stays one this loop has checked. The retry passes the same checks as
//     any request (shape, policy, DNS) and is charged to the same budget, inside the same load's timeout; the first
//     answer's body is cancelled unread, and the second is read as any response
//   - search resolution's loader (createResolveLoader) sends Mastodon's FetchResourceService Accept and hands back a
//     200 answer of another type unread (OtherAnswer), its HTML body read only on demand, within the same rules
export const DOCUMENT_BODY_LIMIT = 1024 * 1024;
export const DOCUMENT_TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 5;

type Kind = {
  accept: string;
  // Whether the parsed Content-Type is acceptable, and the message when it is not.
  accepts: (media: MediaType) => boolean;
  refusal: string;
  // Whether the document must be a JSON object (see requireObjectRoot).
  objectRoot: boolean;
  // Whether its key entries are read as Mastodon 4.7 reads them (readableKeys): ActivityPub documents only.
  keyEntries: boolean;
};

const DOCUMENT: Kind = {
  accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  accepts: isActivityPubMediaType,
  refusal: "Not an ActivityPub document",
  objectRoot: true,
  keyEntries: true,
};

// Search resolution's first request and an alternate's (federation/resolve.ts): Mastodon's
// FetchResourceService::ACCEPT_HEADER (v4.7.5), HTML at a low weight; documents are taken as DOCUMENT takes them.
export const RESOLVE_ACCEPT =
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/activity+json, text/html;q=0.1';
const RESOLVE: Kind = { ...DOCUMENT, accept: RESOLVE_ACCEPT };

const CONTEXT_TYPES = new Set(["application/ld+json", "application/json", "application/activity+json"]);
const CONTEXT: Kind = {
  accept: "application/ld+json, application/json",
  accepts: (media) => CONTEXT_TYPES.has(media.essence),
  refusal: "Not a JSON-LD context",
  objectRoot: false,
  keyEntries: false,
};

// WebFinger answers (RFC 7033): JRD, as servers serve it. Never trusted as an ActivityPub object; only the actor link
// is read from it, and that actor is then fetched through the document loader.
const WEBFINGER_TYPES = new Set(["application/jrd+json", "application/json"]);
const WEBFINGER: Kind = {
  accept: "application/jrd+json, application/json",
  accepts: (media) => WEBFINGER_TYPES.has(media.essence),
  refusal: "Not a WebFinger document",
  objectRoot: true,
  keyEntries: false,
};

// A document refused by policy (scheme, host, redirect, type, size, id, root) or unusable as served. Fetching
// it again would not help.
export class RefusedFetchError extends FetchError {}

// A document refused only by a caller's tighter caps (DocumentCaps): what it holds is unknown, not refused by the rules
// above, and fetching it again under the same caps would not help.
export class CappedFetchError extends RefusedFetchError {}

// A 2xx answer read within the rules whose body is no usable document: not JSON, a root that is not an object (ID-8),
// or an id on another origin (ID-2). Search resolution tells it from the refusals above (federation/resolve.ts).
export class UnusableDocumentError extends RefusedFetchError {}

// A timeout or a network failure: fetching again may succeed.
export class TransientFetchError extends FetchError {}

// The request's fetch budget ran out (count, bytes or deadline). Not a verdict on the document: the same request may
// fit another time (cached contexts cost nothing), so it is transient and the request is answered 503 and retried.
export class BudgetExceededError extends TransientFetchError {}

// Whether a failed load may succeed if tried again: a timeout, a network error, or an HTTP 408, 429 or 5xx. Refusals and
// other HTTP errors (404, 410, ...) are permanent. An error that is not a FetchError (a Store refusal inside a signer,
// for one) is treated as transient.
export function isTransientLoadError(error: unknown): boolean {
  if (error instanceof RefusedFetchError) {
    return false;
  }
  if (error instanceof FetchError) {
    const status = error.response?.status;
    return status === undefined
      ? error instanceof TransientFetchError
      : status === 408 || status === 429 || status >= 500;
  }
  return true;
}

// The load failure behind an error that wraps it (JSON-LD reports a failed context fetch as its own error, with the
// loader's error as its cause), or undefined if there is none.
export function loadFailureOf(error: unknown, depth = 0): FetchError | undefined {
  if (error instanceof FetchError || depth > 8 || typeof error !== "object" || error === null) {
    return error instanceof FetchError ? error : undefined;
  }
  const { cause, details } = error as { cause?: unknown; details?: { cause?: unknown } };
  return loadFailureOf(cause, depth + 1) ?? loadFailureOf(details?.cause, depth + 1);
}

// What one inbound request may fetch in all (RES-6): documents, JSON-LD contexts, redirect hops and RFC 9421 retries
// share one count, one byte allowance and one deadline. Cache hits and preloaded contexts cost nothing.
export type FetchBudget = { fetches: number; bytes: number; deadline: number };

export const REQUEST_MAX_FETCHES = 8;
export const REQUEST_MAX_BYTES = 2 * 1024 * 1024;
export const REQUEST_DEADLINE_MS = 15_000;

export function requestBudget(now: number): FetchBudget {
  return { fetches: REQUEST_MAX_FETCHES, bytes: REQUEST_MAX_BYTES, deadline: now + REQUEST_DEADLINE_MS };
}

export type LoaderDeps = {
  fetch: typeof fetch;
  checkHost?: (url: URL) => Promise<void>;
  userAgent: string;
  timeoutMs?: number;
  // Shared by every loader of one request; none means only the per-load limits apply.
  budget?: FetchBudget;
  // The instance's domain policy (instance-domain-blocks.ts fetchRefused), asked before each request: true refuses the
  // host (a normalized domain) before any request. The answer may come from the Store answer that decided the fetch,
  // for its first request only (federation.ts refusesHost). Advisory: the Store's writes decide what is stored.
  refusesHost?: (host: string) => Promise<boolean>;
  // A caller's own refusal of a document read within the rules (RES-2's JSON bounds, federation.ts withinBounds), run
  // as part of reading its answer, so that its error carries the answer's status (answeredStatus).
  checkDocument?: (remote: RemoteDocument) => RemoteDocument;
} & DocumentCaps;

// Tighter per-document caps than the loader's own, for a caller whose documents must fit a round's budget together
// (federation/collections.ts NETWORK_CAPS): a body past `documentBytes` (UTF-8 bytes as served, checked before it is
// parsed), or a redirect past `maxRedirects`, is refused with CappedFetchError. None means DOCUMENT_BODY_LIMIT and
// MAX_REDIRECTS.
export type DocumentCaps = { documentBytes?: number; maxRedirects?: number };

export type RequestSigner = (request: Request) => Promise<Request>;

// How a loader signs: `sign` signs every request; `retry`, when given, signs the one more send of a request answered
// with one of RETRY_STATUSES. Each signs an unsigned request.
export type Signing = { sign: RequestSigner; retry?: RequestSigner | undefined };

// Mastodon 4.7 sends a signed request answered with one of these once more with an RFC 9421 signature (request.rb
// Request#perform); so does the delivery sink, and the loader for each redirect hop.
export const RETRY_STATUSES: ReadonlySet<number> = new Set([400, 401]);

export const dnsCheckHost = (url: URL): Promise<void> => validatePublicUrl(url.href);

// The loader of documents trusted as ActivityPub objects or keys (Fedify's document loaders).
export function createSafeLoader(deps: LoaderDeps, signing?: Signing): DocumentLoader {
  return createLoader(deps, DOCUMENT, signing);
}

// ID-8: an ActivityPub document must be a JSON object. JSON-LD reads a string root as the URL of the real document and
// fetches it with the context loader, which takes plain JSON, so an uploaded file could become an object or a key.
// Applied in the loader and again around caches, whose hits do not pass through the loader.
export function requireObjectRoot(loader: DocumentLoader): DocumentLoader {
  return async (url, options) => assertObjectRoot(await loader(url, options));
}

function assertObjectRoot(remote: RemoteDocument): RemoteDocument {
  const { document } = remote;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new UnusableDocumentError(remote.documentUrl, "Document root is not a JSON object");
  }
  return remote;
}

// The loader of JSON-LD contexts (Fedify's context loader), which are never trusted as objects.
export function createContextLoader(deps: LoaderDeps): DocumentLoader {
  return createLoader(deps, CONTEXT);
}

// The loader of WebFinger documents (search resolution of user@domain), unsigned, with NET-1's rules and the budget.
export function createWebFingerLoader(deps: LoaderDeps): DocumentLoader {
  return createLoader(deps, WEBFINGER);
}

function createLoader(deps: LoaderDeps, kind: Kind, signing?: Signing): DocumentLoader {
  return async (url, options) => {
    // A signal aborted before the call never fires 'abort' again, so it is checked up front.
    options?.signal?.throwIfAborted();
    if (url in preloadedContexts) {
      return { contextUrl: null, document: preloadedContexts[url], documentUrl: url };
    }
    const target = new URL(url);
    const cap = deps.documentBytes ?? DOCUMENT_BODY_LIMIT;
    return withinDeadline(deps, target, options?.signal, (signal) =>
      load(deps, kind, signing, target, signal, async (response, final) =>
        checked(deps, await readDocument(response, kind, final, target, deps.budget, cap)),
      ),
    );
  };
}

function checked(deps: LoaderDeps, remote: RemoteDocument): RemoteDocument {
  return deps.checkDocument === undefined ? remote : deps.checkDocument(remote);
}

// The status of the answer whose reading threw `error` (load marks it, `answered`): a non-2xx, or a 2xx refused for its
// type, its size (the document's cap or the request's remaining bytes, RES-6), its root or its id. Null for a request
// that got no answer: refused before it was sent (NET-1, the domain policy, the request's fetches or deadline), a
// network error, a timeout, or a redirect refused. Search resolution reads it as Mastodon's
// FetchResourceService#response_code (federation/resolve.ts), set before the body is read within its limit.
const answered = new WeakMap<object, number>();

export function answeredStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null ? (answered.get(error) ?? null) : null;
}

// `run` under the load's timeout and the request's deadline, given up at either or at an abort of `outer`.
async function withinDeadline<T>(
  deps: LoaderDeps,
  target: URL,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = deps.timeoutMs ?? DOCUMENT_TIMEOUT_MS;
  const left = deps.budget === undefined ? timeoutMs : deps.budget.deadline - Date.now();
  if (left <= 0) {
    throw new BudgetExceededError(target, "Request fetch deadline exhausted");
  }
  const limit = Math.min(timeoutMs, left);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TransientFetchError(target, `Timed out after ${limit} ms`)),
    limit,
  );
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onAbort, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason as Error), { once: true });
  });
  const running = run(controller.signal);
  // After a timeout the abandoned run may still reject; that rejection is not this call's result.
  running.catch(() => {});
  try {
    // The race makes the deadline hold even if a fetch or a body read ignores the signal.
    return await Promise.race([running, aborted]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

// The hops of one load from `target`, the last answer handed to `read`; `follow` false hands a redirect over as any
// answer. An error `read` throws is marked with that answer's status (answeredStatus), unless the load was given up
// (its timeout or deadline).
async function load<T>(
  deps: LoaderDeps,
  kind: Kind,
  signing: Signing | undefined,
  target: URL,
  signal: AbortSignal,
  read: (response: Response, final: URL) => Promise<T>,
  follow = true,
): Promise<T> {
  let current = target;
  for (let redirects = 0; ; redirects++) {
    let response = await send(deps, kind, current, signing?.sign, signal);
    if (signing?.retry !== undefined && RETRY_STATUSES.has(response.status)) {
      await response.body?.cancel();
      response = await send(deps, kind, current, signing.retry, signal);
    }
    if (follow && response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") ?? "", current);
      if (next.origin !== target.origin) {
        throw new RefusedFetchError(current, `Refused cross-origin redirect to ${next.origin}`);
      }
      const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
      if (redirects >= maxRedirects) {
        throw maxRedirects < MAX_REDIRECTS
          ? new CappedFetchError(current, `Redirects past the caller's cap (${redirects + 1})`)
          : new RefusedFetchError(current, `Too many redirects (${redirects + 1})`);
      }
      current = next;
      continue;
    }
    try {
      return await read(response, response.url === "" ? current : new URL(response.url));
    } catch (error) {
      if (!signal.aborted && typeof error === "object" && error !== null) {
        answered.set(error, response.status);
      }
      throw error;
    }
  }
}

// What search resolution's request answered (federation/resolve.ts): an ActivityPub document, read as the document
// loader reads one, or a 200 answer of any other type (OtherAnswer).
export type ResolveAnswer = { kind: "document"; remote: RemoteDocument } | OtherAnswer;

// A 200 answer that is not an ActivityPub document, its body unread: its Link header as the runtime joins its fields
// (null without one), and `page`, for a text/html answer (its media type's essence: parameters stripped, ASCII
// lowercase), which reads the body whole (readPage). `discard` cancels the body unread; it is a no-op once read.
export type OtherAnswer = {
  kind: "other";
  link: string | null;
  page: (() => Promise<HtmlBody>) | null;
  discard: () => void;
};

// Search resolution's loader: the document loader's rules under RESOLVE_ACCEPT, as Mastodon's FetchResourceService
// requests (v4.7.5). The first request (`terminal` false) follows redirects as any document fetch (same origin, at most
// MAX_REDIRECTS) and hands back a 200 answer of another type unread; a terminal one, an alternate's, follows none and
// takes only a 200 answer (Mastodon's `follow: false` and `response.code != 200`): any other status, a redirect's
// included, is refused with that status.
export function createResolveLoader(
  deps: LoaderDeps,
  signing?: Signing,
): (url: string, terminal: boolean) => Promise<ResolveAnswer> {
  const cap = deps.documentBytes ?? DOCUMENT_BODY_LIMIT;
  return (url, terminal) => {
    const target = new URL(url);
    const read = async (response: Response, final: URL): Promise<ResolveAnswer> => {
      if (terminal && response.status !== 200) {
        await response.body?.cancel();
        throw statusError(response, final);
      }
      if (final.origin === target.origin && response.status === 200) {
        const media = parseMediaType(response.headers.get("content-type") ?? "");
        if (media === null || !isActivityPubMediaType(media)) {
          return otherAnswer(response, media, final, deps);
        }
      }
      return {
        kind: "document",
        remote: checked(deps, await readDocument(response, RESOLVE, final, target, deps.budget, cap)),
      };
    };
    return withinDeadline(deps, target, undefined, (signal) =>
      load(deps, RESOLVE, signing, target, signal, read, !terminal),
    );
  };
}

function otherAnswer(response: Response, media: MediaType | null, final: URL, deps: LoaderDeps): OtherAnswer {
  return {
    kind: "other",
    link: response.headers.get("link"),
    page: media?.essence === "text/html" ? () => readPage(response, media, final, deps) : null,
    discard: () => {
      response.body?.cancel().catch(() => {});
    },
  };
}

// The body of a text/html answer, read whole as Mastodon's body_with_limit reads it: refused past DOCUMENT_BODY_LIMIT
// by its Content-Length before any byte is read or as it is read, and past the request's bytes (RES-6), which it is
// charged to; decoded and its charset chosen as the web-page sink does (platform/html-body.ts readHtmlBody: an encoding
// workerd does not decode is refused); within a timeout of its own (the load's) and the request's deadline.
async function readPage(response: Response, media: MediaType, final: URL, deps: LoaderDeps): Promise<HtmlBody> {
  const limit = Math.min(DOCUMENT_BODY_LIMIT, deps.budget?.bytes ?? DOCUMENT_BODY_LIMIT);
  const tooLarge = () =>
    limit < DOCUMENT_BODY_LIMIT
      ? new BudgetExceededError(final, `Request byte budget exhausted (${limit} bytes left)`)
      : new RefusedFetchError(final, `Document exceeds ${limit} bytes`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const html = await withinDeadline(deps, final, undefined, (signal) => {
    const stopped = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    });
    stopped.catch(() => {});
    return readHtmlBody(response, media, limit, (read) => Promise.race([read, stopped]));
  });
  if (html === "encoding") {
    await response.body?.cancel();
    throw new RefusedFetchError(
      final,
      `Undecoded content encoding: ${response.headers.get("content-encoding") ?? "none"}`,
    );
  }
  if (html.limitReached) {
    throw tooLarge();
  }
  if (deps.budget !== undefined) {
    deps.budget.bytes -= html.bytes.byteLength;
  }
  return html;
}

// A status the caller does not take (non-ok, or a terminal resolve request's 2xx other than 200), as Fedify reads one:
// the status and headers kept, not the body.
function statusError(response: Response, final: URL): FetchError {
  return new FetchError(
    final,
    `HTTP ${response.status}: ${final.href}`,
    new Response(null, { status: response.status, headers: response.headers }),
  );
}

// One request to `current`. The policy is asked before every request, a redirect's and a retry's included, and no
// answer outlives an awaited response (a prepared verdict serves only a request with none before it): a block that
// commits while a response is awaited stops the next request.
async function send(
  deps: LoaderDeps,
  kind: Kind,
  current: URL,
  sign: RequestSigner | undefined,
  signal: AbortSignal,
): Promise<Response> {
  assertPublicShape(current);
  if (deps.refusesHost !== undefined && (await deps.refusesHost(hostDomain(current.href)))) {
    throw new RefusedFetchError(current, `Refused host ${current.hostname}: blocked by the instance`);
  }
  await assertFetchable(current, deps.checkHost ?? dnsCheckHost);
  if (deps.budget !== undefined) {
    if (deps.budget.fetches <= 0) {
      throw new BudgetExceededError(current, "Request fetch budget exhausted");
    }
    deps.budget.fetches--;
  }
  const unsigned = new Request(current, {
    headers: { accept: kind.accept, "user-agent": deps.userAgent },
    redirect: "manual",
    signal,
  });
  const request = sign === undefined ? unsigned : await sign(unsigned);
  try {
    return await deps.fetch(request);
  } catch {
    throw signal.aborted ? (signal.reason as Error) : new TransientFetchError(current, "Network error");
  }
}

async function readDocument(
  response: Response,
  kind: Kind,
  final: URL,
  target: URL,
  budget: FetchBudget | undefined,
  cap: number,
): Promise<RemoteDocument> {
  if (final.origin !== target.origin) {
    await response.body?.cancel();
    throw new RefusedFetchError(final, `Refused document redirected to ${final.origin}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Keep the status for Fedify (it treats 404 and 410 differently from transient failures), not the body.
    throw statusError(response, final);
  }
  const media = parseMediaType(response.headers.get("content-type") ?? "");
  if (media === null || !kind.accepts(media)) {
    await response.body?.cancel();
    throw new RefusedFetchError(final, `${kind.refusal}: ${response.headers.get("content-type") ?? "none"}`);
  }
  // Overflow is judged against the effective cap: below it, the request's bytes ran out.
  const limit = Math.min(cap, budget?.bytes ?? cap);
  const body = await readBoundedBody(response, limit);
  if (body === "too-large") {
    throw limit < cap
      ? new BudgetExceededError(final, `Request byte budget exhausted (${limit} bytes left)`)
      : cap < DOCUMENT_BODY_LIMIT
        ? new CappedFetchError(final, `Document exceeds the caller's cap of ${cap} bytes`)
        : new RefusedFetchError(final, `Document exceeds ${limit} bytes`);
  }
  if (budget !== undefined) {
    budget.bytes -= body.byteLength;
  }
  // Fedify parses the bounded bytes, so a JSON-LD context given in a Link header is applied as Fedify applies it.
  // Fedify's alternate-document links are not followed: only JSON types reach this point (search resolution follows
  // Mastodon's alternates itself, federation/resolve.ts). Fedify compares the Content-Type case-sensitively, so it is
  // given the parsed essence.
  const headers = new Headers(response.headers);
  headers.set("content-type", media.essence);
  let remote: RemoteDocument;
  try {
    remote = await getRemoteDocument(final.href, new Response(body, { headers }), () =>
      Promise.reject(new RefusedFetchError(final, "Refused alternate document link")),
    );
  } catch (error) {
    throw error instanceof FetchError ? error : new UnusableDocumentError(final, "Document is not valid JSON");
  }
  // A cheap pre-filter only: it sees the literal id and @id, not a JSON-LD alias of @id. The identity that counts is
  // the parsed object's id, which Fedify's consumers compare with this documentUrl (fetchKey for signature keys,
  // lookupObject's crossOrigin check for objects; test/remote-identity.test.ts). Code that parses fetched documents
  // itself must make the same check.
  const id = documentId(remote.document);
  if (id !== undefined && originOf(id) !== final.origin) {
    throw new UnusableDocumentError(final, `Document id ${id} is not on ${final.origin}`);
  }
  // ID-1: a document's key entries as Mastodon 4.7 reads them (key-entries.ts readableKeys). A context given in a Link
  // header applies before the document's own, so the document's alone does not establish what its terms mean.
  const document =
    kind.keyEntries && remote.contextUrl === null ? await readableKeys(remote.document) : remote.document;
  const loaded = { ...remote, document, documentUrl: final.href };
  return kind.objectRoot ? assertObjectRoot(loaded) : loaded;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function documentId(document: unknown): string | undefined {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return undefined;
  }
  const record = document as Record<string, unknown>;
  const id = record.id ?? record["@id"];
  return typeof id === "string" ? id : undefined;
}

async function assertFetchable(url: URL, checkHost: (url: URL) => Promise<void>): Promise<void> {
  assertPublicShape(url);
  try {
    await checkHost(url);
  } catch (error) {
    throw new RefusedFetchError(url, `Refused host ${url.hostname}: ${errorMessage(error)}`);
  }
}

// NET-1's rules that need no lookup (publicShapeRefusal), as a refused fetch. Shared by every outbound sink (NET-3); the
// DNS check (checkHost) runs after it.
export function assertPublicShape(url: URL): void {
  const refusal = publicShapeRefusal(url);
  if (refusal !== null) {
    throw new RefusedFetchError(url, refusal);
  }
}
