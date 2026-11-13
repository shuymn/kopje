import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

// The Worker configs that deploy Kopje: the package's own and the instance template's. maintenance.wrangler.jsonc is
// not one: it is only bundled, and the Pages project that runs it keeps its own compatibility settings.
const SHIPPED = ["../wrangler.jsonc", "../../../deploy/wrangler.jsonc"];
const MAINTENANCE = "../maintenance.wrangler.jsonc";

// The reader wrangler deploys with (as scripts/check-kopje-package.mjs). Its declared types live in a package this one
// does not depend on, so the part read here is typed locally.
const readRawConfig = experimental_readRawConfig as unknown as (args: { config: string }) => {
  rawConfig: { compatibility_flags?: string[]; observability?: unknown; workers_dev?: boolean };
};

function read(path: string) {
  return readRawConfig({ config: fileURLToPath(new URL(path, import.meta.url)) }).rawConfig;
}

// The observability value of a documented `"observability": {...}` block: written as a config file in a fresh temporary
// directory, read with the reader above, and removed however the read ends.
function readBlock(block: string): unknown {
  const directory = mkdtempSync(join(tmpdir(), "kopje-observability-"));
  try {
    const path = join(directory, "wrangler.jsonc");
    writeFileSync(path, `{\n${block}\n}\n`);
    return readRawConfig({ config: path }).rawConfig.observability;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// NET-1: every global fetch() is strictly public, whatever host it names.
const REQUIRED_FLAGS = ["nodejs_compat", "global_fetch_strictly_public"];

// DATA-5 (platform telemetry), docs/observability.md: Kopje's events on; invocation logs (request headers) and traces
// off unless an instance opts in; query-string removal requested for either (redact_query_string).
const EXPECTED_OBSERVABILITY = {
  enabled: true,
  redact_query_string: true,
  logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
  traces: { enabled: false, head_sampling_rate: 1 },
};

describe("shipped Kopje Worker configs", () => {
  it.each(SHIPPED)("%s sets the required compatibility flags", (path) => {
    expect(read(path).compatibility_flags).toEqual(expect.arrayContaining(REQUIRED_FLAGS));
  });

  it.each(SHIPPED)("%s pins the observability block", (path) => {
    expect(read(path).observability).toEqual(EXPECTED_OBSERVABILITY);
  });

  // The block docs/observability.md shows as the template's is the template's: its one code block that sets
  // "observability", read by the same reader as a config file of its own.
  it("shows the template's observability block in docs/observability.md", () => {
    const doc = readFileSync(new URL("../docs/observability.md", import.meta.url), "utf8");
    const blocks = [...doc.matchAll(/^```jsonc\n("observability": [\s\S]*?)\n```$/gm)].map((m) => m[1] ?? "");
    expect(blocks).toHaveLength(1);
    expect(readBlock(blocks[0] ?? "")).toEqual(read("../../../deploy/wrangler.jsonc").observability);
  });

  it("reads a documented block with comments and trailing commas", () => {
    const block = '"observability": {\n  // on\n  "enabled": true, /* kept */\n  "logs": { "enabled": true, },\n}';
    expect(readBlock(block)).toEqual({ enabled: true, logs: { enabled: true } });
  });

  // WEB-6: an instance answers only on its domain, so the template leaves the workers.dev address off.
  it("turns the workers.dev address off in the instance template", () => {
    expect(read("../../../deploy/wrangler.jsonc").workers_dev).toBe(false);
  });

  // Never deployed as a Worker, so a block there would do nothing.
  it("leaves observability out of the maintenance worker config", () => {
    expect(read(MAINTENANCE).observability).toBeUndefined();
  });
});
