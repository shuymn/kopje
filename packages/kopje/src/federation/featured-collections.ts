import {
  type FeaturedCollectionInput,
  type FeaturedItemInput,
  MAX_REMOTE_ITEMS,
} from "../domain/remote-featured-collections";
import { railsBoolean } from "../platform/rails-boolean";
import { COLLECTION_TOTAL_ITEMS_MAX } from "../platform/stored-bounds";
import { isObject } from "./json-shapes";
import { htmlLink } from "./remote-actor";
import { idOf } from "./remote-status";

// An embedded FEP-7aa9 FeaturedCollection or FeaturedItem as Mastodon 4.7.5's ActivityPub::ProcessFeaturedCollectionService
// and ProcessFeaturedItemService read one, for the Store to apply (domain/remote-featured-collections.ts, which checks
// every rule again): the collection read from a sync's featuredCollections page, an inbound Add or Update, or a search
// resolve. Nothing is fetched here.

// ProcessFeaturedCollectionService#url: url_to_href(url, 'text/html') when it is an http(s) URL, else none (the
// collection's id stands for it).
function urlOf(value: unknown): string | null {
  const list = isObject(value) ? [value] : value;
  const chosen = Array.isArray(list) ? (typeof list[0] === "string" ? list[0] : htmlLink(list)) : list;
  const href = isObject(chosen) ? chosen.href : chosen;
  return typeof href === "string" && (href.startsWith("http://") || href.startsWith("https://")) ? href : null;
}

// The first value of an object's members, and its first key, as Ruby's Hash#values.first and #keys.first.
function firstEntry(value: unknown): [string, unknown] | undefined {
  return isObject(value) ? Object.entries(value)[0] : undefined;
}

// original_number_of_items: totalItems, 0 when absent, null or false (`|| 0`), null when it is not an integer the
// column holds, which refuses the collection (Collection's numericality validation refuses one that is no number).
function totalItemsOf(value: unknown): number | null {
  if (value === undefined || value === null || value === false) {
    return 0;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COLLECTION_TOTAL_ITEMS_MAX
    ? value
    : null;
}

// An embedded FeaturedItem: its id, value_or_id of its featuredObject and featureAuthorization, and its published
// when a string (the Store decides whether it is a time); null for an item given only as a URI
// (ProcessFeaturedItemService would fetch it) or without a string id and object.
export function featuredItemOf(value: unknown): FeaturedItemInput | null {
  if (!isObject(value) || typeof value.id !== "string") {
    return null;
  }
  const object = idOf(value.featuredObject);
  return object === null
    ? null
    : {
        id: value.id,
        object,
        authorization: idOf(value.featureAuthorization),
        published: typeof value.published === "string" ? value.published : null,
      };
}

// An embedded FeaturedCollection, or null when it has no string id (one given only as a URI is not read). Its type is
// not compared, as ProcessFeaturedCollectionService does not compare it. Its items: the first MAX_REMOTE_ITEMS of
// orderedItems (`@json['orderedItems'] || []`), each read by featuredItemOf.
export function featuredCollectionOf(value: unknown): FeaturedCollectionInput | null {
  if (!isObject(value) || typeof value.id !== "string") {
    return null;
  }
  const summaryMap = firstEntry(value.summaryMap);
  const summary =
    typeof summaryMap?.[1] === "string" ? summaryMap[1] : typeof value.summary === "string" ? value.summary : "";
  const topic = isObject(value.topic) && typeof value.topic.name === "string" ? value.topic.name : null;
  const ordered = Array.isArray(value.orderedItems) ? value.orderedItems : [];
  return {
    id: value.id,
    attributedTo: typeof value.attributedTo === "string" ? value.attributedTo : null,
    name: typeof value.name === "string" ? value.name : null,
    summary,
    language: summaryMap?.[0] ?? null,
    sensitive: railsBoolean(value.sensitive),
    discoverable: railsBoolean(value.discoverable),
    totalItems: totalItemsOf(value.totalItems),
    topic,
    url: urlOf(value.url),
    items: ordered.slice(0, MAX_REMOTE_ITEMS).map(featuredItemOf),
  };
}
