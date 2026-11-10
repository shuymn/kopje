import type { Node } from "oxc-parser";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { layering } from "../lint/layering.js";
import { guardFixtures, inventoryDiff, ownerOf, parse, sources, walk, type Source } from "./source-scan.js";

// The kopje/layering rule (lint/layering.js): no upward, sideways, or platform-leaking imports.
RuleTester.describe = describe;
RuleTester.it = it;

const flagged = (path: string, code: string, ...messages: string[]) => ({
  code,
  errors: messages.map((message) => ({ message })),
  filename: `packages/kopje/${path}`,
});
const passed = (path: string, code: string) => ({ code, filename: `packages/kopje/${path}` });

new RuleTester().run("layering", layering, {
  invalid: [
    flagged(
      "src/domain/a.ts",
      "import { x } from '../app/app'\nimport { DurableObject } from 'cloudflare:workers'",
      "domain imports app (../app/app)",
      "domain imports cloudflare:workers",
    ),
    flagged(
      "src/mastodon/b.ts",
      "export { y } from '../federation/spool'",
      "mastodon imports federation (../federation/spool)",
    ),
    flagged(
      "src/db/c.ts",
      "export type X = string\nconst m = await import('../platform/config')",
      "db imports platform (../platform/config)",
    ),
    flagged("src/security/e.ts", "import '../domain/ids'", "security imports domain (../domain/ids)"),
    flagged("src/stray/d.ts", "", "directory is not part of the layering"),
    flagged(
      "src/client/f.ts",
      "import { g } from './g'\nimport { h } from '../web/format'\nimport 'valibot'\nimport '../../scripts/x'",
      "client imports web (../web/format)",
      "client imports valibot",
      "client imports ../../scripts/x",
    ),
    flagged("src/web/i.ts", "import { f } from '../client/f'", "web imports client (../client/f)"),
    flagged("src/domain/probe.ts", "export * from '../app/app'", "domain imports app (../app/app)"),
    flagged("src/domain/probe.ts", "type T = import('../web/pages').Page", "domain imports web (../web/pages)"),
    flagged("src/domain/probe.ts", "const m = await import(`../app/${name}`)", "imports a computed specifier"),
    flagged(
      "src/web/probe.tsx",
      "import { DurableObject } from 'cloudflare:workers'",
      "web imports cloudflare:workers",
    ),
  ],
  valid: [
    passed(
      "src/domain/probe.ts",
      "import { a } from './ids'\nimport { b } from '../db/sql'\nimport * as v from 'valibot'",
    ),
    passed("src/domain/probe.ts", "// import { x } from '../app/app'\nconst s = \"import '../app/app'\""),
    passed("src/worker.ts", "import { app } from './app/app'\nimport { DurableObject } from 'cloudflare:workers'"),
    passed("src/platform/probe.ts", "import { DurableObject } from 'cloudflare:workers'"),
    passed("src/version.ts", "import { a } from './domain/ids'"),
  ],
});

const SOURCES = sources("src");

// R32 (docs/visibility.md): a streaming delete is captured (streamDelete in src/domain/streaming.ts) at exactly these
// four sites. That each captures once, before the first change to the status's audience, and keeps its capture when a
// batch fails, the runtime tests show (test/stream-delete.test.ts unless named):
// - deleteStatus: the captures of a status's boosts and its tombstone, and the streaming suite;
// - unreblog: "captures a local boost removed by unreblog, by its own id, before it is hidden";
// - deleteObject: "names the viewers a mention authorized, once, through every batch and a redelivery", and in
//   test/inbound-job-isolation.test.ts a failing first batch that keeps its capture and a redelivered Delete whose job
//   exists that captures nothing;
// - removeBoost: "captures a remote boost removed by Delete or Undo, by its own id".
// This inventory fails on any other site, which then needs a witness of its own. No capture function runs under a
// batch's budget (JobBudget, RowBudget): a capture a budget could skip is invisible to those tests, which never
// exhaust one before it.
const CAPTURES = {
  "src/domain/statuses.ts deleteStatus": 1,
  "src/domain/statuses.ts unreblog": 1,
  "src/domain/inbox.ts deleteObject": 1,
  "src/domain/inbox.ts removeBoost": 1,
};

