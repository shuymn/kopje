import type { CollectionFields, CollectionResult } from "../domain/collections";
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
import { fullMessage, mastodonError, recordNotFound, validationDetails, validationFailed } from "./errors";
import { linkHeader } from "./pagination";
import { limitParam, offsetParam, type Params, parseBoolean } from "./params";

// Collections (Mastodon 4.7.5's Api::V1::CollectionsController, CollectionItemsController and InCollectionsController,
// served under /api/v1 and /api/v1_alpha alike); the Store does the work (domain/collections.ts).

// CollectionsController's limits, and InCollectionsController's (limit_param(40) with 80 as every list's maximum).
const COLLECTIONS_LIMIT = 40;
const COLLECTIONS_MAX_LIMIT = 100;
const IN_COLLECTIONS_MAX_LIMIT = 80;

const NOT_ALLOWED = "This action is not allowed";

function forbidden(): Response {
  return mastodonError(403, NOT_ALLOWED);
}

// What a create or an update sends (collection_creation_params, collection_update_params): a field not sent is
// undefined; JSON null is nil, as is a boolean sent blank (Rails' boolean cast); any other string stays a string.
function collectionFields(p: Params): CollectionFields {
  const text = (name: string) => (p.sentNull(name) ? null : p.get(name));
  const flag = (name: string) => {
    const value = p.get(name);
    return value === undefined ? undefined : (parseBoolean(value) ?? null);
  };
  return {
    name: text("name"),
    description: text("description"),
    language: text("language"),
    sensitive: flag("sensitive"),
    discoverable: flag("discoverable"),
    tagName: text("tag_name"),
  };
}

// The collections routes answer a validation error nested in error (their rescue_from), the 404 and 403 as the API's
// base handlers do.
function collectionResponse(c: ApiContext, result: CollectionResult): Response {
  switch (result.status) {
    case "ok":
      return c.json({ collection: result.collection });
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return forbidden();
    case "invalid":
      return validationDetails(result.problems, "nested");
  }
}

function emptyResponse(result: "ok" | "not_found" | "forbidden"): Response {
  switch (result) {
    case "ok":
      // head 200: an empty body.
      return new Response(null, { status: 200 });
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return forbidden();
  }
}

// The Link header of an account's collections (CollectionsController#next_path, #prev_path), at the /api/v1 route
// whatever the prefix: next while the page is full, prev to max(offset - limit, 0) past the first page; `limit` only
// when sent. Kopje steps by the page's limit (docs/mastodon-deviations.md, "Collections").
function offsetLinks(c: ApiContext, p: Params, route: string, offset: number, limit: number, full: boolean): void {
  if (limit === 0) {
    return;
  }
  const url = (at: number) => {
    const target = new URL(route, c.req.url);
    if (p.get("limit") !== undefined) {
      target.searchParams.set("limit", String(limit));
    }
    target.searchParams.set("offset", String(at));
    return target.toString();
  };
  const links = [
    ...(full ? [`<${url(offset + limit)}>; rel="next"`] : []),
    ...(offset > 0 ? [`<${url(Math.max(offset - limit, 0))}>; rel="prev"`] : []),
  ];
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}

// GET /api/v1/accounts/:account_id/collections.
export const accountCollections: ApiHandler = withParams(async (c, deps, p) => {
  const limit = limitParam(p, COLLECTIONS_LIMIT, COLLECTIONS_MAX_LIMIT);
  const offset = Math.min(offsetParam(p), Number.MAX_SAFE_INTEGER);
  const input = {
    credential: optionalCredential(c, deps),
    now: deps.now(),
    account: c.req.param("id") ?? "",
    offset,
    limit,
    present: present(c),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.accountCollections(b, input)));
  if (result === null) {
    return recordNotFound();
  }
  offsetLinks(c, p, `/api/v1/accounts/${result.owner}/collections`, offset, limit, result.full);
  return c.json({ collections: result.collections });
});

