import { attributionDomainsSql, displayNameReadSql, presentedLocalFieldsSql } from "../platform/stored-bounds";

// A local actor's row as ACTOR_ROW_COLUMN_MAP selects it, from accounts a and local_accounts l: what the actor endpoint
// (actors.ts localActorOf) and the profile Update (actor-update.ts) render. attribution_domains is read within
// ATTRIBUTION_DOMAINS_BYTES (attributionDomainsSql) and presented by presentedAttributionDomains. The display name is
// read by its stored bytes (displayNameReadSql), and both renderers bound it and the note again after decoding
// (presentedDisplayName, presentedNote), as an Account does (RES-3). The image descriptions are read as stored (0097's
// triggers bound them) and presented by presentedProfileDescription, and the display settings as stored (the integer 0
// or 1, by the same triggers). Both publish the creation day through actorPublished.
export type ActorRow = {
  uri: string;
  username: string;
  actor_type: string;
  display_name: string;
  note: string;
  avatar_url: string | null;
  header_url: string | null;
  avatar_description: string;
  header_description: string;
  show_featured: number;
  show_media: number;
  show_media_replies: number;
  locked: number;
  discoverable: number | null;
  indexable: number | null;
  also_known_as: string;
  fields: string | null;
  attribution_domains: string;
  suspended_at: string | null;
  pubkey: string;
  created_at: string;
  emojis: string | null;
};

export const ACTOR_ROW_COLUMN_MAP = {
  uri: "a.uri",
  username: "a.username",
  actor_type: "a.actor_type",
  display_name: displayNameReadSql("a.display_name"),
  note: "a.note",
  avatar_url: "a.avatar_url",
  header_url: "a.header_url",
  avatar_description: "a.avatar_description",
  header_description: "a.header_description",
  show_featured: "a.show_featured",
  show_media: "a.show_media",
  show_media_replies: "a.show_media_replies",
  locked: "a.locked",
  discoverable: "a.discoverable",
  indexable: "a.indexable",
  also_known_as: "l.also_known_as",
  fields: presentedLocalFieldsSql("l.fields"),
  attribution_domains: attributionDomainsSql("l.attribution_domains"),
  suspended_at: "l.suspended_at",
  pubkey: "l.pubkey",
  created_at: "a.created_at",
  emojis: "a.emojis",
} as const satisfies Record<keyof ActorRow, string>;

// A stored time as Kopje's writers store it (Date#toISOString): the 24-byte ISO form that Date reads back as itself,
// the rule account-columns.ts createdDaySql applies in SQL (isoTimeSql), so the actor and the Account judge a value
// alike (test/account-created-at.test.ts compares the two).
const STORED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// The actor's `published`, as ActivityPub::ActorSerializer#published writes it (created_at.midnight.iso8601): the
// midnight UTC of its creation day when the stored value is a stored time, else the stored value, as before #1564.
// The one judgment of the actor endpoint and every Update(Person).
export function actorPublished(createdAt: string): string {
  const ms = STORED_TIME.test(createdAt) ? Date.parse(createdAt) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString() === createdAt
    ? `${createdAt.slice(0, 10)}T00:00:00Z`
    : createdAt;
}
