import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";

// The Worker configs that deploy Kopje: the package's own and the instance template's. maintenance.wrangler.jsonc is
// not one: it is only bundled, and the Pages project that runs it keeps its own compatibility settings.
const SHIPPED = ["../wrangler.jsonc", "../../../deploy/wrangler.jsonc"];
const MAINTENANCE = "../maintenance.wrangler.jsonc";

// The reader wrangler deploys with (as scripts/check-kopje-package.mjs). Its declared types live in a package this one
// does not depend on, so the part read here is typed locally.
const readRawConfig = experimental_readRawConfig as unknown as (args: { config: string }) => {
  rawConfig: {
    compatibility_flags?: string[];
    limits?: unknown;
    observability?: unknown;
    workers_dev?: boolean;
    containers?: unknown;
    durable_objects?: { bindings: { name: string; class_name: string }[] };
    migrations?: unknown[];
  };
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

// A documented block's parsed value, read as a config file of its own.
function readBlockAs(block: string): { containers?: unknown } {
  const directory = mkdtempSync(join(tmpdir(), "kopje-block-"));
  try {
    const path = join(directory, "wrangler.jsonc");
    writeFileSync(path, `{\n${block}\n}\n`);
    return readRawConfig({ config: path }).rawConfig;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The configuration wrangler deploys with: normalized and validated, throwing on what wrangler refuses.
const readConfig = unstable_readConfig as unknown as (args: { config: string }) => {
  containers?: unknown[];
  durable_objects: { bindings: { name: string }[] };
};
function validate(config: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "kopje-config-"));
  try {
    const path = join(directory, "wrangler.json");
    writeFileSync(path, JSON.stringify(config));
    return readConfig({ config: path });
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

// The Store applies and verifies a release's migrations in one invocation (docs/upgrade.md); the migration bench's
// UPGRADE_BUDGET_MS (test/bench/migration-cost.ts) is two thirds of this CPU limit.
const EXPECTED_LIMITS = { cpu_ms: 60_000 };

describe("shipped Kopje Worker configs", () => {
  it.each(SHIPPED)("%s sets the required compatibility flags", (path) => {
    expect(read(path).compatibility_flags).toEqual(expect.arrayContaining(REQUIRED_FLAGS));
  });

  it.each(SHIPPED)("%s raises the CPU limit to 60 s", (path) => {
    expect(read(path).limits).toEqual(EXPECTED_LIMITS);
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

  // G1 (design #1828): the media processor is opt-in. Neither shipped config has a container or its binding.
  it.each(SHIPPED)("%s binds no media processor", (path) => {
    const config = read(path);
    expect(config.containers).toBeUndefined();
    expect(config.durable_objects?.bindings.map((b) => b.class_name)).toEqual(["Store"]);
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Store"] }]);
  });

  // The template's commented "Video and audio" block, uncommented and added as it says, is a configuration wrangler
  // accepts: the Durable Object-managed container (which takes no max_instances), its binding and its migration.
  it("documents a media processor block that wrangler validates", () => {
    const template = readFileSync(new URL("../../../deploy/wrangler.jsonc", import.meta.url), "utf8");
    const lines = template.split("\n");
    const first = lines.indexOf('  // "containers": [');
    const last = lines.indexOf("  // ],", first);
    expect(first).toBeGreaterThan(0);
    expect(last).toBeGreaterThan(first);
    const containers = readBlockAs(
      lines
        .slice(first, last + 1)
        .map((line) => line.replace(/^ {2}\/\/ ?/, ""))
        .join("\n"),
    ).containers;
    const fragment = (label: string) => {
      const line = lines.find((l) => l.startsWith(`  // ${label}:`)) ?? "";
      return JSON.parse(line.slice(line.indexOf("{"))) as unknown;
    };
    const binding = fragment("binding");
    const migration = fragment("migration");
    expect(containers).toEqual([
      {
        class_name: "MediaProcessor",
        scheduling_policy: "durable_object",
        images: {
          media: {
            dockerfile: "./node_modules/kopje/container/Dockerfile",
            build_context: "./node_modules/kopje/container",
          },
        },
      },
    ]);
    expect(binding).toEqual({ name: "MEDIA_PROCESSOR", class_name: "MediaProcessor" });
    const base = read("../../../deploy/wrangler.jsonc");
    const enabled = {
      ...base,
      containers,
      durable_objects: { bindings: [...(base.durable_objects?.bindings ?? []), binding] },
      migrations: [...(base.migrations ?? []), migration],
    };
    const validated = validate(enabled);
    expect(validated.containers).toEqual([expect.objectContaining({ class_name: "MediaProcessor" })]);
    expect(validated.durable_objects.bindings.map((b) => b.name)).toEqual(["STORE", "MEDIA_PROCESSOR"]);
    // The validation ran: the same block with max_instances is refused under the durable_object policy.
    const [container] = containers as Record<string, unknown>[];
    expect(() => validate({ ...enabled, containers: [{ ...container, max_instances: 2 }] })).toThrow(
      /Unsupported fields for Durable Object-managed Containers in containers: "max_instances"/,
    );
  });

  // Never deployed as a Worker, so a block there would do nothing.
  it("leaves observability out of the maintenance worker config", () => {
    expect(read(MAINTENANCE).observability).toBeUndefined();
  });
});
