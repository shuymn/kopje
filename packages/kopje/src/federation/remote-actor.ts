import { type DocumentLoader, exportSpki, FetchError, type RemoteDocument } from "@fedify/fedify";
import { type Actor, getActorTypeName, isActor, lookupObject, Multikey } from "@fedify/vocab";

import { collectionValue } from "../domain/collection-requests";
import { ACTOR_URI_LIMIT } from "../domain/profile-bounds";
import type { Handle, RemoteActorInput, RemoteFeaturePolicyInput } from "../domain/remote-actors";
import { hostDomain, normalizeDomain } from "../platform/domain-name";
import { boundedHref, httpUrl } from "../platform/http-url";
import { DOMAIN_BYTES, isRemoteUsername, isStorableActorId, REMOTE_USERNAME_LIMIT } from "../platform/identity-bounds";
import { railsBlank } from "../platform/rails-blank";
import { railsBoolean } from "../platform/rails-boolean";
import { storedDisplayName, storedProfileDescription, storedProfileUrl, storedText } from "../platform/stored-bounds";
import { sanitizeRemoteBio } from "../security/html";
import { isObject, railsTime } from "./json-shapes";
import { MAX_PUBLIC_KEYS, readableKeys } from "./key-entries";
import { remoteDescription } from "./lang-string";
import { isTransientLoadError, loadFailureOf } from "./loader";
import { emojiCandidates } from "./remote-emoji";
import { policyHalf } from "./remote-status";

// Remote actors as Kopje stores them: fetched through the safe loader (NET-1, ID-8), parsed by Fedify's lookupObject,
// which checks the parsed id against the document's origin (ID-2), and reduced to bounded, safe columns.

// Raw caps (RES-1): the display name is plain text and is cut (storedDisplayName), as Mastodon cuts what it
// receives. Text is stored as platform/stored-bounds.ts storedText writes it.
// Actor ids and inbox URLs (RES-6): a delivery target is an inbox and, for a silent recipient, an actor id, so their
// length bounds a target. This cap is Kopje's own interoperability policy, not another server's behaviour: Mastodon
// sets no length limit, and Misskey stores inbox URLs in 512-character columns. Real servers use far shorter URLs.
// A serialized URL is ASCII, so its length is its size in bytes.
export const INBOX_URL_LIMIT = 2048;
export { ACTOR_URI_LIMIT };

export type FetchedActor =
  | { kind: "ok"; actor: Actor; input: RemoteActorInput | null }
  // Fetching again may succeed (timeout, network error, 5xx).
  | { kind: "transient" }
  // The document answers 404 or 410: the actor is gone. url: the URL that answered, after the same-origin redirects
  // the safe loader follows (its FetchError's, loader.ts readDocument); only a 410 at the actor URI itself starts a
  // deletion (actor-gone.ts).
  | { kind: "gone"; status: 404 | 410; url: string }
  // Refused, or not an actor with exactly this id.
  | { kind: "unusable" };

// Loads the actor at uri. The document is loaded once through `loader` and handed to lookupObject, which therefore
// never falls back to its own WebFinger lookup (that would fetch outside the safe loader). An actor whose id is not
// exactly uri is unusable.
export async function fetchActor(
  uri: string,
  loader: DocumentLoader,
  contextLoader: DocumentLoader,
): Promise<FetchedActor> {
  const loaded = await loadActor(uri, loader, contextLoader);
  return loaded.kind === "ok"
    ? { kind: "ok", actor: loaded.actor, input: await remoteActorInput(loaded.actor, loaded.document) }
    : loaded;
}

type ReadActor = { kind: "ok"; actor: Actor; document: unknown } | { kind: "transient" } | { kind: "unusable" };

