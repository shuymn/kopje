import { packagePath } from "./paths.js";

// The shape of Kopje's log events (docs/observability.md; DATA-5 in docs/threat-model.md). A bounded syntactic guard,
// not data-flow enforcement: it reads each log call in src/ and checks what the call itself spells out.
//
// - A direct call, `console.log | warn | error({ event: 'kopje.…', ...fields })`, takes exactly one argument. A
//   recognized sink, `this.#log(entry, level?)` or `(x.log ?? sink)(entry, level?)`, takes the entry and an optional
//   level literal, 'warn' or 'error'. The entry is an object literal whose first property is `event`, a string literal.
// - A name is `kopje.<area>.<what>[.<step>…]` in lowercase words joined by `_`, with an area of AREAS, or one of
//   LEGACY_NAMES. An event at the error level names its failure (`failed`, `unavailable` or `error`), and an event
//   that names one is logged at warn or error.
// - No field is a raw message (`errorMessage(…)`, `….message`, `String(…)`), a request URL or path (`c.req.path`,
//   `c.req.url`, `request.url`) or a raw error (`error`).
// - `console` is used for nothing else; EXCEPTIONS lists the reviewed sites that do otherwise.
//
// The rule checks each file; test-node/log-events.test.ts reads every event through logCall() for what needs the whole
// tree: that LEGACY_NAMES and EXCEPTIONS hold only what still occurs, and that the docs name only logged events.

const AREAS = new Set([
  "activity",
  "admin",
  "announcements",
  "authorize",
  "backup",
  "card_images",
  "config",
  "cutover",
  "delivery",
  "emoji",
  "error",
  "field_links",
  "inbox",
  "jobs",
  "link_cards",
  "maintenance",
  "media",
  "presenter",
  "push",
  "queue",
  "quote",
  "remote_media",
  "scheduled",
  "setup",
  "snapshot",
  "spool",
  "store",
  "stream",
]);
const NAME = /^kopje\.([a-z0-9_]+)(\.[a-z0-9_]+)+$/;
const FAILURE_WORDS = new Set(["failed", "unavailable", "error"]);

// Names from before the naming rule, kept because docs and operators' queries use them. Frozen: it may only shrink, and
// the test fails for a listed name that no longer occurs. A new event follows the rule instead.
export const LEGACY_NAMES = new Set([
  "kopje.announcements.row-cap-exceeded",
  "kopje.authorize.access-denied",
  "kopje.config.invalid",
  "kopje.error",
  "kopje.maintenance.backlog-full",
  "kopje.maintenance.queue-missing",
  "kopje.maintenance.rate-limited",
  "kopje.media.type_refused",
  "kopje.presenter.row-cap-exceeded",
  "kopje.queue.unknown",
  "kopje.snapshot.save-failed",
  "kopje.spool.backlog-full",
  "kopje.spool.handed-off",
  "kopje.spool.handoff-check.failed",
  "kopje.spool.metrics-unavailable",
  "kopje.store.cutover.discard-kept",
  "kopje.store.hold.persist-failed",
  "kopje.store.import.chunk-failed",
  "kopje.store.import.reset-done",
  "kopje.store.import.verify-failed",
  "kopje.store.snapshot.unreadable",
  "kopje.stream.capture-truncated",
  "kopje.stream.journal-full",
  "kopje.stream.payload-skipped",
  "kopje.stream.register-failed",
  "kopje.stream.send-failed",
  "kopje.stream.tick-failed",
  "kopje.stream.turn-failed",
  "kopje.stream.turn-request-failed",
]);

