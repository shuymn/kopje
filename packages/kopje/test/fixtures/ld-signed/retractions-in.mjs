// The input of retractions.rb for retractions.json: every retraction entry, and Fedify's preloaded copy of each context
// the entries or Mastodon's full_context name. Run as retractions.mjs says.

import { preloadedContexts } from "@fedify/fedify";

import { retractionEntries } from "./retractions.mjs";

const urls = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  "https://www.w3.org/ns/cid/v1",
  "https://purl.archive.org/socialweb/webfinger",
];
const contexts = Object.fromEntries(urls.map((url) => [url, preloadedContexts[url]]));
console.log(JSON.stringify({ contexts, entries: retractionEntries() }));
