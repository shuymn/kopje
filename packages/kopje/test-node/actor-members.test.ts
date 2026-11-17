import { readFileSync } from "node:fs";

import { Application, Group, Organization, Person, Service } from "@fedify/vocab";
import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { editOnce, guardFixtures, parse, type Source, sources, walk } from "./source-scan.js";

// #1709: Fedify parses an actor document holding only the members of src/federation/remote-actor.ts FEDIFY_MEMBERS
// (fedifyActorView), so a property Kopje reads from Fedify's Actor object is the document's only if its member is
// there. Every Actor property remote-actor.ts and inbound.ts read names an inventory member through ACCESSORS; a read
// of any other Fedify Actor accessor, a computed key that is not a literal, or one whose member the inventory lacks,
// fails. An Actor is seen as actorNames binds it and as a fetch's `.actor`; one reached otherwise (returned by a call,
// held in a property or a collection) is not seen.

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

// The types an Actor is declared with: Fedify's Actor and its classes, and a file's aliases of them.
const ACTOR_TYPES = ["Actor", "Application", "Group", "Organization", "Person", "Service"];

// Whether `type` names an Actor type, alone or in a union (`Actor | null`).
function isActorType(type: Node | null | undefined, types: ReadonlySet<string>): boolean {
  if (type?.type === "TSTypeReference") {
    return types.has(name(type.typeName) ?? "");
  }
  return type?.type === "TSUnionType" && type.types.some((member) => isActorType(member, types));
}

// The property a member expression reads: its name, or a computed key that is a string literal or a template without
// expressions (`actor["published"]`); null for any other computed key.
function propertyOf(node: Node & { type: "MemberExpression" }): string | null {
  const key = node.property;
  if (!node.computed || key.type === "Literal") {
    return name(key);
  }
  return key.type === "TemplateLiteral" && key.expressions.length === 0 ? (key.quasis[0]?.value.cooked ?? null) : null;
}

// Whether `node` is an Actor: a cast to an Actor type, an identifier among `actors`, or a member `actor` of anything
// (a fetch's result), through `!`, `as`, `satisfies` and optional chaining.
function isActorValue(node: Node, actors: ReadonlySet<string>, types: ReadonlySet<string>): boolean {
  let value = node;
  for (;;) {
    if (
      (value.type === "TSAsExpression" || value.type === "TSSatisfiesExpression") &&
      isActorType(value.typeAnnotation, types)
    ) {
      return true;
    }
    if (
      value.type === "TSNonNullExpression" ||
      value.type === "TSAsExpression" ||
      value.type === "TSSatisfiesExpression" ||
      value.type === "ChainExpression"
    ) {
      value = value.expression;
      continue;
    }
    break;
  }
  if (value.type === "Identifier") {
    return actors.has(value.name);
  }
  return value.type === "MemberExpression" && propertyOf(value) === "actor";
}

