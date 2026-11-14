import { defineConfig } from "vitest/config";

// Kopje's code, for coverage. Vitest matches coverage globs from the workspace root in a run of every project and from
// the project's root (packages/kopje) in a run of one (`--project`), and ignores absolute globs, so each is given
// from both; the root has no src/ or cli/ of its own.
const covered = ["src/**/*.{ts,tsx}", "cli/**/*.js"];

export default defineConfig({
  test: {
    projects: [
      "packages/kopje/vitest.config.ts",
      "packages/kopje/vitest.streaming.config.ts",
      "packages/kopje/vitest.main-runtime.config.ts",
      "packages/kopje/vitest.node.config.ts",
    ],
    // `--coverage`, run by hand to find code no test reaches, writes a summary and coverage/index.html. CI does not
    // collect it. V8 coverage reaches workerd through @cloudflare/vitest-plugin's inspector session and counts blocks
    // in every module the isolate runs, which slows a tight JavaScript loop many times over (a string's JSON bytes,
    // char by char, about 30 times): the globs choose what is reported, not what is slowed. Every file they match is
    // reported, one no test loads as uncovered.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: [...covered, ...covered.map((glob) => `packages/kopje/${glob}`)],
      exclude: ["**/*.d.ts"],
    },
  },
});
