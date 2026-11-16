import { ACCOUNTS_URI_INDEX, LOCAL_ACCOUNTS_ID_INDEX, STATUSES_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { parseAddress } from "../platform/domain-name";
import { sameOrigin } from "../platform/http-url";
import { iso } from "../platform/iso-time";
import { STATUS_EMOJIS_BYTES, storedMediaMeta, storedTime } from "../platform/stored-bounds";
import { type Account, type Present, presentAccountById } from "./accounts";
import {
  availableSql,
  domainBlocksSql,
  findableBySql,
  interpretAddressing,
  isDistributable,
  isPublicCollection,
  QUOTE_POLICY_FLAGS,
  MENTION_STATUS_COLUMNS,
  mentionStatusSql,
  type StatusMention,
  viewableStatusId,
  type Visibility,
} from "./audience";
import { userWriteOperation } from "./auth";
import { emojiSnapshot } from "./custom-emojis";
import { insertWithFreshId, remoteId } from "./ids";
import { enqueueCard, remoteCardLink } from "./link-cards";
import { notify } from "./notifications";
import { isLocalPoll, markPollFetched, receiveVote, remotePollChanges, storeRemotePoll } from "./polls";
import { linkQuotes, promoteQuote, QUOTE_HOPS, quoteArrival, quoteDue, recordQuote, refreshQuote } from "./quotes";
import { withinRealTimeWindow } from "./real-time-window";
import {
  type DocumentRevision,
  remoteAccount,
  type RemoteActorInput,
  type RemoteRow,
  upsertRemoteActor,
} from "./remote-actors";
import { dropAttachmentFiles, noteStatusEmoji, syncAttachmentFiles } from "./remote-media";
import {
  type RemoteQuotePolicyInput,
  type RemoteMediaInput,
  type RemoteStatusInput,
  statusByUri,
  followersUri,
  type StoredStatus,
} from "./remote-status-reads";
import { isDeleted } from "./retractions";
import { normalizeSearchText } from "./search-text";
import { MAX_STATUS_MEDIA, MAX_STATUS_MENTION_ROWS, MAX_STATUS_TAGS, MAX_TAG_LENGTH } from "./status-bounds";
import { measureFilterText, presentStatus, type Status } from "./status-presenter";
import { MAX_STATUS_EDITS, notifyEdited, recordEdit, recountStatus, writeTags } from "./statuses";

// Remote statuses: Create, Update and the originals of boosts and search results, stored as Mastodon 4.7.5's
// ActivityPub::Activity::Create and ProcessStatusUpdateService store them; a search result Kopje already stores is
// its author's Update (storeFetchedStatus). The Worker has parsed the object as Mastodon reads it (compacted JSON),
// sanitized its content (HTML-1), kept only http(s) URLs (HTML-3) and cut it to the bounds below (RES-2, RES-4); here
// it is authorized against the stored state (ID-3, ID-6, ID-7) and written.
//
// Addressing goes through interpretAddressing (audience.ts): known accounts in to/cc that are not mentioned, and the
// owner of the personal inbox it came to, are silent mentions; a direct status with any is limited (VIS-2). Unknown
// mentioned or addressed accounts are not fetched and add nothing. The raw object is kept whole in statuses.raw.

// What one remote status may store (RES-4), as Mastodon caps it where it has a cap: 4 attachments
// (Status::MEDIA_ATTACHMENTS_LIMIT) and 10,000 code points of description (MAX_DESCRIPTION_HARD_LENGTH_LIMIT). Content
// is cut at REMOTE_HTML_RAW_LIMIT before sanitizing (security/html.ts). Mastodon has no cap on the rest; these are
// Kopje's.
// Attachments, tags and their names, mention rows (local accounts first, then mentions, then silent mentions) and
// media descriptions are bounded as status-bounds.ts states, content and content warnings as security/html.ts does.
export { MAX_STATUS_MEDIA, MAX_STATUS_MENTION_ROWS, MAX_STATUS_TAGS, MAX_TAG_LENGTH };
// Mention tags read, and to and cc entries read (Public is detected before the cut).
export const MAX_STATUS_MENTION_TAGS = 100;
export const MAX_STATUS_AUDIENCE = 1000;
export const MAX_SPOILER_LENGTH = 10_000;
// Replies stored before their parent that one arriving parent links (the rest stay unresolved, by uri).
export const MAX_LINKED_REPLIES = 100;
// An Update of an unknown status creates it only if the status is this recent (Mastodon's OBJECT_AGE_THRESHOLD).
const UPDATE_CREATES_WITHIN_MS = 24 * 60 * 60 * 1000;

export type StoreContext = {
  now: number;
  origin: string;
  // The local account whose personal inbox received the activity.
  deliveredTo: string | null;
  // Fetched by Kopje (a boosted original, a search result) rather than delivered: Mastodon's fetch?, which needs no
  // relation to a local account, and notifies only within the real-time window (real-time-window.ts).
  fetched: boolean;
  // The work budget of the status's quote (quotes.ts): QUOTE_HOPS when it arrives as a root, one less than its
  // quoting status's when it is stored as a quoted target during verification.
  quoteHops?: number;
};

// The context of a path that may update a stored status (updateRemoteStatus): also the Store's own time, which an
// accepted poll records as fetched (polls.ts markPollFetched).
export type UpdateContext = StoreContext & { storeNow: number };

export type StatusOutcome = { applied: boolean; reason: string; statusId?: string };

type Author = { id: string; uri: string };

// A remote time as stored: parsed, and never in the future (a future time would pin the status to the top of feeds);
// one it cannot store (storedTime: unreadable, or before year 0) is the arrival.
function remoteTime(value: string | null, now: number): number {
  const parsed = value === null ? NaN : Date.parse(value);
  return parsed > now || storedTime(parsed) === null ? now : parsed;
}

// How far ahead of the clock a remote version may be (clock skew between servers).
const VERSION_SKEW_MS = 5 * 60 * 1000;

// A remote version (updated, else published) as the remote wrote it, unclamped, so that versions compare by their own
// order whenever they arrive. NaN if there is none; Infinity if it is more than VERSION_SKEW_MS ahead of the clock,
// which no Update may be (it is ignored until the clock catches up, so a far-future version cannot be accepted
// again and again as the clock moves).
function versionOf(value: string | null, now: number): number {
  const parsed = value === null ? NaN : Date.parse(value);
  return parsed > now + VERSION_SKEW_MS ? Infinity : parsed;
}

// StatusParser#quote_policy (Status::InteractionPolicyConcern's flags, audience.ts QUOTE_POLICY_FLAGS) of a remote
// status by `author`: each half's flags from the URIs it lists: the public collection, the author's followers and
// following collections (as its stored actor document names them), the author itself (which means nobody, so it adds
// nothing), and anything else unsupported_policy; automatic in the high 16 bits. A Note that states no policy is 0,
// nobody, as Mastodon stores it. Stored at a status's first store and on every Update of it (explicit or implicit),
// never from a Create of a status already stored, so a replayed Create cannot bring an older policy back
// (test/quote-authoring.test.ts concurrency table, row 2). Advisory (FEP-044f): it decides only whether a local user
// may ask (R36); the quoted author's answer decides the quote.
function remoteQuotePolicy(db: Db, author: Author, policy: RemoteQuotePolicyInput | null | undefined): number {
  if (policy === null || policy === undefined) {
    return 0;
  }
  const collections = db.first<{ followers: string | null; following: string | null }>(
    `SELECT CASE WHEN json_type(raw, '$.followers') = 'text' THEN json_extract(raw, '$.followers') END AS followers,
			CASE WHEN json_type(raw, '$.following') = 'text' THEN json_extract(raw, '$.following') END AS following
		FROM accounts WHERE id = ?`,
    author.id,
  );
  const flags = (entries: readonly string[]): number => {
    let half = 0;
    for (const entry of new Set(entries)) {
      if (isPublicCollection(entry)) {
        half |= QUOTE_POLICY_FLAGS.public;
      } else if (entry === collections?.followers) {
        half |= QUOTE_POLICY_FLAGS.followers;
      } else if (entry === collections?.following) {
        half |= QUOTE_POLICY_FLAGS.following;
      } else if (entry !== author.uri) {
        half |= QUOTE_POLICY_FLAGS.unsupported_policy;
      }
    }
    return half;
  };
  return (flags(policy.automatic) << 16) | flags(policy.manual);
}

type Known = { byUri: Map<string, string>; local: Set<string> };

// Known accounts (local or remote) among uris, by their exact URI (ID-5), each sought through the URI index (RES-7).
function knownAccounts(db: Db, uris: readonly string[]): Known {
  const rows = db.all<{ id: string; uri: string; local: number }>(
    `SELECT id, uri, domain IS NULL AS local FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX}
		WHERE uri IN (SELECT value FROM json_each(?))`,
    JSON.stringify([...new Set(uris)]),
  );
  return {
    byUri: new Map(rows.map((row) => [row.uri, row.id])),
    local: new Set(rows.filter((row) => row.local === 1).map((row) => row.id)),
  };
}

// The account's accepted followers through follows_target, each looked up among the local accounts (RES-7).
export function hasLocalFollowers(db: Db, accountId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM follows f INDEXED BY follows_target CROSS JOIN local_accounts l ON l.account_id = f.account_id
			WHERE f.target_account_id = ? AND f.state = 'accepted' LIMIT 1`,
      accountId,
    ) !== undefined
  );
}

type Parent = { id: string; account_id: string; in_reply_to_uri: string | null; in_reply_to_account_id: string | null };

// The stored parent a reply names, never a boost; a withdrawn one (its removal under way) is none, so the reply gains
// it no reply, count or notification, and keeps only in_reply_to_uri.
function parentOf(db: Db, uri: string | null): Parent | undefined {
  return uri === null
    ? undefined
    : db.first<Parent>(
        `SELECT id, account_id, in_reply_to_uri, in_reply_to_account_id FROM statuses
				WHERE uri = ? AND reblog_of_id IS NULL AND withdrawn = 0`,
        uri,
      );
}

// The mention rows to write: local accounts first (they are who the audience rule serves), then mentions, then the
// rest, at most MAX_STATUS_MENTION_ROWS.
function boundedMentions(mentions: readonly StatusMention[], local: ReadonlySet<string>): StatusMention[] {
  const rank = (m: StatusMention) => (local.has(m.accountId) ? 0 : m.silent ? 2 : 1);
  return [...mentions].toSorted((a, b) => rank(a) - rank(b)).slice(0, MAX_STATUS_MENTION_ROWS);
}

// Mastodon's Create#related_to_local_activity? for a delivered status: public and unlisted ones need a local follower
// of the author, a reply to a local status or to a followed account, or a local account in to/cc (or the personal
// inbox); private ones a local follower or a local account addressed; direct ones a local account addressed.
function relatedToLocal(
  db: Db,
  author: Author,
  visibility: Visibility,
  addressesLocal: boolean,
  parent: Parent | undefined,
): boolean {
  if (addressesLocal) {
    return true;
  }
  if (visibility === "direct" || visibility === "limited") {
    return false;
  }
  if (hasLocalFollowers(db, author.id)) {
    return true;
  }
  if (visibility === "private" || parent === undefined) {
    return false;
  }
  const parentLocal =
    db.first("SELECT 1 AS x FROM local_accounts WHERE account_id = ?", parent.account_id) !== undefined;
  return parentLocal || hasLocalFollowers(db, parent.account_id);
}

function mediaMeta(media: RemoteMediaInput): string | null {
  const original = media.width !== null && media.height !== null ? { width: media.width, height: media.height } : null;
  if (original === null && media.focus === null) {
    return null;
  }
  return storedMediaMeta(JSON.stringify(original === null ? {} : { original }));
}

function writeMedia(db: Db, statusId: string, author: Author, media: readonly RemoteMediaInput[], ctx: StoreContext) {
  const current = db.all<{ id: string; url: string }>(
    "SELECT id, url FROM media_attachments WHERE status_id = ? AND file_token IS NULL",
    statusId,
  );
  const kept = new Set<string>();
  media.slice(0, MAX_STATUS_MEDIA).forEach((m, position) => {
    const values = [
      position,
      m.type,
      m.url,
      m.previewUrl,
      m.description,
      mediaMeta(m),
      m.focus?.x ?? 0,
      m.focus?.y ?? 0,
      m.blurhash,
    ] as const;
    const existing = current.find((row) => row.url === m.url && !kept.has(row.id));
    if (existing !== undefined) {
      kept.add(existing.id);
      db.run(
        `UPDATE media_attachments SET position = ?, type = ?, url = ?, preview_url = ?, description = ?, meta = ?,
					focus_x = ?, focus_y = ?, blurhash = ? WHERE id = ?`,
        ...values,
        existing.id,
      );
      syncAttachmentFiles(db, existing.id, ctx.now);
      return;
    }
    const inserted = insertWithFreshId(
      "media_attachments",
      () => remoteId("", ctx.now),
      (id) => {
        db.run(
          `INSERT INTO media_attachments (id, account_id, status_id, position, type, url, preview_url, description,
						meta, focus_x, focus_y, blurhash, processed, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          id,
          author.id,
          statusId,
          ...values,
          iso(ctx.now),
        );
        return id;
      },
    );
    syncAttachmentFiles(db, inserted, ctx.now);
  });
  for (const row of current) {
    if (!kept.has(row.id)) {
      // Its cached files first, so no slot outlives the row (remote-media.ts).
      dropAttachmentFiles(db, row.id, ctx.now);
      db.run("DELETE FROM media_attachments WHERE id = ? AND file_token IS NULL", row.id);
    }
  }
}

