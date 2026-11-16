import { describe, expect, it } from "vitest";

import {
  blankText,
  exceedsRawLength,
  MAX_RAW_LENGTH,
  MAX_URL_LENGTH,
  noteLength,
  parseStatusText,
  renderStatusHtml,
  statusLength,
} from "../src/domain/status-text";

const KNOWN: Record<string, string> = {
  "bob@": "https://kopje.test/@bob",
  "carol@remote.example": "https://remote.example/@carol",
};

function render(text: string): string {
  return renderStatusHtml(parseStatusText(text).segments, {
    mention: (m) => {
      const url = KNOWN[`${m.username.toLowerCase()}@${m.domain ?? ""}`];
      return url === undefined ? undefined : { url, username: m.username };
    },
    tagUrl: (name) => `https://kopje.test/tags/${encodeURIComponent(name)}`,
  });
}

const link = (url: string, shown: string, prefix = "https://", hidden = "") =>
  `<a href="${url}" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">${prefix}</span>` +
  `<span class="${hidden === "" ? "" : "ellipsis"}">${shown}</span><span class="invisible">${hidden}</span></a>`;

describe("status text to HTML (Mastodon TextFormatter)", () => {
  it("escapes everything that is not an entity", () => {
    expect(render(`<script>alert("x")</script> & 'q'`)).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>",
    );
  });

  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(render("a\r\nb\n\n\nc")).toBe("<p>a<br />b</p><p>c</p>");
  });

  it("links only absolute http(s) URLs", () => {
    expect(render("see https://example.com/x and http://www.example.org")).toBe(
      `<p>see ${link("https://example.com/x", "example.com/x")} and ${link("http://www.example.org", "example.org", "http://www.")}</p>`,
    );
    for (const text of [
      "example.com",
      "ftp://example.com/x",
      "mailto:a@example.com",
      "//example.com",
      "a@example.com",
    ]) {
      expect(render(text)).toBe(`<p>${text}</p>`);
    }
    expect(render("javascript:alert(1)")).toBe("<p>javascript:alert(1)</p>");
  });

  it("escapes the URL in the attribute and cuts long links with an ellipsis", () => {
    const url = 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/b?x="1"';
    const html = render(url);
    expect(html).not.toContain('"1"');
    expect(html).toContain('<span class="ellipsis">example.com/aaaaaaaaaaaaaaaaaa</span>');
  });

  it("links known mentions and leaves unknown ones as escaped text", () => {
    expect(render("@bob @Carol@Remote.Example @dave @bob@nowhere.example")).toBe(
      '<p><span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span> ' +
        '<span class="h-card"><a href="https://remote.example/@carol" class="u-url mention">@<span>Carol</span></a></span> ' +
        "@dave @bob@nowhere.example</p>",
    );
  });

  it("finds mentions and hashtags only where Mastodon does", () => {
    const parsed = parseStatusText(
      "mail@bob.example x/@bob a#b #1 #a1 #日本語 #Tag_A #tag_a https://example.com/#tag @bob",
    );
    expect(parsed.mentions).toEqual([{ username: "bob", domain: null }]);
    expect(parsed.tags).toEqual(["a1", "日本語", "tag_a"]);
  });

  // Tag::HASHTAG_RE of Mastodon 4.7.5, (?<=^|[[:space:]])[#＃], scanned over the whole text (Extractor): Ruby's
  // [[:space:]] is White_Space, which holds U+0085 and not U+FEFF.
  it.each([
    ["at the start", "#tag"],
    ["after a space", "x #tag"],
    ["after a newline", "x\n#tag"],
    ["after U+00A0", "x\u00A0#tag"],
    ["after U+0085", "x\u0085#tag"],
    ["after U+3000", "x\u3000#tag"],
    ["written ＃ after a space", "x ＃tag"],
    ["written ＃ at the start", "＃tag"],
  ])("starts a hashtag %s", (_, text) => {
    expect(parseStatusText(text).tags).toEqual(["tag"]);
  });

  it.each([
    ["after (", "(#tag)"],
    ["after .", "text.#tag"],
    ["after a letter", "a#b"],
    ["after U+FEFF", "x\uFEFF#tag"],
    ["after U+200B", "x\u200B#tag"],
    ["after a URL that ends before ＃", "https://example.com/a＃tag"],
    ["after a URL mid-text", "see https://example.com/a＃tag"],
  ])("starts no hashtag %s", (_, text) => {
    const parsed = parseStatusText(text);
    expect(parsed.tags).toEqual([]);
    // The text was parsed: a tag written after a space in the same text is found.
    expect(parseStatusText(`${text} #seen`).tags).toEqual(["seen"]);
  });

  it("links a ＃ hashtag as # and finds mentions as before", () => {
    expect(render("＃Tag")).toBe(
      '<p><a href="https://kopje.test/tags/tag" class="mention hashtag" rel="tag">#<span>Tag</span></a></p>',
    );
    expect(parseStatusText("＃Tag").tags).toEqual(["tag"]);
    const parsed = parseStatusText("@bob x @Carol@Remote.Example https://example.com/a @dave");
    expect(parsed.mentions).toEqual([
      { username: "bob", domain: null },
      { username: "Carol", domain: "remote.example" },
      { username: "dave", domain: null },
    ]);
  });

  // Each stretch between URLs is matched from its own start: an entity before a URL is not emitted again after it.
  it("splits the text into segments in order, each entity once", () => {
    const text = "#a @bob https://example.com/x #b @carol https://example.com/y c";
    expect(parseStatusText(text).segments).toEqual([
      { kind: "tag", name: "a", text: "#a" },
      { kind: "text", text: " " },
      { kind: "mention", username: "bob", domain: null, text: "@bob" },
      { kind: "text", text: " " },
      { kind: "url", url: "https://example.com/x", text: "https://example.com/x" },
      { kind: "text", text: " " },
      { kind: "tag", name: "b", text: "#b" },
      { kind: "text", text: " " },
      { kind: "mention", username: "carol", domain: null, text: "@carol" },
      { kind: "text", text: " " },
      { kind: "url", url: "https://example.com/y", text: "https://example.com/y" },
      { kind: "text", text: " c" },
    ]);
  });

  it("normalizes tags and keeps the written form in the text", () => {
    expect(render("#Ｋｏｐｊｅ")).toBe(
      '<p><a href="https://kopje.test/tags/kopje" class="mention hashtag" rel="tag">#<span>Ｋｏｐｊｅ</span></a></p>',
    );
  });
});