// fetchActor's load and parse, without reading the document into a remote account's columns: the parsed actor and
// the document as loaded.
export async function loadActor(
  uri: string,
  loader: DocumentLoader,
  contextLoader: DocumentLoader,
): Promise<ReadActor | Extract<FetchedActor, { kind: "gone" }>> {
  let remote: RemoteDocument;
  try {
    remote = await loader(uri);
  } catch (error) {
    const status = error instanceof FetchError ? error.response?.status : undefined;
    if (error instanceof FetchError && (status === 404 || status === 410)) {
      return { kind: "gone", status, url: error.url.href };
    }
    return { kind: isTransientLoadError(error) ? "transient" : "unusable" };
  }
  return readActor(uri, remote, contextLoader);
}

// The members of an actor document Fedify is handed, by their literal spelling, each with what reads it from Fedify's
// object (test-node/actor-members.test.ts holds every Actor property remote-actor.ts and inbound.ts read to an entry).
// Fedify 2.4.5 expands the document before it reads a member, so it reads a member by its IRI whatever the spelling,
// and fails the whole actor on one it cannot decode (an `icon` that is not an Image, an unreadable `updated`, an
// invalid language map), where Mastodon 4.7 reads every member by its literal spelling (`@json[...]`) and stores the
// account. Every member outside this inventory, in any spelling, is read from the document's JSON by spelling
// (profileUrl, profileImage, collection-requests.ts collectionUri and namedMove, sharedInboxUri, claimedHandle,
// emojiCandidates, remoteActorInput's flags) or not at all. So the literal top-level `movedTo` is never handed to
// Fedify; a kept member a context maps to `as:movedTo` still is, and Kopje reads no move from it (namedMove reads the
// literal key alone, as Mastodon does).
const FEDIFY_MEMBERS: Readonly<Record<string, string>> = {
  "@context": "JSON-LD expansion",
  id: "lookupObject's id check (ID-2), readActor",
  type: "Fedify's dispatch to an Actor class, getActorTypeName",
  preferredUsername: "claimedHandle",
  inbox: "remoteActorInput",
  name: "remoteActorInput",
  summary: "remoteActorInput",
  alsoKnownAs: "inbound.ts Move",
  publicKey: "ownKeys; the HTTP signature's and the LD signature's key (ID-1)",
  assertionMethod: "ownKeys; the author proof's key (ID-1)",
  owner: "a key document at the key's URL (actorViewLoader): its owner",
  controller: "a Multikey document at the key's URL: its controller",
  publicKeyPem: "a key document at the key's URL: the key",
  publicKeyMultibase: "a Multikey document at the key's URL: the key",
};

// The only form of an actor document Fedify is handed (readActor, actorViewLoader, author-proof.ts verifyAuthorProof):
// a shallow copy holding the members of FEDIFY_MEMBERS the document has, by their literal spelling, and nothing else
// (no `@id`, `@type` or other keyword spelling: Mastodon reads `id` and `type`). Leaving a member out never grants
// anything: the id Fedify checks (ID-2) and the keys it finds (ID-1) are the document's own, or none. A kept member
// Fedify cannot decode still refuses the actor (docs/mastodon-deviations.md). Anything that is not an object is
// returned as it is.
export function fedifyActorView(document: unknown): unknown {
  if (!isObject(document)) {
    return document;
  }
  return Object.fromEntries(Object.entries(document).filter(([key]) => Object.hasOwn(FEDIFY_MEMBERS, key)));
}

// `loader` answering each document as fedifyActorView gives it: the loader Fedify is handed where it loads documents
// itself (inbound.ts verifyHttpSignature: a key it fetches, at the key's URL or as its owner's document). A key
// document keeps what Fedify reads of it (FEDIFY_MEMBERS: its id, type, owner or controller and key).
export function actorViewLoader(loader: DocumentLoader): DocumentLoader {
  return async (url, options) => {
    const remote = await loader(url, options);
    return { ...remote, document: fedifyActorView(remote.document) };
  };
}

