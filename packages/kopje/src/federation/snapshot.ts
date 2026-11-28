import { publishedDay } from "../domain/actor-row";
import type { SnapshotSource } from "../domain/snapshot";
import { errorFields } from "../platform/error-message";
import { offDomain } from "../platform/instance-host";
import { callStore, type StoreStub } from "../platform/store-client";
import { isSnapshotKey, type RescuedSnapshot, sha256, type Snapshot, snapshotKind } from "../platform/store-kernel";

// Snapshots of the always-served GETs (maintenance mode): actor documents, WebFinger and NodeInfo. A
// healthy response is saved under the key of its request; while the Store refuses (version mismatch, pending or
// diverged schema), the Worker answers the same request from the snapshot through a rescue RPC instead of 503.
// Only canonical answers of existing actors are saved (federationHandler): the actor path and the acct: and actor URI
// WebFinger queries of each local actor, plus /actor and the three NodeInfo documents. Any other handle, resource or
// query string creates no row, so the rows stay bounded by the number of local actors.

const NODEINFO_PATHS = new Set(["/.well-known/nodeinfo", "/nodeinfo/2.0", "/nodeinfo/2.1"]);
const ACTOR_PATH = /^\/ap\/users\/[^/]+$/;

// The snapshot key of a request, or null for requests that never have one.
export function snapshotKey(url: URL): string | null {
  if (url.pathname === "/.well-known/webfinger") {
    const resource = url.searchParams.get("resource");
    return resource === null ? null : `webfinger:${resource}`;
  }
  if (url.pathname === "/actor" || ACTOR_PATH.test(url.pathname) || NODEINFO_PATHS.has(url.pathname)) {
    return `path:${url.pathname}`;
  }
  return null;
}

// Actor documents are JSON-LD; a browser asking for HTML gets no snapshot (it would get the profile page).
export function acceptable(request: Request, url: URL): boolean {
  if (!isActorPath(url)) {
    return true;
  }
  return /json/i.test(request.headers.get("accept") ?? "");
}

// An unchanged document is written again at most once per interval per key; a changed one is written at once.
export const SNAPSHOT_SAVE_INTERVAL_MS = 60 * 1000;

export type SnapshotSaver = (
  store: StoreStub,
  build: string,
  key: string,
  snapshot: Snapshot,
  source: SnapshotSource,
  renderedAt: number,
) => Promise<void>;

// Remembers, per isolate, what each key last saved, so a steady document does not cost a Store write RPC on every
// GET. Changed content is not throttled: only local data changes it, and a stale snapshot would outlive a key
// rotation. The map is bounded like the keys (see federationHandler).
export function createSnapshotSaver(now: () => number): SnapshotSaver {
  const saved = new Map<string, { digest: string; at: number }>();
  return async (store, build, key, snapshot, source, renderedAt) => {
    // An oversized body still goes to the Store, which drops the kept snapshot of the key.
    if (!isSnapshotKey(key)) {
      return;
    }
    const digest = await sha256(`${snapshot.contentType}\n${snapshot.body}`);
    const last = saved.get(key);
    // A changed body is always saved (a key rotation or profile edit must reach the rescue path); an identical one
    // is re-saved at most once per interval.
    if (last !== undefined && last.digest === digest && now() - last.at < SNAPSHOT_SAVE_INTERVAL_MS) {
      return;
    }
    try {
      // Only a stored body counts as saved: a refused one (stale source, oversized) must not suppress a later save.
      if (await callStore(() => store.saveSnapshot(build, { key, ...snapshot, source, renderedAt }))) {
        saved.set(key, { digest, at: now() });
      }
    } catch (error) {
      // A refused write (readonly) keeps the previous snapshot, which is what the rescue path should serve anyway.
      console.warn({ event: "kopje.snapshot.save-failed", kind: snapshotKind(key), ...errorFields(error) });
    }
  };
}

