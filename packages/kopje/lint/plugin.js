// Kopje's oxlint JS plugin (the root .oxlintrc.json `jsPlugins`), whose overrides turn each rule on where it applies;
// test-node/lint-config.test.ts pins that wiring.
import { fedifyUsage } from "./fedify-usage.js";
import { layering } from "./layering.js";
import { logEvents } from "./log-events.js";
import { signingKeys } from "./signing-keys.js";
import { webStrings } from "./web-strings.js";

export default {
  meta: { name: "kopje" },
  rules: {
    "fedify-usage": fedifyUsage,
    layering,
    "log-events": logEvents,
    "signing-keys": signingKeys,
    "web-strings": webStrings,
  },
};