// An actor document as served at `uri`, parsed by Fedify's lookupObject over a loader that answers its view
// (fedifyActorView) alone: nothing is fetched but its JSON-LD contexts, through `contextLoader`. lookupObject asks its
// loader only for the URI it was given (as it parses it: without verifyPortableObject it takes no portable path), and
// never falls back to its own WebFinger lookup, which would fetch outside the safe loader. An actor whose id is not
// exactly uri is unusable. The document answered is the one served.
async function readActor(uri: string, served: RemoteDocument, contextLoader: DocumentLoader): Promise<ReadActor> {
  const view = { ...served, document: fedifyActorView(served.document) };
  let object: unknown;
  try {
    object = await lookupObject(uri, { documentLoader: () => Promise.resolve(view), contextLoader });
  } catch (error) {
    // A JSON-LD context that failed to load for a reason that may pass is transient too; only a document that
    // cannot be read as served is unusable.
    const failure = loadFailureOf(error);
    return { kind: failure !== undefined && isTransientLoadError(failure) ? "transient" : "unusable" };
  }
  if (!isActor(object) || object.id?.href !== uri) {
    return { kind: "unusable" };
  }
  return { kind: "ok", actor: object, document: served.document };
}

// The actor document an activity embeds (an Update(Person)'s object, docs/threat-model.md ID-1), read as a fetched one
// is: its key entries as the safe loader reads a fetched document's (key-entries.ts readableKeys), then readActor and
// remoteActorInput. It is served under the actor's URI with the activity's @context before its own (`context`), as
// JSON-LD nests the object in the activity and Mastodon reads it under the activity's compacted context. Nothing is
// fetched but its JSON-LD contexts, through the request's context loader and budget (RES-6); its size is the
// activity's (inbound.ts parseActivity, RES-2). Unusable: no actor of exactly `uri`, or one remoteActorInput refuses.
export async function readEmbeddedActor(
  uri: string,
  object: Record<string, unknown>,
  context: unknown,
  contextLoader: DocumentLoader,
): Promise<{ kind: "ok"; input: RemoteActorInput } | { kind: "transient" } | { kind: "unusable" }> {
  const own = object["@context"];
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);
  const document = { ...object, "@context": own === undefined ? context : [...list(context), ...list(own)] };
  const served = { contextUrl: null, documentUrl: uri, document: await readableKeys(document) };
  const read = await readActor(uri, served, contextLoader);
  if (read.kind !== "ok") {
    return read;
  }
  const input = await remoteActorInput(read.actor, read.document);
  return input === null ? { kind: "unusable" } : { kind: "ok", input };
}

