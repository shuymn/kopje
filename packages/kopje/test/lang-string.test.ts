import { describe, expect, it } from "vitest";

import { firstLangString, remoteDescription } from "../src/federation/lang-string";
import { DOCUMENT_BODY_LIMIT } from "../src/federation/loader";
import { INBOX_BODY_LIMIT } from "../src/federation/spool";

// Mastodon's first_lang_string, then presence and strip (MediaAttachmentParser#description), over the compacted forms a
// natural-language property arrives in (federation/lang-string.ts).

const MAP = { summaryMap: { en: "b" } };

describe("firstLangString", () => {
  it("reads a string, an array's first element, or an object's @value", () => {
    expect(firstLangString({ summary: "a" }, "summary")).toBe("a");
    expect(firstLangString({ summary: ["", "x"] }, "summary")).toBe("");
    expect(firstLangString({ summary: [{ "@value": "a" }] }, "summary")).toBe("a");
    expect(firstLangString({ summary: { "@value": "a", "@language": "en" } }, "summary")).toBe("a");
  });

  it("reads the map only when the property is absent, null or false", () => {
    expect(firstLangString(MAP, "summary")).toBe("b");
    expect(firstLangString({ summary: null, ...MAP }, "summary")).toBe("b");
    expect(firstLangString({ summary: false, ...MAP }, "summary")).toBe("b");
    // Truthy in Ruby: the property decides, the map is not read.
    for (const summary of ["", 0, [], {}, true]) {
      expect(firstLangString({ summary, ...MAP }, "summary"), JSON.stringify(summary)).toBe(
        typeof summary === "string" ? summary : null,
      );
    }
  });

  // Mastodon raises on these once it strips them; Kopje reads none.
  it("reads a value that is not a string as null", () => {
    expect(firstLangString({ summary: { "@value": 5 } }, "summary")).toBeNull();
    expect(firstLangString({ summary: [5, "x"] }, "summary")).toBeNull();
    expect(firstLangString({ summaryMap: { en: 5 } }, "summary")).toBeNull();
    expect(firstLangString({ summaryMap: ["b"] }, "summary")).toBeNull();
    expect(firstLangString({ summaryMap: "b" }, "summary")).toBeNull();
  });
});

describe("remoteDescription", () => {
  const name = { name: "n" };

  // [case, the attachment's properties, the description]
  it.each<[string, Record<string, unknown>, string]>([
    ["a string", { summary: "s", ...name }, "s"],
    ["an array whose first element is blank", { summary: ["", "x"], ...name }, "n"],
    ["an array of an @value", { summary: [{ "@value": "a" }], ...name }, "a"],
    ["a language-tagged value", { summary: { "@value": "a", "@language": "en" }, ...name }, "a"],
    ["an empty string, the map not read", { summary: "", ...MAP, ...name }, "n"],
    ["null, the map read", { summary: null, ...MAP, ...name }, "b"],
    ["false, the map read", { summary: false, ...MAP, ...name }, "b"],
    ["0, the map not read", { summary: 0, ...MAP, ...name }, "n"],
    ["a numeric @value", { summary: { "@value": 5 }, ...name }, "n"],
    ["a numeric map value", { summaryMap: { en: 5 }, ...name }, "n"],
    ["neither", {}, ""],
    ["both blank", { summary: " ", name: "\t" }, ""],
  ])("takes the summary when it is present, else the name, else '': %s", (_, object, expected) => {
    expect(remoteDescription(object)).toBe(expected);
  });

  it("reads the name the same ways", () => {
    expect(remoteDescription({ name: ["", "x"] })).toBe("");
    expect(remoteDescription({ name: [{ "@value": "a" }] })).toBe("a");
    expect(remoteDescription({ name: "", nameMap: { en: "b" } })).toBe("");
    expect(remoteDescription({ name: null, nameMap: { en: "b" } })).toBe("b");
    expect(remoteDescription({ summary: "　", name: { "@value": "a", "@language": "en" } })).toBe("a");
  });

  // Rails' blank?: White_Space only, so U+0085 and U+3000 are blank and U+FEFF is not.
  it("judges presence by Rails' blank set", () => {
    expect(remoteDescription({ summary: "　", ...name })).toBe("n");
    expect(remoteDescription({ summary: "\u0085", ...name })).toBe("n");
    expect(remoteDescription({ summary: "﻿", ...name })).toBe("﻿");
    // NUL is not blank: the summary is taken, and Ruby's strip empties it.
    expect(remoteDescription({ summary: "\u0000", ...name })).toBe("");
  });

  // Ruby's String#strip: NUL, tab, LF, VT, FF, CR and space, nothing else.
  it("strips as Ruby does", () => {
    expect(remoteDescription({ summary: " \t a \n" })).toBe("a");
    expect(remoteDescription({ summary: "\u0000\u000ba\u000c\r" })).toBe("a");
    expect(remoteDescription({ summary: " a " })).toBe(" a ");
    expect(remoteDescription({ summary: "　a　" })).toBe("　a　");
    expect(remoteDescription({ summary: " \u{1F600} " })).toBe("\u{1F600}");
  });

  // RES-1: a summary or name can hold a whitespace run as long as an inbound activity or a fetched document
  // (INBOX_BODY_LIMIT, DOCUMENT_BODY_LIMIT: 1 MiB). A run followed by another character is the regex's quadratic case
  // (about 1.4 s at 40,000 on a laptop); the smaller size fails first under it, so the cap is reached only by a linear
  // strip. Presence (railsBlank) reads the same input.
  it("strips a run at the cap within a generous time", () => {
    expect(INBOX_BODY_LIMIT).toBe(DOCUMENT_BODY_LIMIT);
    for (const size of [100_000, INBOX_BODY_LIMIT]) {
      for (const run of [" ", "\u0000", "\t\r\n"]) {
        const spaces = run.repeat(Math.ceil(size / run.length)).slice(0, size);
        const started = performance.now();
        const read = [
          remoteDescription({ summary: `x${spaces}x` }),
          remoteDescription({ summary: spaces, name: `x${spaces}` }),
          remoteDescription({ summary: `${spaces}x${spaces}` }),
        ];
        expect(performance.now() - started, `${size} ${JSON.stringify(run)}`).toBeLessThan(1000);
        // A NUL run is not blank (Rails), so that summary is taken and stripped to nothing.
        expect(read).toEqual([`x${spaces}x`, run === "\u0000" ? "" : "x", "x"]);
      }
    }
  });
});
