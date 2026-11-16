import { type ApiHandler, authorized, storeCall, userCredential } from "./context";
import { mastodonError } from "./errors";

// GET /api/v1_alpha/async_refreshes/:id (Mastodon 4.7.5's Api::V1Alpha::AsyncRefreshesController#show): a context's
// refresh of a status's replies by its id (domain/reply-walks.ts getAsyncRefresh), to any signed-in user, as
// AsyncRefresh#to_json shows it; Mastodon's not_found for an id that names none.
export const show: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "" };
  const refresh = authorized(await storeCall(c, deps, (s, b) => s.getAsyncRefresh(b, input)));
  if (refresh === null) {
    return mastodonError(404, "Not Found");
  }
  return c.json({ async_refresh: { id: refresh.id, status: refresh.status, result_count: refresh.resultCount } });
};
