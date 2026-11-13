import { Hono } from "hono";

import { requireAccess, type RouteAccess } from "./access";
import * as accounts from "./accounts";
import * as admin from "./admin";
import * as announcements from "./announcements";
import * as blocks from "./blocks";
import type { ApiDeps, ApiEnv, ApiHandler } from "./context";
import * as conversations from "./conversations";
import * as filters from "./filters";
import * as instance from "./instance";
import * as lists from "./lists";
import * as markers from "./markers";
import * as media from "./media";
import * as notificationGroups from "./notification-groups";
import * as notificationRequests from "./notification-requests";
import * as notifications from "./notifications";
import * as oauth from "./oauth";
import * as oembed from "./oembed";
import * as placeholders from "./placeholders";
import * as polls from "./polls";
import * as push from "./push";
import * as reports from "./reports";
import * as scheduled from "./scheduled-statuses";
import * as search from "./search";
import * as statuses from "./statuses";
import * as suggestions from "./suggestions";
import * as tags from "./tags";
import * as timelines from "./timelines";
import * as trends from "./trends";

// The explicit API route table: every route names the access it requires, one middleware (requireAccess)
// declares it, and the Store enforces it in each operation. Routes are matched in order, so fixed paths come before
// their :id siblings.

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type Route = {
  method: Method;
  path: string;
  access: RouteAccess;
  handler: ApiHandler;
};

const route =
  (method: Method) =>
  (path: string, access: RouteAccess, handler: ApiHandler): Route => ({ method, path, access, handler });
const get = route("GET");
const post = route("POST");
const patch = route("PATCH");
const put = route("PUT");
const del = route("DELETE");

