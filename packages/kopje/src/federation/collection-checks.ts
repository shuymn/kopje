import type { DocumentLoader } from "@fedify/fedify";

import {
  type ItemCheck,
  type ItemCheckOutcome,
  type ItemCheckResult,
  ITEM_CHECKS_PER_ROUND,
} from "../domain/collection-checks";
import { readConfig, userKek } from "../platform/config";
import { sameOrigin } from "../platform/http-url";
import { callStore } from "../platform/store-client";
import { createRemoteLoaders, type FederationState } from "./federation";
import { hasActivityStreamsContext } from "./inbound";
import type { InboxDeps } from "./inbox";
import { asArray, isObject } from "./json-shapes";
import {
  type DocumentCaps,
  isTransientLoadError,
  loadFailureOf,
  REQUEST_MAX_BYTES,
  REQUEST_MAX_FETCHES,
  requestBudget,
  UnusableDocumentError,
} from "./loader";
import { idOf } from "./remote-status";

// The Worker's part of the checks of remote members' feature authorizations (domain/collection-checks.ts, Mastodon
// 4.7.5's ActivityPub::VerifyFeaturedItemService), run by the job rounds (jobs/queue.ts) apart from the collection
// syncs: a round claims at most ITEM_CHECKS_PER_ROUND items, fetches each item's candidate authorization through the
// safe loader (NET-1) signed by the instance actor (Mastodon's fetch_resource), within one request's budget for the
// round (RES-6), and hands the outcomes back.
//
// Each fetch is under ITEM_CHECK_CAPS: no redirect, so the loader sends a document at most twice (the signed request
// and, answered 400 or 401, its RFC 9421 retry), and 64 KiB of body. A round's checks therefore fit its budget's
// fetches and bytes whatever the documents are (checked as the module loads), and none waits for a later round.
// The document matches when it is what it was fetched as (its id the URL asked for), in the ActivityStreams context,
// typed FeatureAuthorization, its interactionTarget the item's member and on the authorization's own origin, and its
// interactingObject the collection. A redirect or a body past the caps is not read (a mismatch: the check ends); an
// answer Mastodon's fetch_resource takes as final, a 4xx other than 401, 408 and 429 (response_error_unsalvageable?),
// or a body that is no object is gone; a 401, a 408, a 429, a 5xx (a 501 included, which Mastodon takes as final) or a
// failure to reach the server is transient.
const ITEM_CHECK_CAPS = { documentBytes: 64 * 1024, maxRedirects: 0 } as const satisfies DocumentCaps;
if (
  ITEM_CHECKS_PER_ROUND * 2 > REQUEST_MAX_FETCHES ||
  ITEM_CHECKS_PER_ROUND * ITEM_CHECK_CAPS.documentBytes > REQUEST_MAX_BYTES
) {
  throw new Error(
    "a round's item checks must fit one round of REQUEST_MAX_FETCHES and REQUEST_MAX_BYTES under ITEM_CHECK_CAPS, an RFC 9421 retry each included",
  );
}

type Json = Record<string, unknown>;

// Whether `document` is a FeatureAuthorization of `check`'s collection and member, as VerifyFeaturedItemService
// compares one (non_matching_uri_hosts?, matching_type?, matching_collection_uri?, matching_actors?).
function authorizes(document: Json, check: Pick<ItemCheck, "authorization" | "collection" | "member">): boolean {
  const target = idOf(document.interactionTarget);
  return (
    document.id === check.authorization &&
    hasActivityStreamsContext(document["@context"]) &&
    asArray(document.type).includes("FeatureAuthorization") &&
    target !== null &&
    sameOrigin(check.authorization, target) &&
    target === check.member &&
    idOf(document.interactingObject) === check.collection
  );
}

// One check's outcome: the authorization fetched through `loader` (under ITEM_CHECK_CAPS) and compared.
async function checkOutcome(check: ItemCheck, loader: DocumentLoader): Promise<ItemCheckOutcome> {
  let document: unknown;
  try {
    document = (await loader(check.authorization)).document;
  } catch (error) {
    const status = loadFailureOf(error)?.response?.status;
    if (status === 401 || isTransientLoadError(error)) {
      return "transient";
    }
    if ((status !== undefined && status >= 400 && status < 500) || error instanceof UnusableDocumentError) {
      return "gone";
    }
    return "mismatch";
  }
  if (!isObject(document)) {
    return "gone";
  }
  return authorizes(document, check) ? "match" : "mismatch";
}

// One round: the claims, their fetches and their outcomes. Returns whether another check is due now.
export async function checkCollectionItems(env: Env, deps: InboxDeps): Promise<boolean> {
  const build = deps.build(env);
  const store = () => deps.store(env);
  const domain = await callStore(() => store().instanceDomain(build));
  if (domain === null) {
    return false;
  }
  const claimed = await callStore(() => store().claimItemChecks(build, { now: deps.now() }));
  if (claimed.checks.length === 0) {
    return claimed.pending;
  }
  const config = readConfig(env);
  const state: FederationState = { resolvedUsername: null, source: null, storeError: null, ticket: null };
  const loaders = createRemoteLoaders(
    {
      domain,
      build,
      store,
      kek: config.ok ? userKek(config.config) : "",
      now: deps.now,
      keygen: deps.keygen,
      loader: deps.loader,
    },
    state,
    null,
    requestBudget(Date.now()),
  );
  const loader = loaders.capped(ITEM_CHECK_CAPS);
  const results: ItemCheckResult[] = [];
  for (const check of claimed.checks) {
    results.push({ item: check.item, token: check.token, outcome: await checkOutcome(check, loader) });
  }
  if (state.storeError !== null) {
    throw state.storeError;
  }
  const due = await callStore(() => store().completeItemChecks(build, { now: deps.now(), results }));
  return claimed.pending || due;
}
