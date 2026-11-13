import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { guardFixtures, inventoryDiff, ownerOf, parse, resolve, sources, walk, type Source } from "./source-scan.js";

// HTML-1 at the sink (docs/threat-model.md): a page writes HTML unescaped only as a SafeHtml, which only the sanitizing
// functions of src/web/safe-html.ts make, through Rich (src/web/components/basics.tsx); the doctype is the one raw
// string (src/web/components/html.tsx). This inventory fails on any other site of the ways to write raw HTML:
// - `dangerouslySetInnerHTML`, as a JSX attribute, a property key or member, or a string;
// - a cast to SafeHtml (`as`, `<SafeHtml>`), by its name, an alias of its import, or a qualified or import() type;
// - each use of a name imported from hono/html or hono/utils/html (its `raw`, and `html`, whose template text is
//   written as given), through any alias or a namespace, and any re-export or import() of them;
// - a `.html(` call (Hono's c.html writes a string as given) whose first argument is neither JSX nor onHost's page
//   (src/web/components/layout.tsx, which takes the page as an escaped child): a page helper passes its body as JSX.
const SOURCES = sources("src");

const EXPECTED = {
  "src/web/components/basics.tsx Rich: dangerouslySetInnerHTML": 1,
  "src/web/safe-html.ts sanitizedDocument: as SafeHtml": 1,
  "src/web/safe-html.ts sanitizedWithEmoji: as SafeHtml": 1,
  "src/web/safe-html.ts sanitizedField: as SafeHtml": 1,
  "src/web/components/html.tsx Html: hono/html": 1,
  // emoji.html: the emoji field's own escaped image markup, inside the sanitizer's pass (HTML-1, sanitizedWithEmoji).
  "src/web/safe-html.ts sanitizedWithEmoji: .html()": 1,
};

