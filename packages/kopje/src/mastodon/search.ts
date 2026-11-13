import { isUrlQuery } from "../domain/remote-statuses";
import type { SearchType } from "../domain/search";
import { readConfig } from "../platform/config";
import { parseAddress } from "../platform/domain-name";
import { type MaintenanceReason, StoreUnavailableError } from "../platform/store-errors";
import {
  type ApiHandler,
  authorized,
  present,
  refuseAfterAuth,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { mastodonError } from "./errors";
import { pageQuery } from "./pagination";
import { offsetParam, type Params, parseBoolean } from "./params";

// GET /api/v2/search: accounts, statuses and hashtags from local data (domain/search.ts). Hashtags are recent
// autocomplete over the viewer's library and the newest public statuses, not a catalogue of every tag.
//
// resolve=true (Mastodon's SearchService): after the token is verified, a URL or user@domain query is fetched
// (federation/resolve.ts, signed by the instance actor) and stored by the Store with inbound validation. A URL query
// answers with what it resolved to alone, if the viewer may see it; an address query answers the account search with
// the resolved account first, which the Store's search puts there (resolvedAccountId), so the answer budget (RES-3)
// covers it. Unauthenticated requests are refused before anything is fetched (401, the route's scope), and a request
// the Store could not store for (resolveQuery) is answered as without resolve=true. The final search takes a fresh
// credential, so a token that expired while resolving is refused. GET /api/v1/accounts/search
// resolves addresses only, through the same resolveQuery (mastodon/accounts.ts).

// The raw bound of q before it is normalized and split (RES-1). Terms beyond the eighth are ignored (search-text.ts).
const MAX_QUERY_LENGTH = 500;
// Offsets past this are answered with an empty page (RES-3, RES-7).
export const MAX_SEARCH_OFFSET = 10_000;

const TYPES: readonly SearchType[] = ["accounts", "statuses", "hashtags"];

export type SearchParams = { query: string; offset: number } | { error: Response };

// q and offset, shared with /api/v1/accounts/search.
export function searchParams(p: Params): SearchParams {
  const query = p.get("q");
  if (query === undefined) {
    return { error: mastodonError(400, "Missing parameter q") };
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { error: mastodonError(400, `Search query is too long (maximum is ${MAX_QUERY_LENGTH} characters)`) };
  }
  return { query, offset: offsetParam(p) };
}

export const search: ApiHandler = withParams(async (c, deps, p) => {
  // Rails' params.require refuses a blank q here (the account search answers it with an empty list).
  const parsed = p.get("q")?.trim() === "" ? { error: mastodonError(400, "Missing parameter q") } : searchParams(p);
  if ("error" in parsed) {
    return refuseAfterAuth(c, deps, parsed.error);
  }
  // Mastodon: 20 by default, at most 40, per type. An unknown type finds nothing.
  const { limit, maxId, minId } = pageQuery(p, 20, 40);
  const type = p.get("type");
  const types = type === undefined || type === "" ? TYPES : TYPES.filter((t) => t === type);
  const excludeUnreviewed = parseBoolean(p.get("exclude_unreviewed")) === true;
  const offset = parsed.offset > MAX_SEARCH_OFFSET ? null : parsed.offset;
  if (offset === null || types.length === 0) {
    authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, userCredential(c, deps))));
    return c.json({ accounts: [], statuses: [], hashtags: [] });
  }
  const query = parsed.query.trim();
  const resolving = (parseBoolean(p.get("resolve")) ?? false) && offset === 0;
  let resolved: Found | null = null;
  if (resolving && (isUrlQuery(query) || parseAddress(query) !== null)) {
    resolved = await resolveQuery(c, deps, query);
    if (resolved !== null && isUrlQuery(query)) {
      return c.json({
        accounts: types.includes("accounts") ? resolved.accounts : [],
        statuses: types.includes("statuses") ? resolved.statuses : [],
        hashtags: [],
      });
    }
  }
  const accountId = p.get("account_id");
  const results = await storeCall(c, deps, (s, b) =>
    s.search(b, {
      credential: userCredential(c, deps),
      query: parsed.query,
      types,
      limit,
      offset,
      following: parseBoolean(p.get("following")) ?? false,
      excludeUnreviewed,
      accountId: accountId === undefined || accountId === "" ? undefined : accountId,
      maxId,
      minId,
      localDomain: new URL(c.req.url).host,
      present: present(c),
      resolvedAccountId: resolved?.accounts[0]?.id,
    }),
  );
  return c.json(authorized(results));
});

// What resolve=true found, as the Store presented it.
type Found = { accounts: { id: string }[]; statuses: unknown[] };

// The reasons a Store refuses a write while it still serves reads (store-kernel.ts refusalOf under a hold or an
// upgrade, store-flags.ts flagRefusal): readonly maintenance, a dump's freeze, an unpublished import, a held or
// upgrading Store. The plain search can still answer then.
const WRITE_REFUSALS: ReadonlySet<MaintenanceReason> = new Set<MaintenanceReason>([
  "maintenance",
  "dump-in-progress",
  "unpublished",
  "upgrade-in-progress",
  "upgrade-failed",
  "bookmark-failed",
  "verify-failed",
]);

// Fetches and stores the query's target; null: nothing was resolved for a reason that is not the query's, and the
// caller answers as a plain search (resolve=false), whose own Store call judges the token again at its time. That is so
// while the env's MAINTENANCE is not off (KEK rotation runs readonly with no Store flag), with no Store call; while the
// Store refuses writes (readonly, an unpublished import), which the resolution gate answers after the token and before
// any signer read, so nothing is fetched for a request that cannot store it (engineering.md, "a writing path checks
// the Store's flags and the maintenance mode"); and when the Store comes to refuse a write while resolving (the instance
// key's creation, or the final store), for a reason in WRITE_REFUSALS. Any other failure (a transient or overloaded
// Store, a read refused) is the request's error, as without the fallback.
export async function resolveQuery(
  c: Parameters<ApiHandler>[0],
  deps: Parameters<ApiHandler>[1],
  query: string,
): Promise<Found | null> {
  const config = readConfig(c.env);
  if (!config.ok || config.config.MAINTENANCE !== "off") {
    return null;
  }
  const gate = authorized(
    await storeCall(c, deps, (s, b) => s.resolutionGate(b, { credential: userCredential(c, deps), query })),
  );
  if (gate.refused !== null) {
    return null;
  }
  if (deps.resolve === undefined) {
    return { accounts: [], statuses: [] };
  }
  try {
    const resolved = await deps.resolve(c.env, query, gate);
    const found = authorized(
      await storeCall(c, deps, (s, b) =>
        s.resolveSearch(b, {
          credential: userCredential(c, deps),
          query,
          resolved,
          now: deps.now(),
          origin: new URL(c.req.url).origin,
          present: present(c),
        }),
      ),
    );
    // The resolved status's quote is verified by the job rounds (federation/quotes.ts).
    if (found.quotesDue) {
      await deps.requestJobs?.(c.env);
    }
    return found;
  } catch (error) {
    if (error instanceof StoreUnavailableError && WRITE_REFUSALS.has(error.reason)) {
      return null;
    }
    throw error;
  }
}