// A natural-language value: a plain string or Fedify's LanguageString (a String with a language tag).
function text(value: string | { toString(): string } | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

// A profile URL: http(s) (HTML-3) and within its stored bound, else none, as an invalid one.
function storedHref(value: string | null): string | null {
  return storedProfileUrl(httpUrl(value)?.href ?? null);
}

// Keys are taken only when embedded: a reference would cost another fetch per actor (RES-6).
const NO_FETCH: DocumentLoader = () => Promise.reject(new Error("not fetched"));

// An icon or image (avatar or header) as Mastodon 4.7 reads it from the document's JSON by spelling
// (ProcessAccountService#image_url_and_description, process_account_service.rb:354-379): the member's first value; an
// object whose type is the string "Image" gives its url's first value (a Link's href) and its description, read by
// remoteDescription (summary, else name) and cut to PROFILE_DESCRIPTION_LIMIT code points (Mastodon cuts at 10,000;
// docs/mastodon-deviations.md); any other object gives its own href and no description; an href is unwrapped once
// more, as Mastodon unwraps it after either branch. A reference (a string) is not fetched (RES-6), so it gives none,
// where Mastodon fetches it. The URL is kept as storedHref keeps it (HTML-3, RES-2): a relative one is none, as
// Mastodon's avatar_remote_url= refuses a URL without a scheme and host. Mastodon assigns `url || ''` and
// `description || ''` on every processing, so a document without them clears the stored ones.
export function profileImage(value: unknown): { url: string | null; description: string } {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  if (!isObject(first)) {
    return { url: null, description: "" };
  }
  let url: unknown = first;
  let description = "";
  if (first.type === "Image") {
    url = Array.isArray(first.url) ? first.url[0] : first.url;
    url = isObject(url) ? url.href : url;
    description = storedProfileDescription(remoteDescription(first));
  }
  url = isObject(url) ? url.href : url;
  return { url: typeof url === "string" ? storedHref(url) : null, description };
}

// A display setting (Mastodon 4.6's showFeatured, showMedia, showRepliesInMedia, read from the document's JSON by
// spelling, process_account_service.rb:258-260) when the document holds a JSON boolean for it; else null, and the
// stored value is kept, as Mastodon keeps it when the key is absent (docs/mastodon-deviations.md: it casts any other
// value, and fails on null).
function displaySetting(document: Record<string, unknown>, key: string): boolean | null {
  const value = document[key];
  return typeof value === "boolean" ? value : null;
}

// The keys of this actor (ID-1): its FEP-521a Multikeys (assertionMethod), then its legacy keys (publicKey), embedded
// in its document, the first of each id kept, as Mastodon 4.7 orders them (ProcessAccountService#public_keys). A key
// is the actor's only if its id has the actor's origin, it names no other owner (a legacy key's owner, a Multikey's
// controller), it is RSA or Ed25519 (what Fedify imports), and its id is among the first MAX_PUBLIC_KEYS ids the actor
// lists in its property (as Fedify parsed them, whatever the document's context), so one store writes at most
// 2 × MAX_PUBLIC_KEYS keys (RES-6). Keys listed by reference are not fetched (RES-6; inbound.ts withVerifiedReference
// takes a legacy one the signature's verification resolved). Stored as PEM-SPKI, whose algorithm is the key type.
export async function ownKeys(actor: Actor, uri: URL): Promise<{ id: string; pem: string }[]> {
  const options = { documentLoader: NO_FETCH, contextLoader: NO_FETCH, suppressError: true };
  const forms = [
    { listed: actor.assertionMethodIds, keys: () => actor.getAssertionMethods(options) },
    { listed: actor.publicKeyIds, keys: () => actor.getPublicKeys(options) },
  ];
  const keys: { id: string; pem: string }[] = [];
  for (const form of forms) {
    const listed = new Set(form.listed.slice(0, MAX_PUBLIC_KEYS).map((id) => id.href));
    try {
      for await (const key of form.keys()) {
        const owner = key instanceof Multikey ? key.controllerId : key.ownerId;
        const id = key.id?.href;
        if (
          id === undefined ||
          !listed.has(id) ||
          keys.some((kept) => kept.id === id) ||
          key.id!.origin !== uri.origin ||
          (owner !== null && owner.href !== uri.href) ||
          key.publicKey === null ||
          !KEY_ALGORITHMS.has(key.publicKey.algorithm.name)
        ) {
          continue;
        }
        keys.push({ id, pem: await exportSpki(key.publicKey) });
      }
    } catch {
      // A key that does not parse ends its form's list.
    }
  }
  return keys;
}

const KEY_ALGORITHMS: ReadonlySet<string> = new Set(["RSASSA-PKCS1-v1_5", "Ed25519"]);

// The longest webfinger value read: `acct:`, a username, `@` and a domain at their bounds.
const CLAIM_LIMIT = 5 + REMOTE_USERNAME_LIMIT + 1 + DOMAIN_BYTES;

// The handle an actor document claims, as Mastodon 4.7 reads it (ProcessAccountService#extract_username_and_domain!):
// its FEP-2c59 `webfinger`, read from the document's JSON by that spelling, when it is a string of at most CLAIM_LIMIT
// UTF-16 code units that, without a leading `acct:`, holds exactly one `@` between a username isRemoteUsername accepts
// and a domain normalizeDomain accepts (normalized); else its preferredUsername (as Fedify parsed it) at the actor id's
// normalized host; else null, and the document is not an actor Kopje stores. Mastodon splits `a@b@c` into a and b, and
// checks the username only after WebFinger; Kopje reads such a value as malformed and falls back. The claim is only
// a candidate: the Store takes a handle once WebFinger confirms it (federation/resolve.ts confirmHandle,
// domain/remote-actors.ts acceptedHandle).
export function claimedHandle(document: unknown, uri: string, preferredUsername: string | null): Handle | null {
  const webfinger =
    typeof document === "object" && document !== null ? (document as { webfinger?: unknown }).webfinger : undefined;
  if (typeof webfinger === "string" && webfinger.length <= CLAIM_LIMIT) {
    const parts = webfinger.replace(/^acct:/, "").split("@");
    const domain = parts.length === 2 ? normalizeDomain(parts[1]!) : null;
    if (domain !== null && isRemoteUsername(parts[0]!)) {
      return { username: parts[0]!, domain };
    }
  }
  const host = normalizeDomain(hostDomain(uri));
  return preferredUsername !== null && isRemoteUsername(preferredUsername) && host !== null
    ? { username: preferredUsername, domain: host }
    : null;
}

// Object#blank? of a member's JSON value (ActiveSupport): missing, null, false, a string of whitespace alone
// (railsBlank), an empty array or an empty object.
function blank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (typeof value === "string" && railsBlank(value)) ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0)
  );
}

