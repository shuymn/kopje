import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { editOnce, guardFixtures, inventoryDiff, ownerOf, parse, sources, walk, type Source } from "./source-scan.js";

// #1589's D26: whether a status can tag a collection, whatever the viewer, is one decision
// (collection-presenter.ts taggableCollections: the owner available, and taggable), which the writer applies to each
// link or tag before it takes a slot and the readers to each reference before they present or name it, so a
// collection takes a slot only when every surface would show it to some viewer. This inventory holds the decision's
// three callers (the writer's taggableRow, the REST presenter's taggedCollectionsOf and the Note's statusFacts) and the
// reads of the columns it judges: its own, and R's term and column map, which charge them without reading a row. A new
// read of the columns, or a reader or writer that stops calling it, fails here.
//
// A local collection's id is built in one place (collection-presenter.ts localCollectionUri, from its owner's stored
// actor id: #1589's D1), so every surface emits the same id. The second inventory holds every text in src/ that spells a
// /collections path segment: that builder, the page's url (collectionUrl) and its route path, the routes' patterns, and
// an actor's featured and tags collections, which are not a collection of #1589. A text is a string or template literal
// (an interpolation as a placeholder), SQL string literals joined by `||` taken as one ('/' || 'collections' || '/'),
// and a `+` chain of literals as one; an array element that is exactly `collections` is a segment too ([owner,
// "collections", id].join("/")), where a call's argument is not (a table name: insertWithFreshId("collections", …)).
// What it cannot see is a path built at run time from no literal of it (a character code, a value read from elsewhere,
// the bare segment passed to a call): the dereference tests (tagged-collections.test.ts) hold every emitted id to the
// document it names.

const SOURCES = sources("src");

const EXPECTED = {
  "src/domain/collection-presenter.ts taggableCollections TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/status-rows.ts hydrateQueries TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/status-rows.ts statusRowTerms TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/collections.ts taggableRow taggableCollections": 1,
  "src/domain/collection-presenter.ts taggedCollectionsOf taggableCollections": 1,
  "src/domain/activities.ts statusFacts taggableCollections": 1,
};

const NAMES = new Set(["TAGGED_COLLECTION_COLUMNS", "taggableCollections"]);

// Each use of one of NAMES as a value (not its declaration, an import or an export), by file, owner and name.
function sites(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const { program } = parse(source);
    const found: string[] = [];
    walk(program, (node, parents) => {
      const parent = parents[0];
      if (
        node.type === "Identifier" &&
        NAMES.has(node.name) &&
        !(parent?.type === "VariableDeclarator" && parent.id === node) &&
        !(parent?.type === "FunctionDeclaration" && parent.id === node) &&
        parent?.type !== "ImportSpecifier" &&
        parent?.type !== "ExportSpecifier"
      ) {
        found.push(`${source.path} ${ownerOf(program, node.start)?.name ?? "(top level)"} ${node.name}`);
      }
    });
    return found;
  });
}

const violations = (all: readonly Source[]) => inventoryDiff(sites(all), EXPECTED);

const BUILT = {
  // The builder, and the path of its ids the collection route takes (D2).
  "src/domain/collection-presenter.ts localCollectionUri": 1,
  "src/domain/collection-presenter.ts ROUTED_ID_PATH": 1,
  // The page's url and the route path an ActivityPub client is forwarded to, which are no ids.
  "src/domain/collection-presenter.ts collectionUrl": 1,
  "src/domain/collections.ts localCollectionPath": 1,
  "src/web/pages/collection.tsx collectionPath": 1,
  "src/federation/routes.ts collectionAnswer": 1,
  // The routes' patterns: the page, the documents and the API.
  "src/app/public-pages.tsx publicPageRoutes": 2,
  "src/federation/routes.ts COLLECTION_ROUTE": 1,
  "src/federation/routes.ts COLLECTION": 1,
  "src/federation/routes.ts FEDERATION_GET_ROUTES": 2,
  "src/mastodon/routes.ts collectionRoutes": 9,
  "src/mastodon/routes.ts DEPRECATED_ROUTES": 9,
  "src/mastodon/collections.ts accountCollections": 1,
  // An actor's featured and tags collections, which are not a collection of #1589.
  "src/federation/federation.ts createKopjeFederation": 2,
  "src/domain/activities.ts featuredUri": 1,
  "src/domain/featured-tags.ts recordFeaturedChange": 1,
  "src/domain/actor-update.ts documentOf": 1,
};

// A /collections path segment.
const SEGMENT = /(^|[^A-Za-z0-9_])collections\/|\/collections($|[^A-Za-z0-9_])/;

// A literal's text, each interpolation a NUL, SQL string literals joined by || taken as one.
function textOf(parts: readonly ({ text: string } | object)[]): string {
  return parts
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : "\0"))
    .join("")
    .replace(/'\s*\|\|\s*'/g, "");
}

