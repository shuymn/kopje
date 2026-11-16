import type { PollReservation } from "../domain/polls";
import type { RemoteStatusInput } from "../domain/remote-status-reads";
import { readConfig, userKek } from "../platform/config";
import { createRemoteLoaders, type FederationState } from "./federation";
import { requestBudget } from "./loader";
import { idOf, parseRemoteStatus } from "./remote-status";
import type { ResolverDeps } from "./resolve";

// The fetch of a remote poll's refresh on read (#1655; Mastodon 4.7.5's FetchRemotePollService, which fetches the
// status's uri with allow_redirects: false and takes the document only when its id is that uri): one request for the
// status's document after its reservation (domain/polls.ts reservePollRefresh), signed by the
// reservation's signer (DATA-7: the instance actor for a public or unlisted status, the reader otherwise; the RFC 9421
// retry of a 400 or 401 by the same key), within the request's fetch budget (RES-6), through the per-request memo of
// createRemoteLoaders, never the cached signed loader (NET-4), at no redirect (a 3xx ends the load with
// CappedFetchError). The document is read as JSON (parseRemoteStatus), so no JSON-LD context and no actor is
// fetched. It is taken only when its id is the status's uri and its attributedTo the stored author's (ID-2, ID-6);
// anything else, a failure of any kind included, is nothing fetched, and the reservation stays the attempt's record.
// A Store refusal met on the way (the instance key's creation while writes are refused) is thrown, for the caller to
// answer as it answers a refused refresh.
export type PollFetcher = (env: Env, reservation: PollReservation) => Promise<RemoteStatusInput | null>;

export function createPollFetcher(deps: Omit<ResolverDeps, "requestJobs">): PollFetcher {
  return async (env, reservation) => {
    const build = deps.build(env);
    const config = readConfig(env);
    const state: FederationState = {
      resolvedUsername: null,
      source: null,
      storeError: null,
      ticket: reservation.prefetch?.ticket ?? null,
    };
    const loaders = createRemoteLoaders(
      {
        domain: reservation.domain,
        build,
        store: () => deps.store(env),
        kek: config.ok ? userKek(config.config) : "",
        now: deps.now,
        keygen: deps.keygen,
        loader: deps.loader,
      },
      state,
      reservation.signer,
      (deps.budget ?? requestBudget)(Date.now()),
      reservation.prefetch?.signer ?? null,
    );
    let document: unknown;
    try {
      document = (await loaders.capped({ maxRedirects: 0 })(reservation.uri)).document;
    } catch {
      document = undefined;
    }
    if (state.storeError !== null) {
      throw state.storeError;
    }
    if (idOf(document) !== reservation.uri) {
      return null;
    }
    const status = parseRemoteStatus(document);
    return status !== null && status.uri === reservation.uri && status.attributedTo === reservation.authorUri
      ? status
      : null;
  };
}
