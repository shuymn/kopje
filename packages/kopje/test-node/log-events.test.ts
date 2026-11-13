import { readdirSync, readFileSync } from "node:fs";

import { visitorKeys } from "oxc-parser";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { EXCEPTIONS, LEGACY_NAMES, logCall, logEvents, nameProblem } from "../lint/log-events.js";
import { codeSpans } from "./code-spans.js";
import { parse, sources, walk, type Source } from "./source-scan.js";

// The kopje/log-events rule (lint/log-events.js) checks each log call's shape, name and fields. This file checks what
// needs the whole tree: that LEGACY_NAMES and EXCEPTIONS hold only what still occurs, and that the docs name only
// events the code logs.
RuleTester.describe = describe;
RuleTester.it = it;

type Scan = { events: number; names: Set<string>; exceptions: Set<string>; offRule: Set<string> };

type LogCall = { event: { name: string; level: string } | null; exception: string | null };

// Every log call of `files`, read as the rule reads it. Its findings are left to the rule, which reports them for the
// same calls over the same files (src/**/*.{ts,tsx} in the root .oxlintrc.json); the checks here need only the events
// and exceptions, which a finding does not change.
function scan(files: readonly Source[]): Scan {
  const names = new Set<string>();
  const exceptions = new Set<string>();
  const offRule = new Set<string>();
  let events = 0;
  for (const source of files) {
    const text = (node: { start: number; end: number }) => source.text.slice(node.start, node.end);
    walk(parse(source).program, (node) => {
      if (node.type !== "CallExpression") {
        return;
      }
      // lint/log-events.js is untyped: its event is { name, level } and its exception a key of EXCEPTIONS.
      const call = logCall(source.path, node, text, visitorKeys) as LogCall | null;
      if (call?.exception) {
        exceptions.add(call.exception);
      }
      if (call?.event) {
        const { name, level } = call.event;
        events += 1;
        names.add(name);
        if (nameProblem(name, level) !== null) {
          offRule.add(name);
        }
      }
    });
  }
  return { events, names, exceptions, offRule };
}

const SCAN = scan(sources("src"));
const NAMES = SCAN.names;

// Event references in the docs: inline code spans (code-spans.ts; fenced blocks left out, and a span ends with its
// paragraph) holding `kopje.` and at least two more segments (`*` counting as one); one ending in `.*` names a family,
// which some event must start with.
function docReferences(text: string): string[] {
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
  return prose
    .split(/\n[ \t]*\n/)
    .flatMap((paragraph) => codeSpans(paragraph))
    .flatMap(({ content }) =>
      [...content.matchAll(/\bkopje(?:\.[A-Za-z0-9_-]+)+\.\*|\bkopje(?:\.[A-Za-z0-9_-]+){2,}/g)].map((m) => m[0]),
    );
}

function unknownReferences(text: string, names: ReadonlySet<string>): string[] {
  return docReferences(text).filter((reference) => {
    if (reference.endsWith(".*")) {
      const prefix = reference.slice(0, -1);
      return ![...names].some((name) => name.startsWith(prefix));
    }
    return !names.has(reference);
  });
}

