import { describe, expect, it } from "vitest";

import { editOnce, guardFixtures, inventoryDiff, ownerOf, parse, sources, walk, type Source } from "./source-scan.js";

// #1589's D26: whether a status can tag a collection, whatever the viewer, is one decision
// (collection-presenter.ts taggableCollections: the owner available, and taggable), which the writer applies to each
// link or tag before it takes a slot and the readers to each reference before they present or name it, so a
// collection takes a slot only when every surface would show it to some viewer. This inventory holds the decision's
// three callers (the writer's taggableId, the REST presenter's taggedCollectionsOf and the Note's statusFacts) and the
// reads of the columns it judges: its own, and R's term and column map, which charge them without reading a row. A new
// read of the columns, or a reader or writer that stops calling it, fails here.
//
// A local collection's id is built in one place (collection-presenter.ts localCollectionUri, from the owner's columns
// collectionOwnerColumns reads), so the id a surface emits is the one its route serves its document under. The second
// inventory holds every text in src/domain that spells a path under /collections/: that builder, the page's url
// (collectionUrl) and an actor's featured and tags collections, which are not a collection of #1589. A surface that
// builds a collection's id its own way, in code or in SQL, fails here.

const SOURCES = sources("src");

const EXPECTED = {
  "src/domain/collection-presenter.ts taggableCollections TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/status-rows.ts hydrateQueries TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/status-rows.ts statusRowTerms TAGGED_COLLECTION_COLUMNS": 1,
  "src/domain/collections.ts taggableId taggableCollections": 1,
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
  "src/domain/collection-presenter.ts localCollectionUri": 1,
  "src/domain/collection-presenter.ts collectionUrl": 1,
  "src/domain/activities.ts featuredUri": 1,
  "src/domain/featured-tags.ts recordFeaturedChange": 1,
  "src/domain/actor-update.ts documentOf": 1,
};

// Each string or template in src/domain whose text spells /collections/, by file and owner.
function builders(all: readonly Source[]): string[] {
  return all
    .filter((source) => source.path.startsWith("src/domain/"))
    .flatMap((source) => {
      const { program, literals } = parse(source);
      return literals
        .filter((literal) => literal.parts.some((part) => "text" in part && part.text.includes("/collections/")))
        .map((literal) => `${source.path} ${ownerOf(program, literal.node.start)?.name ?? "(top level)"}`);
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
          editOnce(
            writer.text,
            /taggableCollections\(\n\s*db,\n\s*origin,/,
            "readCollections(\n      db,\n      origin,",
          ),
          "src/domain/collections.ts taggableId taggableCollections has 0, expected 1",
        ],
      },
      passed: {},
    },
    { path: "src/domain/collections.ts", over: SOURCES },
  );
});

describe("a local collection's id (#1589's D26)", () => {
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
      },
      passed: {
        "the path in a comment": "// `${owner}/collections/${id}`\nconst s = 1",
      },
    },
    { over: SOURCES },
  );
});
