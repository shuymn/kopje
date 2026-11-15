import { accepted, type Exceptions, open } from "./mastodon-conformance.js";

// The request parameters Mastodon reads and Kopje does not, by route (test/mastodon-params.test.ts). Each is a real
// gap: tracked by an issue (open) or a decided deviation of docs/mastodon-deviations.md (accepted). A harness
// limitation is fixed in the test's recipes or world, never written here.

const PAGE = ["limit", "max_id", "min_id", "since_id"];

// Admin features Kopje does not serve (MD-2) and features not built yet (MD-3).
const NOT_SERVED = (...names: string[]) => accepted("MD-2", ...names);
const PLACEHOLDER = (...names: string[]) => accepted("MD-3", ...names);

// Mastodon 4.6's bot condition of the notification policy, v1 and v2.
const POLICY_V1_BOTS = open(1582, "Mastodon 4.6's bot condition", "filter_bots");
const POLICY_V2_BOTS = open(1582, "Mastodon 4.6's bot condition", "for_bots");

export const PARAM_EXCEPTIONS: Exceptions = {
  "POST /api/v1/accounts": accepted(
    "MD-1",
    "agreement",
    "date_of_birth",
    "email",
    "invite_code",
    "locale",
    "password",
    "reason",
    "time_zone",
    "username",
  ),
  "POST /api/v1/emails/confirmations": accepted("MD-1", "email"),

  // Features not built yet: answered as Mastodon with the feature off.
  "GET /api/v1/admin/domain_allows": PLACEHOLDER(...PAGE),
  "POST /api/v1/accounts/:id/email_subscriptions": PLACEHOLDER("email"),

  // Mastodon reads local and remote only to decide whether the link timeline needs a user
  // (TopicController#require_auth?), which it never does while topic feeds are public, Kopje's only setting (MD-5).
  "GET /api/v1/timelines/link": accepted("MD-5", "local", "remote"),

  // Gaps of the Mastodon 4.6 and 4.7 client API, each tracked by its issue.
  "PATCH /api/v1/notifications/policy": POLICY_V1_BOTS,
  "PUT /api/v1/notifications/policy": POLICY_V1_BOTS,
  "PATCH /api/v2/notifications/policy": POLICY_V2_BOTS,
  "PUT /api/v2/notifications/policy": POLICY_V2_BOTS,
  "PATCH /api/v1/accounts/update_credentials": open(
    1583,
    "the profile image descriptions of Mastodon 4.6",
    "avatar_description",
    "header_description",
  ),
  "GET /api/v1/accounts/:id/statuses": open(1585, "exclude_direct", "exclude_direct"),
  "POST /api/v1/reports": open(1589, "collections", "collection_ids[]"),

  // Admin features not served.
  "POST /api/v1/admin/dimensions": NOT_SERVED("end_at", "keys[]", "limit", "start_at"),
  "POST /api/v1/admin/retention": NOT_SERVED("frequency"),
  "POST /api/v1/admin/domain_allows": NOT_SERVED("domain"),
  "GET /api/v1/admin/ip_blocks": NOT_SERVED(...PAGE),
  "POST /api/v1/admin/ip_blocks": NOT_SERVED("comment", "expires_in", "ip", "severity"),
  "PUT /api/v1/admin/ip_blocks/:id": NOT_SERVED("comment", "expires_in", "ip", "severity"),
  "PATCH /api/v1/admin/ip_blocks/:id": NOT_SERVED("comment", "expires_in", "ip", "severity"),
  "GET /api/v1/admin/email_domain_blocks": NOT_SERVED(...PAGE),
  "POST /api/v1/admin/email_domain_blocks": NOT_SERVED("allow_with_approval", "domain"),
  "GET /api/v1/admin/canonical_email_blocks": NOT_SERVED(...PAGE),
  "POST /api/v1/admin/canonical_email_blocks": NOT_SERVED("canonical_email_hash", "email"),
  "POST /api/v1/admin/canonical_email_blocks/test": NOT_SERVED("email"),
  "GET /api/v1/admin/trends/links/publishers": NOT_SERVED(...PAGE),
  "GET /api/v1/admin/tags": NOT_SERVED(...PAGE),
  "PUT /api/v1/admin/tags/:id": NOT_SERVED("display_name", "listable", "trendable", "usable"),
  "PATCH /api/v1/admin/tags/:id": NOT_SERVED("display_name", "listable", "trendable", "usable"),
};

// Routes whose fixture entry has unresolved extraction, with exactly the reasons acknowledged and why the names read
// suffice.
export const UNRESOLVED_PARAMS: Record<string, { reasons: string[]; why: string }> = {
  // Admin::Metrics::Measure / Dimension read per-key options (e.g. instance_accounts[domain]) from the params they are
  // handed. Kopje reads each served key's domain and include_subdomains (test/admin-measures-keys.test.ts); the tag
  // keys' id is not read, as they are refused (MD-2).
  "POST /api/v1/admin/measures": {
    reasons: ["app/controllers/api/v1/admin/measures_controller.rb set_measures: params used whole `params`"],
    why: "per-key options of Admin::Metrics::Measure",
  },
  "POST /api/v1/admin/dimensions": {
    reasons: ["app/controllers/api/v1/admin/dimensions_controller.rb set_dimensions: params used whole `params`"],
    why: "per-key options of Admin::Metrics::Dimension",
  },
};