describe("blank text (ActiveSupport's String#blank?)", () => {
  // [[:space:]] under Unicode, as Ruby matches it.
  const SPACES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680]
    .concat(Array.from({ length: 11 }, (_, i) => 0x2000 + i))
    .concat([0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

  it("is blank for the 25 [[:space:]] characters only, over every code point, NUL removed as it is stored", () => {
    expect(SPACES).toHaveLength(25);
    expect(blankText("")).toBe(true);
    expect(blankText(String.fromCodePoint(...SPACES))).toBe(true);
    const blank: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if ((c < 0xd800 || c > 0xdfff) && blankText(String.fromCodePoint(c))) {
        blank.push(c);
      }
    }
    // U+0000 is removed by storedText, which leaves nothing.
    expect(blank).toEqual([0, ...SPACES]);
    // JavaScript's trim() removes U+FEFF; U+180E is no longer a space.
    expect(blankText("\ufeff")).toBe(false);
    expect(blankText("\u180e")).toBe(false);
    expect(blankText(" \u0000 ")).toBe(true);
    // A lone surrogate is stored as U+FFFD.
    expect(blankText("\ud800")).toBe(false);
  });
});

describe("status length (StatusLengthValidator)", () => {
  it("counts graphemes, a URL as 23 and a remote mention by its username", () => {
    expect(statusLength("👍🏽👨‍👩‍👧", "")).toBe(2);
    expect(statusLength(`https://example.com/${"x".repeat(100)}`, "")).toBe(23);
    expect(statusLength("@carol@remote.example", "")).toBe("@carol".length);
    expect(statusLength("abc", "cw")).toBe(5);
  });

  it("counts the warning followed by the text as one string, and a blank text as nothing", () => {
    // A combining mark that starts the text joins the warning's last grapheme, as Ruby's each_grapheme_cluster counts.
    expect(statusLength("\u0301x", "x".repeat(499))).toBe(500);
    expect(statusLength("\u0301xy", "x".repeat(499))).toBe(501);
    expect(statusLength(" ".repeat(10), "x".repeat(495))).toBe(495);
    expect(statusLength("\u0085", "")).toBe(0);
    // A blank text is not parsed, whatever its length.
    expect(statusLength(" ".repeat(MAX_RAW_LENGTH + 1), "w")).toBe(1);
  });
});

