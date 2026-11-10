import { describe, expect, it } from "vitest";

import { lintProbe } from "./lint-probe.js";

// Settings of the root .oxlintrc.json that a narrower glob or a broader option would quietly undo.
describe("the lint config", () => {
  it("reports an unused import however it is named", () => {
    const flagged = lintProbe({
      "packages/kopje/src/probe.ts": 'import { Hono as _Hono } from "hono";\nimport { cors } from "hono/cors";\n',
    }).filter((d) => d.code === "eslint(no-unused-vars)");
    expect(flagged).toHaveLength(2);
  });

  it("refuses a nullish value in a template in src, pages included", () => {
    const code = "export const line = (name: string | undefined) => `name: ${name}`;\n";
    const flagged = lintProbe({
      "packages/kopje/src/probe.ts": code,
      "packages/kopje/src/probe-page.tsx": code,
      "packages/kopje/probe-outside.ts": code,
    })
      .filter((d) => d.code === "typescript(restrict-template-expressions)")
      .map((d) => d.filename)
      .toSorted();
    expect(flagged).toEqual(["packages/kopje/src/probe-page.tsx", "packages/kopje/src/probe.ts"]);
  });

  it("refuses an import cycle of values, and passes one closed by a type import", () => {
    const flagged = lintProbe({
      "packages/kopje/src/probe-a.ts":
        'import { b } from "./probe-b";\nexport const a = 1;\nexport const ab = a + b;\n',
      "packages/kopje/src/probe-b.ts":
        'import { a } from "./probe-a";\nexport const b = 2;\nexport const ba = a + b;\n',
      "packages/kopje/src/probe-c.ts":
        'import { d } from "./probe-d";\nexport type C = { d: number };\nexport const c = d;\n',
      "packages/kopje/src/probe-d.ts":
        'import type { C } from "./probe-c";\nexport const d = 1;\nexport const e: C = { d };\n',
    })
      .filter((d) => d.code === "import(no-cycle)")
      .map((d) => d.filename)
      .toSorted();
    expect(flagged).toEqual(["packages/kopje/src/probe-a.ts", "packages/kopje/src/probe-b.ts"]);
  });

  // lint/plugin.js: the source rules apply to packages/kopje/src, web-strings to its pages but the setup wizard.
  it("turns the kopje rules on where they apply", () => {
    const source = "import '../app/app'\nawait ctx.sendActivity(a, b, c)\nconsole.info({ event: 'kopje.store.x' })\n";
    const page = "export const A = () => <p>Hello</p>;\n";
    const flagged = lintProbe({
      "packages/kopje/src/domain/probe.ts": source,
      "packages/kopje/src/domain/probe-page.tsx": source,
      "packages/kopje/probe-outside.ts": source,
      "packages/kopje/src/web/pages/probe.tsx": page,
      "packages/kopje/src/web/setup-pages.tsx": page,
      "packages/kopje/src/domain/probe-text.tsx": page,
    })
      .filter((d) => d.code.startsWith("kopje(") && d.code !== "kopje(signing-keys)")
      .map((d) => `${d.filename} ${d.code}`)
      .toSorted();
    expect(flagged).toEqual([
      "packages/kopje/src/domain/probe-page.tsx kopje(fedify-usage)",
      "packages/kopje/src/domain/probe-page.tsx kopje(layering)",
      "packages/kopje/src/domain/probe-page.tsx kopje(log-events)",
      "packages/kopje/src/domain/probe.ts kopje(fedify-usage)",
      "packages/kopje/src/domain/probe.ts kopje(layering)",
      "packages/kopje/src/domain/probe.ts kopje(log-events)",
      "packages/kopje/src/web/pages/probe.tsx kopje(web-strings)",
    ]);
  });
});