// The snapshot of the emoji the status's stored texts reference (custom-emojis.ts): its content warning, the text of
// its content and its poll's choices, each scanned alone.
function statusEmojis(input: RemoteStatusInput): string | null {
  const texts = [input.spoilerText, input.text, ...(input.poll?.options ?? [])];
  return emojiSnapshot(input.emojiTags, texts, STATUS_EMOJIS_BYTES);
}

function searchText(input: RemoteStatusInput): string {
  return normalizeSearchText(`${input.spoilerText} ${input.text}`);
}

// The object's atomUri when it names another status than its id, else null (RemoteStatusInput.atomUri).
function otherAtomUri(input: RemoteStatusInput): string | null {
  return input.atomUri === undefined || input.atomUri === input.uri ? null : input.atomUri;
}

// ID-7: whether `uri`, or the atomUri naming the status it may be, was retracted by the author or deleted.
function isDeletedUnder(db: Db, authorUri: string, uri: string, atomUri: string | null, now: number): boolean {
  return isDeleted(db, authorUri, uri, now) || (atomUri !== null && isDeleted(db, authorUri, atomUri, now));
}

// Mastodon's ActivityPub::Activity::Create#create_status for an object whose author is `author` (already stored and
// verified: the actor of the activity, or the fetched author of a fetched object). A stored status is found as
// Create#find_existing_status finds it: by the object's id, else by its atomUri; the outcome's statusId names the row
// found or created, which the stored document's own id may not (a match by atomUri).
export function storeRemoteStatus(db: Db, author: Author, input: RemoteStatusInput, ctx: StoreContext): StatusOutcome {
  // ID-6: the object is the author's, on the author's origin; ID-3: so it is never a local object.
  if (!sameOrigin(input.uri, author.uri)) {
    return { applied: false, reason: "foreign-object" };
  }
  if (input.attributedTo !== null && input.attributedTo !== author.uri) {
    return { applied: false, reason: "not-author" };
  }
  const atomUri = otherAtomUri(input);
  // ID-7: a Delete that arrived first keeps the object from appearing, and a deleted stored object is not created
  // again by anyone (ID-6), under its id or under another id naming it by atomUri.
  if (isDeletedUnder(db, author.uri, input.uri, atomUri, ctx.now)) {
    return { applied: false, reason: "retracted" };
  }
  // R38, VIS-30: nothing is stored for an unavailable author (an account the instance suspended), whichever path
  // fetched it, as Mastodon's FetchRemoteStatusService refuses a suspended author.
  if (db.first(`SELECT 1 AS x WHERE ${availableSql("?1")}`, author.id) === undefined) {
    return { applied: false, reason: "author-unavailable" };
  }
  // Create#poll_vote?: a Note naming a choice in reply to a local poll is a vote, counted when it may be
  // (receiveVote), and never stored as a status.
  const votedIn = input.name === null || input.name === undefined ? undefined : parentOf(db, input.inReplyTo);
  if (input.name !== null && input.name !== undefined && votedIn !== undefined && isLocalPoll(db, votedIn.id)) {
    const counted = receiveVote(db, {
      voterId: author.id,
      statusId: votedIn.id,
      name: input.name,
      uri: input.uri,
      now: ctx.now,
    });
    return { applied: counted, reason: counted ? "vote" : "vote-refused" };
  }
  // ID-3, ID-6: a status found by atomUri is matched only when it is the author's own (Create, mastodon#39916).
  const byId = statusByUri(db, input.uri);
  const existing = byId ?? (atomUri === null ? undefined : statusByUri(db, atomUri));
  if (existing !== undefined) {
    if (existing.account_id !== author.id) {
      return { applied: false, reason: "not-author" };
    }
    if (byId === undefined) {
      linkMatchedReplies(db, author, input.uri, atomUri);
    }
    // A known status arriving again as a root verifies its quote as any root does (quotes.ts promoteQuote).
    promoteQuote(db, existing.id, arrivalOf(db, author, ctx), ctx.now);
    return extendAudience(db, existing, ctx.deliveredTo);
  }
  const to = input.to.slice(0, MAX_STATUS_AUDIENCE);
  const cc = input.cc.slice(0, MAX_STATUS_AUDIENCE);
  const mentionUris = input.mentions.slice(0, MAX_STATUS_MENTION_TAGS);
  const known = knownAccounts(db, [...to, ...cc, ...mentionUris]);
  const deliveredTo = ctx.deliveredTo;
  const { visibility, mentions } = interpretAddressing({
    to,
    cc,
    followersUri: followersUri(db, author.id),
    mentionUris,
    known: known.byUri,
    deliveredTo,
  });
  // The known accounts of to and cc, and with them the owner of the personal inbox it came to (Mastodon's
  // accounts_in_audience).
  const addressed = new Set(
    [...to, ...cc].flatMap((uri) => {
      const id = known.byUri.get(uri);
      return id === undefined ? [] : [id];
    }),
  );
  const audience = deliveredTo === null ? addressed : new Set([...addressed, deliveredTo]);
  const parent = parentOf(db, input.inReplyTo);
  const addressesLocal = [...audience].some((id) => known.local.has(id) || id === deliveredTo);
  if (!ctx.fetched && !relatedToLocal(db, author, visibility, addressesLocal, parent)) {
    return { applied: false, reason: "unrelated" };
  }
  const published = remoteTime(input.published, ctx.now);
  const updated = input.updated === null ? null : remoteTime(input.updated, ctx.now);
  const quotePolicy = remoteQuotePolicy(db, author, input.quotePolicy);
  const declared = versionOf(input.updated ?? input.published, ctx.now);
  const version = Number.isFinite(declared) ? declared : published;
  // Status#carried_over_reply_to_account_id.
  const replyTarget =
    parent === undefined
      ? null
      : parent.account_id === author.id && parent.in_reply_to_uri !== null
        ? parent.in_reply_to_account_id
        : parent.account_id;
  // Its thread (statuses.thread): the parent's when the parent is stored, else the conversation the sender names
  // (ActivityPub::Activity::Create#conversation_from_uri), else what the trigger of migration 0009 gives.
  const id = insertWithFreshId(
    "statuses",
    () => remoteId(iso(published), ctx.now),
    (candidate) => {
      db.run(
        `INSERT INTO statuses (id, uri, url, account_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
					visibility, spoiler_text, content, sensitive, language, published_at, edited_at, remote_version, raw,
					search_text, created_at, thread, quote_policy, emojis)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
					COALESCE((SELECT p.thread FROM statuses p WHERE p.id = ?6), ?), ?, ?)`,
        candidate,
        input.uri,
        input.url,
        author.id,
        input.inReplyTo,
        parent?.id ?? null,
        replyTarget,
        visibility,
        input.spoilerText,
        input.content,
        input.sensitive ? 1 : 0,
        input.language,
        iso(published),
        updated !== null && updated !== published ? iso(updated) : null,
        iso(version),
        input.raw,
        searchText(input),
        iso(ctx.now),
        input.conversation ?? null,
        quotePolicy,
        statusEmojis(input),
      );
      return candidate;
    },
  );
  const rows = boundedMentions(mentions, known.local);
  db.run(
    `INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		SELECT ?1, json_extract(value, '$.accountId'), json_extract(value, '$.silent'), ${mentionStatusSql("?1")}
		FROM json_each(?2) WHERE true
		ON CONFLICT DO NOTHING`,
    id,
    JSON.stringify(rows.map((m) => ({ accountId: m.accountId, silent: m.silent ? 1 : 0 }))),
  );
  writeTags(db, id, input.tags.slice(0, MAX_STATUS_TAGS));
  writeMedia(db, id, author, input.media, ctx);
  noteStatusEmoji(db, id, ctx.now);
  if (input.poll !== null && input.poll !== undefined) {
    storeRemotePoll(db, id, input.poll, true, ctx.now);
  }
  measureFilterText(db, id, iso(ctx.now));
  recountStatus(db, parent?.id ?? null);
  const isReply = input.inReplyTo !== null;
  linkReplies(db, { id, uri: input.uri, accountId: author.id, replyTarget, isReply });
  // A new status has no quote to remove: only one it names is recorded.
  if (input.quote !== undefined && input.quote !== null) {
    recordQuote(db, { id, uri: input.uri, author }, input.quote, arrivalOf(db, author, ctx), ctx, storeRemoteStatus);
  }
  linkQuotes(db, { id, uri: input.uri }, ctx.now);
  // Create#process_status's LinkCrawlWorker, for every status stored (a fetched one included).
  enqueueCard(db, id, remoteCardLink(db, id, input.cardCandidates, new URL(ctx.origin).host, input.cardLink), ctx.now);
  // Create#distribute fans out a delivered status, and a fetched one only within the real-time window (create.rb:92 in
  // v4.7.5). A fetch has no delivered_to_account_id (ActivityPub::FetchRemoteStatusService), so a fetched status's
  // limited condition counts to and cc alone, whatever inbox the fetch began from.
  if (!ctx.fetched || withinRealTimeWindow(db, id)) {
    notifyCreated(db, {
      id,
      author,
      rows,
      local: known.local,
      audience: ctx.fetched ? addressed : audience,
      language: input.language,
      replyTarget,
      isReply,
      now: ctx.now,
    });
  }
  return { applied: true, reason: "created", statusId: id };
}

