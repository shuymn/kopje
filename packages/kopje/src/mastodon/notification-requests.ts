import { POLICY_DEFAULTS, type PolicyChoice, type PolicyColumn } from "../domain/audience";
import { MAX_BULK_REQUESTS, type Policy, type PolicySummary, type PolicyView } from "../domain/notification-requests";
import {
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  present,
  refuseAfterAuth,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { mastodonError, recordNotFound } from "./errors";
import { pageQuery, pageResponse } from "./pagination";
import { type Params, parseBoolean } from "./params";

// The notification policy (Mastodon 4.7.5's /api/v1 and /api/v2/notifications/policy) and notification requests
// (/api/v1/notifications/requests); the Store does the work (domain/notification-requests.ts).

const COLUMNS = Object.keys(POLICY_DEFAULTS) as PolicyColumn[];

// The v1 columns: for_limited_accounts has no v1 form.
const V1_COLUMNS = [
  "for_not_following",
  "for_not_followers",
  "for_new_accounts",
  "for_private_mentions",
  "for_bots",
] as const;

const CHOICES: readonly PolicyChoice[] = ["accept", "filter", "drop"];

// REST::NotificationPolicySerializer.
type NotificationPolicyV2 = {
  for_not_following: PolicyChoice;
  for_not_followers: PolicyChoice;
  for_new_accounts: PolicyChoice;
  for_private_mentions: PolicyChoice;
  for_limited_accounts: PolicyChoice;
  for_bots: PolicyChoice;
  summary: PolicySummary;
};

// REST::V1::NotificationPolicySerializer: each condition as whether it is anything but accept.
type NotificationPolicyV1 = {
  filter_not_following: boolean;
  filter_not_followers: boolean;
  filter_new_accounts: boolean;
  filter_private_mentions: boolean;
  filter_bots: boolean;
  summary: PolicySummary;
};

function v2Policy({ policy, summary }: PolicyView): NotificationPolicyV2 {
  return { ...policy, summary };
}

function v1Policy({ policy, summary }: PolicyView): NotificationPolicyV1 {
  const filters = (column: (typeof V1_COLUMNS)[number]) => policy[column] !== "accept";
  return {
    filter_not_following: filters("for_not_following"),
    filter_not_followers: filters("for_not_followers"),
    filter_new_accounts: filters("for_new_accounts"),
    filter_private_mentions: filters("for_private_mentions"),
    filter_bots: filters("for_bots"),
    summary,
  };
}

export const getPolicyV1: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(v1Policy(authorized(await storeCall(c, deps, (s, b) => s.getNotificationPolicy(b, { credential })))));
};

export const getPolicyV2: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(v2Policy(authorized(await storeCall(c, deps, (s, b) => s.getNotificationPolicy(b, { credential })))));
};

async function update(c: ApiContext, deps: ApiDeps, changes: Partial<Policy>) {
  const credential = userCredential(c, deps);
  return authorized(
    await storeCall(c, deps, (s, b) => s.updateNotificationPolicy(b, { credential, changes, now: deps.now() })),
  );
}

// PATCH and PUT /api/v1/notifications/policy: filter_not_following, filter_not_followers, filter_new_accounts,
// filter_private_mentions and filter_bots, each setting its condition to filter (true) or accept (false), as
// NotificationPolicy's v1 setters do. Mastodon's setter takes any value Ruby holds true, so a form's "false" filters
// there; Kopje reads the values as Rails casts booleans ("0", "f", "false", "off" and blank are false), as clients mean
// them (docs/mastodon-deviations.md, "Notification policy").
export const updatePolicyV1: ApiHandler = withParams(async (c, deps, p) => {
  const changes: Partial<Policy> = {};
  for (const column of V1_COLUMNS) {
    const value = p.get(column.replace(/^for_/, "filter_"));
    if (value !== undefined) {
      changes[column] = parseBoolean(value) === true ? "filter" : "accept";
    }
  }
  return c.json(v1Policy(await update(c, deps, changes)));
});

// PATCH and PUT /api/v2/notifications/policy: for_not_following, for_not_followers, for_new_accounts,
// for_private_mentions, for_limited_accounts and for_bots, each accept, filter or drop (or the enum's integer, 0 to 2).
// Mastodon's enum refuses any other value with an ArgumentError ("'x' is not a valid for_not_following"), which no
// handler rescues, so it answers 500; Kopje answers 422 with that message, and changes nothing
// (docs/mastodon-deviations.md, "Notification policy").
export const updatePolicyV2: ApiHandler = withParams(async (c, deps, p) => {
  const changes: Partial<Policy> = {};
  for (const column of COLUMNS) {
    const value = p.get(column);
    if (value === undefined) {
      continue;
    }
    const choice = CHOICES.find((name, index) => value === name || value === String(index));
    if (choice === undefined) {
      return refuseAfterAuth(c, deps, mastodonError(422, `'${value}' is not a valid ${column}`));
    }
    changes[column] = choice;
  }
  return c.json(v2Policy(await update(c, deps, changes)));
});

// GET /api/v1/notifications/requests: 40 by default, at most 80, by max_id, since_id and min_id, with Link headers.
export const listRequests: ApiHandler = withParams(async (c, deps, p) => {
  const page = pageQuery(p);
  const credential = userCredential(c, deps);
  const result = authorized(
    await storeCall(c, deps, (s, b) => s.listNotificationRequests(b, { credential, page, present: present(c) })),
  );
  return pageResponse(c, result, page.limit);
});

export const getRequest: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const credential = userCredential(c, deps);
  const request = authorized(
    await storeCall(c, deps, (s, b) => s.getNotificationRequest(b, { credential, id, present: present(c) })),
  );
  return request === null ? recordNotFound() : c.json(request);
};

export const acceptRequest: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "", now: deps.now() };
  const found = authorized(await storeCall(c, deps, (s, b) => s.acceptNotificationRequest(b, input)));
  return found ? c.json({}) : recordNotFound();
};

export const dismissRequest: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "", now: deps.now() };
  const found = authorized(await storeCall(c, deps, (s, b) => s.dismissNotificationRequest(b, input)));
  return found ? c.json({}) : recordNotFound();
};

// id[] of the bulk forms (set_requests: Array(params[:id]).uniq), at most MAX_BULK_REQUESTS.
async function bulkIds(c: ApiContext, deps: ApiDeps, p: Params): Promise<string[] | Response> {
  const ids = [...new Set(p.getAll("id"))];
  if (ids.length > MAX_BULK_REQUESTS) {
    return refuseAfterAuth(
      c,
      deps,
      mastodonError(422, `Validation failed: at most ${MAX_BULK_REQUESTS} requests can be answered at once`),
    );
  }
  return ids;
}

export const acceptRequests: ApiHandler = withParams(async (c, deps, p) => {
  const ids = await bulkIds(c, deps, p);
  if (ids instanceof Response) {
    return ids;
  }
  const input = { credential: userCredential(c, deps), ids, now: deps.now() };
  authorized(await storeCall(c, deps, (s, b) => s.acceptNotificationRequests(b, input)));
  return c.json({});
});

export const dismissRequests: ApiHandler = withParams(async (c, deps, p) => {
  const ids = await bulkIds(c, deps, p);
  if (ids instanceof Response) {
    return ids;
  }
  const input = { credential: userCredential(c, deps), ids, now: deps.now() };
  authorized(await storeCall(c, deps, (s, b) => s.dismissNotificationRequests(b, input)));
  return c.json({});
});

export const merged: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.notificationRequestsMerged(b, { credential }))));
};
