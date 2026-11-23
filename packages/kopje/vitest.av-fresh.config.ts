import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { avFresh } from "./test-node/av-fixtures";

// The output verifier on fresh output of the image (test/av-fresh/), run only by scripts/container-smoke.sh in the CI
// container job, which makes the outputs and lists them at $AV_FRESH_LIST; apart from the workerd suites, which have
// none. On workerd, as the verifier runs in the Worker; otherwise as vitest.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        ratelimits: {
          APP_REGISTRATION_LIMIT: { namespace_id: "4201", simple: { limit: 1_000_000, period: 60 } },
          LOGIN_LIMIT: { namespace_id: "4202", simple: { limit: 1_000_000, period: 60 } },
        },
        serviceBindings: { AV_FRESH: { node: avFresh } },
      },
    }),
  ],
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje-av-fresh",
    include: [fileURLToPath(new URL("./test/av-fresh/*.test.ts", import.meta.url))],
  },
});