// Whether the document's own `inbox` member is blank as Mastodon 4.7 reads it (`json['inbox'].blank?`,
// ProcessAccountService#call, process_account_service.rb:24). A value that is not blank but no inbox URL is not
// refused here (Mastodon stores no inbox for it, valid_collection_uri).
function blankInbox(document: unknown): boolean {
  return blank(isObject(document) ? document.inbox : undefined);
}

// The profile URL an actor document's `url` member offers, as Mastodon 4.7.5 chooses it (ProcessAccountService#url,
// process_account_service.rb:454-465, through JsonLdHelper#url_to_href(value, 'text/html'), json_ld_helper.rb:46-61):
// an object is read as an array of it; an array whose first value is a string gives that string alone, any other
// array the value htmlLink finds; an object gives its href. That one candidate is the URL only when it is a string
// with a literal `http://` or `https://` prefix (unsupported_uri_scheme?, :95-97) whose host is the actor id's,
// whatever the scheme and port (mismatching_origin?, process_account_service.rb:475-480), and within storedHref's
// bound (HTML-3, RES-2); else none, and no later candidate is tried. A blank member (Mastodon's early return) gives
// none by these rules. A presenter then shows the actor id, as Mastodon stores `url || @uri` (:228). Hosts are compared
// as the URL parser reads them, where Mastodon compares Addressable's raw host ASCII case-insensitively, and a value on
// which Mastodon raises (a member neither a string, a Link nor an array of them; a href neither a string nor null) is
// none (docs/mastodon-deviations.md; test/fixtures/profile-url/urls.json holds Mastodon's answer for each form).
export function profileUrl(value: unknown, actorId: URL): string | null {
  const list = isObject(value) ? [value] : value;
  const chosen = Array.isArray(list) ? (typeof list[0] === "string" ? list[0] : htmlLink(list)) : list;
  const href = isObject(chosen) ? chosen.href : chosen;
  if (typeof href !== "string" || !(href.startsWith("http://") || href.startsWith("https://"))) {
    return null;
  }
  const url = httpUrl(href);
  return url !== null && url.hostname === actorId.hostname ? storedProfileUrl(url.href) : null;
}

// url_to_href's `find` with 'text/html' preferred: the first value that is an object whose mimeType is blank or
// exactly `text/html` (mediaType is not read), or a string, which Ruby's String#[] reads as a Link without a mimeType
// unless it holds the text `mimeType`. undefined when there is none, or at a value before it that is neither, on which
// Mastodon raises.
export function htmlLink(list: readonly unknown[]): unknown {
  for (const link of list) {
    if (typeof link === "string") {
      if (!link.includes("mimeType")) {
        return link;
      }
    } else if (isObject(link)) {
      if (blank(link.mimeType) || link.mimeType === "text/html") {
        return link;
      }
    } else {
      return undefined;
    }
  }
  return undefined;
}

