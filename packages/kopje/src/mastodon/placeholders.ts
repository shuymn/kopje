import { grantsAny } from "../security/scopes";
import {
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  credential,
  optionalTokenCredential,
  present,
  storeCall,
} from "./context";
import { mastodonError, recordNotFound } from "./errors";

// Features Kopje has no data for (annual reports, translation, e-mail confirmation, async refreshes), answered as
// Mastodon answers when the feature has nothing to show or is not configured, because clients call them and a missing
// route can stop a client (MD-3). Each is replaced when its feature arrives with its own tables; annual reports when
// Kopje builds their generation. The writes act on records that never exist, so they change nothing.

// Mastodon's not_found (ApplicationController#not_found, Api::BaseController#respond_with_error), as opposed to the
// "Record not found" of an ActiveRecord::RecordNotFound.
const NOT_FOUND = () => mastodonError(404, "Not Found");

// The signed-in user's token, checked (validity, the route's scope if any, suspension) and bound to a user, as
// Mastodon's require_user! asks: a route without a scope accepts any user token.
async function signedIn(c: ApiContext, deps: ApiDeps): Promise<void> {
  const value = credential(c, deps);
  const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
  if (viewer.accountId === null) {
    authorized({ status: "user_required" });
  }
}

// The answer of a route that requires the signed-in user, given once the token passes.
const forUser =
  (answer: (c: ApiContext) => Response): ApiHandler =>
  async (c, deps) => {
    await signedIn(c, deps);
    return answer(c);
  };

// Annual reports as a stock Mastodon 4.7.5 answers with Wrapstodon off (Setting.wrapstodon false): no campaign
// (AnnualReport.current_campaign is nil), so no report is generated for anyone (docs/mastodon-deviations.md, annual
// reports). Kopje makes none.
// GET /api/v1/annual_reports: Api::V1::AnnualReportsController#index with no pending report
// (REST::AnnualReportsSerializer).
export const annualReports = forUser((c) => c.json({ annual_reports: [], accounts: [], statuses: [] }));

// GET /api/v1/annual_reports/:id and POST /api/v1/annual_reports/:id/read: AnnualReportsController#set_annual_report
// raises RecordNotFound (find_by!) for a year without a report.
export const annualReport = forUser(recordNotFound);

// GET /api/v1/annual_reports/:id/state: AnnualReport#state is ineligible for a year without a report while no
// campaign runs.
export const annualReportState = forUser((c) => c.json({ state: "ineligible" }));

// POST /api/v1/annual_reports/:id/generate: AnnualReportsController#generate renders {} (render_empty) for a year that
// is not the current campaign's, and starts nothing.
export const generateAnnualReport = forUser((c) => c.json({}));

// POST /api/v1/statuses/:id/translate: Api::V1::Statuses::TranslationsController rescues
// TranslationService::NotConfiguredError with not_found. Kopje has no translation service; a status the viewer cannot
// see is answered the same (Api::V1::Statuses::BaseController#set_status), so the status is not looked up.
export const translateStatus = forUser(NOT_FOUND);

// GET /api/v1_alpha/async_refreshes/:id: Api::V1Alpha::AsyncRefreshesController#show answers not_found when
// AsyncRefresh.find finds no refresh. Kopje starts none.
export const asyncRefresh = forUser(NOT_FOUND);

// POST /api/v1/emails/confirmations: Api::V1::Emails::ConfirmationsController#require_user_owned_by_application!
// refuses a token without a user, or one whose user did not sign up through the token's application. No Kopje user
// signed up through an application (registrations are closed), so every token with write:accounts is refused. Any
// token at the route: write:accounts is checked here, since the route takes app tokens.
export const resendConfirmation: ApiHandler = async (c, deps) => {
  const value = credential(c, deps);
  const viewer = authorized(await storeCall(c, deps, (s, b) => s.checkCredential(b, value)));
  if (!grantsAny(viewer.scopes, "write:accounts")) {
    authorized({ status: "insufficient_scope" });
  }
  return mastodonError(403, "This method is only available to the application the user originally signed-up with");
};

// GET /api/v1/emails/check_confirmation: ConfirmationsController#check renders current_user.confirmed?. Kopje's users
// have no unconfirmed e-mail.
export const checkConfirmation = forUser((c) => c.json(true));

// GET /api/v1/donation_campaigns: Api::V1::DonationCampaignsController with no campaign source configured (its
// default) answers 204 to any user; its require_user! answers 422 without one, and Api::BaseController's
// require_not_suspended! 403 to a suspended user's token. It checks no doorkeeper scope, so any user token passes. A
// token past its expiry, revoked or of an earlier epoch reads as none (MD-3, AUTH-2's exception).
export const donationCampaigns: ApiHandler = async (c, deps) => {
  const value = optionalTokenCredential(c, deps);
  const check = value === null ? null : await storeCall(c, deps, (s, b) => s.checkCredential(b, value));
  if (check?.status === "suspended") {
    authorized(check);
  }
  if (check?.status !== "ok" || check.value.accountId === null) {
    authorized({ status: "user_required" });
  }
  return c.body(null, 204);
};

// POST /api/v1/accounts/:id/email_subscriptions: with e-mail subscriptions off (Setting.email_subscriptions unset),
// Api::V1::Accounts::EmailSubscriptionsController answers a suspended user's token 403 (require_not_suspended!),
// Record not found for an id that names no local account (set_account), and an empty 404 otherwise
// (require_feature_enabled!). It reads no parameter and needs no token; any other token changes nothing (MD-3).
export const emailSubscription: ApiHandler = async (c, deps) => {
  const value = optionalTokenCredential(c, deps);
  const id = c.req.param("id") ?? "";
  const target = await storeCall(c, deps, (s, b) => s.emailSubscriptionTarget(b, { credential: value, id }));
  if (target === "suspended") {
    authorized({ status: "suspended" });
  }
  return target === "missing" ? recordNotFound() : new Response(null, { status: 404 });
};

// An empty list, for an account that exists.
const emptyAccountList: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const account = await storeCall(c, deps, (s, b) => s.getAccount(b, { id, present: present(c) }));
  return account === null ? recordNotFound() : c.json([]);
};

// GET /api/v1/accounts/:id/identity_proofs: [] for an account that exists, as Mastodon's deprecated
// Accounts::IdentityProofsController answers, to a user token (require_user!, no scope).
export const identityProofs: ApiHandler = async (c, deps) => {
  await signedIn(c, deps);
  return emptyAccountList(c, deps);
};
