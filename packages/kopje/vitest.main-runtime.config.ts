import { fileURLToPath } from "node:url";

import { cloudflareTest } from "vitest-plugin-sqlite-3534";
import { defineConfig } from "vitest/config";

import { sqlDepthService } from "./test-node/sql-depth";

// The suites that compare a rewritten statement with main's own (test/main-runtime), on the runtime whose SQLite
// (3.53.4, workerd 1.20261023.1 through the aliased @cloudflare/vitest-plugin 1.4.11 in pnpm-workspace.yaml) prepares
// main's statements: from SQLite 3.54.1 they resolve a CTE after more cursors than the Store allows
// (docs/engineering.md "Queries"), so main's side of each pair (test/plan-witness.ts) runs here only. The statements
// the code under test runs through Db are guarded and audited as in vitest.config.ts. wrangler.jsonc's
// compatibility_date must stay within what this workerd accepts. Otherwise as vitest.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: { serviceBindings: { SQL_DEPTH: sqlDepthService } },
    }),
  ],
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje-main-runtime",
    globalSetup: [fileURLToPath(new URL("./test-node/plan-audit-run.ts", import.meta.url))],
    include: [fileURLToPath(new URL("./test/main-runtime/**/*.test.ts", import.meta.url))],
    setupFiles: [
      fileURLToPath(new URL("./test/sql-depth-setup.ts", import.meta.url)),
      fileURLToPath(new URL("./test/storage-setup.ts", import.meta.url)),
    ],
    isolate: false,
    testTimeout: 20_000,
    fsModuleCache: false,
    provide: { fcSeed: process.env.FC_SEED ?? "" },
  },
});
