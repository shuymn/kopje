import type { Db } from "../db/sql";
import { type FetchSigner, fetchSignerOf, instanceDomainOf } from "./actors";
import type { FollowerSigner } from "./follower-signer";
import { type PolicyTicket, ticketFor } from "./instance-domain-blocks";
import { originOf } from "./remote-actors";

// What a fetch a Store answer decided needs, read in that answer (docs/engineering.md, "How a request talks to the
// Store"): its signer by DATA-7's rule (fetchSignerOf), wrapped (DATA-1), and the domain policy's verdict for its
// first request (ticketFor; null when the loader would refuse the target anyway). Optional: the Worker reads what is
// missing itself, as it would without it.
export type FetchPreparation = { signer: FetchSigner; ticket: PolicyTicket | null };

// The one producer of FetchPreparation, for the answers that decide a fetch: the inbox gate, a receiveActivity need, a
// search resolution's gate (inbox.ts resolutionGate) and a poll refresh's reservation (polls.ts reservePollRefresh).
// Null for a target of this instance's own origin: the paths it serves never fetch one (federation/inbound.ts
// fetchNeeded and prepare; resolutionTarget), so no key leaves the Store for it; a signature key at this origin, which
// Fedify may still fetch, then costs the Worker its own signer and policy reads.
export function fetchPreparation(db: Db, by: string | FollowerSigner | null, target: string): FetchPreparation | null {
  const domain = instanceDomainOf(db);
  if (domain !== null && originOf(target) === `https://${domain}`) {
    return null;
  }
  return { signer: fetchSignerOf(db, by), ticket: ticketFor(db, target) };
}
