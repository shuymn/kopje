import { describe, expect, it } from "vitest";

import { goneAt } from "../src/federation/actor-gone";
import { createSafeLoader } from "../src/federation/loader";
import { fetchRemoteStatus } from "../src/federation/remote-status";

// A status's fetch that answers 404 or 410 tells which, and which URL answered it (federation/remote-status.ts
// FetchedStatus), so a caller can act on a 404 at the status's own URI only (actor-gone.ts goneAt), as Mastodon's
// FetchRemoteStatusService#fetch_status does (v4.7.5 fetch_remote_status_service.rb:86-98: no redirect followed).

const STATUS = "https://remote.example/users/bob/statuses/1";
const MOVED = "https://remote.example/users/bob/statuses/1-moved";

// The safe loader over a server whose answers `routes` gives by URL (404 for any other).
function loaderOf(routes: Record<string, () => Response>) {
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    return Promise.resolve(routes[url]?.() ?? new Response(null, { status: 404 }));
  }) as typeof globalThis.fetch;
  return createSafeLoader({ fetch, checkHost: () => Promise.resolve(), userAgent: "Kopje/test" });
}

describe("a status fetch's 404 and 410", () => {
  it.each([404, 410] as const)("answers %i as gone, with the URL that answered", async (status) => {
    const fetched = await fetchRemoteStatus(STATUS, loaderOf({ [STATUS]: () => new Response(null, { status }) }));
    expect(fetched).toEqual({ kind: "gone", status, url: STATUS });
    expect(goneAt(fetched, STATUS, status)).toBe(true);
    expect(goneAt(fetched, `${STATUS}#fragment`, status)).toBe(true);
    expect(goneAt(fetched, STATUS, status === 404 ? 410 : 404)).toBe(false);
  });

  it("tells a 404 after a same-origin redirect from the status's own", async () => {
    const fetched = await fetchRemoteStatus(
      STATUS,
      loaderOf({ [STATUS]: () => new Response(null, { status: 302, headers: { location: MOVED } }) }),
    );
    expect(fetched).toEqual({ kind: "gone", status: 404, url: MOVED });
    expect(goneAt(fetched, STATUS, 404)).toBe(false);
    expect(goneAt(fetched, MOVED, 404)).toBe(true);
  });

  it("keeps other failures as they were: a 5xx may pass, a 403 is unusable", async () => {
    const answer = (status: number) =>
      fetchRemoteStatus(STATUS, loaderOf({ [STATUS]: () => new Response(null, { status }) }));
    expect(await answer(503)).toEqual({ kind: "transient" });
    expect(await answer(403)).toEqual({ kind: "unusable" });
    expect(goneAt(await answer(403), STATUS, 404)).toBe(false);
  });
});
