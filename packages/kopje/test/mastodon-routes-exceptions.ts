import { accepted, type Exception, open } from "./mastodon-conformance.js";

// The routes Mastodon serves and Kopje does not route (test/mastodon-access.test.ts, "routes every route of Mastodon,
// or lists why not"), keyed by 'METHOD /path' in the fixture's spelling. Each is a gap tracked by an issue (open) or a
// decided deviation of docs/mastodon-deviations.md (accepted).

// Collections (FEP-7aa9), under /api/v1 and the earlier /api/v1_alpha.
const COLLECTIONS = (prefix: string) => [
  `GET ${prefix}/accounts/:account_id/collections`,
  `GET ${prefix}/accounts/:account_id/in_collections`,
  `POST ${prefix}/collections`,
  `GET ${prefix}/collections/:id`,
  `PATCH ${prefix}/collections/:id`,
  `PUT ${prefix}/collections/:id`,
  `DELETE ${prefix}/collections/:id`,
  `POST ${prefix}/collections/:collection_id/items`,
  `DELETE ${prefix}/collections/:collection_id/items/:id`,
  `POST ${prefix}/collections/:collection_id/items/:id/revoke`,
];

export const UNROUTED: Record<string, Exception> = {
  ...open(1589, "collections", ...COLLECTIONS("/api/v1"), ...COLLECTIONS("/api/v1_alpha")),
  ...open(
    1583,
    "the profile API of Mastodon 4.6",
    "GET /api/v1/profile",
    "PATCH /api/v1/profile",
    "PUT /api/v1/profile",
  ),
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
