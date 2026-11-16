import { readFileSync } from "node:fs";

import { Application, Group, Organization, Person, Service } from "@fedify/vocab";
import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { editOnce, guardFixtures, parse, type Source, sources, walk } from "./source-scan.js";

// #1709: Fedify parses an actor document holding only the members of src/federation/remote-actor.ts FEDIFY_MEMBERS
// (fedifyActorView), so a property Kopje reads from Fedify's Actor object is the document's only if its member is
// there. Every Actor property remote-actor.ts and inbound.ts read names an inventory member through ACCESSORS; a read
// of any other Fedify Actor accessor, or one whose member the inventory lacks, fails. An Actor is seen as a parameter
// typed `Actor`, a value isActor() narrows, a fetch's `.actor`, and what is destructured from one; a read through
// another name (an alias, a helper's parameter of another type) is not seen.

const FILES = ["src/federation/remote-actor.ts", "src/federation/inbound.ts"];
const INVENTORY_FILE = "src/federation/remote-actor.ts";

// The Fedify Actor accessors Kopje reads, each with the member of the document it reads. getActorTypeName reads the
// type.
const ACCESSORS: Readonly<Record<string, string>> = {
  id: "id",
  preferredUsername: "preferredUsername",
  inboxId: "inbox",
  name: "name",
  summary: "summary",
  url: "url",
  manuallyApprovesFollowers: "manuallyApprovesFollowers",
  discoverable: "discoverable",
  indexable: "indexable",
  published: "published",
  successorId: "movedTo",
  aliasIds: "alsoKnownAs",
  publicKeyIds: "publicKey",
  getPublicKeys: "publicKey",
  assertionMethodIds: "assertionMethod",
  getAssertionMethods: "assertionMethod",
};

// Every accessor Fedify 2.4.5's Actor classes have: an instance's own (`id`) and their prototypes' up to the
// vocabulary's Object.
const FEDIFY_ACCESSORS: ReadonlySet<string> = new Set(
  [Application, Group, Organization, Person, Service].flatMap((cls) => {
    const names: string[] = Object.getOwnPropertyNames(new cls({}));
    for (
      let proto = cls.prototype;
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      names.push(...Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor"));
    }
    return names;
  }),
);

const name = (node: Node | null | undefined): string | null =>
  node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : null;

// The keys of FEDIFY_MEMBERS's object literal in `source`.
function inventoryOf(source: Source): Set<string> {
  const keys = new Set<string>();
  walk(parse(source).program, (node) => {
    if (node.type === "VariableDeclarator" && name(node.id) === "FEDIFY_MEMBERS" && node.init !== null) {
      const init = node.init.type === "TSAsExpression" ? node.init.expression : node.init;
      if (init.type === "ObjectExpression") {
        for (const property of init.properties) {
          const key = property.type === "Property" ? name(property.key) : null;
          if (key !== null) {
            keys.add(key);
          }
        }
      }
    }
  });
  return keys;
}

// Whether `node` is an Actor in `source`: an identifier among `actors`, or a member `.actor` of anything.
function isActorValue(node: Node, actors: ReadonlySet<string>): boolean {
  if (node.type === "Identifier") {
    return actors.has(node.name);
  }
  return node.type === "MemberExpression" && !node.computed && name(node.property) === "actor";
}

// The Fedify Actor accessors each file reads, as `path accessor`.
function reads(files: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of files) {
    const { program } = parse(source);
    const actors = new Set<string>();
    walk(program, (node) => {
      const params =
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
          ? node.params
          : [];
      for (const param of params) {
        const annotation = param.type === "Identifier" ? param.typeAnnotation?.typeAnnotation : undefined;
        if (annotation?.type === "TSTypeReference" && name(annotation.typeName) === "Actor") {
          actors.add((param as { name: string }).name);
        }
      }
      if (
        node.type === "CallExpression" &&
        name(node.callee) === "isActor" &&
        node.arguments[0]?.type === "Identifier"
      ) {
        actors.add(node.arguments[0].name);
      }
    });
    walk(program, (node) => {
      if (node.type === "MemberExpression" && !node.computed && isActorValue(node.object, actors)) {
        found.push(`${source.path} ${name(node.property)}`);
      }
      if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init !== null) {
        if (isActorValue(node.init, actors)) {
          for (const property of node.id.properties) {
            if (property.type === "Property") {
              found.push(`${source.path} ${name(property.key)}`);
            }
          }
        }
      }
      if (
        node.type === "CallExpression" &&
        name(node.callee) === "getActorTypeName" &&
        node.arguments[0] !== undefined &&
        isActorValue(node.arguments[0], actors)
      ) {
        found.push(`${source.path} getActorTypeName`);
      }
    });
  }
  return found;
}

