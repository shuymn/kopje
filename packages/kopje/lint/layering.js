import { packagePath } from "./paths.js";

// worker -> app/jobs -> {mastodon, federation, web} -> domain -> {db, platform, security}
// A module may import its own layer or any lower one. Top-level files (worker.ts, store.ts, version.ts) are the entry
// tier. Durable Object features (cloudflare:*) belong to platform and the entry tier only. src/client is the browser's
// L1 bundle (docs/web-pages.md), a program of its own: it imports only its own modules, and nothing imports it (having
// no rank, it is neither above nor below any layer). Every specifier counts: import and export declarations, import()
// and import types; an import() whose specifier is not a string literal is refused, as its layer cannot be read.
const CLIENT = "client";
const RANK = {
  worker: 0,
  app: 1,
  jobs: 1,
  mastodon: 2,
  federation: 2,
  web: 2,
  domain: 3,
  db: 4,
  platform: 4,
  security: 4,
};
const PLATFORM_MODULE_LAYERS = new Set(["worker", "platform"]);

function layerOf(file) {
  const parts = file.replace(/^src\//, "").split("/");
  return parts.length === 1 ? "worker" : parts[0];
}

// The package-relative path a relative specifier of `from` names (`../db/sql` from `src/web/a.ts` is `src/db/sql`).
function resolve(from, specifier) {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

// What is wrong with `specifier` (null for a computed one) imported by a module of layer `from` at `file`, or null.
function problem(file, from, specifier) {
  if (specifier === null) {
    return "imports a computed specifier";
  }
  if (specifier.startsWith("cloudflare:") && !PLATFORM_MODULE_LAYERS.has(from)) {
    return `${from} imports ${specifier}`;
  }
  const target = specifier.startsWith(".") ? resolve(file, specifier) : null;
  if (target === null || !target.startsWith("src/")) {
    return from === CLIENT ? `client imports ${specifier}` : null;
  }
  const to = layerOf(target);
  const allowed = to === from || (RANK[to] ?? -1) > (RANK[from] ?? Infinity);
  return allowed ? null : `${from} imports ${to} (${specifier})`;
}

export const layering = {
  create(context) {
    const file = packagePath(context.filename);
    if (file === null || !file.startsWith("src/")) {
      return {};
    }
    const from = layerOf(file);
    if (from !== CLIENT && RANK[from] === undefined) {
      return { Program: (node) => context.report({ node, message: "directory is not part of the layering" }) };
    }
    const check = (node, specifier) => {
      const message = problem(file, from, specifier);
      if (message !== null) {
        context.report({ node, message });
      }
    };
    const declared = (node) => check(node, node.source.value);
    return {
      ImportDeclaration: declared,
      ExportAllDeclaration: declared,
      TSImportType: declared,
      ExportNamedDeclaration: (node) => node.source !== null && declared(node),
      ImportExpression: (node) =>
        check(node, node.source.type === "Literal" && typeof node.source.value === "string" ? node.source.value : null),
    };
  },
};
