import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { fedifyUsage } from "../lint/fedify-usage.js";
import { parse, sources } from "./source-scan.js";

// The kopje/fedify-usage rule (lint/fedify-usage.js): the sources never send or queue through Fedify, verify author
// proofs in author-proof.ts only, and sign Linked Data in ld-sign.ts only.
RuleTester.describe = describe;
RuleTester.it = it;

const PROBE = "packages/kopje/src/domain/probe.ts";
const QUEUE = "uses a Fedify message queue";
const VERIFIES = "verifyObject: Fedify's verifiers run in federation/author-proof.ts only";
const flagged = (code: string, ...messages: string[]) => ({
  code,
  errors: messages.map((message) => ({ message })),
  filename: PROBE,
});

new RuleTester().run("fedify-usage", fedifyUsage, {
  invalid: [
    flagged("await ctx.sendActivity({ identifier }, recipient, activity)", "uses sendActivity"),
    flagged('await ctx.forwardActivity(sender, "followers")', "uses forwardActivity"),
    flagged("federation.startQueue(data)", "uses Fedify queue processing"),
    flagged("await federation.processQueuedTask(ctx, message)", "uses Fedify queue processing"),
    flagged("import { InProcessMessageQueue } from '@fedify/fedify'", QUEUE, QUEUE),
    flagged("const q: ParallelMessageQueue = make()", QUEUE),
    flagged("import { WorkersMessageQueue } from '@fedify/cfworkers'", QUEUE, QUEUE, QUEUE),
    flagged("createFederation<State>({ kv, queue: mq })", QUEUE),
    flagged("createFederationBuilder({ kv, queue })", QUEUE),
    flagged("fedify.createFederation({ kv: { a: 1 }, queue: mq })", QUEUE),
    flagged("ctx['sendActivity'](sender, recipient, activity)", "uses sendActivity"),
    flagged("const { forwardActivity } = ctx", "uses forwardActivity", "uses forwardActivity"),
    flagged("const m = await import('@fedify/cfworkers')", QUEUE),
    flagged("const q = new fedify[`InProcessMessageQueue`]()", QUEUE),
    flagged("await fedify[`verifyObject`](doc)", VERIFIES),
    flagged(
      "await fedify[`signJsonLd`](doc, key, id)",
      "signJsonLd: Kopje's LD signatures are made in federation/ld-sign.ts only",
    ),
    flagged("createFederation({ kv, [`queue`]: mq })", QUEUE),
    flagged("import { verifyObject } from '@fedify/fedify'", VERIFIES, VERIFIES),
    flagged(
      "const signed = await signJsonLd(doc, key, id)",
      "signJsonLd: Kopje's LD signatures are made in federation/ld-sign.ts only",
    ),
  ],
  valid: [
    {
      code: "// ctx.sendActivity(...), createFederation({ queue: q }), verifyObject, signJsonLd\nf()",
      filename: PROBE,
    },
    { code: "const options = { queue: q }\ncreateFederation({ kv })", filename: PROBE },
    { code: "const m = fedify[`${name}`]", filename: PROBE },
    {
      code: "import { verifyObject } from '@fedify/fedify'\nawait verifyObject(doc)",
      filename: "packages/kopje/src/federation/author-proof.ts",
    },
    {
      code: "import { signJsonLd } from '@fedify/fedify'\nawait signJsonLd(doc, key, id)",
      filename: "packages/kopje/src/federation/ld-sign.ts",
    },
  ],
});

// The rule allows the verifiers and signers in their files; these still use them, so the allowance is not stale.
describe("Fedify usage", () => {
  const names = (path: string, pattern: RegExp) => {
    const source = sources("src/federation", [".ts"]).find((s) => s.path === path);
    return source !== undefined && pattern.test(parse(source).code);
  };

  it("verifies author proofs in author-proof.ts", () => {
    expect(names("src/federation/author-proof.ts", /\b(verifyJsonLd|verifyObject|verifyProof|verifySignature)\b/)).toBe(
      true,
    );
  });

  it("signs Linked Data in ld-sign.ts", () => {
    expect(names("src/federation/ld-sign.ts", /\b(signJsonLd|signObject)\b/)).toBe(true);
  });
});
