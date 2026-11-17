import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { retractionWrittenBound } from "../src/federation/ld-signed-body";
import formsFixture from "./fixtures/ld-signed/forms.json";
import { compactedAndPatched, jsonValues } from "./ld-compaction";

// #1717, form 4: the bound mastodonCompacts holds an LD-signed retraction's compaction to (retractionWritten) is at
// least the values jsonld.js's compaction under Mastodon's full_context writes, patched as patch_for_forwarding!
// patches it, of any such body: an Undo of a block typed as absolute IRIs under the contexts the shape takes, holding
// names of each kind of definition (typed @id, untyped, a datatype, a language map, a list, one full_context alone
// defines, one it shadows, none) given values of each kind. inbox-signed-forms.test.ts holds it to Ruby's compaction
// of each captured body.

type Json = Record<string, unknown>;
type Entry = { name: string; received: Json; mastodon?: Json };

const AS = "https://www.w3.org/ns/activitystreams";
const SECURITY = "https://w3id.org/security/v1";
const BOB = "https://mastodon.example/users/bob";
const ALICE = "https://kopje.test/ap/users/alice";

const forms = new Map((formsFixture as unknown as Entry[]).map((entry) => [entry.name, entry]));
const fullContext = forms.get("type as an absolute IRI")!.mastodon!["@context"];
const contextOf = (name: string) =>
  forms.get(`Undo of a block, both typed as absolute IRIs, ${name}`)!.received["@context"];

// An Undo of a block typed as absolute IRIs, its own members ones the compaction writes as given (so that the bound is
// exact but for the members added).
const undo = (context: unknown, members: Json): Json => ({
  "@context": context,
  id: `${BOB}/activities/1`,
  type: `${AS}#Undo`,
  actor: BOB,
  object: { id: `${BOB}/blocks/1`, type: `${AS}#Block`, actor: BOB, object: ALICE },
  ...members,
  signature: {
    type: "RsaSignature2017",
    creator: `${BOB}#main-key`,
    created: "2026-11-16T12:00:00Z",
    signatureValue: "placeholder",
  },
});

const NAMES = [
  "to",
  "cc",
  "instrument",
  "content",
  "name",
  "contentMap",
  "summaryMap",
  "orderedItems",
  "published",
  "expires",
  "expiration",
  "sensitive",
  "quote",
  "votersCount",
  "padding",
  "tag",
  "url",
  "href",
];
const IRIS = [`${AS}#Public`, BOB, ALICE, `${BOB}/followers`, "http://joinmastodon.org/ns#featured", "urn:uuid:1"];
const TYPES = ["Note", "Mention", "Hashtag", "Emoji", `${AS}#Note`, "PropertyValue"];

const value = fc.letrec((tie) => ({
  tree: fc.oneof({ depthSize: "small" }, tie("leaf"), tie("array"), tie("node"), tie("map")),
  leaf: fc.oneof(
    fc.constantFrom(...IRIS),
    fc.constantFrom("x", "2026-11-18T00:00:00Z"),
    fc.integer({ min: -2, max: 2 }),
    fc.boolean(),
    fc.constant(null),
  ),
  array: fc.array(tie("tree"), { maxLength: 3 }),
  node: fc
    .record(
      {
        id: fc.constantFrom(...IRIS),
        type: fc.constantFrom(...TYPES),
        members: fc.dictionary(fc.constantFrom(...NAMES), tie("tree"), { maxKeys: 3 }),
      },
      { requiredKeys: ["members"] },
    )
    .map(({ members, ...node }) => ({ ...node, ...members })),
  map: fc.dictionary(
    fc.constantFrom("en", "ja", "EN"),
    fc.oneof(fc.constant("x"), fc.constant(null), fc.array(fc.constant("y"), { maxLength: 2 })),
    { maxKeys: 2 },
  ),
})).tree;

const body = fc
  .tuple(
    fc.constantFrom(
      [AS, SECURITY],
      [AS],
      contextOf("under Mastodon's inline context"),
      contextOf("under Fedify's inline context"),
    ),
    fc.dictionary(fc.constantFrom(...NAMES), value, { maxKeys: 4 }),
  )
  .map(([context, members]) => undo(context, members));

describe("the values of an LD-signed retraction's compaction (#1717, form 4)", () => {
  // Each a member the compaction writes with more values than given: a scalar under a list, which it writes as a list;
  // a scalar under a language map, which joins `content`; a name full_context shadows, which joins the name it writes;
  // a name the body defines otherwise, whose value it writes as a value object; a one-element array, which the patch
  // puts back.
  it.each([
    { member: "a scalar under a list", context: [AS, SECURITY], members: { orderedItems: ALICE } },
    { member: "a scalar under a language map", context: [AS, SECURITY], members: { content: "y", contentMap: "x" } },
    {
      member: "a name full_context shadows",
      context: [AS, SECURITY],
      members: { expires: "2026-11-18T00:00:00Z", expiration: "2026-11-19T00:00:00Z" },
    },
    {
      member: "a name defined otherwise",
      context: contextOf("under Fedify's inline context"),
      members: { votersCount: 3 },
    },
    { member: "a one-element array", context: [AS, SECURITY], members: { cc: [`${AS}#Public`] } },
  ])("are at most the bound, given $member", async ({ context, members }) => {
    const received = undo(context, members);
    const reading = await compactedAndPatched(received, fullContext);
    expect(reading).toBeDefined();
    expect(jsonValues(reading)).toBeLessThanOrEqual(retractionWrittenBound(received)!);
  });

  it("are at most the bound mastodonCompacts takes, for any body jsonld.js compacts", async () => {
    let compacted = 0;
    await fc.assert(
      fc.asyncProperty(body, async (received) => {
        const bound = retractionWrittenBound(received);
        expect(bound).not.toBeNull();
        const reading = await compactedAndPatched(received, fullContext);
        if (reading !== undefined) {
          compacted++;
          expect(jsonValues(reading)).toBeLessThanOrEqual(bound!);
        }
      }),
      { numRuns: 2_000 },
    );
    expect(compacted).toBeGreaterThanOrEqual(1_000);
  }, 120_000);
});