// How a status came, for its quote's work (quotes.ts).
function arrivalOf(db: Db, author: Author, ctx: StoreContext) {
  return quoteArrival(db, author.id, ctx.deliveredTo, ctx.quoteHops ?? QUOTE_HOPS);
}

// ThreadResolveWorker: replies stored before an object, waiting on its id, are linked to the status found by its
// atomUri (matchedUri; a Create, an Update), as to one created under the id (parentOf: never a boost or a withdrawn
// status).
function linkMatchedReplies(db: Db, author: Author, objectId: string, matchedUri: string | null): void {
  const found = parentOf(db, matchedUri);
  if (found !== undefined) {
    linkReplies(db, {
      id: found.id,
      uri: objectId,
      accountId: author.id,
      replyTarget: found.in_reply_to_account_id,
      isReply: found.in_reply_to_uri !== null,
    });
  }
}

// Replies that arrived before this status are linked to it now (a bounded number; the rest keep their uri).
function linkReplies(
  db: Db,
  status: { id: string; uri: string; accountId: string; replyTarget: string | null; isReply: boolean },
): void {
  const changed = db.run(
    `UPDATE statuses INDEXED BY ${STATUSES_ID_INDEX} SET in_reply_to_id = ?1,
			in_reply_to_account_id = CASE WHEN account_id = ?2 AND ?3 THEN ?4 ELSE ?2 END
		WHERE id IN (SELECT id FROM statuses INDEXED BY statuses_unresolved_reply
			WHERE in_reply_to_uri = ?5 AND in_reply_to_uri IS NOT NULL AND in_reply_to_id IS NULL LIMIT ?6)`,
    status.id,
    status.accountId,
    status.isReply ? 1 : 0,
    status.replyTarget,
    status.uri,
    MAX_LINKED_REPLIES,
  );
  if (changed > 0) {
    recountStatus(db, status.id);
  }
}

