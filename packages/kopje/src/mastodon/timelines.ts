import type { Page } from "../domain/accounts";
import {
  type ApiContext,
  type ApiHandler,
  authorized,
  optionalCredential,
  present,
  storeCall,
  userCredential,
  withParams,
} from "./context";
import { recordNotFound } from "./errors";
import { feedPageQuery, pageQuery, pageResponse } from "./pagination";
import { type Params, parseBoolean } from "./params";

// Timelines: home, a list's, public, hashtag, link, an account's statuses, bookmarks and favourites. Status
// lists default to 20 and allow up to 40, as Mastodon's; a limit of 0 answers the first five (Timelines::*Controller)
// with no statuses and no Link (feedPageQuery).

const STATUS_LIMIT = 20;
const MAX_STATUS_LIMIT = 40;
// Mastodon reads at most 4 extra tags each for any[], all[] and none[].
const MAX_EXTRA_TAGS = 4;

export const home: ApiHandler = withParams(async (c, deps, p) => {
  const page = feedPageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const credential = userCredential(c, deps);
  const result = await storeCall(c, deps, (s, b) => s.homeTimeline(b, { credential, page, present: present(c) }));
  return pageResponse(c, authorized(result), page.limit);
});

// A list that is not the viewer's is not found (Timelines::ListController#set_list).
export const listTimeline: ApiHandler = withParams(async (c, deps, p) => {
  const page = feedPageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "", page, present: present(c) };
  const result = authorized(await storeCall(c, deps, (s, b) => s.listTimeline(b, input)));
  if (result === null) {
    return recordNotFound();
  }
  return pageResponse(c, result, page.limit);
});

export const publicTimeline: ApiHandler = withParams(async (c, deps, p) => {
  const page = feedPageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const credential = optionalCredential(c, deps);
  const result = await storeCall(c, deps, (s, b) =>
    s.publicTimeline(b, {
      credential,
      now: deps.now(),
      page,
      local: parseBoolean(p.get("local")) ?? false,
      remote: parseBoolean(p.get("remote")) ?? false,
      onlyMedia: parseBoolean(p.get("only_media")) ?? false,
      present: present(c),
    }),
  );
  return pageResponse(c, authorized(result), page.limit);
});

export const tagTimeline: ApiHandler = withParams(async (c, deps, p) => {
  const page = feedPageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const tags = (name: string) =>
    p
      .getAll(name)
      .filter((tag) => tag !== "")
      .slice(0, MAX_EXTRA_TAGS);
  const credential = optionalCredential(c, deps);
  const result = await storeCall(c, deps, (s, b) =>
    s.tagTimeline(b, {
      credential,
      now: deps.now(),
      page,
      tag: c.req.param("hashtag") ?? "",
      any: tags("any"),
      all: tags("all"),
      none: tags("none"),
      local: parseBoolean(p.get("local")) ?? false,
      remote: parseBoolean(p.get("remote")) ?? false,
      onlyMedia: parseBoolean(p.get("only_media")) ?? false,
      present: present(c),
    }),
  );
  return pageResponse(c, authorized(result), page.limit);
});

// GET /api/v1/timelines/link (Api::V1::Timelines::LinkController): a link that has no timeline now, or trends off, is
// not found (MD-5).
export const linkTimeline: ApiHandler = withParams(async (c, deps, p) => {
  const page = feedPageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const credential = optionalCredential(c, deps);
  const url = p.get("url") ?? null;
  const result = authorized(
    await storeCall(c, deps, (s, b) =>
      s.linkTimeline(b, { credential, now: deps.now(), url, page, present: present(c) }),
    ),
  );
  if (result === null) {
    return recordNotFound();
  }
  linkTimelineLinks(c, p, result);
  return c.json(result.items);
});

// The Link header of a link timeline page (Api::V1::Timelines::BaseController#insert_pagination_headers): next at
// max_id its oldest status and prev at min_id its newest, on every page that shows a status, keeping only `url` and
// `limit` as sent (PERMITTED_PARAMS). A page cut at its window or its bytes links on from where it stopped, whatever
// it shows (Page.cut); an empty page that was not cut has neither end.
function linkTimelineLinks(c: ApiContext, p: Params, page: Page<unknown>): void {
  const at = (name: "max_id" | "min_id", id: string) => {
    const target = new URL("/api/v1/timelines/link", c.req.url);
    for (const key of ["url", "limit"]) {
      const value = p.get(key);
      if (value !== undefined) {
        target.searchParams.set(key, value);
      }
    }
    target.searchParams.set(name, id);
    return target.toString();
  };
  const links = [
    ...(page.oldest === null ? [] : [`<${at("max_id", page.oldest)}>; rel="next"`]),
    ...(page.newest === null ? [] : [`<${at("min_id", page.newest)}>; rel="prev"`]),
  ];
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}

export const accountStatuses: ApiHandler = withParams(async (c, deps, p) => {
  const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
  const tagged = p.get("tagged");
  const credential = optionalCredential(c, deps);
  const result = authorized(
    await storeCall(c, deps, (s, b) =>
      s.accountStatuses(b, {
        credential,
        now: deps.now(),
        account: c.req.param("id") ?? "",
        page,
        onlyMedia: parseBoolean(p.get("only_media")) ?? false,
        excludeReplies: parseBoolean(p.get("exclude_replies")) ?? false,
        excludeReblogs: parseBoolean(p.get("exclude_reblogs")) ?? false,
        excludeDirect: parseBoolean(p.get("exclude_direct")) ?? false,
        pinned: parseBoolean(p.get("pinned")) ?? false,
        tagged: tagged === undefined || tagged === "" ? null : tagged,
        present: present(c),
      }),
    ),
  );
  if (result === null) {
    return recordNotFound();
  }
  return pageResponse(c, result, page.limit);
});

function edgeList(rpc: "bookmarksList" | "favouritesList"): ApiHandler {
  return withParams(async (c, deps, p) => {
    const page = pageQuery(p, STATUS_LIMIT, MAX_STATUS_LIMIT);
    const credential = userCredential(c, deps);
    const result = await storeCall(c, deps, (s, b) => s[rpc](b, { credential, page, present: present(c) }));
    return pageResponse(c, authorized(result), page.limit);
  });
}

export const bookmarks = edgeList("bookmarksList");
export const favourites = edgeList("favouritesList");
