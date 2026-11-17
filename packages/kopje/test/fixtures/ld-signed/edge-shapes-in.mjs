// The input of readings.rb for edge-shapes.json: every edge shape's body, and Fedify's preloaded copy of each context
// the bodies name. Run as edge-shapes.mjs says.

import { preloadedContexts } from "@fedify/fedify";

import { edgeShapes } from "./edge-shapes.mjs";
import { PROOF_SHAPE_CONTEXTS } from "./proof-shapes.mjs";

const urls = [...new Set(Object.values(PROOF_SHAPE_CONTEXTS).flat())];
const contexts = Object.fromEntries(urls.map((url) => [url, preloadedContexts[url]]));
console.log(JSON.stringify({ contexts, bodies: edgeShapes().map((shape) => shape.body) }));