// Mastodon's mention notifications (FanOutOnWriteService#notify_mentioned_accounts!, fan_out_on_write_service.rb:68-75
// in v4.7.5): each local account the status mentions (not silently), and one it tags without addressing it (not in
// `audience`, to/cc and, for a delivered status, the owner of the personal inbox it came to: Create#process_audience's
// silenced_account_ids, create.rb:155) marked `limited`, so the policy's limited accounts condition applies; and
// FeedInsertWorker#notify? for followers who asked to hear of the author's posts. notify() applies the audience rule.
function notifyCreated(
  db: Db,
  created: {
    id: string;
    author: Author;
    rows: readonly StatusMention[];
    local: ReadonlySet<string>;
    audience: ReadonlySet<string>;
    language: string | null;
    replyTarget: string | null;
    isReply: boolean;
    now: number;
  },
): void {
  const { id, author, now } = created;
  for (const mention of created.rows) {
    if (!mention.silent && created.local.has(mention.accountId)) {
      notify(db, {
        recipientId: mention.accountId,
        type: "mention",
        fromId: author.id,
        statusId: id,
        now,
        limited: !created.audience.has(mention.accountId),
      });
    }
  }
  // No post notification for a reply other than in the author's own conversation, its partner unknown included
  // (FeedInsertWorker#notify?).
  if (created.isReply && created.replyTarget !== author.id) {
    return;
  }
  // The local accounts drive, each one's accepted follow of the author sought by follows_accepted, so the author's other
  // followers (an import may hold any number) are never read; local accounts are operator-sized (docs/threat-model.md,
  // "Deployment assumptions").
  const subscribers = db.all<{ account_id: string }>(
    `SELECT f.account_id FROM local_accounts l INDEXED BY ${LOCAL_ACCOUNTS_ID_INDEX}
		CROSS JOIN follows f INDEXED BY follows_accepted ON f.account_id = l.account_id AND f.target_account_id = ?1
		WHERE f.state = 'accepted' AND f.notify = 1
			AND (f.languages IS NULL OR ?2 IS NULL OR ?2 IN (SELECT value FROM json_each(f.languages)))`,
    author.id,
    created.language,
  );
  for (const subscriber of subscribers) {
    notify(db, { recipientId: subscriber.account_id, type: "status", fromId: author.id, statusId: id, now });
  }
}

