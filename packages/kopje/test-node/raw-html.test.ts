import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, ownerOf, parse, sources, walk, type Source } from "./source-scan.js";

// HTML-1 at the sink (docs/threat-model.md): a page writes HTML unescaped only as a SafeHtml, which only the sanitizing
// functions of src/web/safe-html.ts make, through Rich (src/web/components/basics.tsx); the doctype is the one raw
// string (src/web/components/html.tsx). This inventory fails on any other site of the three ways to write raw HTML:
// - `dangerouslySetInnerHTML`, as a JSX attribute, a property key or member, or a string;
// - a cast to SafeHtml (`as`, `<SafeHtml>`), by its name, an alias of its import, or a qualified or import() type;
// - a reference to hono/html or hono/utils/html (its `raw`, and `html`, whose template text is written as given).
const SOURCES = sources("src");

const EXPECTED = {
  "src/web/components/basics.tsx Rich: dangerouslySetInnerHTML": 1,
  "src/web/safe-html.ts sanitizedDocument: as SafeHtml": 1,
  "src/web/safe-html.ts sanitizedWithEmoji: as SafeHtml": 1,
  "src/web/safe-html.ts sanitizedField: as SafeHtml": 1,
  "src/web/components/html.tsx (top level): hono/html": 1,
};

const SINK = "dangerouslySetInnerHTML";
const RAW_MODULE = (specifier: string) => specifier === "hono/html" || specifier.startsWith("hono/utils/html");

// Whether a type names SafeHtml: by one of its local `names`, as `x.SafeHtml`, or as `import('...').SafeHtml`.
function namesSafeHtml(type: Node, names: ReadonlySet<string>): boolean {
  if (type.type === "TSImportType") {
    return type.qualifier?.type === "Identifier" && type.qualifier.name === "SafeHtml";
  }
  if (type.type !== "TSTypeReference") {
    return false;
  }
  const name = type.typeName;
  return (
    (name.type === "Identifier" && names.has(name.name)) ||
    (name.type === "TSQualifiedName" && name.right.name === "SafeHtml")
  );
}

function sites(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const { program, literals } = parse(source);
    const at = (node: Node, kind: string) =>
      `${source.path} ${ownerOf(program, node.start)?.name ?? "(top level)"}: ${kind}`;
    const names = new Set(["SafeHtml"]);
    walk(program, (node) => {
      if (
        node.type === "ImportSpecifier" &&
        (node.imported.type === "Identifier" ? node.imported.name : node.imported.value) === "SafeHtml"
      ) {
        names.add(node.local.name);
      }
    });
    const found: string[] = [];
    walk(program, (node) => {
      if ((node.type === "Identifier" || node.type === "JSXIdentifier") && node.name === SINK) {
        found.push(at(node, SINK));
      } else if (
        (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
        namesSafeHtml(node.typeAnnotation, names)
      ) {
        found.push(at(node, "as SafeHtml"));
      } else if (
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source !== null &&
        node.source !== undefined &&
        RAW_MODULE(node.source.value)
      ) {
        found.push(at(node, "hono/html"));
      } else if (node.type === "ImportExpression" || node.type === "TSImportType") {
        const specifier = node.source.type === "Literal" ? node.source.value : null;
        if (typeof specifier !== "string" || RAW_MODULE(specifier)) {
          found.push(at(node, "hono/html"));
        }
      }
    });
    for (const literal of literals) {
      if (literal.parts.some((part) => "text" in part && part.text.includes(SINK))) {
        found.push(at(literal.node, SINK));
      }
    }
    return found;
  });
}

const violations = (all: readonly Source[]) => inventoryDiff(sites(all), EXPECTED);

describe("raw HTML", () => {
  it("is written only where HTML-1 allows it", () => {
    expect(violations(SOURCES)).toEqual([]);
  });

  guardFixtures(
    violations,
    {
      flagged: {
        "a JSX attribute": [
          "export const P = ({ h }) => <dd dangerouslySetInnerHTML={{ __html: h }} />",
          "src/web/components/probe.tsx P: dangerouslySetInnerHTML has 1, expected 0",
        ],
        "a property of jsx()'s props": [
          "const P = ({ h }) => jsx('dd', { dangerouslySetInnerHTML: { __html: h } })",
          "src/web/components/probe.tsx P: dangerouslySetInnerHTML has 1, expected 0",
        ],
        "a computed key": [
          "const P = ({ h }) => jsx('dd', { ['dangerouslySetInnerHTML']: { __html: h } })",
          "src/web/components/probe.tsx P: dangerouslySetInnerHTML has 1, expected 0",
        ],
        "a cast to SafeHtml": [
          "export function f(h: string) {\n\treturn { html: h } as SafeHtml\n}",
          "src/web/components/probe.tsx f: as SafeHtml has 1, expected 0",
        ],
        "a cast through unknown": [
          "const f = (h: string) => h as unknown as SafeHtml",
          "src/web/components/probe.tsx f: as SafeHtml has 1, expected 0",
        ],
        "a cast to an alias of its import": [
          "import type { SafeHtml as Trusted } from '../safe-html'\nconst f = (h: string) => ({ html: h }) as Trusted",
          "src/web/components/probe.tsx f: as SafeHtml has 1, expected 0",
        ],
        "a cast to a qualified name": [
          "import type * as S from '../safe-html'\nconst f = (h: string) => ({ html: h }) as S.SafeHtml",
          "src/web/components/probe.tsx f: as SafeHtml has 1, expected 0",
        ],
        "a cast to an import() type": [
          "const f = (h: string) => ({ html: h }) as import('../safe-html').SafeHtml",
          "src/web/components/probe.tsx f: as SafeHtml has 1, expected 0",
        ],
        "an import of raw": [
          "import { raw } from 'hono/html'\nexport const P = ({ h }) => <dd>{raw(h)}</dd>",
          "src/web/components/probe.tsx (top level): hono/html has 1, expected 0",
        ],
        "an import of hono/utils/html": [
          "import { raw } from 'hono/utils/html'\nexport const P = ({ h }) => <dd>{raw(h)}</dd>",
          "src/web/components/probe.tsx (top level): hono/html has 1, expected 0",
        ],
        "a re-export": [
          "export { raw } from 'hono/html'",
          "src/web/components/probe.tsx (top level): hono/html has 1, expected 0",
        ],
        "a dynamic import": [
          "export async function f(h) {\n\tconst { raw } = await import('hono/html')\n\treturn raw(h)\n}",
          "src/web/components/probe.tsx f: hono/html has 1, expected 0",
        ],
      },
      passed: {
        "a sink named in a comment": "// dangerouslySetInnerHTML, as SafeHtml, hono/html\nexport const x = 1",
        "a SafeHtml in a type annotation":
          "export const P = ({ h }: { h: SafeHtml }) => <Rich html={h} class='body' />",
        "jsx escaping": "import { jsx } from 'hono/jsx'\nexport const P = ({ h }) => jsx('dd', {}, h)",
      },
    },
    { path: "src/web/components/probe.tsx", over: SOURCES },
  );

  guardFixtures(
    violations,
    {
      flagged: {
        "a second sink in Rich": [
          [
            "export const Rich = ({ html }) => (",
            "\t<div dangerouslySetInnerHTML={{ __html: html.html }}>",
            "\t\t<span dangerouslySetInnerHTML={{ __html: html.html }} />",
            "\t</div>",
            ")",
          ].join("\n"),
          "src/web/components/basics.tsx Rich: dangerouslySetInnerHTML has 2, expected 1",
        ],
      },
      passed: {},
    },
    { path: "src/web/components/basics.tsx", over: SOURCES },
  );
});
