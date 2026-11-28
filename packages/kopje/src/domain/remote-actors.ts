import { ACCOUNTS_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { hostDomain } from "../platform/domain-name";
import { sameOrigin } from "../platform/http-url";
import { DOMAIN_BYTES, REMOTE_USERNAME_LIMIT } from "../platform/identity-bounds";
import { ACCOUNT_EMOJIS_BYTES, cutSql, isoTimeSql, nextDocumentRevisionSql } from "../platform/stored-bounds";
import { presentedRemoteFields } from "./accounts";
import {
  availableSql,
  deletingSql,
  domainCoveredSql,
  FEATURE_POLICY_FLAGS,
  individuallySuspendedSql,
  PUBLIC_COLLECTION,
} from "./audience";
import {
  actorCollections,
  collectionRead,
  collectionSql,
  fetchableMove,
  namedMove,
  requestCollectionSync,
  UNREADABLE,
} from "./collection-requests";
import { type EmojiCandidate, emojiSnapshot } from "./custom-emojis";
import { insertWithFreshId, remoteId } from "./ids";
import { hostCovered } from "./instance-domain-blocks";
import { usernameSql } from "./profile-bounds";
import { armRemoteFieldLinks, remoteLinkBack } from "./remote-field-links";
import { noteEmojiSnapshot, syncProfileFiles } from "./remote-media";
import { accountSearchText } from "./search-text";

// Remote actors as the Store keeps them: storing and refreshing one (upsertRemoteActor, applyRefresh), its stored
// revision, and whether an actor was deleted. The inbox (inbox.ts), remote statuses and quotes build on it; what an
// actor retracted is in retractions.ts.

// Expired retractions, finished jobs and expired mutes removed per call (RES-4), so the sweep stays bounded and
// keeps up.
export const SWEEP_BATCH = 100;
// A stored remote account whose document was stored this long ago (accounts.fetched_at, inclusive) is fetched again
// before a status Kopje fetched by it is stored (staleAccount): Mastodon's Account::STALE_THRESHOLD and
// possibly_stale? (account.rb:71,254-256), a policy separate from KEY_REFRESH_MS.
export const ACCOUNT_STALE_MS = 24 * 60 * 60 * 1000;
// An account's address: a username and a normalized domain (platform/domain-name.ts normalizeDomain).
export type Handle = { username: string; domain: string };

// The WebFinger request (RFC 7033) for acct:<username>@<host>.
export function webfingerUrl(username: string, host: string): string {
  return `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${host}`)}`;
}

// A remote actor as the Worker extracted it from a fetched, origin-checked document (ID-2). Text is bounded,
// display_name is plain text, note is sanitized HTML (HTML-1) and URLs are http(s) or null (HTML-3). keys are the
// public keys the document lists whose owner is this actor and whose id has its origin.
export type RemoteActorInput = {
  uri: string;
  // The handle the document claims (federation/remote-actor.ts claimedHandle: its FEP-2c59 webfinger, else its
  // preferredUsername at its host).
  claim: Handle;
  // The handle WebFinger confirmed for this actor id (federation/resolve.ts confirmHandle), or null when none was:
  // not looked up (the claim is the stored handle), refused or not answered. Only a confirmed handle is ever stored
  // (acceptedHandle).
  confirmed: Handle | null;
  actorType: string;
  displayName: string;
  note: string;
  url: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  // The icon's and image's descriptions, storedProfileDescription's output ('' for none: a store clears a stored one).
  avatarDescription: string;
  headerDescription: string;
  // The display settings (showFeatured, showMedia, showRepliesInMedia) when the document holds a JSON boolean for
  // them, else null: the stored value is kept (a new account's is true).
  showFeatured: boolean | null;
  showMedia: boolean | null;
  showRepliesInMedia: boolean | null;
  // The actor's manuallyApprovesFollowers, discoverable and indexable as Rails' boolean cast reads them
  // (federation/remote-actor.ts remoteActorInput); null for an empty string, where Mastodon assigns nil: discoverable
  // stores it, and locked and indexable keep the stored value (a new account's is false), as Mastodon's NOT NULL
  // columns refuse it (docs/mastodon-deviations.md).
  locked: boolean | null;
  discoverable: boolean | null;
  indexable: boolean | null;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
  published: string | null;
  keys: { id: string; pem: string }[];
  // Emoji tags as read (federation/remote-emoji.ts); the snapshot is chosen when the account is written.
  emojiTags: EmojiCandidate[];
  // The document as received; followers, alsoKnownAs, fields and movedTo are read from it.
  raw: string;
  // interactionPolicy.canFeature's halves as the Worker read them (federation/remote-actor.ts featurePolicyOf), or null
  // when the document states none: the stored policy is 0. Undefined from an earlier build: the stored policy is kept.
  featurePolicy?: RemoteFeaturePolicyInput | null;
};

// An actor's canFeature as the Worker read it: the strings each half lists, as listed ("" included, any length), and
// null for an entry that is not one.
export type RemoteFeaturePolicyInput = { automatic: (string | null)[]; manual: (string | null)[] };

// What the actor's own Update(Person) gives from the document it embeds (ID-1): everything but its keys and inboxes,
// which only a fetched document gives, so that no embedded document can pass them.
export type RemoteProfileInput = Omit<RemoteActorInput, "keys" | "inboxUrl" | "sharedInboxUrl">;

// What only a fetched document gives: the keys and the inboxes beside them (ID-1).
type Protocol = Pick<RemoteActorInput, "keys" | "inboxUrl" | "sharedInboxUrl">;

// A refusal that must leave no trace: thrown out of the operation, so its transaction rolls back (the actor's
// document and keys stored before the handler ran included), and turned into a retryable answer by the Store's RPC
// (store.ts), which the Worker answers 503.
export class RetryLater extends Error {
  constructor(readonly reason: string) {
    super(`retry later: ${reason}`);
  }
}

export function originOf(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

export type RemoteRow = { id: string; uri: string; domain: string };

// What upsertRemoteActor stored. movePending: the store left the account's move pending and its sync's request waits
// for a round (syncWaiting), so the caller rings the jobs queue for it.
export type StoredActor = RemoteRow & { syncWaiting: boolean; movePending: boolean; frozen: boolean };

// ID-1's revision fence. accounts.document_revision changes with every store of a remote actor's document (its profile,
// keys, movedTo or routing), the Move handler's movedTo included (nextDocumentRevisionSql, migration 0073). A writer
// that fetches a document reads the revision first, in the Store, and passes it as its expectation: the stored
// revision, or null when no remote row of the uri was stored. Read before the fetch on purpose: it is no credential
// but the state the document must still find, so a document fetched before another store committed is never stored
// over it, however late it arrives. The comparison (revisionHolds), in the transaction that would store it:
//   expectation   row absent              row present with revision g
//   null          stored (a new row)      superseded, g = 0 included
//   n             superseded              stored only when n = g
//   (none)        stored                  stored
// A writer without one (none) stores what it fetched as Mastodon's ProcessAccountService does, guarded instead by its
// own absence check in the same transaction: a boosted or quoted author Kopje does not know. It still issues a new
// revision, so a fenced document fetched before it is superseded.
export type DocumentRevision = number | null;

// The remote row of `uri` with its revision (the trigger of migration 0073 holds it to an integer), if any.
function storedRevision(db: Db, uri: string): { revision: number | null } | undefined {
  return db.first<{ revision: number | null }>(
    `SELECT CASE WHEN typeof(document_revision) = 'integer' THEN document_revision END AS revision
		FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX} WHERE uri = ? AND domain IS NOT NULL`,
    uri,
  );
}

// What a writer reads of the remote actor `uri` before it fetches its document: the revision it stores the document
// under (DocumentRevision, null when no remote row of the uri is stored; a local row reads as none, ID-3), and the
// stored handle, which the Worker compares with the document's claim to skip a WebFinger confirmation that could only
// keep it (D4; acceptedHandle decides in the Store whatever the Worker skipped). handle is null when no remote row is
// stored. The stored username and domain are unconstrained (imports): a part that is not TEXT within what a claim can
// be (REMOTE_USERNAME_LIMIT, DOMAIN_BYTES) is read as '', which equals no claim.
export type ActorState = { revision: DocumentRevision; handle: Handle | null };

// The state of an actor with no remote row, or of none named.
export const NO_ACTOR_STATE: ActorState = { revision: null, handle: null };

export function actorState(db: Db, uri: string): ActorState {
  const row = db.first<{ revision: number | null; username: string | null; domain: string | null }>(
    `SELECT CASE WHEN typeof(document_revision) = 'integer' THEN document_revision END AS revision,
			CASE WHEN typeof(username) = 'text' AND length(CAST(username AS BLOB)) <= ${REMOTE_USERNAME_LIMIT}
				THEN username END AS username,
			CASE WHEN typeof(domain) = 'text' AND length(CAST(domain AS BLOB)) <= ${DOMAIN_BYTES} THEN domain END AS domain
		FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX} WHERE uri = ? AND domain IS NOT NULL`,
    uri,
  );
  return row === undefined
    ? NO_ACTOR_STATE
    : { revision: row.revision, handle: { username: row.username ?? "", domain: row.domain ?? "" } };
}

// Whether a document of `uri` fetched under the expectation `expected` may be stored (the table at DocumentRevision).
export function revisionHolds(db: Db, uri: string, expected: DocumentRevision | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  const row = storedRevision(db, uri);
  return expected === null ? row === undefined : row !== undefined && row.revision === expected;
}

// The stored remote account of `uri` (none for a local one), available or not.
export function remoteAccount(db: Db, uri: string): RemoteRow | undefined {
  return db.first<RemoteRow>("SELECT id, uri, domain FROM accounts WHERE uri = ? AND domain IS NOT NULL", uri);
}

// Whether the actor deleted itself: its purge job is its tombstone while it lasts (ID-7, independent of the
// retraction cap and TTL).
export function isDeletedActor(db: Db, uri: string, now: number): boolean {
  return (
    db.first(
      "SELECT 1 AS x FROM inbound_jobs WHERE kind = 'purge' AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      uri,
      now,
    ) !== undefined
  );
}

// The handle (username and domain) of a remote account, decided here for every path that stores an actor (NET-4): a
// handle WebFinger confirmed for this actor id is taken, unless it is on this instance's domain; otherwise a stored row
// keeps its handle, whatever the document claims (an invalidated one included); otherwise nothing is stored. Mastodon
// 4.7 drops the whole document when the confirmation fails (ProcessAccountService#check_webfinger!); Kopje stores the
// rest of a stored account's document, as Mastodon's only_key path does (docs/mastodon-deviations.md, Accounts).
// A kept handle stays in SQL: upsertRemoteActor's UPSERT keeps the stored columns, and `stored` (actorState's
// projection) serves only the Worker-side bookkeeping. Domain blocks also match the actor's host (inDomainSql in
// audience.ts).
function acceptedHandle(
  stored: Handle | null,
  actor: Pick<RemoteActorInput, "confirmed">,
  instanceDomain: string,
): Handle | null {
  if (actor.confirmed !== null && actor.confirmed.domain !== instanceDomain) {
    return actor.confirmed;
  }
  return stored;
}

// The handle a kept row is found by (search_text), in the projection presenters show (usernameSql, which keeps a
// long imported username's prefix, and the domain cut to DOMAIN_BYTES): actorState's projection, which reads either
// past what a claim can be as '', would drop such an account from search. Read for the search text only; the stored
// handle itself stays in SQL.
function searchedHandle(db: Db, uri: string): Handle {
  const row = db.first<{ username: SqlStorageValue; domain: SqlStorageValue }>(
    `SELECT ${usernameSql("username")} AS username,
			CASE WHEN typeof(domain) = 'text' THEN ${cutSql("domain", DOMAIN_BYTES)} ELSE '' END AS domain
		FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX} WHERE uri = ? AND domain IS NOT NULL`,
    uri,
  );
  // An imported username that is not TEXT (a number or a blob) is found by nothing.
  const text = (value: SqlStorageValue | undefined) => (typeof value === "string" ? value : "");
  return { username: text(row?.username), domain: text(row?.domain) };
}

// D7, Mastodon's rename_conflicting_account!: the remote row other than `uri` that holds the address a confirmed handle
// takes (at most one, accounts_domain_username being UNIQUE, migration 0096_remote_handles) is invalidated, whatever
// its state: its username becomes '! ' and its id (invalidate_username!; accounts.ts shownHandle presents it), its
// search_text follows, and a refresh of it is asked for (collection_syncs.refresh, the sync's document part), as
// Mastodon queues an AccountRefreshWorker. Each account is asked for at most once per ACCOUNT_STALE_MS by an
// invalidation (accounts.handle_refreshed_at, written only here): two actors whose WebFinger answers alternate would
// otherwise invalidate each other through their refreshes forever. A stored time that is not a number, or in the
// future, does not hold the request back. Writes the holder's row and, when asked, its collection_syncs row.
function invalidateHolder(db: Db, handle: Handle, uri: string, now: number): void {
  const holder = db.first<{ id: string; display_name: string; due: number }>(
    `SELECT id, display_name, CASE WHEN typeof(handle_refreshed_at) IN ('integer', 'real')
				AND handle_refreshed_at > ?4 - ${ACCOUNT_STALE_MS} AND handle_refreshed_at <= ?4 THEN 0 ELSE 1 END AS due
		FROM accounts INDEXED BY accounts_domain_username
		WHERE domain = ?1 AND lower(username) = lower(?2) AND uri <> ?3`,
    handle.domain,
    handle.username,
    uri,
    now,
  );
  if (holder === undefined) {
    return;
  }
  db.run(
    `UPDATE accounts SET username = '! ' || id, search_text = ?2,
			handle_refreshed_at = CASE WHEN ?3 THEN ?4 ELSE handle_refreshed_at END
		WHERE id = ?1 AND domain IS NOT NULL`,
    holder.id,
    accountSearchText(`! ${holder.id}`, handle.domain, holder.display_name),
    holder.due,
    now,
  );
  if (holder.due === 1) {
    requestCollectionSync(db, holder.id, now, true);
  }
}

// R38 (Mastodon's set_immediate_protocol_attributes!): a verified document of an individually suspended account updates
// its inbox and shared inbox only, so that moderation's Rejects reach a current inbox. Its profile, keys and stored
// domain stay frozen; the values passed remote-actor.ts's checks as any refresh's. An account an instance domain block
// covers takes no refresh at all (its documents are not fetched).
// A change of the routing issues a new revision (DocumentRevision); the caller has compared the expectation first.
export function refreshRouting(
  db: Db,
  accountId: string,
  actor: Pick<RemoteActorInput, "inboxUrl" | "sharedInboxUrl">,
): void {
  db.run(
    `UPDATE accounts SET inbox_url = ?2, shared_inbox_url = ?3,
			document_revision = ${nextDocumentRevisionSql("document_revision")}
		WHERE id = ?1 AND ${individuallySuspendedSql("accounts")} AND (inbox_url IS NOT ?2 OR shared_inbox_url IS NOT ?3)
			AND NOT ${domainCoveredSql("accounts")}`,
    accountId,
    actor.inboxUrl,
    actor.sharedInboxUrl,
  );
}

// The stored remote account of `uri` when it is unavailable (R1): the account the instance suspended (R38).
export function unavailableRemote(db: Db, uri: string): RemoteRow | undefined {
  return db.first<RemoteRow>(
    `SELECT a.id, a.uri, a.domain FROM accounts a WHERE a.uri = ? AND a.domain IS NOT NULL AND NOT ${availableSql("a.id")}`,
    uri,
  );
}

// Inserts or refreshes a remote account and its keys from its document. Never touches a local row (ID-3): a URI on
// this instance's origin, or one a local account holds, is refused, and so is a deleted actor. An unavailable account
// (R38, VIS-30) is never refreshed: its stored row is returned unchanged (frozen), but for a routing refresh
// (refreshRouting), as Mastodon leaves a suspended account's key and attributes as they were. No account is stored, and
// none moves, under an instance domain block: a document whose actor host or domain is covered stores nothing, and
// leaves a stored row unchanged (Mastodon's ProcessAccountService stores nothing on a blocked domain), so the set of
// accounts a block covers is fixed when it commits. A refresh stores only an account no block covers, by its stored
// keys or its new ones, so it clears a domain mark left from a lifted block (R38) in its own transaction: the mark
// never outlives the account's move to another domain. A document that names
// any of its collections asks for them to be read (remote-collections.ts, as ActivityPub::ProcessAccountService
// schedules its syncs each time it processes the account); syncWaiting: a request waits for a round.
// expected: the revision the writer read before it fetched the document (DocumentRevision). When it no longer holds,
// nothing of the document is stored, the routing of a frozen row included, and the answer is 'superseded': the caller
// decides what the stored row is worth to it. Every store issues a new revision.
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
): StoredActor | undefined;
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
  expected: DocumentRevision,
): StoredActor | "superseded" | undefined;
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
  expected?: DocumentRevision,
): StoredActor | "superseded" | undefined {
  return storeActor(db, actor, actor, origin, now, expected);
}

// The store of the actor's own Update(Person) that embeds its document (ID-1): one store under the revision the inbox
// gate read (`expected`), issuing one revision, its keys and inboxes those of `fetched`, the document the request fetched
// for its key, else the stored row's (remote_keys untouched, inbox_url and shared_inbox_url as stored), everything else
// the embedded `profile`'s. accounts.fetched_at is set either way, the time the account's document was last stored
// (ACCOUNT_STALE_MS's clock, as Mastodon's last_webfingered_at is set at every processing), so the stale-author refresh
// does not read a peer's cached document back over it; remote_keys.fetched_at only with `fetched`, so a key's trust
// still runs from the last fetched document (KEY_REFRESH_MS). A profile alone never creates an account: with no row
// stored, it is 'superseded'.
export function upsertEmbeddedActor(
  db: Db,
  profile: RemoteProfileInput,
  fetched: RemoteActorInput | null,
  origin: string,
  now: number,
  expected: DocumentRevision,
): StoredActor | "superseded" | undefined {
  return storeActor(db, profile, fetched, origin, now, expected);
}

// upsertRemoteActor's store, of a document's profile with `protocol`, its keys and inboxes, or with none (the stored
// row's kept).
function storeActor(
  db: Db,
  actor: RemoteProfileInput,
  protocol: Protocol | null,
  origin: string,
  now: number,
  expected?: DocumentRevision,
): StoredActor | "superseded" | undefined {
  if (
    originOf(actor.uri) === origin ||
    db.first("SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL", actor.uri) !== undefined ||
    isDeletedActor(db, actor.uri, now)
  ) {
    return undefined;
  }
  if (!revisionHolds(db, actor.uri, expected) || (protocol === null && expected === null)) {
    return "superseded";
  }
  const frozen = unavailableRemote(db, actor.uri);
  if (frozen !== undefined) {
    if (protocol !== null) {
      refreshRouting(db, frozen.id, protocol);
    }
    return { ...frozen, syncWaiting: false, movePending: false, frozen: true };
  }
  const published = actor.published === null ? NaN : Date.parse(actor.published);
  const createdAt = new Date(Number.isNaN(published) || published > now ? now : published).toISOString();
  // The stored handle as actorState projects it, for the search text, the presented fields, the blocks and the emoji
  // only: a kept handle is copied in SQL (`keep` below), never written back from this decoded copy, since an imported
  // username or domain need not be valid UTF-8 (D5: the stored handle stays unchanged).
  const stored = actorState(db, actor.uri).handle;
  const handle = acceptedHandle(stored, actor, new URL(origin).host);
  if (handle === null) {
    return undefined;
  }
  const keep = handle !== actor.confirmed;
  const { username, domain } = handle;
  const searched = keep ? searchedHandle(db, actor.uri) : handle;
  if (hostCovered(db, hostDomain(actor.uri)) || hostCovered(db, domain)) {
    const row = remoteAccount(db, actor.uri);
    return row === undefined ? undefined : { ...row, syncWaiting: false, movePending: false, frozen: true };
  }
  if (handle === actor.confirmed) {
    invalidateHolder(db, handle, actor.uri, now);
  }
  // The snapshot of the emoji the stored name, bio and presented fields reference (custom-emojis.ts), replaced by
  // every refresh and Update(Person).
  const { fields, links } = presentedRemoteFields(db, actor.raw, domain);
  const emojis = emojiSnapshot(
    actor.emojiTags,
    [actor.displayName, actor.note, ...fields.flatMap((field) => [field.name, field.value])],
    ACCOUNT_EMOJIS_BYTES,
  );
  const flag = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
  const values = [
    actor.uri,
    username,
    domain,
    actor.actorType,
    actor.displayName,
    actor.note,
    actor.url,
    actor.avatarUrl,
    actor.headerUrl,
    flag(actor.locked),
    flag(actor.discoverable),
    flag(actor.indexable),
    protocol?.inboxUrl ?? null,
    protocol?.sharedInboxUrl ?? null,
    actor.raw,
    new Date(now).toISOString(),
    accountSearchText(searched.username, searched.domain, actor.displayName),
    createdAt,
    emojis,
    actor.avatarDescription,
    actor.headerDescription,
  ];
  // locked (?11) and indexable (?13) given null: a new account takes false, a stored one keeps its own. The display
  // settings, ?23 to ?25, the same, a new account taking true.
  insertWithFreshId(
    "accounts",
    () => remoteId(actor.published ?? "", now),
    (id) =>
      db.run(
        `INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, indexable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at,
					emojis, avatar_description, header_description, show_featured, show_media, show_media_replies,
					document_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?11, 0), ?, COALESCE(?13, 0), ?, ?, ?, ?, ?, ?, ?, ?, ?,
					COALESCE(?23, 1), COALESCE(?24, 1), COALESCE(?25, 1), ${nextDocumentRevisionSql(null)})
				ON CONFLICT (uri) DO UPDATE SET username = CASE WHEN ?26 THEN accounts.username ELSE excluded.username END,
					document_revision = ${nextDocumentRevisionSql("accounts.document_revision")}, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url,
					locked = COALESCE(?11, accounts.locked), discoverable = excluded.discoverable,
					indexable = COALESCE(?13, accounts.indexable),
					inbox_url = CASE WHEN ?27 THEN accounts.inbox_url ELSE excluded.inbox_url END,
					shared_inbox_url = CASE WHEN ?27 THEN accounts.shared_inbox_url ELSE excluded.shared_inbox_url END,
					raw = excluded.raw, fetched_at = excluded.fetched_at,
					search_text = excluded.search_text, domain = CASE WHEN ?26 THEN accounts.domain ELSE excluded.domain END,
					emojis = excluded.emojis, avatar_description = excluded.avatar_description,
					header_description = excluded.header_description, show_featured = COALESCE(?23, accounts.show_featured),
					show_media = COALESCE(?24, accounts.show_media),
					show_media_replies = COALESCE(?25, accounts.show_media_replies),
					suspended_at = CASE WHEN accounts.suspension_source = 'domain' THEN NULL ELSE accounts.suspended_at END,
					suspension_source = CASE WHEN accounts.suspension_source = 'domain' THEN NULL
						ELSE accounts.suspension_source END
				WHERE accounts.domain IS NOT NULL`,
        id,
        ...values,
        flag(actor.showFeatured),
        flag(actor.showMedia),
        flag(actor.showRepliesInMedia),
        keep ? 1 : 0,
        protocol === null ? 1 : 0,
      ),
  );
  const row = remoteAccount(db, actor.uri);
  let pending = false;
  if (row !== undefined) {
    // The account's move as its document states it (ID-4), set or cleared by every store, an unchanged document's
    // included (Mastodon's ProcessAccountService: process_account_service.rb:293), written once the row is stored, by
    // its id: the literal movedTo (collection-requests.ts namedMove) naming a stored account (moveTargetSql). One Kopje
    // does not know is pending (accounts.move_pending) when the sync may fetch it (fetchableMove), as Mastodon fetches it
    // (process_account_service.rb:516-520): the sync's move part resolves it (remote-collections.ts). The move and the
    // bit are written in this one statement, so no intermediate row passes their bound (0125_account_move_pending).
    const target = moveTarget(db, namedMove(actor.raw, actor.uri), row.id);
    pending = target === null && fetchableMove(actor.raw, actor.uri, origin) !== null;
    db.run(
      "UPDATE accounts SET moved_to_account_id = ?2, move_pending = ?3 WHERE id = ?1 AND domain IS NOT NULL",
      row.id,
      target,
      pending ? 1 : 0,
    );
    // The links of its fields to verify, from the same projection (remote-field-links.ts).
    armRemoteFieldLinks(db, row.id, remoteLinkBack(actor.uri, actor.url), links, now);
    // Its avatar and header to cache, from the same projection (remote-media.ts).
    syncProfileFiles(db, row.id, { avatar: actor.avatarUrl, header: actor.headerUrl }, now);
    // Its custom emoji to cache, from the snapshot just stored (remote-media.ts).
    noteEmojiSnapshot(db, emojis, domain, now);
    // Its feature policy, set by every store (process_account_service.rb:232), with the collections the document just
    // stored names; a profile from an earlier build, which read none, keeps the stored one.
    if (actor.featurePolicy !== undefined) {
      db.run(
        "UPDATE accounts SET feature_policy = ?2 WHERE id = ?1 AND domain IS NOT NULL",
        row.id,
        actor.featurePolicy === null ? 0 : remoteFeaturePolicy(db, { id: row.id, uri: actor.uri }, actor.featurePolicy),
      );
    }
  }
  if (row !== undefined && protocol !== null) {
    // The document lists the actor's current keys; keys it no longer lists are not trusted any more.
    db.run("DELETE FROM remote_keys WHERE account_id = ?", row.id);
    for (const key of protocol.keys) {
      if (!sameOrigin(key.id, actor.uri)) {
        continue;
      }
      db.run(
        `INSERT INTO remote_keys (key_id, account_id, pem, fetched_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (key_id) DO UPDATE SET account_id = excluded.account_id, pem = excluded.pem,
					fetched_at = excluded.fetched_at`,
        key.id,
        row.id,
        key.pem,
        now,
      );
    }
  }
  if (row === undefined) {
    return undefined;
  }
  // The sync is asked for when the document names a collection, or a destination to fetch (the move part).
  const collections = actorCollections(actor.raw);
  const named = Object.values(collections).some((url) => url !== null);
  const syncWaiting = (named || pending) && requestCollectionSync(db, row.id, now);
  return { ...row, syncWaiting, movePending: pending && syncWaiting, frozen: false };
}

// The id of the account a move named `id` (namedMove's href, or null) resolves to, for the account `self`: the stored
// row, local or remote, whatever its availability, whose actor id is `id` with its fragment removed (Mastodon's
// ActivityPub::TagManager#uri_to_resource, `split('#').first`), other than `self` and not being purged; else null. An
// unavailable one is presented redacted (accounts.ts presentAccount). Every writer of a move from a document reads it
// here: the store, and the collection sync's claim and completion (remote-collections.ts).
export function moveTarget(db: Db, id: string | null, self: string): string | null {
  if (id === null) {
    return null;
  }
  return (
    db.first<{ id: string }>(
      `SELECT m.id FROM accounts m INDEXED BY ${ACCOUNTS_URI_INDEX}
			WHERE m.uri = substr(?1, 1, instr(?1 || '#', '#') - 1) AND m.id <> ?2 AND NOT ${deletingSql("m")}`,
      id,
      self,
    )?.id ?? null
  );
}

// The flags a half of an interaction policy gives, the same in canQuote's and canFeature's (audience.ts
// QUOTE_POLICY_FLAGS, FEATURE_POLICY_FLAGS).
type SubpolicyBits = { unsupported_policy: number; public: number; followers: number; following: number };

// Mastodon's reading of one half of a remote account's interaction policy, the same in StatusParser#quote_subpolicy
// (status_parser.rb:179-196, canQuote) and InteractionPolicyParser#subpolicy (interaction_policy_parser.rb:22-40,
// canFeature), with the collections the account's stored document names, read once for both halves, and one pass over a
// half's entries (federation/remote-status.ts policyHalf gives every entry). The entries once each (uniq!), then
// removed as Mastodon removes them, each removal before the next: the first public spelling listed of as:Public, Public
// and the full IRI in that order (one only: Mastodon's `||` stops at the first it deletes, so a second spelling is left
// over), then the account's followers and its following collections as its stored document names them ('' for none, as
// Mastodon stores it, which a listed "" matches), then the account itself (`itself`); anything left over adds
// unsupported_policy. A value that is not a string (null) is always left over, as Mastodon's Array#delete matches no
// string with it. A collection Kopje cannot read as Mastodon stores it (collection-requests.ts UNREADABLE) makes every
// string left at it add nothing, from the first collection it cannot read on: Mastodon may store that collection as the
// very string, so neither a later collection's flag nor unsupported_policy (which lets anyone ask to quote) is known to
// be Mastodon's, and adding nothing grants no one more than Mastodon does.
export function subpolicyReader(
  db: Db,
  account: { id: string; uri: string },
  bits: SubpolicyBits,
): (entries: readonly (string | null)[]) => { flags: number; itself: boolean } {
  const row = db.first<{ followers: string | null; following: string | null }>(
    `SELECT ${collectionSql("raw", "followers")} AS followers, ${collectionSql("raw", "following")} AS following
		FROM accounts WHERE id = ?`,
    account.id,
  );
  const collections = [
    [collectionRead(row?.followers ?? null), bits.followers],
    [collectionRead(row?.following ?? null), bits.following],
  ] as const;
  return (entries) => {
    const left = new Set(entries);
    const take = (value: string) => left.delete(value);
    let flags = 0;
    if (take("as:Public") || take("Public") || take(PUBLIC_COLLECTION)) {
      flags |= bits.public;
    }
    let readable = true;
    for (const [collection, flag] of collections) {
      if (collection === UNREADABLE) {
        readable = false;
        break;
      }
      if (take(collection)) {
        flags |= flag;
      }
    }
    const itself = take(account.uri);
    if (readable ? left.size > 0 : left.has(null)) {
      flags |= bits.unsupported_policy;
    }
    return { flags, itself };
  };
}

// ActivityPub::Parser::InteractionPolicyParser#bitmap (interaction_policy_parser.rb:9-40) of the stored remote
// account's canFeature halves (audience.ts FEATURE_POLICY_FLAGS; the automatic half in the high 16 bits), each read by
// subpolicyReader; a half that adds no flag but held the account itself is `disabled`.
function remoteFeaturePolicy(db: Db, account: { id: string; uri: string }, policy: RemoteFeaturePolicyInput): number {
  const read = subpolicyReader(db, account, FEATURE_POLICY_FLAGS);
  const half = (entries: readonly (string | null)[]): number => {
    const { flags, itself } = read(entries);
    return flags === 0 && itself ? FEATURE_POLICY_FLAGS.disabled : flags;
  };
  return ((half(policy.automatic) << 16) | half(policy.manual)) >>> 0;
}

// Whether the remote account `id` is fetched again before a status Kopje fetched by it is stored (ACCOUNT_STALE_MS,
// Mastodon's possibly_stale?): a remote row that is available (R38, VIS-30: never refetched) and whose handle is
// invalidated (D9: whatever its fetched_at, as possibly_stale? is true for an invalidated username), or whose
// fetched_at is ACCOUNT_STALE_MS old or older, or not a stored time (NULL, or an imported value isoTimeSql does not
// read). The prefix test is accounts.ts shownHandle's on the stored username.
export function staleAccount(db: Db, id: string, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM accounts a
			WHERE a.id = ?1 AND a.domain IS NOT NULL AND ${availableSql("a.id")}
				AND (substr(a.username, 1, 2) = '! ' OR COALESCE(${isoTimeSql("a.fetched_at")} <= ?2, 1))`,
      id,
      new Date(now - ACCOUNT_STALE_MS).toISOString(),
    ) !== undefined
  );
}

