import { ACCOUNTS_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { boundedHref } from "../platform/http-url";
import { DOMAIN_BYTES } from "../platform/identity-bounds";
import { byteCut, PROFILE_URL_LIMIT } from "../platform/stored-bounds";
import { escapeHtml } from "./plain-text";
import { USERNAME_LIMIT, usernameSql } from "./profile-bounds";

// A notification's `fallback` for a client that does not support its type (Mastodon 4.6's NotificationFallbackConcern,
// app/serializers/concerns/notification_fallback_concern.rb): with `supported_types` sent, a notification or group of
// a type outside Mastodon's baseline that the parameter does not include carries {title, summary, description: null};
// its `type` is unchanged. The texts are Mastodon's English ones (config/locales/en.yml:1877-1897 in v4.7.5), each
// account named as TextFormatter.link_to_mention names it (app/lib/text_formatter.rb:80-87) by its stored username and
// linked as ActivityPub::TagManager#url_for links it (fallbackHref; app/lib/activitypub/tag_manager.rb:20-21), every
// interpolated part escaped as Rails' `h` escapes it. The summaries link the instance's front page in place of
// Mastodon's web app and dispute page, which Kopje lacks (docs/mastodon-deviations.md, "Notification fallbacks").
// The Store builds it inside admission (RES-3, FALLBACK_JSON_MAX); the streaming `notification` event and Web Push
// carry none, as Mastodon renders those without the option (app/services/notify_service.rb:269).

// The types outside Mastodon's baseline (Notification::PROPERTIES) that Kopje writes; a restored row of another one
// carries none.
export const FALLBACK_TYPES = ["admin.report", "moderation_warning"] as const;

export type NotificationFallback = { title: string; summary: string; description: null };

// The most JSON a fallback takes (RES-3): an admin.report's title naming two accounts by link_to_mention, each with its
// href at PROFILE_URL_LIMIT and its username at USERNAME_LIMIT bytes, every byte at six (escapeHtml's `&quot;` or a
// JSON escape), and the summary over the instance origin at its longest (https, a DNS name of DOMAIN_BYTES and a port).
// A moderation_warning's is under 1 KB. test/notification-fallback.test.ts derives it.
export const FALLBACK_JSON_MAX = 28_521;

// Api::V1::NotificationsController's and Api::V2's supported_notification_types, the raw parameter (`supported`: the
// array of supported_types[], or the scalar supported_types): the types of FALLBACK_TYPES that need a fallback, those
// the value does not include (needs_fallback?: Array#include? matches an element, String#include? a substring), and
// none without the parameter.
export function fallbackTypes(supported: string | readonly string[] | undefined): string[] {
  return supported === undefined ? [] : FALLBACK_TYPES.filter((type) => !supported.includes(type));
}

// The types a read gives a fallback, from the types its caller asked for: those of FALLBACK_TYPES alone.
export function fallbackSet(types: readonly string[] | undefined): ReadonlySet<string> {
  const asked = new Set(Array.isArray(types) ? types : []);
  return new Set(FALLBACK_TYPES.filter((type) => asked.has(type)));
}

// An account as a fallback names it: its stored username and domain within their bounds (the trends pattern), whether
// it is local, and its stored url as text (within PROFILE_URL_LIMIT as stored, migration 0048_stored_bounds).
type AccountRow = { id: string; username: string; domain: string; local: 0 | 1; url: string | null };

// An admin.report's sender (?1) and its report's target account (?2), each by its key.
const REPORT_ACCOUNTS_SQL = `SELECT a.id, coalesce(${byteCut(usernameSql("a.username"), USERNAME_LIMIT)}, '') AS username,
	coalesce(${byteCut("a.domain", DOMAIN_BYTES)}, '') AS domain, a.domain IS NULL AS local,
	CASE WHEN typeof(a.url) = 'text' THEN a.url END AS url
	FROM accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE a.id IN (?1, ?2)`;

// TagManager#url_for of an account: a remote account's stored url when it is http(s) (unsupported_uri_scheme?,
// app/helpers/json_ld_helper.rb:95-97), a local account's short_account_url; '' for none, as Mastodon's nil. Kopje
// serializes it within PROFILE_URL_LIMIT (HTML-3, RES-2), so a url that does not parse or is past the bound once
// serialized is none too, where Mastodon shows it as stored. accountUrl's derived URLs are not Mastodon's here.
function fallbackHref(account: AccountRow, origin: string): string {
  return boundedHref(account.local === 1 ? `${origin}/@${account.username}` : account.url, PROFILE_URL_LIMIT) ?? "";
}

// TextFormatter.link_to_mention without the domain.
export function linkToMention(href: string, username: string): string {
  return `<span class="h-card" translate="no"><a href="${escapeHtml(href)}" class="u-url mention">@<span>${escapeHtml(username)}</span></a></span>`;
}

// notification_fallbacks.admin_report.title_html.
export function reportTitle(name: string, target: string): string {
  return `${name} reported ${target}`;
}

// notification_fallbacks.moderation_warning.title.
export const WARNING_TITLE = "You have received a moderation warning.";

// notification_fallbacks.generic.summary_html and moderation_warning.summary_html, with the link to the instance's
// front page (docs/mastodon-deviations.md, "Notification fallbacks").
export function fallbackSummary(origin: string): string {
  const host = new URL(origin).host;
  return `You're on an app that does not support the most recent version of Mastodon. <a href="${escapeHtml(`${origin}/`)}">Visit ${escapeHtml(host)}</a>.`;
}

// The fallback of a notification or group of `type` in FALLBACK_TYPES: an admin.report names `accountId` (the
// sender, or a group's first sample) and `targetId` (its report's target account), a remote sender by its domain
// (fallback_title), each read by its key. Undefined when an account is gone.
export function notificationFallback(
  db: Db,
  type: string,
  input: { accountId: string; targetId: string | null; origin: string },
): NotificationFallback | undefined {
  const summary = fallbackSummary(input.origin);
  if (type === "moderation_warning") {
    return { title: WARNING_TITLE, summary, description: null };
  }
  if (type !== "admin.report" || input.targetId === null) {
    return undefined;
  }
  const rows = db.all<AccountRow>(REPORT_ACCOUNTS_SQL, input.accountId, input.targetId);
  const sender = rows.find((row) => row.id === input.accountId);
  const target = rows.find((row) => row.id === input.targetId);
  if (sender === undefined || target === undefined) {
    return undefined;
  }
  const mention = (row: AccountRow) => linkToMention(fallbackHref(row, input.origin), row.username);
  const name = sender.local === 1 ? mention(sender) : escapeHtml(sender.domain);
  return { title: reportTitle(name, mention(target)), summary, description: null };
}
