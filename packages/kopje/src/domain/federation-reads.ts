import type { Db } from "../db/sql";
import { instanceDomainOf, type NodeInfoUsage, nodeInfoUsageOf } from "./actors";
import type { EmojiTag } from "./custom-emojis";
import { localEmojiObjectOf } from "./local-emojis";
import { readOperation } from "./operation";
import { type QuoteAuthorization, quoteAuthorizationOf } from "./quotes";

// The federation GETs' reads (federation/routes.ts): one Store call a request, which also decides setup. Before setup
// has fixed the domain a read answers not_set_up and reads nothing else (SETUP-1); otherwise it answers the stored
// domain with its own answer, read in the same transaction.

type NotSetUp = { status: "not_set_up" };

export type FederationAnswer<O> = NotSetUp | (O & { status: "ok"; domain: string });

// A federation read: `run` gets the stored domain.
export function federationRead<I, O extends object>(run: (db: Db, input: I, domain: string) => O) {
  return readOperation<I, FederationAnswer<O>>((db, input) => {
    const domain = instanceDomainOf(db);
    return domain === null ? { status: "not_set_up" } : { ...run(db, input, domain), status: "ok", domain };
  });
}

// The domain alone: the routes that read nothing else of the Store (/.well-known/nodeinfo, /actor/outbox, a path
// that is no emoji or stamp).
export const apSite = federationRead<void, object>(() => ({}));

// /nodeinfo/2.0 and /nodeinfo/2.1: the usage at `now`.
export const apNodeInfo = federationRead<{ now: number }, { usage: NodeInfoUsage }>((db, { now }) => ({
  usage: nodeInfoUsageOf(db, now),
}));

// A quote stamp (quotes.ts quoteAuthorizationOf, VIS-28).
export const apQuoteAuthorization = federationRead<
  { username: string; authorizationId: string },
  { stamp: QuoteAuthorization | null }
>((db, input) => ({ stamp: quoteAuthorizationOf(db, input) }));

// /emojis/:id (local-emojis.ts localEmojiObjectOf), its URLs on the stored domain.
export const apEmoji = federationRead<{ id: string }, { emoji: EmojiTag | null }>((db, { id }, domain) => ({
  emoji: localEmojiObjectOf(db, id, `https://${domain}`),
}));