const DOCS = readdirSync(new URL("../docs/", import.meta.url))
  .filter((name) => name.endsWith(".md"))
  .toSorted()
  .map((name) => ({ name, text: readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8") }));

describe("log events", () => {
  it("sees the log calls", () => {
    expect(SCAN.events).toBeGreaterThan(100);
    expect(NAMES).toContain("kopje.store.upgrade.failed");
  });

  it("lists only legacy names that still occur and still break the rule", () => {
    expect([...LEGACY_NAMES].filter((name) => !NAMES.has(name))).toEqual([]);
    expect([...LEGACY_NAMES].filter((name) => !SCAN.offRule.has(name))).toEqual([]);
  });

  it("uses every exception", () => {
    expect(Object.keys(EXCEPTIONS).filter((key) => !SCAN.exceptions.has(key))).toEqual([]);
  });

  it("names in the docs only events the code logs", () => {
    expect(DOCS.length).toBeGreaterThan(5);
    const found = DOCS.flatMap(({ name, text }) => unknownReferences(text, NAMES).map((r) => `docs/${name}: ${r}`));
    expect(found).toEqual([]);
    const references = DOCS.flatMap(({ text }) => docReferences(text));
    expect(references).toContain("kopje.store.upgrade.failed");
  });

  it("flags a misspelled doc reference and passes a family, a fenced block and a short name", () => {
    const names = new Set(["kopje.store.upgrade.failed", "kopje.backup.succeeded"]);
    const text = [
      "See `kopje.store.upgrade.faild` and `event = kopje.backup.succeded`.",
      "The `kopje.backup.*` family, `kopje.store.upgrade.failed`, and `kopje.version`.",
      "```text",
      "`kopje.not.real.event`",
      "```",
      "A span of two backticks, ``a ` in kopje.backup.faild``, then `kopje.media.gone.x`.",
    ].join("\n");
    expect(unknownReferences(text, names)).toEqual([
      "kopje.store.upgrade.faild",
      "kopje.backup.succeded",
      "kopje.backup.faild",
      "kopje.media.gone.x",
    ]);
    expect(unknownReferences("`kopje.media.*`", names)).toEqual(["kopje.media.*"]);
  });

  it("reads an exception, a legacy name off the rule and an event, as the rule does", () => {
    const found = scan([
      { path: "src/platform/log.ts", text: "console[level ?? 'log'](entry)" },
      { path: "src/domain/probe.ts", text: "this.#log({ event: 'kopje.store.import.reset-done' })" },
    ]);
    expect(found).toEqual({
      events: 1,
      names: new Set(["kopje.store.import.reset-done"]),
      exceptions: new Set(["src/platform/log.ts: console[level ?? "]),
      offRule: new Set(["kopje.store.import.reset-done"]),
    });
  });
});

// Each fixture is a method's body, so `this.#log` parses.
const PROBE = "packages/kopje/src/domain/probe.ts";
const inMethod = (code: string) => `class Probe {\n\t#log = sink\n\tm() {\n${code}\n\t}\n}`;
const flagged = (code: string, ...messages: string[]) => ({
  code: inMethod(code),
  errors: messages.map((message) => ({ message })),
  filename: PROBE,
});
const passed = (code: string) => ({ code: inMethod(code), filename: PROBE });

new RuleTester().run("log-events", logEvents, {
  invalid: [
    flagged("console.warn('kopje.store.x failed')", "the entry is not an object literal"),
    flagged("console.error({ event: 'kopje.store.x_failed' }, 'error')", "too many arguments"),
    flagged("console.log({ id, event: 'kopje.store.x' })", "the first property is not an event name literal"),
    flagged("console.log({ event: name })", "the first property is not an event name literal"),
    flagged("console.error({ event: 'kopje.store.x_failed', error: errorMessage(error) })", "logs errorMessage(…)"),
    flagged("console.error({ event: 'kopje.store.x_failed', detail: e.message })", "logs a message (e.message)"),
    flagged("console.error({ event: 'kopje.store.x_failed', detail: String(e) })", "logs String(…)"),
    flagged("console.error({ event: 'kopje.store.x_failed', error })", "logs a raw error"),
    flagged("console.error({ event: 'kopje.admin.error', path: c.req.path })", "logs c.req.path"),
    flagged(
      "console.error({ event: 'kopje.store.x_failed', detail: error['message'] })",
      "logs a message (error['message'])",
    ),
    flagged("console.error({ event: 'kopje.admin.error', path: c.req['path'] })", "logs c.req.path"),
    flagged("console.warn({ event: 'kopje.inbox.refused', url: request[`url`] })", "logs request.url"),
    flagged("console.warn({ event: 'kopje.inbox.refused', url: request.url })", "logs request.url"),
    flagged(
      "console.warn({ event: 'kopje.stream.new-thing' })",
      "kopje.stream.new-thing is not kopje.<area>.<what> in snake_case",
    ),
    flagged(
      "console.log({ event: 'kopje.widget.done' })",
      "kopje.widget.done is not kopje.<area>.<what> in snake_case",
    ),
    flagged("console.log({ event: 'kopje.store' })", "kopje.store is not kopje.<area>.<what> in snake_case"),
    flagged("console.error({ event: 'kopje.store.done' })", "kopje.store.done is logged at error but names no failure"),
    flagged("console.info({ event: 'kopje.store.x' })", "console.info; use log, warn or error"),
    flagged("console[level]({ event: 'kopje.store.x' })", "console call other than log, warn or error"),
    flagged("const log = console.log", "uses console other than as a log call"),
    flagged("this.#log({ event: 'kopje.store.x_failed' }, 'error', 1)", "too many arguments"),
    flagged(
      "this.#log({ event: 'kopje.store.x_failed' }, level)",
      "the level is not 'warn' or 'error'",
      "kopje.store.x_failed names a failure but is logged below warn",
    ),
    flagged(
      "this.#log({ event: 'kopje.store.x_failed', error: errorMessage(error) }, 'error')",
      "logs errorMessage(…)",
    ),
    flagged("(deps.log ?? consoleSink)('kopje.backup.error')", "the entry is not an object literal"),
    flagged(
      "(deps.log ?? consoleSink)({ event: 'kopje.backup.done' }, 'error')",
      "kopje.backup.done is logged at error but names no failure",
    ),
    flagged(
      "this.#log({ event: 'kopje.store.import.reset_failed' })",
      "kopje.store.import.reset_failed names a failure but is logged below warn",
    ),
    flagged(
      "this.#log({ event: 'kopje.store.import.chunk-failed', code })",
      "kopje.store.import.chunk-failed names a failure but is logged below warn",
    ),
    flagged("this.#log({ event: 'kopje.store.Thing' })", "kopje.store.Thing is not kopje.<area>.<what> in snake_case"),
    flagged("nextDueOf(round, name)", "the event name passed to nextDueOf is not a string literal"),
    flagged(
      "nextDueOf(round, `kopje.delivery.${step}.failed`)",
      "the event name passed to nextDueOf is not a string literal",
    ),
    flagged("nextDueOf(round)", "the event name passed to nextDueOf is not a string literal"),
    flagged(
      "nextDueOf(round, 'kopje.delivery.round-failed')",
      "kopje.delivery.round-failed is not kopje.<area>.<what> in snake_case",
    ),
    // An exception names its file: the same text elsewhere is checked.
    flagged("console[level ?? 'log'](entry)", "console call other than log, warn or error"),
  ],
  valid: [
    passed("console.warn({ event: 'kopje.store.unavailable', reason, ...errorFields(error) })"),
    passed("console.error({ event: 'kopje.scheduled.status.failed', id, recorded: true })"),
    passed("console.error({ event: 'kopje.backup.record_failed', ...errorFields(e) })"),
    passed("this.#log({ event: 'kopje.store.upgrade.failed', bookmark, detail }, 'error')"),
    passed("this.#log({ event: 'kopje.store.upgrade.done', applied })"),
    passed("(deps.log ?? consoleSink)({ event: 'kopje.backup.error', ...errorFields(e) }, 'error')"),
    passed("console.log({ event: 'kopje.store.x', size: sizes[key] })"),
    passed("const text = error.message\nconsole.log({ event: 'kopje.store.x', size: text.length })"),
    passed("// console.log('x')\nconsole.log({ event: 'kopje.store.x' })"),
    passed("console.error({ event: 'kopje.store.x_failed', ...errorFields(error) })"),
    passed("this.#log({ event: 'kopje.store.import.reset-done' })"),
    { code: "console[level ?? 'log'](entry)", filename: "packages/kopje/src/platform/log.ts" },
  ],
});
