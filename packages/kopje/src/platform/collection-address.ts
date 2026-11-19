import { getPath } from "hono/utils/url";

import { ROUTE_USERNAME } from "./identity-bounds";
import { railsFormat } from "./rails-format";
import { railsFormatParam } from "./rails-format-param";

// A local collection's two addresses, as its routes read a request's URL (#1589's D1, D3), the one parser of them: the
// routes take the collection they serve from it, and a lookup by URL (domain/collections.ts namedCollection) the
// collection a URL names, so a URL on the instance's domain names a local collection exactly when its GET serves it.
// A fragment is never part of a request, and neither reads it.

// The page, /collections/:id (app/public-pages.tsx): matched as the router matches it, on the path Hono decodes
// (getPath: decodeURI, so `%33` is a 3), an id of 1 to 19 digits as the path spells it, which the page reads exactly
// (a shorter id names no stored one); the query is not read.
const PAGE_PATH = /^\/collections\/([0-9]{1,19})$/;

export function collectionPageId(url: URL): string | null {
  return PAGE_PATH.exec(getPath(new Request(url)))?.[1] ?? null;
}

// The FeaturedCollection, /ap/users/:username/collections/:id(.:format) (federation/routes.ts): on the raw path,
// which alone Fedify serves (a percent-encoded spelling Hono decodes is Fedify's 404), its owner's username as the
// route takes it (ROUTE_USERNAME), its id's 18 digits, and Mastodon's `(.:format)`, an extension of anything but `/`,
// `.` and `?` (percent-decoded by railsFormatParam).
const DOCUMENT_PATH = new RegExp(`^/ap/users/(${ROUTE_USERNAME})/collections/(\\d{18})(?:\\.([^/.?]+))?$`);

export type CollectionDocumentAddress = { username: string; id: string; extension: string | undefined };

export function collectionDocumentAddress(url: URL): CollectionDocumentAddress | null {
  const match = DOCUMENT_PATH.exec(url.pathname);
  return match === null ? null : { username: match[1]!, id: match[2]!, extension: match[3] };
}

// The format parameter of a request to `address` (railsFormatParam: its extension, then its query), or where Mastodon
// refuses it (400), as the route reads it.
export function collectionDocumentFormat(address: CollectionDocumentAddress, url: URL) {
  return railsFormatParam(address.extension, url.search.slice(1));
}

// The collection a URL's GET serves on the instance's domain, whatever the request's headers: its page, or its
// FeaturedCollection when the extension and the query are not refused and set no format the route answers 406 to
// (with none set, the Accept picks the page or the document).
export type CollectionAddress = { kind: "page"; id: string } | ({ kind: "document" } & CollectionDocumentAddress);

export function servedCollectionAddress(url: URL): CollectionAddress | null {
  const page = collectionPageId(url);
  if (page !== null) {
    return { kind: "page", id: page };
  }
  const document = collectionDocumentAddress(url);
  if (document === null) {
    return null;
  }
  const param = collectionDocumentFormat(document, url);
  if (param.refused !== false) {
    return null;
  }
  const negotiated =
    param.format === undefined
      ? "html"
      : railsFormat({ accept: undefined, requestedWith: undefined, contentType: undefined, format: param.format });
  return negotiated === "html" || negotiated === "json" ? { kind: "document", ...document } : null;
}