// GET /api/v1/accounts/:account_id/in_collections: the viewer's own memberships (a token is optional, a user is not:
// 422 without one, after the token is judged), paged by item id from a candidate window (domain/collections.ts); the
// Link headers carry max_id and min_id at the /api/v1 route, `limit` only when sent.
export const inCollections: ApiHandler = withParams(async (c, deps, p) => {
  const limit = limitParam(p, COLLECTIONS_LIMIT, IN_COLLECTIONS_MAX_LIMIT);
  const cursor = (name: string) => {
    const value = p.get(name);
    return value !== undefined && /^\d{1,19}$/.test(value) ? value : undefined;
  };
  const input = {
    credential: optionalCredential(c, deps),
    now: deps.now(),
    account: c.req.param("id") ?? "",
    page: { maxId: cursor("max_id"), sinceId: cursor("since_id"), minId: cursor("min_id"), limit },
    offset: offsetParam(p),
    present: present(c),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.inCollections(b, input)));
  switch (result.status) {
    case "user_required":
      return authorized<Response>(result);
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return forbidden();
    case "ok": {
      const { page } = result;
      const route = new URL(`/api/v1/accounts/${input.account}/in_collections`, c.req.url);
      if (p.get("limit") !== undefined) {
        route.searchParams.set("limit", String(limit));
      }
      const count = page.cut === true ? limit : page.items.length;
      const link = limit === 0 ? undefined : linkHeader(route.toString(), { ...page, count }, limit);
      if (link !== undefined) {
        c.header("Link", link);
      }
      return c.json({ collections: page.items });
    }
  }
});

// GET /api/v1/collections/:id: the collection with its accounts.
export const showCollection: ApiHandler = async (c, deps) => {
  const input = {
    credential: optionalCredential(c, deps),
    now: deps.now(),
    id: c.req.param("id") ?? "",
    present: present(c),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.showCollection(b, input)));
  switch (result.status) {
    case "ok":
      return c.json(result.value);
    case "not_found":
      return recordNotFound();
    case "forbidden":
      return forbidden();
  }
};

// POST /api/v1/collections.
export const createCollection: ApiHandler = withParams(async (c, deps, p) => {
  const input = {
    ...collectionFields(p),
    accountIds: p.getAll("account_ids").filter((id) => id !== ""),
    credential: userCredential(c, deps),
    now: deps.now(),
    present: present(c),
  };
  return collectionResponse(c, authorized(await storeCall(c, deps, (s, b) => s.createCollection(b, input))));
});

// PATCH and PUT /api/v1/collections/:id.
export const updateCollection: ApiHandler = withParams(async (c, deps, p) => {
  const input = {
    ...collectionFields(p),
    id: c.req.param("id") ?? "",
    credential: userCredential(c, deps),
    now: deps.now(),
    present: present(c),
  };
  return collectionResponse(c, authorized(await storeCall(c, deps, (s, b) => s.updateCollection(b, input))));
});

// DELETE /api/v1/collections/:id.
export const deleteCollection: ApiHandler = async (c, deps) => {
  const input = { id: c.req.param("id") ?? "", credential: userCredential(c, deps) };
  return emptyResponse(authorized(await storeCall(c, deps, (s, b) => s.deleteCollection(b, input))));
};

// POST /api/v1/collections/:collection_id/items: a validation error is the base handler's flat message.
export const addCollectionItem: ApiHandler = withParams(async (c, deps, p) => {
  const input = {
    collection: c.req.param("id") ?? "",
    account: p.get("account_id") ?? "",
    credential: userCredential(c, deps),
    now: deps.now(),
  };
  const result = authorized(await storeCall(c, deps, (s, b) => s.addCollectionItem(b, input)));
  switch (result.status) {
    case "ok":
      return c.json({ collection_item: result.item });
    case "not_found":
      return recordNotFound();
    case "account_missing":
      return mastodonError(422, "`account_id` parameter is missing");
    case "forbidden":
      return forbidden();
    case "invalid":
      return validationFailed(result.problems.map(fullMessage));
  }
});

// DELETE /api/v1/collections/:collection_id/items/:id.
export const removeCollectionItem: ApiHandler = async (c, deps) => {
  const input = {
    collection: c.req.param("id") ?? "",
    item: c.req.param("item_id") ?? "",
    credential: userCredential(c, deps),
  };
  return emptyResponse(authorized(await storeCall(c, deps, (s, b) => s.removeCollectionItem(b, input))));
};

// POST /api/v1/collections/:collection_id/items/:id/revoke.
export const revokeCollectionItem: ApiHandler = async (c, deps) => {
  const input = {
    collection: c.req.param("id") ?? "",
    item: c.req.param("item_id") ?? "",
    credential: userCredential(c, deps),
    now: deps.now(),
  };
  return emptyResponse(authorized(await storeCall(c, deps, (s, b) => s.revokeCollectionItem(b, input))));
};
