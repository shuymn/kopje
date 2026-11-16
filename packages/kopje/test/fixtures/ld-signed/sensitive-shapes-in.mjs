// The input of readings.rb for sensitive-shapes.json: every sensitive shape's body, and Fedify's preloaded copy of each
// context the bodies name. Run as sensitive-shapes.mjs says.

import { preloadedContexts } from "@fedify/fedify";

import { sensitiveShapeBody, sensitiveShapes } from "./sensitive-shapes.mjs";

const urls = ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"];
const contexts = Object.fromEntries(urls.map((url) => [url, preloadedContexts[url]]));
console.log(JSON.stringify({ contexts, bodies: sensitiveShapes().map(sensitiveShapeBody) }));
