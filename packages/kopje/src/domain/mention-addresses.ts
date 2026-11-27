import type { Db } from "../db/sql";
import { parseAddress } from "../platform/domain-name";
import type { MaintenanceReason } from "../platform/store-errors";
import { blocksDomain } from "./audience";
import { type Authorized, authorize, type UserCredential, type UserViewer } from "./auth";
import { type FetchPreparation, fetchPreparation } from "./fetch-preparation";
import { instanceDomainOf } from "./instance-domain";
import { ticketFor } from "./instance-domain-blocks";
import { isolated } from "./job-attempts";
import { readOperation } from "./operation";
import { type DocumentRevision, type RemoteActorInput, upsertRemoteActor, webfingerUrl } from "./remote-actors";
import { mentionKey, parseStatusText } from "./status-text";

// Unknown mention addresses of a local post, a scheduled post or an edit (#1558), resolved before the write as
// Mastodon's ProcessMentionsService resolves them (find_remote, then ResolveAccountService): the Store's gate
// (scheduled-statuses.ts postMentionGate, statuses.ts editMentionGate) selects the `@user@host` addresses of the text
// that no account holds, at most MENTION_ADDRESSES_PER_POST, the first in text order; the Worker resolves them as search
// resolves an address (federation/resolve.ts createAddressResolver, within one budget, RES-6); the write stores each
// actor (storeMentioned) before it composes, and composing finds it by the address typed, as it finds any stored
// account (statuses.ts resolveMentions). Only the typed address's own account is mentioned: one whose handle WebFinger
// confirmed is that address (isOwnAccount). An alias, a split-domain account's server host or an old domain stays text
// (docs/mastodon-deviations.md, Posting). Publication of a scheduled post resolves nothing: it finds what scheduling
// stored.

// The most unknown addresses one request resolves; the rest stay text (docs/mastodon-deviations.md, Posting).
export const MENTION_ADDRESSES_PER_POST = 4;

// key: the address's mentionKey, the key resolveMentions seeks it by; username and domain as parseAddress reads them.
export type RemoteAddress = { key: string; username: string; domain: string };

// What the gate answers for a resolution: the instance domain, the preparation of the first address's WebFinger (its
// verdict and the signer of every signed fetch; null for none), and the addresses, in text order.
export type MentionStart = { domain: string; prepared: FetchPreparation | null; addresses: RemoteAddress[] };

// An address's own account, as the Worker resolved it, with the revision read before its document was fetched (ID-1).
export type ResolvedAddress = { key: string; actor: RemoteActorInput; revision: DocumentRevision };

export type AddressResolver = (env: Env, start: MentionStart) => Promise<ResolvedAddress[]>;

// What a mention gate answers (scheduled-statuses.ts postMentionGate, statuses.ts editMentionGate): `refused`, the
// reason a write would be refused now; else the credential's judgment, then `none` (nothing to resolve: the write
// would refuse the request, or no address of its text needs a fetch) or the resolution's start.
export type MentionGate =
  | { status: "refused"; reason: MaintenanceReason }
  | Authorized<{ kind: "none" } | ({ kind: "prepared" } & MentionStart)>;

export type MentionGateInput = { credential: UserCredential; now: number; refused: MaintenanceReason | null };

const NONE = { kind: "none" } as const;

// A mention gate's operation, a read run before any network work by Store.postMentionGate or Store.editMentionGate with
// `refused` decided in its transaction (store-kernel.ts executeDeciding): a write refusal is answered first and reads
// nothing more, so no key leaves the Store for a request that cannot write (OPS-8), as the write's own admission comes
// before its authorization; then the credential (as the write judges it, so a failing token is answered as today);
// then `run`, given the request's `now` (advisory: the write judges every check again at its own time). `run` answers
// the addresses to resolve, none for none.
export function mentionGateOperation<I extends MentionGateInput>(
  run: (db: Db, input: I, viewer: UserViewer, domain: string) => RemoteAddress[] | null,
) {
  return readOperation<I, MentionGate>((db, input) => {
    if (input.refused !== null) {
      return { status: "refused", reason: input.refused };
    }
    const auth = authorize(db, input.credential);
    if (auth.status !== "ok") {
      return auth;
    }
    const domain = instanceDomainOf(db);
    const addresses = domain === null ? null : run(db, input, auth.viewer as UserViewer, domain);
    return {
      status: "ok",
      value:
        domain === null || addresses === null || addresses.length === 0 ? NONE : mentionStart(db, domain, addresses),
    };
  });
}

