import { readFileSync } from "node:fs";

import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { parse, type Source, walk } from "./source-scan.js";

// The operator documents name what an operator sets: every variable of the configuration schema
// (src/platform/config.ts) that is not a binding, and every backup setting (src/platform/backup-config.ts). Their
// readers do not have the code, so a setting no document names cannot be found.

// The documents written for operators, relative to the package.
const OPERATOR_DOCS = [
  "README.md",
  "../../deploy/README.md",
  "docs/setup.md",
  "docs/upgrade.md",
  "docs/backup.md",
  "docs/observability.md",
  "docs/cutover-runbook.md",
  "docs/cutover.md",
];

function read(path: string): Source {
  return { path, text: readFileSync(new URL(`../${path}`, import.meta.url), "utf8") };
}

const isCall = (node: Node, name: string): node is Node & { type: "CallExpression" } =>
  node.type === "CallExpression" &&
  ((node.callee.type === "Identifier" && node.callee.name === name) ||
    (node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === name));

// The keys of the object `configSchema` is built from (`v.object({...})`), except those whose value is `binding(...)`.
function schemaSettings(source: Source): string[] {
  const found: string[] = [];
  walk(parse(source).program, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.id.name !== "configSchema" ||
      node.init === null ||
      !isCall(node.init, "object")
    ) {
      return;
    }
    const shape = node.init.arguments[0];
    if (shape?.type !== "ObjectExpression") {
      throw new Error("configSchema is not v.object({...})");
    }
    for (const property of shape.properties) {
      if (property.type !== "Property" || property.key.type !== "Identifier") {
        throw new Error(`${source.path}: a schema entry that is not a plain key`);
      }
      if (!isCall(property.value, "binding")) {
        found.push(property.key.name);
      }
    }
  });
  if (found.length === 0) {
    throw new Error(`${source.path}: no configSchema`);
  }
  return found;
}

// The variables the backup reads: the name each `text(env, "NAME")` call passes.
function backupSettings(source: Source): string[] {
  const found = new Set<string>();
  walk(parse(source).program, (node) => {
    const name = isCall(node, "text") ? node.arguments[1] : undefined;
    if (name?.type === "Literal" && typeof name.value === "string") {
      found.add(name.value);
    }
  });
  return [...found];
}

function undocumented(settings: readonly string[], docs: readonly string[]): string[] {
  return settings.filter((name) => !docs.some((text) => new RegExp(`\\b${name}\\b`).test(text)));
}

describe("operator documents", () => {
  const docs = OPERATOR_DOCS.map((path) => read(path).text);

  it("name every setting of the configuration and the backup", () => {
    const settings = [
      ...schemaSettings(read("src/platform/config.ts")),
      ...backupSettings(read("src/platform/backup-config.ts")),
    ];
    expect(settings).toEqual(expect.arrayContaining(["MAINTENANCE", "VAPID_JWK", "BACKUP_HOUR_UTC"]));
    expect(settings).not.toContain("STORE");
    expect(undocumented(settings, docs)).toEqual([]);
  });

  it("finds a setting no document names, and leaves bindings out", () => {
    const config = {
      path: "config.ts",
      text: [
        "const configSchema = v.object({",
        '  STORE: binding<Env["STORE"]>("STORE"),',
        "  NAMED: v.optional(text()),",
        "  UNNAMED: v.optional(integer(0), 4),",
        "}, () => 'x');",
      ].join("\n"),
    };
    const backup = { path: "backup.ts", text: 'text(env, "BACKUP_NAMED"); text(env, "BACKUP_UNNAMED_X");' };
    const settings = [...schemaSettings(config), ...backupSettings(backup)];
    expect(settings).toEqual(["NAMED", "UNNAMED", "BACKUP_NAMED", "BACKUP_UNNAMED_X"]);
    expect(undocumented(settings, ["Set `NAMED` and BACKUP_NAMED, not UNNAMED_X or BACKUP_UNNAMED."])).toEqual([
      "UNNAMED",
      "BACKUP_UNNAMED_X",
    ]);
  });
});
