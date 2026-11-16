import type { DocumentLoader } from "@fedify/fedify";
import jsonld from "jsonld/dist/jsonld.esm.js";

import { withinJsonBounds } from "../platform/json-bounds";
import { isObject } from "./json-shapes";
import { MASTODON_FULL_CONTEXT } from "./mastodon-context";

// An activity as Mastodon 4.7 reads it (ActivityPub::ProcessActivityService#call, process_activity_service.rb:23-38).
// One that carries a Linked Data signature (a `signature` object, whether it verifies or not) is read as its compaction
// under full_context (JsonLdHelper#compact: the activity without its signature, compacted, the signature put back),
// unless Mastodon's JSON-LD limits refuse the activity before or its compaction after (withinLdLimits), or the
// compaction fails (a context that does not load included); then, as any other activity, it is read as received.
// Kopje compacts with jsonld.js, Mastodon with Ruby's JSON::LD. The activity's contexts load through `contextLoader`
// (the request's cache and budget, RES-6; full_context's are preloaded): a context that fails to load fails the parse
// that follows too, which tells whether that is transient (remote-actor.ts readActor). A compaction past the JSON
// bounds (RES-2) is read as received too. Kopje reads only an Update's embedded actor this way (remote-actor.ts
// readEmbeddedActor), every other activity as received.
export async function mastodonReading(
  activity: Record<string, unknown>,
  contextLoader: DocumentLoader,
): Promise<Record<string, unknown>> {
  const { signature, ...unsigned } = activity;
  if (!isObject(signature) || !withinLdLimits(activity)) {
    return activity;
  }
  let compacted: Record<string, unknown>;
  try {
    compacted = await jsonld.compact(unsigned, MASTODON_FULL_CONTEXT, { documentLoader: contextLoader });
  } catch {
    return activity;
  }
  compacted.signature = signature;
  return withinLdLimits(compacted) && withinJsonBounds(compacted) ? compacted : activity;
}

const UNSUPPORTED_JSONLD_KEYWORDS: ReadonlySet<string> = new Set(["@graph", "@included", "@reverse"]);

// Mastodon's JSON-LD limits (JsonLdHelper#check_jsonld_limits!, json_ld_helper.rb:132-153): no key is one of
// UNSUPPORTED_JSONLD_KEYWORDS, and the values, counted as it counts them, stay within its budget of 1,000.
function withinLdLimits(json: unknown): boolean {
  return budgetLeft(json, 1000) !== null;
}

// check_jsonld_limits! step by step: the budget left after `json`, or null where Mastodon raises.
function budgetLeft(json: unknown, budget: number): number | null {
  let left: number | null = budget - 1;
  if (isObject(json)) {
    for (const [key, value] of Object.entries(json)) {
      if (UNSUPPORTED_JSONLD_KEYWORDS.has(key) || left < 1) {
        return null;
      }
      left = budgetLeft(value, left);
      if (left === null) {
        return null;
      }
    }
  } else if (Array.isArray(json)) {
    for (const value of json) {
      if (left < 1) {
        return null;
      }
      left = budgetLeft(value, left);
      if (left === null) {
        return null;
      }
    }
  }
  return left < 0 ? null : left;
}