// The addresses on a host other than `localHost` that `text` mentions, in text order: every mention segment (not
// parseStatusText's mentions, which keep a key's last spelling) whose username@domain parseAddress reads, each key
// once, by the first spelling it reads. Callers check exceedsRawLength first (parseStatusText).
export function remoteAddresses(text: string, localHost: string): RemoteAddress[] {
  const found = new Map<string, RemoteAddress>();
  for (const segment of parseStatusText(text).segments) {
    if (segment.kind !== "mention" || segment.domain === null || segment.domain === localHost) {
      continue;
    }
    const key = mentionKey(segment);
    const address = found.has(key) ? null : parseAddress(`${segment.username}@${segment.domain}`);
    if (address !== null) {
      found.set(key, { key, ...address });
    }
  }
  return [...found.values()];
}

// The addresses of `text` the author's post would resolve, at most MENTION_ADDRESSES_PER_POST in text order: none an
// account holds (any row, as Mastodon's find_remote finds it: one seek of accounts_domain_username each), none on a
// domain the author blocks (only the typed address's own account is mentioned, and the write drops an account on such a
// domain, R17), and none whose WebFinger the instance's domain policy or the loader would refuse (ticketFor). A skipped
// address takes no slot.
export function selectAddresses(db: Db, text: string, accountId: string, domain: string): RemoteAddress[] {
  const candidates = remoteAddresses(text, domain);
  if (candidates.length === 0) {
    return [];
  }
  // The key's parts, as resolveMentions seeks them.
  const wanted = candidates.map(({ key }) => {
    const at = key.lastIndexOf("@");
    return { key, u: key.slice(0, at), d: key.slice(at + 1) };
  });
  const held = new Set(
    db
      .all<{ key: string }>(
        `SELECT DISTINCT json_extract(j.value, '$.key') AS key FROM json_each(?1) j
			CROSS JOIN accounts a INDEXED BY accounts_domain_username
				ON a.domain IS json_extract(j.value, '$.d') AND lower(a.username) = json_extract(j.value, '$.u')`,
        JSON.stringify(wanted),
      )
      .map((row) => row.key),
  );
  const selected: RemoteAddress[] = [];
  for (const address of candidates) {
    if (selected.length >= MENTION_ADDRESSES_PER_POST) {
      break;
    }
    if (held.has(address.key) || blocksDomain(db, accountId, address.domain)) {
      continue;
    }
    const ticket = ticketFor(db, webfingerUrl(address.username, address.domain));
    if (ticket !== null && !ticket.refused) {
      selected.push(address);
    }
  }
  return selected;
}

// The resolution of `addresses`, its first WebFinger prepared (fetch-preparation.ts): the instance actor signs (DATA-7).
function mentionStart(db: Db, domain: string, addresses: RemoteAddress[]): { kind: "prepared" } & MentionStart {
  const [first] = addresses;
  return {
    kind: "prepared",
    domain,
    prepared: first === undefined ? null : fetchPreparation(db, null, webfingerUrl(first.username, first.domain)),
    addresses,
  };
}

// Whether `actor` is the account of the typed address `key`: WebFinger confirmed its handle (federation/resolve.ts
// confirmHandle, which requires WebFinger at that address to name the actor's id), and that handle is the address.
export function isOwnAccount(key: string, actor: RemoteActorInput): boolean {
  return actor.confirmed !== null && mentionKey(actor.confirmed) === key;
}

// Stores, before a post or an edit composes, each resolved account that is its address's own (isOwnAccount) and whose
// key is a reference of the text (`keys`), each in its own savepoint (isolated): none when another actor already holds
// the address (the holder is mentioned, never invalidated by this path), else upsertRemoteActor under the revision read
// before the fetch (ID-1; a superseded, covered or refused document stores nothing, a frozen row takes only its routing
// refresh). Composing then seeks every reference by its key (statuses.ts resolveMentions) and finds whatever row holds
// the address, under mentionableBySql (R17). `origin`: the author's (ID-5).
export function storeMentioned(
  db: Db,
  resolved: readonly ResolvedAddress[],
  keys: ReadonlySet<string>,
  origin: string,
  now: number,
): void {
  for (const { key, actor, revision } of resolved) {
    const confirmed = actor.confirmed;
    if (!keys.has(key) || confirmed === null || !isOwnAccount(key, actor)) {
      continue;
    }
    isolated(db, () => {
      const holder = db.first(
        `SELECT 1 AS x FROM accounts INDEXED BY accounts_domain_username
				WHERE domain = ?1 AND lower(username) = lower(?2) AND uri <> ?3`,
        confirmed.domain,
        confirmed.username,
        actor.uri,
      );
      if (holder === undefined) {
        upsertRemoteActor(db, actor, origin, now, revision);
      }
    });
  }
}

// The keys of the references `text` makes, as composing seeks them.
export function referenceKeys(text: string): Set<string> {
  return new Set(parseStatusText(text).mentions.map(mentionKey));
}
