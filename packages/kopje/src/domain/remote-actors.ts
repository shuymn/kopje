import { ACCOUNTS_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { hostDomain } from "../platform/domain-name";
import { sameOrigin } from "../platform/http-url";
import { DOMAIN_BYTES, REMOTE_USERNAME_LIMIT } from "../platform/identity-bounds";
import { ACCOUNT_EMOJIS_BYTES, cutSql, isoTimeSql, nextDocumentRevisionSql } from "../platform/stored-bounds";
import { presentedRemoteFields } from "./accounts";
import { availableSql, deletingSql, domainCoveredSql, individuallySuspendedSql } from "./audience";
import { actorCollections, requestCollectionSync } from "./collection-requests";
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
  locked: boolean;
  discoverable: boolean | null;
  // The actor's toot:indexable, true only when the document says so (ProcessAccountService: `@json['indexable']`).
  indexable: boolean;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
  published: string | null;
  keys: { id: string; pem: string }[];
  // Emoji tags as read (federation/remote-emoji.ts); the snapshot is chosen when the account is written.
  emojiTags: EmojiCandidate[];
  // The document as received; followers, alsoKnownAs and fields are read from it.
  raw: string;
  // The actor id the document's movedTo names (Fedify's successorId), when Kopje stores such an id; else null.
  movedTo: string | null;
};

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

// What upsertRemoteActor stored.
export type StoredActor = RemoteRow & { syncWaiting: boolean; frozen: boolean };

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
function acceptedHandle(stored: Handle | null, actor: RemoteActorInput, instanceDomain: string): Handle | null {
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
export function refreshRouting(db: Db, accountId: string, actor: RemoteActorInput): void {
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
  if (
    originOf(actor.uri) === origin ||
    db.first("SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL", actor.uri) !== undefined ||
    isDeletedActor(db, actor.uri, now)
  ) {
    return undefined;
  }
  if (!revisionHolds(db, actor.uri, expected)) {
    return "superseded";
  }
  const frozen = unavailableRemote(db, actor.uri);
  if (frozen !== undefined) {
    refreshRouting(db, frozen.id, actor);
    return { ...frozen, syncWaiting: false, frozen: true };
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
    return row === undefined ? undefined : { ...row, syncWaiting: false, frozen: true };
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
    actor.locked ? 1 : 0,
    actor.discoverable === null ? null : actor.discoverable ? 1 : 0,
    actor.indexable ? 1 : 0,
    actor.inboxUrl,
    actor.sharedInboxUrl,
    actor.raw,
    new Date(now).toISOString(),
    accountSearchText(searched.username, searched.domain, actor.displayName),
    createdAt,
    emojis,
    actor.avatarDescription,
    actor.headerDescription,
  ];
  // The display settings, ?23 to ?25: a new account takes true for one the document leaves out, a stored one keeps it.
  const setting = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
  insertWithFreshId(
    "accounts",
    () => remoteId(actor.published ?? "", now),
    (id) =>
      db.run(
        `INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, indexable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at,
					emojis, avatar_description, header_description, show_featured, show_media, show_media_replies,
					document_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?23, 1), COALESCE(?24, 1),
					COALESCE(?25, 1), ${nextDocumentRevisionSql(null)})
				ON CONFLICT (uri) DO UPDATE SET username = CASE WHEN ?26 THEN accounts.username ELSE excluded.username END,
					document_revision = ${nextDocumentRevisionSql("accounts.document_revision")}, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url, locked = excluded.locked,
					discoverable = excluded.discoverable, indexable = excluded.indexable, inbox_url = excluded.inbox_url,
					shared_inbox_url = excluded.shared_inbox_url, raw = excluded.raw, fetched_at = excluded.fetched_at,
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
        setting(actor.showFeatured),
        setting(actor.showMedia),
        setting(actor.showRepliesInMedia),
        keep ? 1 : 0,
      ),
  );
  const row = remoteAccount(db, actor.uri);
  if (row !== undefined) {
    // The account's move as its document states it, set or cleared by every store (Mastodon's
    // ProcessAccountService: process_account_service.rb:166), written once the row is stored, by its id: an account
    // other than itself, stored and not being purged, by its actor id; one Kopje does not know reads as none, as it is
    // not fetched (process_account_service.rb:310-314 fetches it).
    db.run(
      `UPDATE accounts SET moved_to_account_id = (SELECT m.id FROM accounts m INDEXED BY ${ACCOUNTS_URI_INDEX}
				WHERE m.uri = ?2 AND m.id <> ?1 AND NOT ${deletingSql("m")})
			WHERE id = ?1 AND domain IS NOT NULL`,
      row.id,
      actor.movedTo,
    );
    // The links of its fields to verify, from the same projection (remote-field-links.ts).
    armRemoteFieldLinks(db, row.id, remoteLinkBack(actor.uri, actor.url), links, now);
    // Its avatar and header to cache, from the same projection (remote-media.ts).
    syncProfileFiles(db, row.id, { avatar: actor.avatarUrl, header: actor.headerUrl }, now);
    // Its custom emoji to cache, from the snapshot just stored (remote-media.ts).
    noteEmojiSnapshot(db, emojis, domain, now);
    // The document lists the actor's current keys; keys it no longer lists are not trusted any more.
    db.run("DELETE FROM remote_keys WHERE account_id = ?", row.id);
    for (const key of actor.keys) {
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
  const collections = actorCollections(actor.raw);
  const named = Object.values(collections).some((url) => url !== null);
  return { ...row, syncWaiting: named && requestCollectionSync(db, row.id, now), frozen: false };
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