// The rescue answer of an always-served GET, or null when there is none. Only keys of the two snapshot shapes reach
// the Store, and only stored (size-capped) bodies come back. WEB-6: a snapshot is served only on the domain it was
// rendered on; on another host the answer is the live path's (301 or 421). A row kept before snapshots recorded their
// domain is judged by the stored domain instead, read through config(), a rescue RPC that needs no matching build:
// without that domain (a failed call, none set) it is not served.
export async function rescueFromSnapshot(request: Request, store: StoreStub, build: string): Promise<Response | null> {
  const kept: { snapshot: RescuedSnapshot | null } = { snapshot: null };
  const answer = await answerFromSnapshot(request, async (key) => {
    kept.snapshot = await store.rescueSnapshot(build, key);
    return kept.snapshot;
  });
  if (answer === null || kept.snapshot === null) {
    return null;
  }
  const domain = kept.snapshot.domain ?? (await storedDomain(store, build));
  return domain === null ? null : (offDomain(request, domain) ?? answer);
}

// The instance domain as the Store's configuration holds it, or null when it has none or cannot answer.
async function storedDomain(store: StoreStub, build: string): Promise<string | null> {
  try {
    const domain: unknown = (await callStore(() => store.config(build))).values.domain;
    return typeof domain === "string" ? domain : null;
  } catch {
    return null;
  }
}

// The answer of an always-served GET from the snapshot `find` returns for its key, or null. Shared by the rescue path
// and the cutover's maintenance worker (src/maintenance-worker.ts), so both answer the same requests the same way.
export async function answerFromSnapshot(
  request: Request,
  find: (key: string) => Promise<Snapshot | null>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = snapshotKey(url);
  if (key === null || !isSnapshotKey(key) || !acceptable(request, url)) {
    return null;
  }
  let snapshot: Snapshot | null;
  try {
    snapshot = await find(key);
  } catch {
    return null;
  }
  if (snapshot === null) {
    return null;
  }
  // The headers the live answer has (app.ts): an actor document is negotiated by Accept, and every document but the
  // instance actor's is open to browsers.
  const headers: Record<string, string> = { "content-type": snapshot.contentType };
  if (isActorPath(url)) {
    headers.vary = "Accept";
  }
  if (url.pathname !== "/actor") {
    headers["access-control-allow-origin"] = "*";
  }
  const body = ACTOR_PATH.test(url.pathname) ? keptActor(snapshot, `${url.origin}${url.pathname}`) : snapshot.body;
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

const ACTIVITY_JSON = /^application\/(activity|ld)\+json\b/i;
// A top-level member `"published": "<string>"` of a JSON object, its string's escapes included.
const PUBLISHED_MEMBER = /("published"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

// The kept document of the local actor `actorId` with its `published` as the live document writes it (actor-row.ts
// publishedDay): a snapshot an earlier build kept carries the exact creation time until a healthy GET replaces it
// (#1564 D5). Only that string changes, every other byte as kept; a body that is not that actor's activity JSON, or
// whose published is not an instant or appears more than once, is served as kept.
function keptActor(snapshot: Snapshot, actorId: string): string {
  const { body } = snapshot;
  if (!ACTIVITY_JSON.test(snapshot.contentType)) {
    return body;
  }
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return body;
  }
  const { id, published } = document as { id?: unknown; published?: unknown };
  const day = typeof published === "string" ? publishedDay(published) : null;
  const members = [...body.matchAll(PUBLISHED_MEMBER)];
  const member = members.length === 1 ? members[0] : undefined;
  if (id !== actorId || day === null || day === published || member === undefined) {
    return body;
  }
  const [text, key = "", literal = ""] = member;
  if (JSON.parse(`"${literal}"`) !== published) {
    return body;
  }
  const at = member.index;
  return body.slice(0, at) + key + JSON.stringify(day) + body.slice(at + text.length);
}

function isActorPath(url: URL): boolean {
  return url.pathname === "/actor" || ACTOR_PATH.test(url.pathname);
}
