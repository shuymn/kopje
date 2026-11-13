import { readdirSync, readFileSync } from "node:fs";

import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { textRuns } from "./markdown.js";
import { lineOf, parse, type Source, walk } from "./source-scan.js";

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

// Every `kopje-admin` command the documents name is one the CLI's usage (USAGE in cli/lib/main.js) lists: the package's
// and the template's Markdown, except the CHANGELOG, whose entries keep the commands of the release they describe.
const COMMAND_DOCS = [
  "README.md",
  "RELEASING.md",
  "../../deploy/README.md",
  ...readdirSync(new URL("../docs/", import.meta.url))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
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

// The text of the usage: the template literal `USAGE` is declared with.
function usageText(source: Source): string {
  const usage = parse(source).literals.find((literal) => literal.constant === "USAGE");
  if (usage === undefined) {
    throw new Error(`${source.path}: no USAGE`);
  }
  return usage.parts.map((part) => ("text" in part ? part.text : "")).join("");
}

const WORD = /^[a-z][a-z0-9-]*$/;

// The commands the usage lists, as `name` and `name subcommand`: each line indented by exactly two spaces up to its
// description (two or more spaces), split at ` | ` into forms, with `a|b` and `[a|b]` read as alternatives.
function usageCommands(usage: string): Set<string> {
  const commands = new Set<string>();
  for (const line of usage.split("\n")) {
    const form = /^ {2}([a-z].*?)(?: {2,}|$)/.exec(line)?.[1];
    for (const part of form?.split(" | ") ?? []) {
      const [name = "", second = ""] = part.trim().split(/\s+/);
      const optional = second.startsWith("[");
      const subs = second
        .replace(/^\[(.*)\]$/, "$1")
        .split("|")
        .filter((sub) => WORD.test(sub));
      for (const sub of subs) {
        commands.add(`${name} ${sub}`);
      }
      if (optional || subs.length === 0) {
        commands.add(name);
      }
    }
  }
  return commands;
}

// The commands a Markdown text names that the usage does not list, as `line: command`. The text is read from its parse
// (markdown.ts): each text and inline code node, and each line of a code block, so quote markers and line breaks are
// never part of it. A mention is `kopje-admin` and the plain lowercase words after it in the same node, up to the first
// that is not one (an option, a value, `name=value`) or that punctuation ends. Its first word must be a command; when
// that command has subcommands, a second word must be one of them.
function unlistedCommands(text: string, commands: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const { value, line } of textRuns(text)) {
    for (const match of value.matchAll(/\bkopje-admin(?=\s)/g)) {
      const words = mentionedWords(value.slice(match.index + match[0].length));
      if (!listed(words, commands)) {
        found.push(`${lineOf(value, match.index) + line - 1}: kopje-admin ${words.join(" ")}`);
      }
    }
  }
  return found;
}

// The plain lowercase words, at most two, at the start of `after`.
function mentionedWords(after: string): string[] {
  const words: string[] = [];
  for (const raw of after.trim().split(/\s+/).slice(0, 2)) {
    const word = raw.replace(/[`'".,;:)]+$/, "");
    if (!WORD.test(word)) {
      break;
    }
    words.push(word);
    if (word !== raw) {
      break;
    }
  }
  return words;
}

function listed([name, sub]: readonly string[], commands: ReadonlySet<string>): boolean {
  return (
    name === undefined ||
    (sub !== undefined && commands.has(`${name} ${sub}`)) ||
    (commands.has(name) && (sub === undefined || ![...commands].some((c) => c.startsWith(`${name} `))))
  );
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

  it("name only kopje-admin commands the CLI's usage lists", () => {
    // `help` prints the usage (cli/lib/main.js answers it, like --help, before any command), which does not list it.
    const commands = new Set([...usageCommands(usageText(read("cli/lib/main.js"))), "help"]);
    expect(commands).toEqual(
      new Set([
        ...commands,
        "health",
        "jobs retry",
        "trends links",
        "maintenance off",
        "emoji enable",
        "fingerprint export",
      ]),
    );
    expect(
      COMMAND_DOCS.flatMap((path) => unlistedCommands(read(path).text, commands).map((m) => `${path}:${m}`)),
    ).toEqual([]);
  });

  it("finds a command the usage does not list", () => {
    const usage = [
      "Usage: kopje-admin <command>",
      "",
      "Commands",
      "  health                        a report",
      "  jobs retry                    retry",
      "  trends [tags|links] [--offset <n>]",
      "                                a list | not a form",
      "  emoji disable <id> | emoji enable <id>",
      "      --flag                    an option",
      "  maintenance on|off            enter or leave",
      "",
      "Environment",
      "  KOPJE_ADMIN_URL               the URL",
    ].join("\n");
    const commands = usageCommands(usage);
    expect([...commands].toSorted()).toEqual(
      [
        "emoji disable",
        "emoji enable",
        "health",
        "jobs retry",
        "maintenance off",
        "maintenance on",
        "trends",
        "trends links",
        "trends tags",
      ].toSorted(),
    );
    const text = [
      "Run `kopje-admin health`, then kopje-admin jobs retry. `kopje-admin trends links`, `kopje-admin trends --offset 2`",
      "`kopje-admin emoji enable 3`; kopje-admin health and more; `kopje-admin maintenance on`.",
      "`kopje-admin jobs retry-all`, `kopje-admin trends statuses`, kopje-admin frobnicate, `kopje-admin jobs`",
      "The `kopje-admin` CLI, kopje-admin.",
      "",
      "Run `kopje-admin",
      "  jobs retry`, then kopje-admin",
      "  images-export-old.",
      "```sh",
      "kopje-admin jobs",
      "retry",
      "```",
      "",
      "> Then kopje-admin",
      "> images-export-old, and kopje-admin jobs",
      "> retry, and `kopje-admin",
      "> jobs retry`.",
    ].join("\n");
    expect(unlistedCommands(text, commands)).toEqual([
      "3: kopje-admin jobs retry-all",
      "3: kopje-admin trends statuses",
      "3: kopje-admin frobnicate",
      "3: kopje-admin jobs",
      "7: kopje-admin images-export-old",
      "10: kopje-admin jobs",
      "14: kopje-admin images-export-old",
    ]);
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