// The actor's shared inbox as Mastodon 4.7.5 reads it (process_account_service.rb:225): `endpoints.sharedInbox` when
// `endpoints` is an object (not an array, not null), else the document's own `sharedInbox`, unwrapped as
// valid_collection_uri unwraps it (collection-requests.ts collectionValue). It is kept only when Kopje POSTs where
// Mastodon POSTs (sharedInboxSpelling), as the URL parser writes it, within INBOX_URL_LIMIT; else it is none and the
// personal inbox is used, never a guessed one (docs/mastodon-deviations.md).
function sharedInboxUri(document: Record<string, unknown>): string | null {
  const member = isObject(document.endpoints) ? document.endpoints.sharedInbox : document.sharedInbox;
  const value = collectionValue(member);
  return value !== null && sharedInboxSpelling(value) ? boundedHref(value, INBOX_URL_LIMIT) : null;
}

// RFC 3986's pchar literals: unreserved, sub-delims, ":" and "@".
const PCHAR = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/;
// A scheme, an authority of host and port, and a path; nothing else (no userinfo, query or fragment). Each part's
// pattern is anchored by the next part's first character, so it matches in linear time.
const SPELLING = /^https?:\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::([0-9]*))?((?:\/[^/]*)*)$/;

// Whether `value` is a spelling on which Mastodon's delivery URL (Request#initialize, request.rb:97: Addressable
// 2.9.2's `parse(url).normalize`, :212-214, a query aside) and the URL parser's href are the same URL. Each rule
// removes a class of spellings on which they differ or are not shown alike (test/fixtures/shared-inbox/spellings.json,
// captured by its capture.rb): the scheme lower-case with `//`; the host of ASCII letters, digits and hyphens in
// labels, none empty (a trailing dot), the last beginning with a letter (no IP address, nothing the URL parser reads as
// one); no userinfo; a port of digits whose value is 1 to 65535 (empty and leading zeros are written alike); a path of
// pchar literals and `%HH` escapes, no segment `.` or `..`, each escape upper-case, below %80 and not of a pchar literal
// (neither side decodes, re-cases or re-encodes it); no query or fragment.
function sharedInboxSpelling(value: string): boolean {
  const parts = SPELLING.exec(value);
  if (parts === null) {
    return false;
  }
  const [, host = "", port = "", path = ""] = parts;
  if (!/^[A-Za-z]/.test(host.slice(host.lastIndexOf(".") + 1))) {
    return false;
  }
  if (port !== "" && !(Number(port) >= 1 && Number(port) <= 65535)) {
    return false;
  }
  return path
    .split("/")
    .slice(1)
    .every((segment) => segment !== "." && segment !== ".." && pcharSegment(segment));
}

function pcharSegment(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] !== "%") {
      if (!PCHAR.test(segment[i]!)) {
        return false;
      }
      continue;
    }
    const escape = segment.slice(i + 1, i + 3);
    if (!/^[0-7][0-9A-F]$/.test(escape) || PCHAR.test(String.fromCharCode(Number.parseInt(escape, 16)))) {
      return false;
    }
    i += 2;
  }
  return true;
}