describe("raw input bound", () => {
  it("refuses to parse text over the bound, and counts text and spoiler together", () => {
    expect(() => parseStatusText("x".repeat(MAX_RAW_LENGTH + 1))).toThrow(RangeError);
    expect(() => statusLength("x".repeat(MAX_RAW_LENGTH + 1), "")).toThrow(RangeError);
    expect(parseStatusText("x".repeat(MAX_RAW_LENGTH)).segments).toHaveLength(1);
    expect(exceedsRawLength("x".repeat(MAX_RAW_LENGTH), "")).toBe(false);
    expect(exceedsRawLength("x".repeat(MAX_RAW_LENGTH), "y")).toBe(true);
  });

  it("does not link a URL longer than twitter-text allows, and counts it as text", () => {
    const long = `https://example.com/${"p".repeat(MAX_URL_LENGTH)}`;
    expect(parseStatusText(long).segments).toEqual([{ kind: "text", text: long }]);
    expect(statusLength(long, "")).toBe(long.length);
    const longest = `https://example.com/${"p".repeat(MAX_URL_LENGTH - "https://example.com/".length)}`;
    expect(parseStatusText(longest).segments).toEqual([{ kind: "url", url: longest, text: longest }]);
  });
});

// NoteLengthValidator's count of a note (app/validators/note_length_validator.rb), each against Mastodon 4.7.5's own
// count of the same text (M1: NoteLengthValidator#countable_text and each_grapheme_cluster, through rails runner).
describe("note length (NoteLengthValidator)", () => {
  const a = (n: number) => "a".repeat(n);
  it.each([
    // Account::MENTION_RE's [[:word:]] holds letter numbers (U+2163), alphabetic symbols (U+24B6) and join controls
    // (U+200C): in a domain they extend it, and before an @ they are a word character, so no mention starts.
    ["a letter number as the domain", `@verifier@Ⅳ ${a(490)}`, 500],
    ["a letter number before the mention", `Ⅳ@verifier@x ${a(489)}`, 502],
    ["an alphabetic symbol as the domain", `@verifier@Ⓐ ${a(490)}`, 500],
    ["an alphabetic symbol before the mention", `Ⓐ@verifier@x ${a(489)}`, 502],
    ["a join control before the mention", `‌@verifier@x ${a(487)}`, 500],
    ["a join control before the mention, one more", `‌@verifier@x ${a(488)}`, 501],
    ["a join control in the domain", `@verifier@x‌y ${a(490)}`, 500],
    ["a domain of one character", `@verifier@x ${a(490)}`, 500],
    ["a domain of one character, one more", `@verifier@x ${a(491)}`, 501],
    ["a domain", `@verifier@example.com ${a(490)}`, 500],
    // A URL takes the character before it into its 23 (URL_PATTERN's $1); at the start there is none.
    ["a link after a space", `x https://example.com/path ${a(475)}`, 500],
    ["a link after a space, one more", `x https://example.com/path ${a(476)}`, 501],
    ["a link first", `https://example.com/path ${a(10)}`, 34],
    ["a link after CR LF, which takes only the LF", "abc\r\nhttps://example.com", 27],
    // The mention is read after the links are replaced, so the replacement extends a domain it follows.
    ["a link glued to a mention's domain", `@verifier@example.com/https://example.com/x ${a(10)}`, 20],
    ["combining marks", "é".repeat(500), 500],
    ["combining marks, one more", "é".repeat(501), 501],
  ])("counts %s as Mastodon does", (_name, note, count) => {
    expect(noteLength(note)).toBe(count);
  });

  // Listed (docs/mastodon-deviations.md, Profile credentials): linkify-it reads a link right after # or @, which
  // Mastodon's URL_PATTERN does not, so Kopje counts each as 23 where Mastodon counts the 22 characters of the text.
  it("reads the links linkify-it reads", () => {
    expect(noteLength("#https://example.com/a")).toBe(23);
    expect(noteLength("@https://example.com/a")).toBe(23);
  });

  it("refuses to count past the raw bound", () => {
    expect(() => noteLength("x".repeat(MAX_RAW_LENGTH + 1))).toThrow(RangeError);
    expect(noteLength("x".repeat(MAX_RAW_LENGTH))).toBe(MAX_RAW_LENGTH);
  });
});