// Create#postprocess_audience_and_deliver: a known status delivered again to a personal inbox whose owner it does not
// address gains them as a silent mention (a direct status becomes limited). Nothing else changes (ID-7).
function extendAudience(db: Db, existing: StoredStatus, deliveredTo: string | null): StatusOutcome {
  if (
    deliveredTo === null ||
    existing.reblog_of_id !== null ||
    db.first("SELECT 1 AS x FROM status_mentions WHERE status_id = ? AND account_id = ?", existing.id, deliveredTo) !==
      undefined
  ) {
    return { applied: false, reason: "duplicate", statusId: existing.id };
  }
  // The mention bound holds here too (RES-4): a local recipient takes the place of a remote silent one, else of a
  // remote mention; if every row is local, it is not added.
  const count = db.first<{ n: number }>("SELECT count(*) AS n FROM status_mentions WHERE status_id = ?", existing.id);
  if ((count?.n ?? 0) >= MAX_STATUS_MENTION_ROWS) {
    const evicted = db.run(
      `DELETE FROM status_mentions WHERE status_id = ?1 AND account_id = (SELECT m.account_id FROM status_mentions m
				LEFT JOIN local_accounts l ON l.account_id = m.account_id
				WHERE m.status_id = ?1 AND l.account_id IS NULL ORDER BY m.silent DESC LIMIT 1)`,
      existing.id,
    );
    if (evicted === 0) {
      return { applied: false, reason: "mention-cap", statusId: existing.id };
    }
  }
  db.run(
    `INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		VALUES (?1, ?2, 1, ${mentionStatusSql("?1")}) ON CONFLICT DO NOTHING`,
    existing.id,
    deliveredTo,
  );
  db.run("UPDATE statuses SET visibility = 'limited' WHERE id = ? AND visibility = 'direct'", existing.id);
  return { applied: true, reason: "audience-extended", statusId: existing.id };
}

