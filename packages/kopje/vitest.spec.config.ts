import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The checks of the TLA+ specifications spec/collection-consent/ and spec/media-upload/ under tla-ts (about 7 and 16
// minutes, each split over files that CI's test shards share: test-node/collection-consent-spec/checks.ts,
// test-node/media-upload-spec/checks.ts), apart from the Node suite so that CI runs them only for a change they read
// (scripts/test-affected.sh, kopje_spec). The drift check of the code the
// specification describes (test-node/collection-consent-coverage.test.ts) stays in the Node suite, which every Kopje
// change runs.
export default defineConfig({
  test: {
    name: "kopje-spec",
    environment: "node",
    include: [
      fileURLToPath(new URL("./test-node/collection-consent-spec/*.test.ts", import.meta.url)),
      fileURLToPath(new URL("./test-node/media-upload-spec/*.test.ts", import.meta.url)),
    ],
    testTimeout: 20_000,
  },
});