// Whether `callee` names streamDelete: the name itself, or a static member (`m.streamDelete`, `m["streamDelete"]`).
function namesCapture(callee: Node): boolean {
  if (callee.type === "Identifier") {
    return callee.name === "streamDelete";
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }
  const { property } = callee;
  return callee.computed
    ? property.type === "Literal" && property.value === "streamDelete"
    : property.type === "Identifier" && property.name === "streamDelete";
}

function captureProblems(files: readonly Source[]): string[] {
  const found: string[] = [];
  const owners = new Map<string, string>();
  for (const source of files) {
    const { program, code } = parse(source);
    walk(program, (node) => {
      if (node.type === "CallExpression" && namesCapture(node.callee)) {
        const owner = ownerOf(program, node.start);
        const key = `${source.path} ${owner?.name ?? "(top level)"}`;
        found.push(key);
        if (owner !== null) {
          owners.set(key, code.slice(owner.start, owner.end));
        }
      }
    });
  }
  const budgets = [...owners]
    .filter(([, text]) => /\b(?:Job|Row)?Budget\b/.test(text))
    .map(([key]) => `${key} runs under a budget`);
  return [...inventoryDiff(found, CAPTURES), ...budgets.toSorted()];
}

describe("the streaming delete capture sites", () => {
  it("are the four sites, none under a budget", () => {
    expect(captureProblems(SOURCES)).toEqual([]);
  });

  guardFixtures(
    captureProblems,
    {
      flagged: {
        "a fifth site": [
          "function extra(db: Db): void {\n\tstreamDelete(db, 'x', 0)\n}",
          "src/domain/probe.ts extra has 1, expected 0",
        ],
        "a capture under a budget": [
          "function extra(budget: JobBudget, db: Db): void {\n\tstreamDelete(db, 'x', 0)\n}",
          "src/domain/probe.ts extra runs under a budget",
        ],
        "a capture through a namespace import": [
          "import * as streaming from './streaming'\nfunction extra(db: Db): void {\n\tstreaming.streamDelete(db, 'x', 0)\n}",
          "src/domain/probe.ts extra has 1, expected 0",
        ],
        "a capture through a computed member": [
          "import * as streaming from './streaming'\nfunction extra(db: Db): void {\n\tstreaming['streamDelete'](db, 'x', 0)\n}",
          "src/domain/probe.ts extra has 1, expected 0",
        ],
      },
      passed: { "a capture named in a comment": "// streamDelete(db, id, now) runs above.\nf()" },
    },
    { over: SOURCES },
  );

  guardFixtures(
    captureProblems,
    {
      flagged: {
        "a second capture in the same function": [
          [
            "export const unreblog = (db: Db, id: string) => {",
            "\tstreamDelete(db, id, 0)",
            "\tstreamDelete(db, id, 0)",
            "}",
            "export const deleteStatus = (db: Db, id: string) => streamDelete(db, id, 0)",
          ].join("\n"),
          "src/domain/statuses.ts unreblog has 2, expected 1",
        ],
        "a capture function under a RowBudget": [
          [
            "export const unreblog = (db: Db, id: string) => streamDelete(db, id, 0)",
            "export const deleteStatus = (db: Db, id: string, budget: RowBudget) => streamDelete(db, id, 0)",
          ].join("\n"),
          "src/domain/statuses.ts deleteStatus runs under a budget",
        ],
      },
      passed: {
        "the two sites alone": [
          "export const unreblog = (db: Db, id: string) => streamDelete(db, id, 0)",
          "export const deleteStatus = (db: Db, id: string) => streamDelete(db, id, 0)",
        ].join("\n"),
      },
    },
    { path: "src/domain/statuses.ts", over: SOURCES },
  );
});
