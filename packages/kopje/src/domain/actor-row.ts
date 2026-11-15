import { attributionDomainsSql, displayNameReadSql, presentedLocalFieldsSql } from "../platform/stored-bounds";

// A local actor's row as ACTOR_ROW_COLUMN_MAP selects it, from accounts a and local_accounts l: what the actor endpoint
// (actors.ts localActorOf) and the profile Update (actor-update.ts) render. attribution_domains is read within
// ATTRIBUTION_DOMAINS_BYTES (attributionDomainsSql) and presented by presentedAttributionDomains. The display name is
// read by its stored bytes (displayNameReadSql), and both renderers bound it and the note again after decoding
// (presentedDisplayName, presentedNote), as an Account does (RES-3). The image descriptions are read as stored (0097's
// triggers bound them) and presented by presentedProfileDescription.
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