// Reviewed sites that call `console` otherwise, by file and the call's text.
export const EXCEPTIONS = {
  // The default sink: the level is the sink's argument, checked at each sink call.
  "src/platform/log.ts: console[level ?? ": "the default injected sink",
  // The event names are the literals passed to nextDueOf, which the guard checks as names (NAME_ARGUMENTS).
  "src/jobs/deliver.ts: console.error({ event, ...errorFields(error) })": "an event name passed as a parameter",
  // The event names are the literals passed to cronStep and cronRound (NAME_ARGUMENTS).
  "src/jobs/scheduled.ts: console.error({ event, ...errorFields(error) })": "an event name passed as a parameter",
};
// Calls whose argument at the given index is an event name for an excepted site.
const NAME_ARGUMENTS = { nextDueOf: 1, cronStep: 1, cronRound: 2 };

const LEVELS = new Set(["warn", "error"]);
const DIRECT = new Set(["log", "warn", "error", "info", "debug"]);
const FORBIDDEN_MEMBERS = new Set(["c.req.path", "c.req.url", "request.url"]);

// The key of a member access when it is static: `x.key`, `x['key']` or x[`key`]; else null.
function memberKey(node) {
  if (node.type !== "MemberExpression") {
    return null;
  }
  const key = node.property;
  if (!node.computed) {
    return key.type === "Identifier" ? key.name : null;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return key.type === "TemplateLiteral" && key.expressions.length === 0 ? (key.quasis[0]?.value.cooked ?? null) : null;
}

// A chain of static member accesses from an identifier, dotted (`c.req['path']` is `c.req.path`); else null.
function memberChain(node) {
  if (node.type === "Identifier") {
    return node.name;
  }
  const key = memberKey(node);
  const object = node.type === "MemberExpression" ? memberChain(node.object) : null;
  return key === null || object === null ? null : `${object}.${key}`;
}

// The child nodes of an AST node by `keys`, the visitor keys of oxlint's or oxc-parser's AST.
const children = (node, keys) =>
  (keys[node.type] ?? []).flatMap((key) => (Array.isArray(node[key]) ? node[key] : [node[key]])).filter((v) => v);

function fieldFindings(entry, text, keys) {
  const findings = [];
  const visit = (inner) => {
    if (
      inner.type === "CallExpression" &&
      inner.callee.type === "Identifier" &&
      (inner.callee.name === "errorMessage" || inner.callee.name === "String")
    ) {
      findings.push({ node: inner, message: `logs ${inner.callee.name}(…)` });
    } else if (inner.type === "MemberExpression" && memberKey(inner) === "message") {
      findings.push({ node: inner, message: `logs a message (${text(inner)})` });
    } else if (inner.type === "MemberExpression" && FORBIDDEN_MEMBERS.has(memberChain(inner) ?? "")) {
      findings.push({ node: inner, message: `logs ${memberChain(inner)}` });
    } else if (inner.type === "Property" && inner.value.type === "Identifier" && inner.value.name === "error") {
      findings.push({ node: inner, message: "logs a raw error" });
    }
    children(inner, keys).forEach(visit);
  };
  visit(entry);
  return findings;
}

// What is wrong with an event's name at its level, or null. A legacy name may keep such a problem.
export function nameProblem(name, level) {
  const match = NAME.exec(name);
  if (match === null || !AREAS.has(match[1] ?? "")) {
    return "is not kopje.<area>.<what> in snake_case";
  }
  if (level === "error" && !name.split(/[._-]/).some((word) => FAILURE_WORDS.has(word))) {
    return "is logged at error but names no failure";
  }
  return null;
}

function nameFindings({ node, name, level }) {
  const findings = [];
  // A legacy name keeps its spelling, not a level below warn for a failure.
  if (level === "log" && name.split(/[._-]/).some((word) => FAILURE_WORDS.has(word))) {
    findings.push({ node, message: `${name} names a failure but is logged below warn` });
  }
  const problem = nameProblem(name, level);
  if (problem !== null && !LEGACY_NAMES.has(name)) {
    findings.push({ node, message: `${name} ${problem}` });
  }
  return findings;
}

// A call read as a log call of `file` (package-relative), with the source text of a node by `text(node)` and the AST's
// visitor keys: null when it is none; else the event it logs (its node is where the name is reported), the exception
// it matches, and its findings.
export function logCall(file, node, text, keys) {
  const callee = node.callee;
  const refused = (...findings) => ({ event: null, exception: null, findings });
  if (callee.type === "Identifier" && Object.hasOwn(NAME_ARGUMENTS, callee.name)) {
    const name = node.arguments[NAME_ARGUMENTS[callee.name]];
    if (name?.type === "Literal" && typeof name.value === "string") {
      const found = { node: name, name: name.value, level: "error" };
      return { event: found, exception: null, findings: nameFindings(found) };
    }
    return refused({ node, message: `the event name passed to ${callee.name} is not a string literal` });
  }
  let form = null;
  let level = "log";
  if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "console") {
    const exception = Object.keys(EXCEPTIONS).find((k) => `${file}: ${text(node)}`.startsWith(k));
    if (exception !== undefined) {
      return { event: null, exception, findings: [] };
    }
    const method = !callee.computed && callee.property.type === "Identifier" ? callee.property.name : null;
    if (method === null || !DIRECT.has(method)) {
      return refused({ node, message: "console call other than log, warn or error" });
    }
    if (method === "info" || method === "debug") {
      return refused({ node, message: `console.${method}; use log, warn or error` });
    }
    form = "direct";
    level = method;
  } else if (
    (callee.type === "MemberExpression" &&
      callee.object.type === "ThisExpression" &&
      callee.property.type === "PrivateIdentifier" &&
      callee.property.name === "log") ||
    (callee.type === "LogicalExpression" &&
      callee.operator === "??" &&
      callee.left.type === "MemberExpression" &&
      !callee.left.computed &&
      callee.left.property.type === "Identifier" &&
      callee.left.property.name === "log")
  ) {
    form = "sink";
  } else {
    return null;
  }
  const findings = [];
  const [entry, levelArgument, ...rest] = node.arguments;
  if (form === "direct" ? levelArgument !== undefined : rest.length > 0) {
    findings.push({ node, message: "too many arguments" });
  }
  if (form === "sink" && levelArgument !== undefined) {
    if (
      levelArgument.type === "Literal" &&
      typeof levelArgument.value === "string" &&
      LEVELS.has(levelArgument.value)
    ) {
      level = levelArgument.value;
    } else {
      findings.push({ node, message: "the level is not 'warn' or 'error'" });
    }
  }
  if (entry?.type !== "ObjectExpression") {
    return refused(...findings, { node, message: "the entry is not an object literal" });
  }
  const first = entry.properties[0];
  let found = null;
  if (
    first?.type !== "Property" ||
    first.computed ||
    first.key.type !== "Identifier" ||
    first.key.name !== "event" ||
    first.value.type !== "Literal" ||
    typeof first.value.value !== "string"
  ) {
    findings.push({ node, message: "the first property is not an event name literal" });
  } else {
    found = { node, name: first.value.value, level };
    findings.push(...nameFindings(found));
  }
  findings.push(...fieldFindings(entry, text, keys));
  return { event: found, exception: null, findings };
}

// Whether a `console` identifier is the object of a log call's callee (`console.x(…)`), the one use logCall reads.
const isLogCallConsole = (node, parent, grandparent) =>
  parent?.type === "MemberExpression" &&
  parent.object === node &&
  grandparent?.type === "CallExpression" &&
  grandparent.callee === parent;

export const logEvents = {
  create(context) {
    const file = packagePath(context.filename) ?? context.filename;
    const { sourceCode } = context;
    const text = (node) => sourceCode.getText(node);
    return {
      CallExpression(node) {
        for (const { node: at, message } of logCall(file, node, text, sourceCode.visitorKeys)?.findings ?? []) {
          context.report({ node: at, message });
        }
      },
      Identifier(node) {
        if (node.name === "console" && !isLogCallConsole(node, node.parent, node.parent?.parent)) {
          context.report({ node, message: "uses console other than as a log call" });
        }
      },
    };
  },
};