// The finding of each read that names no inventory member.
function find(all: readonly Source[]): string[] {
  const inventory = inventoryOf(all.find((s) => s.path === INVENTORY_FILE)!);
  return reads(all.filter((s) => FILES.includes(s.path))).flatMap((read) => {
    const accessor = read.slice(read.lastIndexOf(" ") + 1);
    const member = accessor === "getActorTypeName" ? "type" : ACCESSORS[accessor];
    if (member === undefined) {
      return FEDIFY_ACCESSORS.has(accessor) ? [`${read}: an accessor ACCESSORS does not map`] : [];
    }
    return inventory.has(member) ? [] : [`${read}: reads ${member}, which FEDIFY_MEMBERS lacks`];
  });
}

const SOURCES = sources("src/federation", [".ts"]);

describe("the members Fedify is handed (#1709)", () => {
  it("every Actor property read names an inventory member", () => {
    expect(find(SOURCES)).toEqual([]);
  });

  it("sees the reads it guards", () => {
    const seen = new Set(reads(SOURCES.filter((s) => FILES.includes(s.path))).map((r) => r.slice(r.indexOf(" ") + 1)));
    for (const accessor of ["id", "inboxId", "preferredUsername", "publicKeyIds", "aliasIds", "getActorTypeName"]) {
      expect(seen, accessor).toContain(accessor);
    }
    expect(FEDIFY_ACCESSORS).toContain("followersId");
    for (const accessor of Object.keys(ACCESSORS)) {
      expect(FEDIFY_ACCESSORS, accessor).toContain(accessor);
    }
  });

  const INBOUND = "src/federation/inbound.ts";
  guardFixtures(
    find,
    {
      flagged: {
        "a parameter typed Actor": [
          "function f(actor: Actor) { return actor.followersId; }",
          `${INBOUND} followersId: an accessor ACCESSORS does not map`,
        ],
        "a fetch's actor": [
          "const x = fetched.actor.endpoints;",
          `${INBOUND} endpoints: an accessor ACCESSORS does not map`,
        ],
        "a value isActor narrows": [
          "if (isActor(o)) { use(o.iconId); }",
          `${INBOUND} iconId: an accessor ACCESSORS does not map`,
        ],
        "a destructured accessor": [
          "const { outboxId } = loaded.actor;",
          `${INBOUND} outboxId: an accessor ACCESSORS does not map`,
        ],
        // #1710: published is read from the JSON (json-shapes.ts railsTime), never from Fedify's object.
        "a read of published": [
          "function f(actor: Actor) { return actor.published; }",
          `${INBOUND} published: reads published, which FEDIFY_MEMBERS lacks`,
        ],
      },
      passed: {
        "a mapped accessor": "if (!fetched.actor.aliasIds.some((a) => a.href === x)) {}",
        "a property no Actor has": "use(states.actor.revision);",
        "a parameter of another type": "function f(actor: string) { return actor.length; }",
      },
    },
    { path: INBOUND, over: SOURCES },
  );

  // An inventory without a member a read needs.
  const real = readFileSync(new URL(`../${INVENTORY_FILE}`, import.meta.url), "utf8");
  guardFixtures(
    find,
    {
      flagged: {
        "an inventory without inbox": [
          editOnce(real, /\n {2}inbox: "remoteActorInput",/, ""),
          `${INVENTORY_FILE} inboxId: reads inbox, which FEDIFY_MEMBERS lacks`,
        ],
      },
      passed: { "the inventory as written": real },
    },
    { path: INVENTORY_FILE, over: SOURCES },
  );
});