const SINK = "dangerouslySetInnerHTML";
const LAYOUT = "src/web/components/layout";
// The import's own nodes, which declare a name rather than use it.
const IMPORT_BINDINGS = new Set(["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"]);
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
    // The local names of SafeHtml, of what hono/html exports and of onHost.
    const names = new Set(["SafeHtml"]);
    const raw = new Set<string>();
    const onHost = new Set<string>();
    walk(program, (node) => {
      if (node.type !== "ImportDeclaration") {
        return;
      }
      const specifier = node.source.value;
      const target = (specifier.startsWith(".") ? resolve(source.path, specifier) : specifier).replace(/\.tsx?$/, "");
      for (const binding of node.specifiers) {
        const imported =
          binding.type !== "ImportSpecifier"
            ? null
            : binding.imported.type === "Identifier"
              ? binding.imported.name
              : binding.imported.value;
        if (imported === "SafeHtml") {
          names.add(binding.local.name);
        }
        if (RAW_MODULE(specifier)) {
          raw.add(binding.local.name);
        }
        if (imported === "onHost" && target === LAYOUT) {
          onHost.add(binding.local.name);
        }
      }
    });
    const escaped = (argument: Node | undefined) =>
      argument?.type === "JSXElement" ||
      argument?.type === "JSXFragment" ||
      (argument?.type === "CallExpression" &&
        argument.callee.type === "Identifier" &&
        onHost.has(argument.callee.name));
    const found: string[] = [];
    // A shorthand property's key and value may be one node: each use counts once.
    const used = new Set<number>();
    walk(program, (node, parents) => {
      const parent = parents[0];
      if ((node.type === "Identifier" || node.type === "JSXIdentifier") && node.name === SINK) {
        found.push(at(node, SINK));
      } else if (
        node.type === "Identifier" &&
        raw.has(node.name) &&
        !IMPORT_BINDINGS.has(parent?.type ?? "") &&
        !used.has(node.start) &&
        !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed) &&
        !(parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand)
      ) {
        used.add(node.start);
        found.push(at(node, "hono/html"));
      } else if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        (node.callee.computed
          ? node.callee.property.type === "Literal" && node.callee.property.value === "html"
          : node.callee.property.type === "Identifier" && node.callee.property.name === "html") &&
        !escaped(node.arguments[0])
      ) {
        found.push(at(node, ".html()"));
      } else if (
        (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
        namesSafeHtml(node.typeAnnotation, names)
      ) {
        found.push(at(node, "as SafeHtml"));
      } else if (
        (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
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
        "a use of raw": [
          "import { raw } from 'hono/html'\nexport const P = ({ h }) => <dd>{raw(h)}</dd>",
          "src/web/components/probe.tsx P: hono/html has 1, expected 0",
        ],
        "a use of raw from hono/utils/html": [
          "import { raw } from 'hono/utils/html'\nexport const P = ({ h }) => <dd>{raw(h)}</dd>",
          "src/web/components/probe.tsx P: hono/html has 1, expected 0",
        ],
        "a use of raw through an alias": [
          "import { raw as trusted } from 'hono/html'\nexport const P = ({ h }) => <dd>{trusted(h)}</dd>",
          "src/web/components/probe.tsx P: hono/html has 1, expected 0",
        ],
        "a use through a namespace": [
          "import * as h from 'hono/html'\nexport const P = ({ t }) => <dd>{h['raw'](t)}</dd>",
          "src/web/components/probe.tsx P: hono/html has 1, expected 0",
        ],
        "the html template": [
          "import { html } from 'hono/html'\nexport const P = ({ t }) => html`<dd>${t}</dd>`",
          "src/web/components/probe.tsx P: hono/html has 1, expected 0",
        ],
        "raw passed on in a shorthand property": [
          "import { raw } from 'hono/html'\nexport const tools = { raw }",
          "src/web/components/probe.tsx tools: hono/html has 1, expected 0",
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
        "a property named raw": "import { raw } from 'hono/html'\nexport const f = (o) => ({ raw: o.raw })",
      },
    },
    { path: "src/web/components/probe.tsx", over: SOURCES },
  );

  // Hono's c.html writes a string as given; a page reaches it only as JSX.
  guardFixtures(
    violations,
    {
      flagged: {
        "a string": [
          "app.get('/p', (c) => c.html('<p>' + c.req.query('name') + '</p>'))",
          "src/app/probe.tsx (top level): .html() has 1, expected 0",
        ],
        "a template": [
          "export const page = (c) => c.html(`<p>${c.req.query('name')}</p>`)",
          "src/app/probe.tsx page: .html() has 1, expected 0",
        ],
        "a body of any type": [
          "function page(c, body: string) {\n\treturn c.html(body, 200)\n}",
          "src/app/probe.tsx page: .html() has 1, expected 0",
        ],
        "a computed member": [
          "export const page = (c, body) => c['html'](body)",
          "src/app/probe.tsx page: .html() has 1, expected 0",
        ],
        "an onHost of another module": [
          "import { onHost } from './host'\nexport const page = (c, body) => c.html(onHost(c.req.url, body))",
          "src/app/probe.tsx page: .html() has 1, expected 0",
        ],
      },
      passed: {
        JSX: "export const page = (c) => c.html(<p>{c.req.query('name')}</p>)",
        "a body in a fragment": "export const page = (c, body: string) => c.html(<>{body}</>, 200)",
        "onHost's page":
          "import { onHost } from '../web/components/layout'\nexport const page = (c, body) => c.html(onHost(c.req.url, body))",
      },
    },
    { path: "src/app/probe.tsx", over: SOURCES },
  );

  const HTML_TSX = SOURCES.find((source) => source.path === "src/web/components/html.tsx")!.text;
  guardFixtures(
    violations,
    {
      flagged: {
        "a second use of the doctype's import": [
          `${HTML_TSX}\nexport const Snippet = (text: string) => raw(text)\n`,
          "src/web/components/html.tsx Snippet: hono/html has 1, expected 0",
        ],
      },
      passed: { "the doctype": HTML_TSX },
    },
    { path: "src/web/components/html.tsx", over: SOURCES },
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
