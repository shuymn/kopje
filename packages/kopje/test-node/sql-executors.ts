import type { Node } from "oxc-parser";

import { parse, type Source, walk } from "./source-scan.js";

// The shared executors of the domain code: functions that run SQL their caller hands them, so the plan audit's site of
// a statement they run (test/plan-audit.ts callerFrames, the first frame below Db) names them and not the reader that
// wrote the statement (audience.ts's statusReads `run`, under its `select`; windows.ts singleWindow). Derived from the
// source, as `path#name` (a method's name without its object): a function is one when, at the SQL argument of a Db
// call (`db.all`, `first`, `run`, `iterate`) or of another executor's call, it passes one of its own parameters, a
// member of one, a template literal interpolating either, or a local constant initialized from any of these. An
// executor is called by its name in its own file or under an imported name, or, for a method of an object or a class,
// as a member of that name.

const DB_METHODS = new Set(["all", "first", "run", "iterate"]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

type Named = Node & { name: string };
type Fn = { path: string; name: string; method: boolean; node: Node; params: string[][]; imports: Set<string> };

// The name a stack frame gives the function `node` with ancestors `parents` (its declaration's, its variable's, its
// property's or method's key), and whether it is a method; null for one V8 names `<anonymous>`.
function nameOf(node: Node, parents: Node[]): { name: string; method: boolean } | null {
  const id = (node as Node & { id?: Named | null }).id;
  if (id?.name !== undefined) {
    return { name: id.name, method: false };
  }
  const parent = parents[0] as (Node & { id?: Node; key?: Node }) | undefined;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return { name: (parent.id as Named).name, method: false };
  }
  if ((parent?.type === "Property" || parent?.type === "MethodDefinition") && parent.key?.type === "Identifier") {
    return { name: (parent.key as Named).name, method: true };
  }
  return null;
}

// The names each parameter binds, by its place (a destructured one binds several; a type or a default binds none).
function paramNames(node: Node): string[][] {
  return (node as Node & { params: Node[] }).params.map((param) => {
    const names: string[] = [];
    const bind = (target: Node): void => {
      const t = target as Node & Record<string, unknown>;
      if (t.type === "Identifier") {
        names.push(t.name);
      } else if (t.type === "RestElement") {
        bind(t.argument);
      } else if (t.type === "AssignmentPattern") {
        bind(t.left);
      } else if (t.type === "ObjectPattern") {
        for (const property of t.properties as Node[]) {
          bind(property.type === "RestElement" ? property : (property as Node & { value: Node }).value);
        }
      } else if (t.type === "ArrayPattern") {
        for (const element of t.elements as (Node | null)[]) {
          if (element !== null) {
            bind(element);
          }
        }
      } else if (t.type === "TSParameterProperty") {
        bind(t.parameter);
      }
    };
    bind(param);
    return names;
  });
}

export function sqlExecutors(files: readonly Source[]): Set<string> {
  const fns: Fn[] = [];
  for (const source of files) {
    const { program } = parse(source);
    const imports = new Set<string>();
    for (const statement of program.body) {
      if (statement.type === "ImportDeclaration") {
        for (const specifier of statement.specifiers) {
          imports.add(specifier.local.name);
        }
      }
    }
    walk(program, (node, parents) => {
      const named = FUNCTION_TYPES.has(node.type) ? nameOf(node, parents) : null;
      if (named !== null) {
        fns.push({ path: source.path, ...named, node, params: paramNames(node), imports });
      }
    });
  }
  const executors = new Map<Fn, Set<number>>();
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of fns) {
      const known = executors.get(fn) ?? new Set<number>();
      const places = sqlPlaces(fn, executors);
      if ([...places].some((place) => !known.has(place))) {
        executors.set(fn, new Set([...known, ...places]));
        changed = true;
      }
    }
  }
  return new Set([...executors.keys()].map((fn) => `${fn.path}#${fn.name}`));
}

// The places of `fn`'s parameters that reach the SQL argument of a Db call or of an executor's call in its body.
function sqlPlaces(fn: Fn, executors: ReadonlyMap<Fn, ReadonlySet<number>>): Set<number> {
  const params = new Set(fn.params.flat());
  const locals = new Map<string, Node>();
  walk(fn.node, (node) => {
    const d = node as Node & { id?: Node; init?: Node | null };
    if (node.type === "VariableDeclarator" && d.id?.type === "Identifier" && d.init) {
      locals.set((d.id as Named).name, d.init);
    }
  });
  // The parameters an argument's SQL comes from.
  const from = (arg: Node, seen: Set<string>): string[] => {
    if (arg.type === "Identifier") {
      const name = (arg as Named).name;
      const init = locals.get(name);
      if (params.has(name)) {
        return [name];
      }
      if (init === undefined || seen.has(name)) {
        return [];
      }
      seen.add(name);
      const found: string[] = [];
      walk(init, (inner) => {
        if (inner.type === "Identifier" && params.has((inner as Named).name)) {
          found.push((inner as Named).name);
        }
      });
      return found;
    }
    if (arg.type === "MemberExpression") {
      return from((arg as Node & { object: Node }).object, seen);
    }
    if (arg.type === "TemplateLiteral") {
      // Only a parameter, or a member of one, interpolated as it is: a local derived from one (a sort order) is the
      // reader's own SQL.
      return (arg as Node & { expressions: Node[] }).expressions.flatMap((e) => {
        const root = e.type === "MemberExpression" ? (e as Node & { object: Node }).object : e;
        return root.type === "Identifier" && params.has((root as Named).name) ? [(root as Named).name] : [];
      });
    }
    return [];
  };
  // The SQL places of the function a call names.
  const placesOf = (callee: Node): number[] => {
    if (callee.type === "Identifier") {
      const name = (callee as Named).name;
      return [...executors]
        .filter(([e]) => !e.method && e.name === name && (e.path === fn.path || fn.imports.has(name)))
        .flatMap(([, places]) => [...places]);
    }
    if (callee.type !== "MemberExpression") {
      return [];
    }
    const { object, property } = callee as Node & { object: Node; property: Node };
    if (property.type !== "Identifier") {
      return [];
    }
    const name = (property as Named).name;
    const receiver =
      object.type === "Identifier"
        ? (object as Named).name
        : object.type === "MemberExpression"
          ? ((object as Node & { property: Named }).property.name ?? "")
          : "";
    if (DB_METHODS.has(name) && /^(db|this)$/i.test(receiver)) {
      return [0];
    }
    return [...executors].filter(([e]) => e.method && e.name === name).flatMap(([, places]) => [...places]);
  };
  const places = new Set<number>();
  walk(fn.node, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const call = node as Node & { callee: Node; arguments: Node[] };
    for (const index of placesOf(call.callee)) {
      const arg = call.arguments[index];
      for (const param of arg === undefined ? [] : from(arg, new Set())) {
        places.add(fn.params.findIndex((names) => names.includes(param)));
      }
    }
  });
  return places;
}
