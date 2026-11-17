import type { Page, PageQuery } from "../domain/accounts";
import { rubyToI } from "../platform/ruby-to-i";
import type { ApiContext } from "./context";
import { limitParam, type Params } from "./params";

// Keyset pagination for every list: max_id, since_id and min_id cursors, and a Link header with next (older) and
// prev (newer) pages, as Mastodon sends them.

const CURSOR = /^\d{1,19}$/;

// `limit` as limit_param reads it (Api::BaseController#limit_param: `defaultLimit` when absent, else the absolute value
// of its to_i, at most `maxLimit`), and a limit of 0 as 1, where Mastodon answers 500 (docs/mastodon-deviations.md,
// "Request parameters").
export function pageQuery(params: Params, defaultLimit = 40, maxLimit = 80): PageQuery {
  const limit = params.integer("limit");
  return {
    maxId: cursor(params.get("max_id")),
    sinceId: cursor(params.get("since_id")),
    minId: cursor(params.get("min_id")),
    limit: limit === undefined ? defaultLimit : Math.min(Math.max(Math.abs(rubyToI(limit)), 1), maxLimit),
  };
}

// pageQuery with a limit of 0 kept, for the lists Mastodon answers with an empty page and no Link for it: the timelines
// (Timelines::BaseController skips the headers of an empty page) and the notifications (v1 and v2, whose next_path and
// prev_path are guarded by empty?).
export function feedPageQuery(params: Params, defaultLimit = 40, maxLimit = 80): PageQuery {
  return { ...pageQuery(params, defaultLimit, maxLimit), limit: limitParam(params, defaultLimit, maxLimit) };
}

function cursor(value: string | undefined): string | undefined {
  return value !== undefined && CURSOR.test(value) ? value : undefined;
}

// next is offered when the page is full and has an oldest end; prev whenever it has a newest end. Each stands on its
// own: an empty page cut at its window may have only the end it moves on from (a grouped walk's).
export function linkHeader(
  requestUrl: string,
  page: { newest: string | null; oldest: string | null; count: number },
  limit: number,
): string | undefined {
  const links: string[] = [];
  if (page.oldest !== null && page.count >= limit) {
    links.push(`<${pageUrl(requestUrl, "max_id", page.oldest)}>; rel="next"`);
  }
  if (page.newest !== null) {
    links.push(`<${pageUrl(requestUrl, "min_id", page.newest)}>; rel="prev"`);
  }
  return links.length === 0 ? undefined : links.join(", ");
}

function pageUrl(requestUrl: string, name: "max_id" | "min_id", value: string): string {
  const url = new URL(requestUrl);
  for (const key of ["max_id", "min_id", "since_id"]) {
    url.searchParams.delete(key);
  }
  url.searchParams.set(name, value);
  return url.toString();
}

// A page as a list response: its items, and the Link header to the pages around it. `count` is what the page read
// toward its limit: its items, the candidates of a window the rule filtered (the quotes list), or the limit when the
// read stopped at its window (Page.cut).
export function pageResponse<T>(
  c: ApiContext,
  page: Page<T>,
  limit: number,
  count = page.cut === true ? limit : page.items.length,
): Response {
  const link = linkHeader(c.req.url, { ...page, count }, limit);
  if (link !== undefined) {
    c.header("Link", link);
  }
  return c.json(page.items as object);
}

// An answer of every item at once (limit=0), sent without Link headers as Mastodon sends it; one Kopje cut at its byte
// bound (Page.cut) links next to the rest with max_id at its oldest item, which the same limit=0 request continues
// from.
export function unlimitedResponse<T>(c: ApiContext, page: Page<T>): Response {
  if (page.cut === true && page.oldest !== null) {
    c.header("Link", `<${pageUrl(c.req.url, "max_id", page.oldest)}>; rel="next"`);
  }
  return c.json(page.items as object);
}