export const ROUTES: readonly Route[] = [
  post("/api/v1/apps", "public", oauth.registerApp),
  get("/api/v1/apps/verify_credentials", "token", oauth.verifyApp),
  post("/oauth/token", "public", oauth.tokenHandler),
  post("/oauth/revoke", "public", oauth.revokeHandler),
  // Doorkeeper's error answers, not the API's: each handler reads its own credentials.
  get("/oauth/token/info", "public", oauth.tokenInfo),
  post("/oauth/introspect", "public", oauth.introspect),
  get("/oauth/userinfo", { scope: "profile" }, oauth.userinfo),
  post("/oauth/userinfo", { scope: "profile" }, oauth.userinfo),
  get("/.well-known/oauth-authorization-server", "public", oauth.authorizationServerMetadata),

  get("/api/v1/instance", "public", instance.instanceV1),
  get("/api/v2/instance", "public", instance.instanceV2),
  get("/api/v1/custom_emojis", "public", instance.customEmojis),
  // Api::OEmbedController: no token is read.
  get("/api/oembed", "public", oembed.oembed),

  // Reads clients make at startup (instance details, preferences, tags, familiar followers), and the empty answers of
  // features Kopje has no data for yet (mastodon/placeholders.ts). Kept before the accounts routes, so
  // familiar_followers comes before its :id sibling.
  get("/api/v1/instance/rules", "public", instance.rules),
  get("/api/v1/instance/peers", "public", instance.peers),
  get("/api/v1/instance/extended_description", "public", instance.extendedDescription),
  get("/api/v1/instance/languages", "public", instance.languages),
  get("/api/v1/instance/privacy_policy", "public", instance.privacyPolicy),
  get("/api/v1/instance/terms_of_service", "public", instance.termsOfService),
  get("/api/v1/instance/terms_of_service/:date", "public", instance.termsOfService),
  get("/api/v1/instance/translation_languages", "public", instance.translationLanguages),
  get("/api/v1/peers/search", "public", instance.searchPeers),
  get("/api/v1/instance/activity", "public", instance.activity),
  // A token is read: a suspended user's is refused, and show_domain_blocks may list to users only.
  get("/api/v1/instance/domain_blocks", { optional: true }, instance.domainBlocks),
  get("/api/v1/preferences", { scope: "read:accounts" }, accounts.preferences),
  get("/api/v1/accounts/familiar_followers", { scope: "read:follows" }, accounts.familiarFollowers),
  // Hashtags, followed and featured (mastodon/tags.ts).
  get("/api/v1/tags/:id", { optional: true }, tags.getTag),
  post("/api/v1/tags/:id/follow", { scope: "write:follows" }, tags.followTag),
  post("/api/v1/tags/:id/unfollow", { scope: "write:follows" }, tags.unfollowTag),
  post("/api/v1/tags/:id/feature", { scope: "write:accounts" }, tags.featureTag),
  post("/api/v1/tags/:id/unfeature", { scope: "write:accounts" }, tags.unfeatureTag),
  get("/api/v1/followed_tags", { scope: "read:follows" }, tags.followedTags),
  get("/api/v1/featured_tags/suggestions", { scope: "read:accounts" }, tags.featuredTagSuggestions),
  get("/api/v1/featured_tags", { scope: "read:accounts" }, tags.featuredTags),
  post("/api/v1/featured_tags", { scope: "write:accounts" }, tags.createFeaturedTag),
  del("/api/v1/featured_tags/:id", { scope: "write:accounts" }, tags.deleteFeaturedTag),
  get("/api/v1/accounts/:id/featured_tags", "public", tags.accountFeaturedTags),
  // The profile directory: optional token, no scope (Api::V1::DirectoriesController).
  get("/api/v1/directory", { optional: true }, accounts.directory),
  get("/api/v1/endorsements", { scope: "read:accounts" }, accounts.endorsements),
  // Announcements (mastodon/announcements.ts): any user token lists them (require_user!, no scope).
  get("/api/v1/announcements", "token", announcements.listAnnouncements),
  post("/api/v1/announcements/:id/dismiss", { scope: "write:accounts" }, announcements.dismissAnnouncement),
  put(
    "/api/v1/announcements/:announcement_id/reactions/:id",
    { scope: "write:favourites" },
    announcements.reactToAnnouncement,
  ),
  patch(
    "/api/v1/announcements/:announcement_id/reactions/:id",
    { scope: "write:favourites" },
    announcements.reactToAnnouncement,
  ),
  del(
    "/api/v1/announcements/:announcement_id/reactions/:id",
    { scope: "write:favourites" },
    announcements.unreactToAnnouncement,
  ),
  // Trends (mastodon/trends.ts).
  get("/api/v1/trends", { optional: true }, trends.trendTags),
  get("/api/v1/trends/tags", { optional: true }, trends.trendTags),
  get("/api/v1/trends/statuses", { optional: true }, trends.trendStatuses),
  get("/api/v1/trends/links", { optional: true }, trends.trendLinks),
  // Follow suggestions (mastodon/suggestions.ts).
  get("/api/v1/suggestions", { scope: "read:accounts" }, suggestions.suggestionsV1),
  del("/api/v1/suggestions/:id", { scope: "write:accounts" }, suggestions.dismissSuggestion),
  get("/api/v2/suggestions", { scope: "read:accounts" }, suggestions.suggestionsV2),
  get("/api/v1/annual_reports", { scope: "read:accounts" }, placeholders.annualReports),
  // As Mastodon's: every action but index asks write:accounts.
  get("/api/v1/annual_reports/:id", { scope: "write:accounts" }, placeholders.annualReport),
  post("/api/v1/annual_reports/:id/read", { scope: "write:accounts" }, placeholders.annualReport),
  // E-mail confirmation (any token at the route: placeholders.resendConfirmation checks write:accounts, since Mastodon
  // takes app tokens there), and async refreshes, which Kopje never starts.
  post("/api/v1/emails/confirmations", "token", placeholders.resendConfirmation),
  get("/api/v1/emails/check_confirmation", { scope: "read:accounts" }, placeholders.checkConfirmation),
  get("/api/v1_alpha/async_refreshes/:id", { scope: "read" }, placeholders.asyncRefresh),

  get("/api/v1/accounts/verify_credentials", { scope: ["profile", "read:accounts"] }, accounts.verifyCredentials),
  patch("/api/v1/accounts/update_credentials", { scope: "write:accounts" }, accounts.updateCredentials),
  get("/api/v1/accounts/relationships", { scope: "read:follows" }, accounts.relationships),
  get("/api/v1/accounts/search", { scope: "read:accounts" }, accounts.searchAccounts),
  get("/api/v1/accounts/lookup", "public", accounts.lookupAccount),
  // Accounts by id, as /api/v1/accounts/:id shows them; registration answers as Mastodon's with registrations closed
  // (any token here: the handler checks write:accounts, then that the token has no user).
  get("/api/v1/accounts", "public", accounts.getAccounts),
  post("/api/v1/accounts", "token", accounts.register),
  get("/api/v1/accounts/:id", "public", accounts.getAccount),
  post("/api/v1/accounts/:id/follow", { scope: "write:follows" }, accounts.follow),
  post("/api/v1/accounts/:id/unfollow", { scope: "write:follows" }, accounts.unfollow),
  get("/api/v1/accounts/:id/followers", { scope: "read:accounts", optional: true }, accounts.followers),
  get("/api/v1/follow_requests", { scope: "read:follows" }, accounts.followRequests),
  post("/api/v1/follow_requests/:id/authorize", { scope: "write:follows" }, accounts.authorizeFollowRequest),
  post("/api/v1/follow_requests/:id/reject", { scope: "write:follows" }, accounts.rejectFollowRequest),
  get("/api/v1/accounts/:id/following", { scope: "read:accounts", optional: true }, accounts.following),
  get("/api/v1/accounts/:id/statuses", { scope: "read:statuses", optional: true }, timelines.accountStatuses),

  // Removing a follower, private notes and endorsements.
  post("/api/v1/accounts/:id/remove_from_followers", { scope: "write:follows" }, accounts.removeFromFollowers),
  post("/api/v1/accounts/:id/note", { scope: "write:accounts" }, accounts.note),
  post("/api/v1/accounts/:id/endorse", { scope: "write:accounts" }, accounts.endorse),
  post("/api/v1/accounts/:id/pin", { scope: "write:accounts" }, accounts.endorse),
  post("/api/v1/accounts/:id/unendorse", { scope: "write:accounts" }, accounts.unendorse),
  post("/api/v1/accounts/:id/unpin", { scope: "write:accounts" }, accounts.unendorse),
  get("/api/v1/accounts/:id/endorsements", { scope: "read:accounts", optional: true }, accounts.accountEndorsements),
  // Any token at the route; the handler refuses one without a user (require_user!).
  get("/api/v1/accounts/:id/identity_proofs", "token", placeholders.identityProofs),

  get("/api/v1/accounts/:id/lists", { scope: "read:lists" }, lists.accountLists),

  // Blocks, mutes and domain blocks (mastodon/blocks.ts).
  post("/api/v1/accounts/:id/block", { scope: "write:blocks" }, blocks.block),
  post("/api/v1/accounts/:id/unblock", { scope: "write:blocks" }, blocks.unblock),
  post("/api/v1/accounts/:id/mute", { scope: "write:mutes" }, blocks.mute),
  post("/api/v1/accounts/:id/unmute", { scope: "write:mutes" }, blocks.unmute),
  get("/api/v1/blocks", { scope: "read:blocks" }, blocks.blocks),
  get("/api/v1/mutes", { scope: "read:mutes" }, blocks.mutes),
  // As Mastodon's DomainBlocks::PreviewsController: it previews a write.
  get("/api/v1/domain_blocks/preview", { scope: "write:blocks" }, blocks.previewDomainBlock),
  get("/api/v1/domain_blocks", { scope: "read:blocks" }, blocks.domainBlocks),
  post("/api/v1/domain_blocks", { scope: "write:blocks" }, blocks.blockDomain),
  del("/api/v1/domain_blocks", { scope: "write:blocks" }, blocks.unblockDomain),

  post("/api/v1/statuses", { scope: "write:statuses" }, statuses.createStatus),
  get("/api/v1/statuses", { scope: "read:statuses", optional: true }, statuses.getStatuses),
  get("/api/v1/statuses/:id", { scope: "read:statuses", optional: true }, statuses.getStatus),
  put("/api/v1/statuses/:id", { scope: "write:statuses" }, statuses.editStatus),
  patch("/api/v1/statuses/:id", { scope: "write:statuses" }, statuses.editStatus),
  put("/api/v1/statuses/:id/interaction_policy", { scope: "write:statuses" }, statuses.updateInteractionPolicy),
  patch("/api/v1/statuses/:id/interaction_policy", { scope: "write:statuses" }, statuses.updateInteractionPolicy),
  del("/api/v1/statuses/:id", { scope: "write:statuses" }, statuses.deleteStatus),
  get("/api/v1/statuses/:id/context", { scope: "read:statuses", optional: true }, statuses.statusContext),
  get("/api/v1/statuses/:id/history", { scope: "read:statuses", optional: true }, statuses.statusHistory),
  get("/api/v1/statuses/:id/source", { scope: "read:statuses" }, statuses.statusSource),
  get("/api/v1/statuses/:id/quotes", { scope: "read:statuses", app: true }, statuses.statusQuotes),
  post("/api/v1/statuses/:id/quotes/:quoting_status_id/revoke", { scope: "write:statuses" }, statuses.revokeQuote),
  get("/api/v1/statuses/:id/favourited_by", { scope: "read:accounts", optional: true }, statuses.favouritedBy),
  get("/api/v1/statuses/:id/reblogged_by", { scope: "read:accounts", optional: true }, statuses.rebloggedBy),
  post("/api/v1/statuses/:id/favourite", { scope: "write:favourites" }, statuses.favourite),
  post("/api/v1/statuses/:id/unfavourite", { scope: "write:favourites" }, statuses.unfavourite),
  post("/api/v1/statuses/:id/reblog", { scope: "write:statuses" }, statuses.reblog),
  post("/api/v1/statuses/:id/unreblog", { scope: "write:statuses" }, statuses.unreblog),
  post("/api/v1/statuses/:id/bookmark", { scope: "write:bookmarks" }, statuses.bookmark),
  post("/api/v1/statuses/:id/unbookmark", { scope: "write:bookmarks" }, statuses.unbookmark),
  // Pins and conversation mutes.
  post("/api/v1/statuses/:id/pin", { scope: "write:accounts" }, statuses.pin),
  post("/api/v1/statuses/:id/unpin", { scope: "write:accounts" }, statuses.unpin),
  post("/api/v1/statuses/:id/mute", { scope: "write:mutes" }, statuses.muteConversation),
  post("/api/v1/statuses/:id/unmute", { scope: "write:mutes" }, statuses.unmuteConversation),
  post("/api/v1/statuses/:id/translate", { scope: "read:statuses" }, placeholders.translateStatus),

  get("/api/v1/timelines/home", { scope: "read:statuses" }, timelines.home),
  get("/api/v1/timelines/list/:id", { scope: "read:lists" }, timelines.listTimeline),
  get("/api/v1/timelines/public", { scope: "read:statuses", optional: true }, timelines.publicTimeline),
  get("/api/v1/timelines/tag/:hashtag", { scope: "read:statuses", optional: true }, timelines.tagTimeline),
  get("/api/v1/timelines/link", { scope: "read:statuses", optional: true }, timelines.linkTimeline),
  get("/api/v1/bookmarks", { scope: "read:bookmarks" }, timelines.bookmarks),
  get("/api/v1/favourites", { scope: "read:favourites" }, timelines.favourites),

  // Lists (mastodon/lists.ts).
  get("/api/v1/lists", { scope: "read:lists" }, lists.lists),
  post("/api/v1/lists", { scope: "write:lists" }, lists.createList),
  get("/api/v1/lists/:id", { scope: "read:lists" }, lists.getList),
  put("/api/v1/lists/:id", { scope: "write:lists" }, lists.updateList),
  patch("/api/v1/lists/:id", { scope: "write:lists" }, lists.updateList),
  del("/api/v1/lists/:id", { scope: "write:lists" }, lists.deleteList),
  get("/api/v1/lists/:id/accounts", { scope: "read:lists" }, lists.listAccounts),
  post("/api/v1/lists/:id/accounts", { scope: "write:lists" }, lists.addListAccounts),
  del("/api/v1/lists/:id/accounts", { scope: "write:lists" }, lists.removeListAccounts),

  // Filters (mastodon/filters.ts): v2, and v1 over the same filters. Fixed paths before their :id siblings.
  get("/api/v1/filters", { scope: "read:filters" }, filters.listFiltersV1),
  post("/api/v1/filters", { scope: "write:filters" }, filters.createFilterV1),
  get("/api/v1/filters/:id", { scope: "read:filters" }, filters.getFilterV1),
  put("/api/v1/filters/:id", { scope: "write:filters" }, filters.updateFilterV1),
  patch("/api/v1/filters/:id", { scope: "write:filters" }, filters.updateFilterV1),
  del("/api/v1/filters/:id", { scope: "write:filters" }, filters.deleteFilterV1),
  get("/api/v2/filters", { scope: "read:filters" }, filters.listFilters),
  post("/api/v2/filters", { scope: "write:filters" }, filters.createFilter),
  get("/api/v2/filters/keywords/:id", { scope: "read:filters" }, filters.getFilterKeyword),
  put("/api/v2/filters/keywords/:id", { scope: "write:filters" }, filters.updateFilterKeyword),
  patch("/api/v2/filters/keywords/:id", { scope: "write:filters" }, filters.updateFilterKeyword),
  del("/api/v2/filters/keywords/:id", { scope: "write:filters" }, filters.deleteFilterKeyword),
  get("/api/v2/filters/statuses/:id", { scope: "read:filters" }, filters.getFilterStatus),
  del("/api/v2/filters/statuses/:id", { scope: "write:filters" }, filters.deleteFilterStatus),
  get("/api/v2/filters/:filter_id/keywords", { scope: "read:filters" }, filters.listFilterKeywords),
  post("/api/v2/filters/:filter_id/keywords", { scope: "write:filters" }, filters.createFilterKeyword),
  get("/api/v2/filters/:filter_id/statuses", { scope: "read:filters" }, filters.listFilterStatuses),
  post("/api/v2/filters/:filter_id/statuses", { scope: "write:filters" }, filters.createFilterStatus),
  get("/api/v2/filters/:id", { scope: "read:filters" }, filters.getFilter),
  put("/api/v2/filters/:id", { scope: "write:filters" }, filters.updateFilter),
  patch("/api/v2/filters/:id", { scope: "write:filters" }, filters.updateFilter),
  del("/api/v2/filters/:id", { scope: "write:filters" }, filters.deleteFilter),
  // Conversations (mastodon/conversations.ts).
  get("/api/v1/conversations", { scope: "read:statuses" }, conversations.conversations),
  del("/api/v1/conversations/:id", { scope: "write:conversations" }, conversations.deleteConversation),
  post("/api/v1/conversations/:id/read", { scope: "write:conversations" }, conversations.readConversation),
  post("/api/v1/conversations/:id/unread", { scope: "write:conversations" }, conversations.unreadConversation),
  // Timeline markers (mastodon/markers.ts).
  get("/api/v1/markers", { scope: "read:statuses" }, markers.markers),
  post("/api/v1/markers", { scope: "write:statuses" }, markers.saveMarkers),
  // Reports (mastodon/reports.ts).
  post("/api/v1/reports", { scope: "write:reports" }, reports.createReport),
  // The Mastodon admin API (mastodon/admin.ts): all 63 routes, each with its admin scope and an optional token
  // (Mastodon's authorize_if_got_token!).
  get("/api/v1/admin/accounts", { scope: "admin:read:accounts", optional: true }, admin.adminAccounts(1)),
  get("/api/v2/admin/accounts", { scope: "admin:read:accounts", optional: true }, admin.adminAccounts(2)),
  get("/api/v1/admin/accounts/:id", { scope: "admin:read:accounts", optional: true }, admin.adminAccount),
  del("/api/v1/admin/accounts/:id", { scope: "admin:write:accounts", optional: true }, admin.notAllowed),
  post(
    "/api/v1/admin/accounts/:account_id/action",
    { scope: "admin:write:accounts", optional: true },
    admin.accountAction,
  ),
  post(
    "/api/v1/admin/accounts/:id/approve",
    { scope: "admin:write:accounts", optional: true },
    admin.actOnAccount("approve"),
  ),
  post(
    "/api/v1/admin/accounts/:id/enable",
    { scope: "admin:write:accounts", optional: true },
    admin.actOnAccount("enable"),
  ),
  post(
    "/api/v1/admin/accounts/:id/reject",
    { scope: "admin:write:accounts", optional: true },
    admin.actOnAccount("reject"),
  ),
  post(
    "/api/v1/admin/accounts/:id/unsensitive",
    { scope: "admin:write:accounts", optional: true },
    admin.actOnAccount("unsensitive"),
  ),
  post(
    "/api/v1/admin/accounts/:id/unsilence",
    { scope: "admin:write:accounts", optional: true },
    admin.actOnAccount("unsilence"),
  ),
  post(
    "/api/v1/admin/accounts/:id/unsuspend",
    { scope: "admin:write:accounts", optional: true },
    admin.unsuspendAccount,
  ),
  get("/api/v1/admin/reports", { scope: "admin:read:reports", optional: true }, admin.reports),
  get("/api/v1/admin/reports/:id", { scope: "admin:read:reports", optional: true }, admin.report),
  put("/api/v1/admin/reports/:id", { scope: "admin:write:reports", optional: true }, admin.updateReport),
  patch("/api/v1/admin/reports/:id", { scope: "admin:write:reports", optional: true }, admin.updateReport),
  post(
    "/api/v1/admin/reports/:id/assign_to_self",
    { scope: "admin:write:reports", optional: true },
    admin.actOnReport("assign_to_self"),
  ),
  post(
    "/api/v1/admin/reports/:id/reopen",
    { scope: "admin:write:reports", optional: true },
    admin.actOnReport("reopen"),
  ),
  post(
    "/api/v1/admin/reports/:id/resolve",
    { scope: "admin:write:reports", optional: true },
    admin.actOnReport("resolve"),
  ),
  post(
    "/api/v1/admin/reports/:id/unassign",
    { scope: "admin:write:reports", optional: true },
    admin.actOnReport("unassign"),
  ),
  get("/api/v1/admin/domain_blocks", { scope: "admin:read:domain_blocks", optional: true }, admin.domainBlocks),
  post("/api/v1/admin/domain_blocks", { scope: "admin:write:domain_blocks", optional: true }, admin.createDomainBlock),
  get("/api/v1/admin/domain_blocks/:id", { scope: "admin:read:domain_blocks", optional: true }, admin.domainBlock),
  put(
    "/api/v1/admin/domain_blocks/:id",
    { scope: "admin:write:domain_blocks", optional: true },
    admin.updateDomainBlock,
  ),
  patch(
    "/api/v1/admin/domain_blocks/:id",
    { scope: "admin:write:domain_blocks", optional: true },
    admin.updateDomainBlock,
  ),
  del(
    "/api/v1/admin/domain_blocks/:id",
    { scope: "admin:write:domain_blocks", optional: true },
    admin.deleteDomainBlock,
  ),
  get("/api/v1/admin/domain_allows", { scope: "admin:read:domain_allows", optional: true }, admin.domainAllows),
  post("/api/v1/admin/domain_allows", { scope: "admin:write:domain_allows", optional: true }, admin.notAllowed),
  get("/api/v1/admin/domain_allows/:id", { scope: "admin:read:domain_allows", optional: true }, admin.recordNotFound),
  del("/api/v1/admin/domain_allows/:id", { scope: "admin:write:domain_allows", optional: true }, admin.recordNotFound),
  get("/api/v1/admin/ip_blocks", { scope: "admin:read:ip_blocks", optional: true }, admin.notAllowed),
  post("/api/v1/admin/ip_blocks", { scope: "admin:write:ip_blocks", optional: true }, admin.notAllowed),
  get("/api/v1/admin/ip_blocks/:id", { scope: "admin:read:ip_blocks", optional: true }, admin.recordNotFound),
  put("/api/v1/admin/ip_blocks/:id", { scope: "admin:write:ip_blocks", optional: true }, admin.recordNotFound),
  patch("/api/v1/admin/ip_blocks/:id", { scope: "admin:write:ip_blocks", optional: true }, admin.recordNotFound),
  del("/api/v1/admin/ip_blocks/:id", { scope: "admin:write:ip_blocks", optional: true }, admin.recordNotFound),
  get(
    "/api/v1/admin/email_domain_blocks",
    { scope: "admin:read:email_domain_blocks", optional: true },
    admin.notAllowed,
  ),
  post(
    "/api/v1/admin/email_domain_blocks",
    { scope: "admin:write:email_domain_blocks", optional: true },
    admin.notAllowed,
  ),
  get(
    "/api/v1/admin/email_domain_blocks/:id",
    { scope: "admin:read:email_domain_blocks", optional: true },
    admin.recordNotFound,
  ),
  del(
    "/api/v1/admin/email_domain_blocks/:id",
    { scope: "admin:write:email_domain_blocks", optional: true },
    admin.recordNotFound,
  ),
  get(
    "/api/v1/admin/canonical_email_blocks",
    { scope: "admin:read:canonical_email_blocks", optional: true },
    admin.notAllowed,
  ),
  post(
    "/api/v1/admin/canonical_email_blocks",
    { scope: "admin:write:canonical_email_blocks", optional: true },
    admin.notAllowed,
  ),
  post(
    "/api/v1/admin/canonical_email_blocks/test",
    { scope: "admin:read:canonical_email_blocks", optional: true },
    admin.notAllowed,
  ),
  get(
    "/api/v1/admin/canonical_email_blocks/:id",
    { scope: "admin:read:canonical_email_blocks", optional: true },
    admin.recordNotFound,
  ),
  del(
    "/api/v1/admin/canonical_email_blocks/:id",
    { scope: "admin:write:canonical_email_blocks", optional: true },
    admin.recordNotFound,
  ),
  get("/api/v1/admin/trends/links", { scope: "admin:read", optional: true }, trends.trendLinks),
  get("/api/v1/admin/trends/statuses", { scope: "admin:read", optional: true }, trends.trendStatuses),
  get("/api/v1/admin/trends/tags", { scope: "admin:read", optional: true }, trends.trendTags),
  get("/api/v1/admin/trends/links/publishers", { scope: "admin:read", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/links/:id/approve", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/links/:id/reject", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/statuses/:id/approve", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/statuses/:id/reject", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/tags/:id/approve", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/tags/:id/reject", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/links/publishers/:id/approve", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/trends/links/publishers/:id/reject", { scope: "admin:write", optional: true }, admin.notAllowed),
  post("/api/v1/admin/dimensions", { scope: "admin:read", optional: true }, admin.emptyMetric),
  post("/api/v1/admin/measures", { scope: "admin:read", optional: true }, admin.measures),
  post("/api/v1/admin/retention", { scope: "admin:read", optional: true }, admin.emptyMetric),
  get("/api/v1/admin/tags", { scope: "admin:read", optional: true }, admin.notAllowed),
  get("/api/v1/admin/tags/:id", { scope: "admin:read", optional: true }, admin.notAllowed),
  put("/api/v1/admin/tags/:id", { scope: "admin:write", optional: true }, admin.notAllowed),
  patch("/api/v1/admin/tags/:id", { scope: "admin:write", optional: true }, admin.notAllowed),
  // Polls (mastodon/polls.ts); a poll is posted with its status.
  get("/api/v1/polls/:id", { scope: "read:statuses", optional: true }, polls.showPoll),
  post("/api/v1/polls/:id/votes", { scope: "write:statuses" }, polls.votePoll),
  // Scheduled statuses (mastodon/scheduled-statuses.ts); scheduling is POST /api/v1/statuses with scheduled_at.
  get("/api/v1/scheduled_statuses", { scope: "read:statuses" }, scheduled.list),
  get("/api/v1/scheduled_statuses/:id", { scope: "read:statuses" }, scheduled.show),
  put("/api/v1/scheduled_statuses/:id", { scope: "write:statuses" }, scheduled.update),
  patch("/api/v1/scheduled_statuses/:id", { scope: "write:statuses" }, scheduled.update),
  del("/api/v1/scheduled_statuses/:id", { scope: "write:statuses" }, scheduled.destroy),

  post("/api/v1/media", { scope: "write:media" }, media.uploadMedia),
  post("/api/v2/media", { scope: "write:media" }, media.uploadMedia),
  get("/api/v1/media/:id", { scope: "write:media" }, media.getMedia),
  put("/api/v1/media/:id", { scope: "write:media" }, media.updateMedia),
  patch("/api/v1/media/:id", { scope: "write:media" }, media.updateMedia),
  del("/api/v1/media/:id", { scope: "write:media" }, media.deleteMedia),
  // Profile images (mastodon/accounts.ts); they are set from the settings page.
  del("/api/v1/profile/avatar", { scope: "write:accounts" }, accounts.removeAvatar),
  del("/api/v1/profile/header", { scope: "write:accounts" }, accounts.removeHeader),

  // Unauthenticated search is refused: it would enumerate accounts and load the Store.
  get("/api/v2/search", { scope: "read:search" }, search.search),

  get("/api/v1/notifications", { scope: "read:notifications" }, notifications.listNotifications),
  post("/api/v1/notifications/clear", { scope: "write:notifications" }, notifications.clearNotifications),
  get("/api/v1/notifications/unread_count", { scope: "read:notifications" }, notificationGroups.unreadCount),
  // The notification policy and requests (mastodon/notification-requests.ts), before the :id routes.
  get("/api/v1/notifications/policy", { scope: "read:notifications" }, notificationRequests.getPolicyV1),
  patch("/api/v1/notifications/policy", { scope: "write:notifications" }, notificationRequests.updatePolicyV1),
  put("/api/v1/notifications/policy", { scope: "write:notifications" }, notificationRequests.updatePolicyV1),
  get("/api/v2/notifications/policy", { scope: "read:notifications" }, notificationRequests.getPolicyV2),
  patch("/api/v2/notifications/policy", { scope: "write:notifications" }, notificationRequests.updatePolicyV2),
  put("/api/v2/notifications/policy", { scope: "write:notifications" }, notificationRequests.updatePolicyV2),
  get("/api/v1/notifications/requests", { scope: "read:notifications" }, notificationRequests.listRequests),
  get("/api/v1/notifications/requests/merged", { scope: "read:notifications" }, notificationRequests.merged),
  post("/api/v1/notifications/requests/accept", { scope: "write:notifications" }, notificationRequests.acceptRequests),
  post(
    "/api/v1/notifications/requests/dismiss",
    { scope: "write:notifications" },
    notificationRequests.dismissRequests,
  ),
  get("/api/v1/notifications/requests/:id", { scope: "read:notifications" }, notificationRequests.getRequest),
  post(
    "/api/v1/notifications/requests/:id/accept",
    { scope: "write:notifications" },
    notificationRequests.acceptRequest,
  ),
  post(
    "/api/v1/notifications/requests/:id/dismiss",
    { scope: "write:notifications" },
    notificationRequests.dismissRequest,
  ),
  get("/api/v1/notifications/:id", { scope: "read:notifications" }, notifications.getNotification),
  post("/api/v1/notifications/:id/dismiss", { scope: "write:notifications" }, notifications.dismissNotification),
  // Grouped notifications (mastodon/notification-groups.ts).
  get("/api/v2/notifications", { scope: "read:notifications" }, notificationGroups.listGroupedNotifications),
  get("/api/v2/notifications/unread_count", { scope: "read:notifications" }, notificationGroups.unreadGroupCount),
  post("/api/v2/notifications/clear", { scope: "write:notifications" }, notifications.clearNotifications),
  get("/api/v2/notifications/:group_key", { scope: "read:notifications" }, notificationGroups.getNotificationGroup),
  post(
    "/api/v2/notifications/:group_key/dismiss",
    { scope: "write:notifications" },
    notificationGroups.dismissNotificationGroup,
  ),
  get(
    "/api/v2/notifications/:group_key/accounts",
    { scope: "read:notifications" },
    notificationGroups.notificationGroupAccounts,
  ),

  post("/api/v1/push/subscription", { scope: "push" }, push.createSubscription),
  get("/api/v1/push/subscription", { scope: "push" }, push.getSubscription),
  put("/api/v1/push/subscription", { scope: "push" }, push.updateSubscription),
  patch("/api/v1/push/subscription", { scope: "push" }, push.updateSubscription),
  del("/api/v1/push/subscription", { scope: "push" }, push.deleteSubscription),
];

export function mastodonApi(deps: ApiDeps, routes: readonly Route[] = ROUTES): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();
  for (const route of routes) {
    api.on(route.method, route.path, requireAccess(route.access, deps), (c) => route.handler(c, deps));
  }
  return api;
}
