import { accepted, type Exception } from "./mastodon-conformance.js";

// The routes Mastodon serves and Kopje does not route (test/mastodon-access.test.ts, "routes every route of Mastodon,
// or lists why not"), keyed by 'METHOD /path' in the fixture's spelling. Each is a gap tracked by an issue (open) or a
// decided deviation of docs/mastodon-deviations.md (accepted).

export const UNROUTED: Record<string, Exception> = {
  // Served outside ROUTES by streamingRoutes (src/mastodon/streaming.ts), as a WebSocket only.
  ...accepted("MD-8", "GET /api/v1/streaming", "GET /api/v1/streaming/*any"),
  // Mastodon's web app API and FASP.
  ...accepted(
    "MD-7",
    "PATCH /api/web/settings",
    "PUT /api/web/settings",
    "GET /api/web/embeds/:id",
    "POST /api/web/push_subscriptions",
    "PATCH /api/web/push_subscriptions/:id",
    "PUT /api/web/push_subscriptions/:id",
    "DELETE /api/web/push_subscriptions/:id",
    "POST /api/fasp/registration",
    "POST /api/fasp/debug/v0/callback/responses",
    "POST /api/fasp/data_sharing/v0/backfill_requests",
    "POST /api/fasp/data_sharing/v0/backfill_requests/:backfill_request_id/continuation",
    "POST /api/fasp/data_sharing/v0/event_subscriptions",
    "DELETE /api/fasp/data_sharing/v0/event_subscriptions/:id",
  ),
};
