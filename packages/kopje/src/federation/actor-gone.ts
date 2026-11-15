import type { DocumentRevision } from "../domain/remote-actors";
import { callStore, type StoreStub } from "../platform/store-client";
import type { FetchedActor } from "./remote-actor";

// An actor whose own URI answers 410 is deleted, as Mastodon's FetchRemoteActorService deletes a stored account on a
// 410 (v4.7.5 fetch_remote_actor_service.rb:21-24, :46-54). Only a 410 counts, never a 404, and only when the URL that
// answered is the actor URI itself: the safe loader follows same-origin redirects (loader.ts, ID-2) where Mastodon
// follows none on this fetch (json_ld_helper.rb:242), so a 410 at the end of a redirect says nothing about the URI that
// redirected. The Store deletes only a stored remote actor and only under the revision the path read before that fetch
// (domain/inbox.ts actorGone, ID-1); a path that read none (a URL search's probe, a new author's need) deletes nothing.

// at: the 410 was the actor URI's own. jobsPending: the deletion's purge has a batch for a round.
export type GoneSettled = { at: boolean; jobsPending: boolean };

export type SettleGone = (
  fetched: FetchedActor,
  uri: string,
  revision: DocumentRevision | undefined,
) => Promise<GoneSettled>;

const NOT_GONE: GoneSettled = { at: false, jobsPending: false };

// The request's settler: a 410 at `uri` itself is handed to the Store with `revision`, the expectation read before the
// fetch (undefined: none was read).
export function goneSettler(store: () => StoreStub, build: string, now: () => number): SettleGone {
  return async (fetched, uri, revision) => {
    if (!goneAt(fetched, uri)) {
      return NOT_GONE;
    }
    if (revision === undefined) {
      return { at: true, jobsPending: false };
    }
    const { jobsPending } = await callStore(() => store().actorGone(build, { uri, revision, now: now() }));
    return { at: true, jobsPending };
  };
}

// Whether `fetched` is a 410 that `uri` itself answered. HTTP never sends a fragment, so the URLs are compared without
// one (a key fetch of `uri#main-key` and a fetch of `uri` are one request in the loaders' memo).
function goneAt(fetched: FetchedActor, uri: string): boolean {
  if (fetched.kind !== "gone" || fetched.status !== 410) {
    return false;
  }
  const actor = withoutFragment(uri);
  return actor !== null && withoutFragment(fetched.url) === actor;
}

function withoutFragment(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}
