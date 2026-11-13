import { presentedLocalFieldsSql } from "../platform/stored-bounds";

// A local actor's row as ACTOR_ROW_COLUMNS selects it, from accounts a and local_accounts l: what the actor endpoint
// (actors.ts localActorOf) and the profile Update (actor-update.ts) render.
export type ActorRow = {
  uri: string;
  username: string;
  actor_type: string;
  display_name: string;
  note: string;
  avatar_url: string | null;
  header_url: string | null;
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

export const ACTOR_ROW_COLUMNS = `a.uri, a.username, a.actor_type, a.display_name, a.note, a.avatar_url, a.header_url,
	a.locked, a.discoverable, a.indexable, l.also_known_as, ${presentedLocalFieldsSql("l.fields")} AS fields,
	l.attribution_domains, l.suspended_at, l.pubkey, a.created_at, a.emojis`;