// The text of a `+` chain, each operand that is no literal a NUL.
function chainText(node: Node): string {
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return chainText(node.left) + chainText(node.right);
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    return textOf(
      node.quasis.flatMap((quasi, i) => [
        { text: quasi.value.cooked ?? quasi.value.raw },
        ...(i < node.expressions.length ? [{}] : []),
      ]),
    );
  }
  return "\0";
}

// A module specifier ("./collections"), which names a file and spells no path.
const SPECIFIERS = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]);

// Each text in src/ that spells a /collections segment (SEGMENT), by file and owner: a literal, or a `+` chain no
// literal of which spells one alone.
function builders(all: readonly Source[]): string[] {
  return all.flatMap((source) => {
    const { program, literals } = parse(source);
    const owner = (start: number) => `${source.path} ${ownerOf(program, start)?.name ?? "(top level)"}`;
    const found = literals
      .filter((literal) => {
        const parent = literal.parents[0]?.type ?? "";
        const text = textOf(literal.parts);
        return (
          !SPECIFIERS.has(parent) && (SEGMENT.test(text) || (parent === "ArrayExpression" && text === "collections"))
        );
      })
      .map((literal) => owner(literal.node.start));
    walk(program, (node, parents) => {
      const parent = parents[0];
      if (
        node.type === "BinaryExpression" &&
        node.operator === "+" &&
        !(parent?.type === "BinaryExpression" && parent.operator === "+") &&
        SEGMENT.test(chainText(node)) &&
        !literals.some(
          (literal) =>
            literal.node.start >= node.start && literal.node.end <= node.end && SEGMENT.test(textOf(literal.parts)),
        )
      ) {
        found.push(owner(node.start));
      }
    });
    return found;
  });
}

const builtViolations = (all: readonly Source[]) => inventoryDiff(builders(all), BUILT);

describe("the reads of a status's tagged collections (#1589's D26)", () => {
  it("decide through taggableCollections alone, the writer's and the readers' alike", () => {
    expect(violations(SOURCES)).toEqual([]);
  });

  guardFixtures(
    violations,
    {
      flagged: {
        "a read of the columns that skips the decision": [
          "function p(db) {\n\treturn db.all(`SELECT ${selectSql(TAGGED_COLLECTION_COLUMNS)} FROM collections c`)\n}",
          "src/domain/probe.ts p TAGGED_COLLECTION_COLUMNS has 1, expected 0",
        ],
      },
      passed: {
        "the names in a comment and a string": "// TAGGED_COLLECTION_COLUMNS\nconst s = 'taggableCollections'",
      },
    },
    { over: SOURCES },
  );

  const writer = SOURCES.find((source) => source.path === "src/domain/collections.ts")!;
  guardFixtures(
    violations,
    {
      flagged: {
        "a writer that resolves a candidate without the decision": [
          editOnce(writer.text, /taggableCollections\(db, \{/, "readCollections(db, {"),
          "src/domain/collections.ts taggableRow taggableCollections has 0, expected 1",
        ],
      },
      passed: {},
    },
    { path: "src/domain/collections.ts", over: SOURCES },
  );
});

describe("a local collection's id (#1589's D1)", () => {
  it("is built by localCollectionUri alone", () => {
    expect(builtViolations(SOURCES)).toEqual([]);
  });

  guardFixtures(
    builtViolations,
    {
      flagged: {
        "an id built in SQL": [
          "function d(db) {\n\treturn db.first(`SELECT o.uri || '/collections/' || c.id AS uri FROM collections c`)\n}",
          "src/domain/probe.ts d has 1, expected 0",
        ],
        "an id built in code": [
          "function e(row) {\n\treturn `${row.owner_uri}/collections/${row.id}`\n}",
          "src/domain/probe.ts e has 1, expected 0",
        ],
        "an id built by SQL concatenation of literals": [
          "function f(db) {\n\treturn db.first(`SELECT o.uri || '/' || 'collections' || '/' || c.id AS uri FROM collections c`)\n}",
          "src/domain/probe.ts f has 1, expected 0",
        ],
        "an id built by a + chain of literals": [
          "function g(row) {\n\treturn row.owner_uri + '/' + 'collections' + '/' + row.id\n}",
          "src/domain/probe.ts g has 1, expected 0",
        ],
        "an id built from the bare segment": [
          "function h(row) {\n\treturn [row.owner_uri, 'collections', row.id].join('/')\n}",
          "src/domain/probe.ts h has 1, expected 0",
        ],
      },
      passed: {
        "the path in a comment": "// `${owner}/collections/${id}`\nconst s = 1",
        "the table in SQL": "function t(db) {\n\treturn db.all(`SELECT c.id FROM collections c WHERE c.local = 1`)\n}",
      },
    },
    { over: SOURCES },
  );

  // Outside src/domain too: a route or a page that spells the path is held as the domain's code is.
  guardFixtures(
    builtViolations,
    {
      flagged: {
        "an id built in a page": [
          "export function a(owner, id) {\n\treturn `${owner}/collections/${id}`\n}",
          "src/web/probe.tsx a has 1, expected 0",
        ],
      },
      passed: {},
    },
    { path: "src/web/probe.tsx", over: SOURCES },
  );
});
