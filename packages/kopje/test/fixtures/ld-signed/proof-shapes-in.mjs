// The input of readings.rb for proof-shapes.json: every proof shape's body, and Fedify's preloaded copy of each context
// the bodies name. Run as proof-shapes.mjs says.

import { preloadedContexts } from "@fedify/fedify";

import { PROOF_SHAPE_CONTEXTS, proofShapeBody, proofShapes } from "./proof-shapes.mjs";

const urls = [...new Set(Object.values(PROOF_SHAPE_CONTEXTS).flat())];
const contexts = Object.fromEntries(urls.map((url) => [url, preloadedContexts[url]]));
console.log(JSON.stringify({ contexts, bodies: proofShapes().map(proofShapeBody) }));