// Mastodon's ActivityPub::Activity::Update#update_status and ProcessStatusUpdateService, for `author`'s status.
//   - ID-6: only the status's author updates it; a local status is never one (ID-3).
//   - An Update whose `updated` is older than the stored version, or that names none for an edited status (edited_at
//     set), changes nothing; one naming the stored version, or none for a status never edited, is the implicit update
//     (its poll's counts, its quote policy, its quote's stamp); so a reordered or repeated Update changes no content
//     (ID-7).
//   - The visibility never changes, and the audience of a private, direct or limited status never widens: a mention
//     the edit adds is linked in the content but adds no recipient (as an outbound edit does). Public and unlisted
//     statuses take new mentions, as Mastodon does. A mention the edit removes stays as a silent mention.
//   - A significant change (content, spoiler, media, poll) is recorded in status_edits, the original first, and runs
//     the update fan-out (notifyEdited); history keeps at most MAX_STATUS_EDITS versions, the newest replacing the last
//     one.
//   - An Update of an unknown status creates it if it is recent (Create and Update out of order), unless its atomUri
//     names a stored status: Update#update_status reaches Create#create_status, which finds that status
//     (find_existing_status) and treats it as a Create of it would, and ProcessStatusUpdateService updates it as by its
//     id, under that status's uri.
export function updateRemoteStatus(
  db: Db,
  author: Author,
  input: RemoteStatusInput,
  ctx: UpdateContext,
): StatusOutcome {
  if (!sameOrigin(input.uri, author.uri)) {
    return { applied: false, reason: "foreign-object" };
  }
  if (input.attributedTo !== null && input.attributedTo !== author.uri) {
    return { applied: false, reason: "not-author" };
  }
  const atomUri = otherAtomUri(input);
  // ID-7: a status whose Delete was recorded (possibly still being removed) takes no Update, from anyone, under its id
  // or under another id naming it by atomUri.
  if (isDeletedUnder(db, author.uri, input.uri, atomUri, ctx.now)) {
    return { applied: false, reason: "retracted" };
  }
  // A version too far ahead changes nothing, an unknown status included: no row, history or notification.
  const version = versionOf(input.updated, ctx.now);
  if (version === Infinity) {
    return { applied: false, reason: "future" };
  }
  let existing = statusByUri(db, input.uri);
  // The stored status's own uri, which an atomUri match keeps (its quote is recorded under it).
  let uri = input.uri;
  if (existing === undefined) {
    const published = input.published === null ? NaN : Date.parse(input.published);
    if (!Number.isNaN(published) && published < ctx.now - UPDATE_CREATES_WITHIN_MS) {
      return { applied: false, reason: "unknown-object" };
    }
    const matched = atomUri === null ? undefined : statusByUri(db, atomUri);
    if (atomUri === null || matched === undefined) {
      return storeRemoteStatus(db, author, input, ctx);
    }
    existing = matched;
    uri = atomUri;
  }
  // ID-3, ID-6: found by its id or by atomUri, only the author's own original is updated.
  if (existing.account_id !== author.id || existing.reblog_of_id !== null) {
    return { applied: false, reason: "not-author" };
  }
  // Update#update_status reaches Create#create_status for an unknown id: the status it finds by atomUri gains the
  // delivery's recipient (postprocess_audience_and_deliver) and the replies waiting on the id, as for a Create, before
  // the edit applies or not.
  if (uri !== input.uri) {
    extendAudience(db, existing, ctx.deliveredTo);
    linkMatchedReplies(db, author, input.uri, uri);
  }
  // The watermark is the last accepted version, whether or not it changed the history, as the remote wrote it.
  const stored = Date.parse(existing.watermark ?? "");
  // ProcessStatusUpdateService#already_updated_more_recently?: an older version changes nothing, its poll included;
  // and so does one that names no version for an edited status (process_status_update_service.rb:32-34 in v4.7.5,
  // "an older update"), such as a peer's cached copy from before the edit (ID-7).
  if (version < stored || (Number.isNaN(version) && existing.edited_at !== null)) {
    return { applied: false, reason: "stale" };
  }
  const arrival = arrivalOf(db, author, ctx);
  if (Number.isNaN(version) || version === stored) {
    // ProcessStatusUpdateService#handle_implicit_update!: an Update that names the stored version, or none for a status
    // never edited (such as the Update of a poll's counts, which names one only once the status was edited), still
    // refreshes the counts, the end and the voters of its poll, and verifies a changed stamp of the same quote again;
    // the quoted status itself changes only with a newer version.
    const restamped = refreshQuote(db, { id: existing.id, uri, author }, input.quote, arrival, ctx, storeRemoteStatus);
    const policyChanged =
      db.run(
        "UPDATE statuses SET quote_policy = ?1 WHERE id = ?2 AND quote_policy <> ?1",
        remoteQuotePolicy(db, author, input.quotePolicy),
        existing.id,
      ) > 0;
    const poll = input.poll === undefined ? undefined : storeRemotePoll(db, existing.id, input.poll, false, ctx.now);
    if (poll !== undefined) {
      markPollFetched(db, existing.id, poll, ctx.storeNow);
    }
    const pollUpdated = poll === "written";
    // It broadcasts the update when it moved the quote's state (:82 in v4.7.5): a changed stamp, which resets the quote
    // (refreshQuote). Not a legacy form alone, the same stamp, the poll or the quote policy.
    if (restamped) {
      notifyEdited(db, existing.id, author.id, ctx.now);
    }
    return pollUpdated
      ? { applied: true, reason: "poll-updated", statusId: existing.id }
      : policyChanged
        ? { applied: true, reason: "policy-updated", statusId: existing.id }
        : { applied: false, reason: "stale", statusId: existing.id };
  }
  // A version before year 0 (one past a watermark it cannot read) is stored as the arrival, as remoteTime stores it.
  const editedAt = storedTime(Math.min(version, ctx.now)) ?? iso(ctx.now);
  const media = input.media.slice(0, MAX_STATUS_MEDIA);
  // MediaAttachmentParser#significantly_changes?: the url, the icon (thumbnail_remote_url) or the description; a
  // blurhash alone records no edit, as in Mastodon, and is written with the media below.
  const currentMedia = db.all<{ url: string; preview_url: string | null; description: string }>(
    "SELECT url, preview_url, description FROM media_attachments WHERE status_id = ? ORDER BY position, id",
    existing.id,
  );
  const mediaChanged =
    JSON.stringify(currentMedia.map((m) => [m.url, m.preview_url, m.description])) !==
    JSON.stringify(media.map((m) => [m.url, m.previewUrl, m.description]));
  const significant =
    input.content !== existing.content ||
    input.spoilerText !== existing.spoiler_text ||
    mediaChanged ||
    remotePollChanges(db, existing.id, input.poll ?? null);
  const versions = significant
    ? (db.first<{ n: number }>("SELECT COUNT(*) AS n FROM status_edits WHERE status_id = ?", existing.id)?.n ?? 0)
    : 0;
  if (significant && versions === 0) {
    recordEdit(db, existing.id, existing.published_at);
  }
  markPollFetched(db, existing.id, storeRemotePoll(db, existing.id, input.poll ?? null, true, ctx.now), ctx.storeNow);
  db.run(
    `UPDATE statuses SET content = ?, spoiler_text = ?, sensitive = ?, language = ?, raw = ?, search_text = ?,
			remote_version = ?, edited_at = CASE WHEN ? THEN ? ELSE edited_at END, quote_policy = ?, emojis = ?,
			filter_text_units = NULL
		WHERE id = ?`,
    input.content,
    input.spoilerText,
    input.sensitive ? 1 : 0,
    input.language,
    input.raw,
    searchText(input),
    iso(version),
    significant ? 1 : 0,
    editedAt,
    remoteQuotePolicy(db, author, input.quotePolicy),
    statusEmojis(input),
    existing.id,
  );
  // update_mentions! makes every tagged account an active mention (process_status_update_service.rb:299 in v4.7.5),
  // addressed or not; the addressed accounts only order the cap's eviction (updateMentions).
  const audience = knownAccounts(db, [...input.to, ...input.cc].slice(0, MAX_STATUS_AUDIENCE));
  const addressed = new Set([...audience.local, ...(ctx.deliveredTo === null ? [] : [ctx.deliveredTo])]);
  updateMentions(db, existing, input, addressed);
  writeTags(db, existing.id, input.tags.slice(0, MAX_STATUS_TAGS));
  writeMedia(db, existing.id, author, media, ctx);
  measureFilterText(db, existing.id, iso(ctx.now));
  noteStatusEmoji(db, existing.id, ctx.now);
  recordQuote(db, { id: existing.id, uri, author }, input.quote, arrival, ctx, storeRemoteStatus);
  if (significant) {
    // ProcessStatusUpdateService#reset_preview_card!: the card is fetched again from the Update's first Link, else its
    // anchors (:447-450). A change of the Links alone is not significant (:187), nor here a quote's, so neither
    // resets anything.
    enqueueCard(
      db,
      existing.id,
      remoteCardLink(db, existing.id, input.cardCandidates, new URL(ctx.origin).host, input.cardLink),
      ctx.now,
    );
    if (versions + (versions === 0 ? 2 : 1) > MAX_STATUS_EDITS) {
      db.run("DELETE FROM status_edits WHERE id = (SELECT max(id) FROM status_edits WHERE status_id = ?)", existing.id);
    }
    recordEdit(db, existing.id, editedAt);
    // handle_explicit_update! broadcasts only a significant change (:64, :452-454), so an Update that is not notifies
    // no one, an account it newly tags included; broadcast_updates! fans out without silenced ids (:453), so each
    // mention is notified as an ordinary one.
    notifyEdited(db, existing.id, author.id, ctx.now);
  }
  return { applied: true, reason: significant ? "edited" : "updated", statusId: existing.id };
}

