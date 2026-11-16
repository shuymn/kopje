import { type DocumentLoader, exportSpki, FetchError, type RemoteDocument } from "@fedify/fedify";
import { type Actor, getActorTypeName, type Image, isActor, Link, lookupObject, Multikey } from "@fedify/vocab";

import { ACTOR_URI_LIMIT } from "../domain/profile-bounds";
import type { Handle, RemoteActorInput } from "../domain/remote-actors";
import { hostDomain, normalizeDomain } from "../platform/domain-name";
import { httpUrl } from "../platform/http-url";
import { DOMAIN_BYTES, isRemoteUsername, isStorableActorId, REMOTE_USERNAME_LIMIT } from "../platform/identity-bounds";
import { storedDisplayName, storedProfileUrl, storedText } from "../platform/stored-bounds";
import { sanitizeRemoteBio } from "../security/html";
import { MAX_PUBLIC_KEYS, readableKeys } from "./key-entries";
import { isTransientLoadError, loadFailureOf } from "./loader";
import { emojiCandidates } from "./remote-emoji";

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

// An actor document as served at `uri`, parsed by Fedify's lookupObject over a loader that answers it alone: nothing
// is fetched but its JSON-LD contexts, through `contextLoader`. lookupObject asks its loader only for the URI it was
// given (as it parses it: without verifyPortableObject it takes no portable path), and never falls back to its own
// WebFinger lookup, which would fetch outside the safe loader. An actor whose id is not exactly uri is unusable.
async function readActor(uri: string, served: RemoteDocument, contextLoader: DocumentLoader): Promise<ReadActor> {
  let object: unknown;
  try {
    object = await lookupObject(uri, { documentLoader: () => Promise.resolve(served), contextLoader });
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

// A profile URL (url, icon, image): http(s) (HTML-3) and within its stored bound, else none, as an invalid one.
function href(value: URL | Link | null | undefined): string | null {
  const target = value instanceof Link ? value.href : value;
  return storedProfileUrl(httpUrl(target?.href ?? null)?.href ?? null);
}

// Icons and headers are taken only when embedded: a reference would cost another fetch per actor (RES-6).
const NO_FETCH: DocumentLoader = () => Promise.reject(new Error("not fetched"));

type Images = Record<
  "getIcon" | "getImage",
  (options: { documentLoader: DocumentLoader; contextLoader: DocumentLoader }) => Promise<Image | null>
>;

async function imageUrl(get: () => Promise<{ url: URL | Link | null } | null>): Promise<string | null> {
  try {
    return href((await get())?.url);
  } catch {
    return null;
  }
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

// Ruby's [[:space:]] on a Unicode string (the White_Space property), which ActiveSupport's String#blank? reads.
const RUBY_BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

// Whether the document's own `inbox` member is blank as Mastodon 4.7 reads it (`json['inbox'].blank?`,
// ProcessAccountService#call, process_account_service.rb:24): missing, null, false, a string of whitespace alone, an
// empty array or an empty object. A value that is not blank but no inbox URL is not refused here (Mastodon stores no
// inbox for it, valid_collection_uri).
function blankInbox(document: unknown): boolean {
  const inbox = typeof document === "object" && document !== null ? (document as { inbox?: unknown }).inbox : undefined;
  return (
    inbox === undefined ||
    inbox === null ||
    inbox === false ||
    (typeof inbox === "string" && RUBY_BLANK.test(inbox)) ||
    (Array.isArray(inbox) && inbox.length === 0) ||
    (typeof inbox === "object" && !Array.isArray(inbox) && Object.keys(inbox).length === 0)
  );
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
  // By Kopje's policy, an over-long inbox makes the actor unusable (nothing could be delivered to it), and an
  // over-long shared inbox is ignored, so its personal inbox is used.
  if (inboxUrl !== null && inboxUrl.length > INBOX_URL_LIMIT) {
    return null;
  }
  const sharedInboxUrl = httpUrl(actor.endpoints?.sharedInbox?.href ?? null)?.href ?? null;
  const options = { documentLoader: NO_FETCH, contextLoader: NO_FETCH };
  const images: Images = actor;
  return {
    uri: uri.href,
    claim,
    confirmed: null,
    actorType: getActorTypeName(actor),
    displayName: storedDisplayName(text(actor.name) ?? ""),
    note: sanitizeRemoteBio(storedText(text(actor.summary) ?? "")),
    url: href(actor.url),
    avatarUrl: await imageUrl(() => images.getIcon(options)),
    headerUrl: await imageUrl(() => images.getImage(options)),
    locked: actor.manuallyApprovesFollowers === true,
    discoverable: actor.discoverable,
    indexable: actor.indexable === true,
    inboxUrl,
    sharedInboxUrl: sharedInboxUrl !== null && sharedInboxUrl.length <= INBOX_URL_LIMIT ? sharedInboxUrl : null,
    // A Temporal.Instant, whose type the polyfill's globals leave unresolved for the linter.
    keys: await ownKeys(actor, uri),
    published: (actor.published as { toString(): string } | null)?.toString() ?? null,
    // The document's own tag, as ProcessAccountService#process_tags reads @json['tag'].
    emojiTags: emojiCandidates(
      typeof document === "object" && document !== null ? (document as { tag?: unknown }).tag : null,
    ),
    raw: JSON.stringify(document),
    movedTo: storableActorId(actor.successorId),
  };
}

// An actor id the document names (movedTo), when Kopje stores such an id.
function storableActorId(id: URL | null): string | null {
  return id !== null && isStorableActorId(id.href) ? id.href : null;
}
