import { packagePath } from "./paths.js";

// Outbound delivery goes through the deliveries table, never through Fedify: its queue carries private keys in plain
// JWK, enqueues after the Store commit, and loses order. So the sources must not send with Fedify, give it a queue, or
// run its queue. A name counts wherever it is spelled in code: an identifier, a member (`x.name`, `x['name']`), an
// import or a destructured key.
//
// A relayed revocation is applied on the author's proof (federation/author-proof.ts): Fedify's LD-signature and object
// proof verifiers run there only, against a key the author's own document embeds, and nowhere else decides on them.
// Kopje's own LD signatures (a stamp's Delete, a public or unlisted status's Delete) are made in ld-sign.ts only, with
// the preloaded contexts and a key unwrapped for the call (DATA-1). test-node/fedify-usage.test.ts shows that those
// two files still name them.
const NAMES = {
  sendActivity: "uses sendActivity",
  forwardActivity: "uses forwardActivity",
  startQueue: "uses Fedify queue processing",
  processQueuedTask: "uses Fedify queue processing",
  InProcessMessageQueue: "uses a Fedify message queue",
  ParallelMessageQueue: "uses a Fedify message queue",
  WorkersMessageQueue: "uses a Fedify message queue",
};
const VERIFIERS = new Set(["verifyJsonLd", "verifyObject", "verifyProof", "verifySignature"]);
const SIGNERS = new Set(["signJsonLd", "signObject"]);
const QUEUE_PACKAGE = "@fedify/cfworkers";
const FACTORY = /^createFederation(Builder)?$/;

// The name a key or property node spells statically: an identifier, or a string or expressionless template literal in
// brackets.
function nameOf(node) {
  if (node?.type === "Identifier") {
    return node.name;
  }
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis[0]?.value.cooked ?? null)
    : null;
}

export const fedifyUsage = {
  create(context) {
    const file = packagePath(context.filename);
    const named = (node, name) => {
      if (Object.hasOwn(NAMES, name)) {
        context.report({ node, message: NAMES[name] });
      } else if (VERIFIERS.has(name) && file !== "src/federation/author-proof.ts") {
        context.report({ node, message: `${name}: Fedify's verifiers run in federation/author-proof.ts only` });
      } else if (SIGNERS.has(name) && file !== "src/federation/ld-sign.ts") {
        context.report({ node, message: `${name}: Kopje's LD signatures are made in federation/ld-sign.ts only` });
      }
    };
    return {
      Identifier: (node) => named(node, node.name),
      Literal(node) {
        if (typeof node.value !== "string") {
          return;
        }
        if (node.value.includes(QUEUE_PACKAGE)) {
          context.report({ node, message: "uses a Fedify message queue" });
        }
        named(node, node.value);
      },
      TemplateElement(node) {
        if ((node.value.cooked ?? node.value.raw).includes(QUEUE_PACKAGE)) {
          context.report({ node, message: "uses a Fedify message queue" });
        }
      },
      // A template without expressions spells its name as statically as a string (`x[\`sendActivity\`]`).
      TemplateLiteral(node) {
        const name = nameOf(node);
        if (name !== null) {
          named(node, name);
        }
      },
      // A queue given to the federation's factory anywhere in its arguments, shorthand included.
      Property(node) {
        const key = node.computed && node.key.type === "Identifier" ? null : nameOf(node.key);
        if (key !== "queue") {
          return;
        }
        for (let at = node.parent; at !== null && at !== undefined; at = at.parent) {
          if (at.type === "CallExpression") {
            const callee = at.callee.type === "MemberExpression" ? nameOf(at.callee.property) : nameOf(at.callee);
            if (
              callee !== null &&
              FACTORY.test(callee) &&
              at.arguments.some((a) => a.start <= node.start && node.end <= a.end)
            ) {
              context.report({ node, message: "uses a Fedify message queue" });
              return;
            }
          }
        }
      },
    };
  },
};