// The outcome of refetching a stale stored author (staleAccount), applied in the transaction that stores its status.
// Applied only while the row is still stale, so the first outcome to commit wins: a row refreshed, stamped or made
// unavailable meanwhile is kept as it is ('current'). Staleness is the refresh policy, not the fence: a Move's movedTo
// changes the revision but not fetched_at, so the document is also compared with `expected`, the author's revision read
// when the refetch was decided (DocumentRevision), and a superseded one stores nothing ('current', the stored row).
// While it is stale:
//   - a usable document of this actor (ok) is stored (upsertRemoteActor) while `expected` holds: 'refreshed', frozen if
//     it stored nothing;
//   - 'gone' (404 or 410) writes nothing, and nothing is stored under the account ('refused'), as for an author that
//     cannot be fetched;
//   - any other failure (null: unusable, another id, or one that may pass, budget and deadline included) stamps
//     fetched_at only ('stamped'): the stored row is used, and refetched a day later. remote_keys are not touched,
//     so key trust (ID-1) is not extended.
// Limitation: a 'gone' that commits after another request's stamp finds the row fresh and is not applied.
export function applyRefresh(
  db: Db,
  author: RemoteRow,
  document: RemoteActorInput | null | "gone",
  origin: string,
  now: number,
  expected: DocumentRevision,
): { kind: "current" | "refreshed" | "stamped"; author: RemoteRow; frozen: boolean } | { kind: "refused" } {
  const current = { kind: "current", author, frozen: false } as const;
  if (!staleAccount(db, author.id, now)) {
    return current;
  }
  if (document === "gone") {
    return { kind: "refused" };
  }
  if (document === null || document.uri !== author.uri) {
    db.run(
      "UPDATE accounts SET fetched_at = ?2 WHERE id = ?1 AND domain IS NOT NULL",
      author.id,
      new Date(now).toISOString(),
    );
    return { kind: "stamped", author, frozen: false };
  }
  const stored = upsertRemoteActor(db, document, origin, now, expected);
  if (stored === "superseded") {
    return current;
  }
  return stored === undefined ? { kind: "refused" } : { kind: "refreshed", author: stored, frozen: stored.frozen };
}
