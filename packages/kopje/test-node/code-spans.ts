// The inline code spans of Markdown text, as CommonMark reads them (spec 0.31.2, "Code spans" and "Backslash escapes"):
// a run of N backticks opens a span that the next run of exactly N backticks closes, so a span written with two
// backticks may hold one; a run that no such run closes is literal text. Outside a span, a backslash escapes the
// punctuation character after it, so `\`` opens nothing; inside a span, a backslash is literal. The text is read as one
// paragraph: block structure (fences, blank lines) is the caller's to split off first.

export type CodeSpan = {
  /** Offset of the opening run. */
  start: number;
  /** Offset just past the closing run. */
  end: number;
  /** Length of each delimiting run. */
  run: number;
  /** The content: line endings as spaces, and one space stripped from each side when it both begins and ends with a
   * space and is not all spaces. */
  content: string;
};

const PUNCTUATION = /[!-/:-@[-`{-~]/;

export function codeSpans(text: string): CodeSpan[] {
  const found: CodeSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && PUNCTUATION.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (c !== "`") {
      i++;
      continue;
    }
    const run = runAt(text, i);
    const close = closingRun(text, i + run, run);
    if (close === -1) {
      i += run;
      continue;
    }
    let content = text.slice(i + run, close).replace(/\r\n|\r|\n/g, " ");
    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
      content = content.slice(1, -1);
    }
    found.push({ start: i, end: close + run, run, content });
    i = close + run;
  }
  return found;
}

/** The length of the backtick run at `at`. */
function runAt(text: string, at: number): number {
  let end = at;
  while (text[end] === "`") end++;
  return end - at;
}

/** The offset of the first run of exactly `run` backticks from `from`, or -1. */
function closingRun(text: string, from: number, run: number): number {
  for (let i = from; i < text.length;) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    const length = runAt(text, i);
    if (length === run) return i;
    i += length;
  }
  return -1;
}
