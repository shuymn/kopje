import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The checks of the TLA+ specification spec/collection-consent/ under tla-ts (about 5 minutes), apart from the Node
// suite so that CI runs them only for a change they read (scripts/test-affected.sh, kopje_spec). The drift check of the
// code the specification describes (test-node/collection-consent-coverage.test.ts) stays in the Node suite, which every
// Kopje change runs.
export default defineConfig({
  test: {
    name: "kopje-spec",
    environment: "node",
    include: [fileURLToPath(new URL("./test-node/collection-consent-spec.test.ts", import.meta.url))],
    testTimeout: 20_000,
  },
});