// A status Kopje fetched, which it may already store, as ActivityPub::FetchRemoteStatusService#call takes it
// (fetch_remote_status_service.rb:44-48 in v4.7.5): nothing for an unavailable author (R38, VIS-30), an update included;
// a status stored under the document's id (never its atomUri), by `author`, an original, is updated as by its author's
// Update (updateRemoteStatus: its version rules, fan-out and quote); anything else is a Create (storeRemoteStatus,
// whose lookup by atomUri keeps what it finds). An update that stops before its quote step (an older version, one
// past the skew, or none for an edited status) still has the status arrive again as a root, as storeRemoteStatus's
// known branch does (promoteQuote), and its outcome names the stored status unless that is retracted.
function storeFetchedStatus(db: Db, author: Author, input: RemoteStatusInput, ctx: UpdateContext): StatusOutcome {
  if (db.first(`SELECT 1 AS x WHERE ${availableSql("?1")}`, author.id) === undefined) {
    return { applied: false, reason: "author-unavailable" };
  }
  const stored = statusByUri(db, input.uri);
  if (stored === undefined || stored.account_id !== author.id || stored.reblog_of_id !== null) {
    return storeRemoteStatus(db, author, input, ctx);
  }
  const outcome = updateRemoteStatus(db, author, input, ctx);
  // updateRemoteStatus answers these without a status id only from its checks before the quote step.
  if (outcome.statusId === undefined && (outcome.reason === "stale" || outcome.reason === "future")) {
    promoteQuote(db, stored.id, arrivalOf(db, author, ctx), ctx.now);
    return { ...outcome, statusId: stored.id };
  }
  return outcome;
}

