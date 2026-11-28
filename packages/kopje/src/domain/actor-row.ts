import { Temporal } from "temporal-polyfill";

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

// The midnight UTC of the day the time `value` names, as ActivityPub::ActorSerializer#published writes an actor's
// creation (created_at.midnight.iso8601), or null when `value` is not an instant as a whole: Temporal.Instant.from,
// as Fedify reads the published it is given, so an offset names its UTC day and an hour or a day that does not exist
// names none. The one judgment of the endpoint and every Update (actorPublished) and of the rescue path's kept
// documents (federation/snapshot.ts).
export function publishedDay(value: string): string | null {
  let instant: string;
  try {
    instant = Temporal.Instant.from(value).toString();
  } catch {
    return null;
  }
  return `${instant.slice(0, instant.indexOf("T"))}T00:00:00Z`;
}

// The actor's `published`: its creation day's midnight UTC (publishedDay), or the stored value when it is not an
// instant, as before #1564.
export function actorPublished(createdAt: string): string {
  return publishedDay(createdAt) ?? createdAt;
}
