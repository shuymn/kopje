import type { Poll } from "../domain/poll-presenter";
import { envInMaintenance } from "../platform/config";
import { StoreUnavailableError, WRITE_REFUSALS } from "../platform/store-errors";
import {
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  optionalCredential,
  present,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { mastodonError, recordNotFound } from "./errors";

// Polls (Mastodon 4.5's Api::V1::PollsController and Api::V1::Polls::VotesController); the Store decides who may see
// and vote (domain/polls.ts).

// At most this many choices are read from a request (RES-1): a poll has at most 100, and a vote is refused at its
// first choice that fails, so more are never needed.
const MAX_CHOICES_READ = 101;

// GET /api/v1/polls/:id: the poll, if the viewer may see its status. A signed-in user's read of a remote poll that may
// be stale refreshes it first (Api::V1::PollsController#refresh_poll, #1655): getPoll says the poll is due, the Store
// reserves the attempt (reservePollRefresh), the Worker fetches the status's document (deps.fetchPoll), and the Store
// applies it while nothing has written the poll since (refreshPoll). The answer is the stored poll when nothing is
// fetched, another read reserved first, or the Store refuses writes; nothing is fetched while the env's MAINTENANCE is
// not off.
export const showPoll: ApiHandler = async (c, deps) => {
  const credential = optionalCredential(c, deps);
  const id = c.req.param("id") ?? "";
  const read = authorized(
    await storeCall(c, deps, (s, b) => s.getPoll(b, { credential, id, now: deps.now(), present: present(c) })),
  );
  if (read === null) {
    return recordNotFound();
  }
  if (!read.due || envInMaintenance(c.env) || deps.fetchPoll === undefined) {
    return c.json(read.poll);
  }
  const poll = await refreshed(c, { ...deps, fetchPoll: deps.fetchPoll }, id, read.poll);
  return poll === null ? recordNotFound() : c.json(poll);
};

// The poll after its refresh: the stored one when the Store refuses a write (WRITE_REFUSALS) or nothing is applied;
// null when its status is gone or no longer visible to the reader. Any other Store failure is the request's error. The
// credential of each call is taken after any network work before it.
async function refreshed(
  c: ApiContext,
  deps: ApiDeps & { fetchPoll: NonNullable<ApiDeps["fetchPoll"]> },
  id: string,
  stored: Poll,
): Promise<Poll | null> {
  try {
    const reservation = authorized(
      await storeCall(c, deps, (s, b) => s.reservePollRefresh(b, { credential: userCredential(c, deps), id })),
    );
    if (reservation === null) {
      return stored;
    }
    const status = await deps.fetchPoll(c.env, reservation);
    if (status === null) {
      return stored;
    }
    const answer = authorized(
      await storeCall(c, deps, (s, b) =>
        s.refreshPoll(b, {
          credential: userCredential(c, deps),
          statusId: reservation.statusId,
          revision: reservation.revision,
          status,
          now: deps.now(),
          origin: new URL(c.req.url).origin,
          present: present(c),
        }),
      ),
    );
    if (answer.quotesDue) {
      await deps.requestJobs?.(c.env);
    }
    return answer.poll;
  } catch (error) {
    if (error instanceof StoreUnavailableError && WRITE_REFUSALS.has(error.reason)) {
      return stored;
    }
    throw error;
  }
}

// POST /api/v1/polls/:id/votes: choices[] are the indexes of the choices voted for, each read by Ruby's Integer()
// (a JSON number by its to_i). None (an absent or empty list) is refused as params.require refuses it.
export const votePoll: ApiHandler = withParams(async (c, deps, p) => {
  const choices = p
    .getAllIntegers("choices")
    .filter((choice) => choice !== "")
    .slice(0, MAX_CHOICES_READ);
  const input = {
    credential: userCredential(c, deps),
    id: c.req.param("id") ?? "",
    choices,
    now: deps.now(),
    present: present(c),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.vote(b, input)));
  switch (result.status) {
    case "ok":
      return c.json(result.value);
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return mastodonError(403, "This action is not allowed");
    case "missing":
      return mastodonError(400, "param is missing or the value is empty or invalid: choices");
    case "invalid":
      return mastodonError(422, result.error);
  }
});
