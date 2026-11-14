import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The annual report cost benchmark, apart from the migration benchmark (vitest.bench.config.ts) so it never runs with
// it or counts toward its gate; usage: test/bench/annual-report.bench.ts.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) } })],
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje-annual-report-bench",
    include: [fileURLToPath(new URL("./test/bench/annual-report.bench.ts", import.meta.url))],
    testTimeout: 3_600_000,
    fsModuleCache: false,
    provide: {
      annualReportBenchScale: process.env.KOPJE_BENCH_SCALE ?? "",
      // The machine's load when the run starts (1, 5 and 15 minutes), printed with the figures.
      annualReportBenchLoad: loadavg()
        .map((load) => load.toFixed(2))
        .join(" "),
    },
  },
});