// The columns of a remote account (null if the document cannot be one). Display names are plain text; the bio is
// sanitized HTML (HTML-1); URLs are http(s) or null (HTML-3). Misskey's extensions (_misskey_summary, isCat, ...) are
// not interpreted; they stay in raw with the rest of the document. confirmed is left null: the Worker's path that
// stores the document confirms the claim (federation/resolve.ts confirmedInput). A document whose inbox is blank is
// none, fetched or embedded, as Mastodon raises before it touches the account (blankInbox): nothing of it is stored.
export async function remoteActorInput(actor: Actor, document: unknown): Promise<RemoteActorInput | null> {
  const uri = actor.id;
  if (uri === null || !isStorableActorId(uri.href) || blankInbox(document)) {
    return null;
  }
  const claim = claimedHandle(document, uri.href, text(actor.preferredUsername));
  if (claim === null) {
    return null;
  }
  const inboxUrl = httpUrl(actor.inboxId?.href ?? null)?.href ?? null;
  // By Kopje's policy, an over-long inbox makes the actor unusable (nothing could be delivered to it); an over-long
  // shared inbox is none (sharedInboxUri), so its personal inbox is used.
  if (inboxUrl !== null && inboxUrl.length > INBOX_URL_LIMIT) {
    return null;
  }
  const json = isObject(document) ? document : {};
  const avatar = profileImage(json.icon);
  const header = profileImage(json.image);
  return {
    uri: uri.href,
    claim,
    confirmed: null,
    actorType: getActorTypeName(actor),
    displayName: storedDisplayName(text(actor.name) ?? ""),
    note: sanitizeRemoteBio(storedText(text(actor.summary) ?? "")),
    url: profileUrl(json.url, uri),
    avatarUrl: avatar.url,
    headerUrl: header.url,
    avatarDescription: avatar.description,
    headerDescription: header.description,
    showFeatured: displaySetting(json, "showFeatured"),
    showMedia: displaySetting(json, "showMedia"),
    showRepliesInMedia: displaySetting(json, "showRepliesInMedia"),
    // Read by spelling, as Mastodon casts `@json[name] || false` for a boolean column
    // (process_account_service.rb:252-256, rails-boolean.ts): null for "", which the Store reads as RemoteActorInput
    // says.
    locked: railsBoolean(json.manuallyApprovesFollowers ?? false),
    discoverable: railsBoolean(json.discoverable ?? false),
    indexable: railsBoolean(json.indexable ?? false),
    inboxUrl,
    sharedInboxUrl: sharedInboxUri(json),
    keys: await ownKeys(actor, uri),
    // Read by spelling, as Mastodon casts it (json-shapes.ts railsTime); the Store creates the account now when it is
    // none (remote-actors.ts).
    published: railsTime(json.published),
    // The document's own tag, as ProcessAccountService#process_tags reads @json['tag'].
    emojiTags: emojiCandidates(
      typeof document === "object" && document !== null ? (document as { tag?: unknown }).tag : null,
    ),
    raw: JSON.stringify(document),
    featurePolicy: featurePolicyOf(json),
  };
}

// ProcessAccountService#feature_approval_policy's input (process_account_service.rb:581-583): the document's
// interactionPolicy.canFeature as ActivityPub::Parser::InteractionPolicyParser reads each of its halves, Ruby's
// Array(automaticApproval) and Array(manualApproval), every entry read as remote-status.ts policyHalf reads it (an
// object's members are its pairs, each an entry that is not a string; an empty object none). null when
// canFeature is absent or is no object: Mastodon stores 0 for a blank one (`@json.blank?`, an empty object included,
// which reads as two empty halves here) and fails the account's processing on a value it cannot dig into; Kopje stores
// 0 (no one may feature the account). The Store turns the halves into the bitmap with the account's collections
// (remote-actors.ts remoteFeaturePolicy).
function featurePolicyOf(json: Record<string, unknown>): RemoteFeaturePolicyInput | null {
  const policy = isObject(json.interactionPolicy) ? json.interactionPolicy.canFeature : undefined;
  if (!isObject(policy)) {
    return null;
  }
  const half = (value: unknown): (string | null)[] => {
    const entries =
      value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value
          : isObject(value)
            ? Object.keys(value).length === 0
              ? []
              : [null]
            : [value];
    return policyHalf(entries);
  };
  return { automatic: half(policy.automaticApproval), manual: half(policy.manualApproval) };
}
