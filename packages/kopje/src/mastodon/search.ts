import { localCollectionId } from "../domain/collections";
import { isUrlQuery } from "../domain/remote-statuses";
import type { SearchType } from "../domain/search";
import { envInMaintenance } from "../platform/config";
import { parseAddress } from "../platform/domain-name";
import { railsBlank } from "../platform/rails-blank";
import { rubyToI } from "../platform/ruby-to-i";
import { StoreUnavailableError, WRITE_REFUSALS } from "../platform/store-errors";
import { rubyStrip } from "../platform/strip";
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
import { limitParam, offsetParam, type Params, parseBoolean } from "./params";

// GET /api/v2/search: accounts, statuses and hashtags from local data (domain/search.ts). Hashtags are recent
// autocomplete over the viewer's library and the newest public statuses, not a catalogue of every tag. Collections
// are found only by resolve=true.
//
// Limit and offset are Mastodon 4.7.5's: a `limit` or `offset` that Ruby's to_i reads as negative is refused (400) after
// a missing q, as Api::V2::SearchController's before_actions order them (require_valid_pagination_options!,
// api/pagination.rb); a limit of 0 (limit_param keeps it) answers nothing and resolves nothing (search_service.rb:17),
// and the offset counts only with a type (`:11`). The token is judged first (refuseAfterAuth); the route takes no
// anonymous request, so the controller's 401s for an anonymous offset or resolve never apply.
//
// resolve=true: a URL query is answered by its lookup alone, if the viewer may see what it resolved to, never by the
// plain search, and by nothing past offset 0 or for a type the lookup did not find (`:19-20`). A local collection's URL
// (its uri or url) answers that collection when R45 shows it to the viewer (ResolveURLService#process_local_url), with
// no fetch. Otherwise, after the token is verified, a URL or user@domain query is fetched (federation/resolve.ts,
// signed by the instance actor) and stored by the Store with inbound validation; a URL of this instance is never
// fetched, and the Store finds what it names on Kopje's routes (remote-statuses.ts localSearchTarget). A URL lookup
// whose answer is empty whatever it finds (an offset past 0, a type other than accounts and statuses) fetches nothing,
// where Mastodon fetches and stores first (docs/mastodon-deviations.md, Search). An address is resolved only when
// accounts are searched at offset 0, as only AccountSearchService resolves one (`:90-100`,
// account_search_service.rb:206), and answers the account search with the resolved account first, which the Store's
// search puts there (resolvedAccountId), so the answer budget (RES-3) covers it. Unauthenticated requests are refused
// before anything is fetched (401, the route's scope), and a request the Store could not store for (resolveQuery) is
// answered as without resolve=true. The final search takes a fresh credential, so a token that expired while resolving
// is refused. GET /api/v1/accounts/search resolves addresses only, through the same resolveQuery
// (mastodon/accounts.ts).

// The raw bound of q before it is normalized and split (RES-1). Terms beyond the eighth are ignored (search-text.ts).
const MAX_QUERY_LENGTH = 500;
// Offsets past this are answered with an empty page (RES-3, RES-7).
export const MAX_SEARCH_OFFSET = 10_000;

const TYPES: readonly SearchType[] = ["accounts", "statuses", "hashtags"];

const NOTHING = { accounts: [], statuses: [], hashtags: [], collections: [] };

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
  // Rails' params.require refuses a blank q (railsBlank) here (the account search answers it with an empty list).
  const q = p.get("q");
  if (q === undefined || railsBlank(q)) {
    return refuseAfterAuth(c, deps, mastodonError(400, "Missing parameter q"));
  }
  if ([p.integer("limit"), p.integer("offset")].some((value) => value !== undefined && rubyToI(value) < 0)) {
    return refuseAfterAuth(c, deps, mastodonError(400, "Pagination values for `offset` and `limit` must be positive"));
  }
  const parsed = searchParams(p);
  if ("error" in parsed) {
    return refuseAfterAuth(c, deps, parsed.error);
  }
  // Mastodon: 20 by default, at most 40, per type. An unknown type finds nothing.
  const limit = limitParam(p, 20, 40);
  const { maxId, minId } = pageQuery(p, 20, 40);
  const type = p.get("type");
  // A blank type (railsBlank) is every type, and then the offset is 0 (search_service.rb:11).
  const anyType = type === undefined || railsBlank(type);
  const types = anyType ? TYPES : TYPES.filter((t) => t === type);
  const collections = anyType || type === "collections";
  const excludeUnreviewed = parseBoolean(p.get("exclude_unreviewed")) === true;
  const offset = anyType ? 0 : parsed.offset;
  // SearchService strips q as Ruby does (rubyStrip) and answers nothing for one then blank, before any resolution.
  const query = rubyStrip(parsed.query);
  const resolve = parseBoolean(p.get("resolve")) ?? false;
  const urlQuery = resolve && isUrlQuery(query);
  const nothing = async () => {
    authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, userCredential(c, deps))));
    return c.json(NOTHING);
  };
  if (limit === 0 || railsBlank(query)) {
    return nothing();
  }
  if (urlQuery) {
    if (offset > 0) {
      return nothing();
    }
    const collection = localCollectionId(query, new URL(c.req.url).origin);
    if (collection !== null) {
      if (!collections) {
        return nothing();
      }
      const input = { credential: userCredential(c, deps), id: collection, present: present(c) };
      const found = authorized(await storeCall(c, deps, (s, b) => s.resolvedCollection(b, input)));
      return c.json({ ...NOTHING, collections: found === null ? [] : [found] });
    }
    // Any other URL resolves to an account or a status only (resolveQuery).
    if (!types.includes("accounts") && !types.includes("statuses")) {
      return nothing();
    }
    const looked = await resolveQuery(c, deps, query);
    if (looked !== null) {
      return c.json({
        ...NOTHING,
        accounts: types.includes("accounts") ? looked.accounts : [],
        statuses: types.includes("statuses") ? looked.statuses : [],
      });
    }
  }
  if (offset > MAX_SEARCH_OFFSET || types.length === 0) {
    return nothing();
  }
  const address = resolve && !urlQuery && offset === 0 && types.includes("accounts") && parseAddress(query) !== null;
  const resolved = address ? await resolveQuery(c, deps, query) : null;
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
  if (envInMaintenance(c.env)) {
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