// The names a file binds to an Actor, to a fixed point: parameters and variables declared with an Actor type (a
// file's `type A = Actor` included), values isActor() narrows, variables initialized from an Actor (an alias, a
// fetch's `.actor`) and an `actor` destructured from anything. Names are not scoped: a name bound to an Actor anywhere
// in the file counts everywhere, which can only add reads.
function actorNames(program: Node): { actors: Set<string>; types: Set<string> } {
  const actors = new Set<string>();
  const types = new Set(ACTOR_TYPES);
  let size = -1;
  while (size !== actors.size + types.size) {
    size = actors.size + types.size;
    walk(program, (node) => {
      if (node.type === "TSTypeAliasDeclaration" && isActorType(node.typeAnnotation, types)) {
        types.add(node.id.name);
      }
      const params =
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
          ? node.params
          : [];
      for (const param of params) {
        const target = param.type === "AssignmentPattern" ? param.left : param;
        if (target.type === "Identifier" && isActorType(target.typeAnnotation?.typeAnnotation, types)) {
          actors.add(target.name);
        }
      }
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        if (
          isActorType(node.id.typeAnnotation?.typeAnnotation, types) ||
          (node.init !== null && isActorValue(node.init, actors, types))
        ) {
          actors.add(node.id.name);
        }
      }
      if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          if (property.type === "Property" && name(property.key) === "actor" && property.value.type === "Identifier") {
            actors.add(property.value.name);
          }
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
  }
  return { actors, types };
}

// The Fedify Actor accessors each file reads, as `path accessor`.
function reads(files: readonly Source[]): string[] {
  const found: string[] = [];
  for (const source of files) {
    const { program } = parse(source);
    const { actors, types } = actorNames(program);
    walk(program, (node) => {
      if (node.type === "MemberExpression" && isActorValue(node.object, actors, types)) {
        const property = propertyOf(node);
        found.push(`${source.path} ${property ?? "(a computed key)"}`);
      }
      if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init !== null) {
        if (isActorValue(node.init, actors, types)) {
          for (const property of node.id.properties) {
            if (property.type === "Property") {
              found.push(`${source.path} ${name(property.key) ?? "(a computed key)"}`);
            }
          }
        }
      }
      if (
        node.type === "CallExpression" &&
        name(node.callee) === "getActorTypeName" &&
        node.arguments[0] !== undefined &&
        isActorValue(node.arguments[0], actors, types)
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
    const accessor = read.slice(read.indexOf(" ") + 1);
    const member = accessor === "getActorTypeName" ? "type" : ACCESSORS[accessor];
    if (member === undefined) {
      return FEDIFY_ACCESSORS.has(accessor) || accessor === "(a computed key)"
        ? [`${read}: an accessor ACCESSORS does not map`]
        : [];
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
        // #1734: url is read from the JSON (remote-actor.ts profileUrl), never from Fedify's object.
        "a read of url": [
          "function f(actor: Actor) { return actor.url; }",
          `${INBOUND} url: reads url, which FEDIFY_MEMBERS lacks`,
        ],
        // #1747: the flags are read from the JSON as Rails casts them (remote-actor.ts remoteActorInput), never from
        // Fedify's object.
        "a read of manuallyApprovesFollowers": [
          "function f(actor: Actor) { return actor.manuallyApprovesFollowers; }",
          `${INBOUND} manuallyApprovesFollowers: an accessor ACCESSORS does not map`,
        ],
        "a read of discoverable": [
          "function f(actor: Actor) { return actor.discoverable; }",
          `${INBOUND} discoverable: an accessor ACCESSORS does not map`,
        ],
        "a read of indexable": [
          "function f(actor: Actor) { return actor.indexable; }",
          `${INBOUND} indexable: an accessor ACCESSORS does not map`,
        ],
        "an alias": [
          "function f(actor: Actor) { const alias = actor; const again = alias; return again.published; }",
          `${INBOUND} published: reads published, which FEDIFY_MEMBERS lacks`,
        ],
        "a helper typed with an alias of Actor": [
          "type Remote = Actor | null; type Other = Remote; function f(a: Other) { return a?.published; }",
          `${INBOUND} published: reads published, which FEDIFY_MEMBERS lacks`,
        ],
        "a parameter typed as an Actor class, with a default": [
          "function f(p: Person = make()) { return p.followersId; }",
          `${INBOUND} followersId: an accessor ACCESSORS does not map`,
        ],
        "a literal computed key": [
          'function f(actor: Actor) { return actor["published"]; }',
          `${INBOUND} published: reads published, which FEDIFY_MEMBERS lacks`,
        ],
        "a template computed key": [
          "function f(actor: Actor) { return actor[`followersId`]; }",
          `${INBOUND} followersId: an accessor ACCESSORS does not map`,
        ],
        "a computed key of a variable": [
          "function f(actor: Actor, key: string) { return actor[key]; }",
          `${INBOUND} (a computed key): an accessor ACCESSORS does not map`,
        ],
        "a cast": ["use((value as Actor).followersId);", `${INBOUND} followersId: an accessor ACCESSORS does not map`],
        "a non-null assertion on an alias of a fetch's actor": [
          "const a = loaded.actor; use(a!.endpoints);",
          `${INBOUND} endpoints: an accessor ACCESSORS does not map`,
        ],
        "an actor destructured from a fetch": [
          "const { actor } = loaded; use(actor.outboxId);",
          `${INBOUND} outboxId: an accessor ACCESSORS does not map`,
        ],
        "a variable declared an Actor": [
          "let a: Actor | undefined; use(a?.followingId);",
          `${INBOUND} followingId: an accessor ACCESSORS does not map`,
        ],
      },
      passed: {
        "a mapped accessor": "if (!fetched.actor.aliasIds.some((a) => a.href === x)) {}",
        "a mapped accessor through an alias": 'const a = fetched.actor; use(a["aliasIds"]);',
        "a property no Actor has": "use(states.actor.revision);",
        "a parameter of another type": "function f(actor: string) { return actor.length; }",
        "a type alias of another type": "type Remote = string; function f(a: Remote) { return a.published; }",
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