// ProcessStatusUpdateService#update_mentions!, with the audience of a non-public status kept (see updateRemoteStatus).
// At the MAX_STATUS_MENTION_ROWS cap, a public or unlisted status admits a newly mentioned local account it addresses
// in place of a remote recipient no longer mentioned (silent ones first); a non-public audience stays frozen.
function updateMentions(
  db: Db,
  existing: StoredStatus,
  input: RemoteStatusInput,
  addressed: ReadonlySet<string>,
): void {
  const hrefs = input.mentions.slice(0, MAX_STATUS_MENTION_TAGS);
  const known = knownAccounts(db, hrefs);
  const rows = db.all<{ account_id: string; silent: number }>(
    "SELECT account_id, silent FROM status_mentions WHERE status_id = ?",
    existing.id,
  );
  const present = new Set(rows.map((row) => row.account_id));
  let room = Math.max(MAX_STATUS_MENTION_ROWS - present.size, 0);
  const current = [...new Set(hrefs.flatMap((uri) => known.byUri.get(uri) ?? []))];
  const added = current.filter((id) => !present.has(id));
  const distributable = isDistributable(existing.visibility);
  const local = added.filter((id) => known.local.has(id) && addressed.has(id));
  const ordered = [...local, ...added.filter((id) => !local.includes(id))];
  if (distributable && local.length > room) {
    room += db.run(
      `DELETE FROM status_mentions WHERE status_id = ?1 AND account_id IN (SELECT m.account_id FROM status_mentions m
				LEFT JOIN local_accounts l ON l.account_id = m.account_id
				WHERE m.status_id = ?1 AND l.account_id IS NULL AND m.account_id NOT IN (SELECT value FROM json_each(?2))
				ORDER BY m.silent DESC LIMIT ?3)`,
      existing.id,
      JSON.stringify(current),
      local.length - room,
    );
  }
  const allowed = [...current.filter((id) => present.has(id)), ...(distributable ? ordered.slice(0, room) : [])];
  db.run(
    `UPDATE status_mentions SET silent = 1 WHERE status_id = ?1 AND account_id NOT IN (SELECT value FROM json_each(?2))`,
    existing.id,
    JSON.stringify(allowed),
  );
  db.run(
    `INSERT INTO status_mentions (status_id, account_id, silent, ${MENTION_STATUS_COLUMNS})
		SELECT ?1, value, 0, ${mentionStatusSql("?1")} FROM json_each(?2) WHERE true
		ON CONFLICT (status_id, account_id) DO UPDATE SET silent = 0`,
    existing.id,
    JSON.stringify(allowed),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Search resolution (GET /api/v2/search?resolve=true)
// ---------------------------------------------------------------------------------------------------------------

// What the Worker fetched for a resolve query (federation/resolve.ts): an account, or a status with its author, each
// fetched through the safe loader signed by the instance actor and parsed as inbound documents are. none: nothing was
// fetched (a local URL, an unusable answer, a failed fetch); the query is then looked up by uri in stored data only,
// unless `gone`: the URL's last fetch answered 410. revision: the actor's (the author's) as read before its document was
// fetched (remote-actors.ts DocumentRevision).
export type Resolved =
  | { kind: "account"; actor: RemoteActorInput; revision: DocumentRevision }
  | { kind: "status"; status: RemoteStatusInput; author: RemoteActorInput; revision: DocumentRevision }
  | { kind: "none"; gone?: true };

// The queries resolve=true fetches (Mastodon's SearchService#url_query? and AccountSearchService's address forms): an
// http(s) URL, or an address (parseAddress in platform/domain-name.ts: user@domain, @user@domain or acct:user@domain).
export function isUrlQuery(query: string): boolean {
  return /^https?:\/\//i.test(query);
}

// The WebFinger request (RFC 7033) for acct:<username>@<host>.
export function webfingerUrl(username: string, host: string): string {
  return `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${host}`)}`;
}

// What a search resolution of the trimmed `query` fetches (federation/resolve.ts resolveWith), read one way for the
// fetch and for its preparation (inbox.ts resolutionGate): an address, by its WebFinger, or a URL; null when nothing is
// fetched: an address on the instance `domain`, a URL on its host (both answered from stored data), or a query that is
// neither.
export type ResolutionTarget = { kind: "address"; username: string; domain: string } | { kind: "url"; href: string };

export function resolutionTarget(query: string, domain: string): ResolutionTarget | null {
  const address = parseAddress(query);
  if (address !== null) {
    return address.domain === domain ? null : { kind: "address", ...address };
  }
  let url: URL;
  try {
    url = new URL(query);
  } catch {
    return null;
  }
  return url.host === domain ? null : { kind: "url", href: url.href };
}

// The first request a resolution of `target` makes.
export function firstRequestOf(target: ResolutionTarget): string {
  return target.kind === "address" ? webfingerUrl(target.username, target.domain) : target.href;
}

// storeNow: the Store's own time (atStoreTime), which a fetched poll records (UpdateContext).
export type ResolveInput = {
  query: string;
  resolved: Resolved;
  now: number;
  storeNow: number;
  origin: string;
  present: Present;
};

// quotesDue: the status found has a quote whose verification is due (the Worker asks the Queue for a job round).
export type ResolveResult = { accounts: Account[]; statuses: Status[]; quotesDue?: boolean };

// What a resolution stored, by id: the account or status the query names, or nothing. quotesDue: the status has a quote
// whose verification is due (the Worker asks the Queue for a job round).
export type StoredResolution =
  | { kind: "account"; id: string | undefined }
  | { kind: "status"; id: string | undefined; quotesDue: boolean }
  | { kind: "none" };

// Stores what was resolved with the validation of inbound activities (ID-3, ID-7, HTML-1, HTML-3, RES-4): the one
// ingestion of search resolution and of /authorize_interaction (domain/interaction.ts). An actor document superseded
// since its revision was read is not stored; the stored row is answered instead. A fetched status goes through
// storeFetchedStatus, so one Kopje stores is applied as its author's Update (Mastodon's ResolveURLService hands the
// fetched body to FetchRemoteStatusService, resolve_url_service.rb:28). With nothing fetched (a 404 included), the
// query is looked up by uri in stored data and nothing is removed (process_url_from_db, :38-61); a stored status found
// so arrives as a root, and its quote is verified as any root's. After a 410 (`gone`) nothing is answered and nothing
// is removed: Mastodon answers a stored status only after a 401, 403 or 404 (:44).
export function storeResolved(
  db: Db,
  { query, resolved, now, storeNow, origin }: Pick<ResolveInput, "query" | "resolved" | "now" | "storeNow" | "origin">,
): StoredResolution {
  const storedActor = (actor: RemoteActorInput, revision: DocumentRevision): RemoteRow | undefined => {
    const stored = upsertRemoteActor(db, actor, origin, now, revision);
    return stored === "superseded" ? remoteAccount(db, actor.uri) : stored;
  };
  switch (resolved.kind) {
    case "account":
      return { kind: "account", id: storedActor(resolved.actor, resolved.revision)?.id };
    case "status": {
      const author = storedActor(resolved.author, resolved.revision);
      if (author === undefined) {
        return { kind: "none" };
      }
      const stored = storeFetchedStatus(db, author, resolved.status, {
        now,
        storeNow,
        origin,
        deliveredTo: null,
        fetched: true,
      });
      return {
        kind: "status",
        id: stored.statusId,
        quotesDue: stored.statusId !== undefined && quoteDue(db, stored.statusId, now),
      };
    }
    case "none": {
      if (resolved.gone === true) {
        return { kind: "none" };
      }
      const byUri = db.first<{ kind: string; id: string }>(
        `SELECT 'status' AS kind, id FROM statuses WHERE uri = ?1 AND reblog_of_id IS NULL
				UNION ALL SELECT 'account', id FROM accounts WHERE uri = ?1
				LIMIT 1`,
        query,
      );
      if (byUri === undefined) {
        return { kind: "none" };
      }
      if (byUri.kind === "account") {
        return { kind: "account", id: byUri.id };
      }
      const author = db.first<{ account_id: string }>("SELECT account_id FROM statuses WHERE id = ?", byUri.id);
      if (author !== undefined) {
        promoteQuote(db, byUri.id, quoteArrival(db, author.account_id, null), now);
      }
      return { kind: "status", id: byUri.id, quotesDue: quoteDue(db, byUri.id, now) };
    }
  }
}

// Stores what was resolved (storeResolved), then answers with it only if the viewer may see it (VIS-1): an account only
// if account search would find it (findableBySql, R14), a status by the rule of a single status (canView, R3, as
// Mastodon's ResolveURLService authorizes show?), unless the viewer blocks its author's domain. A private object a
// server answered the instance actor with is stored with its audience and shown to nobody else.
export const resolveSearch = userWriteOperation.atStoreTime("storeNow")<ResolveInput, ResolveResult>((
  db,
  input,
  { accountId },
  viewer,
) => {
  const options = { ...input.present, viewer };
  const account = (id: string | undefined): ResolveResult => {
    const findable =
      id !== undefined && db.first(`SELECT 1 AS found WHERE ${findableBySql("?2", "?1")}`, accountId, id) !== undefined;
    const found = findable ? presentAccountById(db, id, input.present) : undefined;
    return { accounts: found === undefined ? [] : [found], statuses: [] };
  };
  const status = (id: string | undefined): ResolveResult => {
    const blocked =
      id === undefined ||
      db.first(
        `SELECT 1 AS blocked FROM statuses s WHERE s.id = ?2 AND ${domainBlocksSql("?1", "s.account_id")}`,
        accountId,
        id,
      ) !== undefined;
    const visible = blocked ? null : viewableStatusId(db, accountId, id);
    const found = visible === null ? null : presentStatus(db, visible, options);
    return { accounts: [], statuses: found === null ? [] : [found] };
  };
  const stored = storeResolved(db, input);
  switch (stored.kind) {
    case "account":
      return account(stored.id);
    case "status":
      return { ...status(stored.id), quotesDue: stored.quotesDue };
    case "none":
      return { accounts: [], statuses: [] };
  }
});
