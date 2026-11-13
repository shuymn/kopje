// The inline code spans of Markdown text, as CommonMark reads them (spec 0.31.2, "Code spans" and "Backslash escapes"):
// a run of N backticks opens a span that the next run of exactly N backticks closes, so a span written with two
// backticks may hold one; a run that no such run closes is literal text. Outside a span, a backslash escapes the
// punctuation character after it, so `\`` opens nothing; inside a span, a backslash is literal. The text is read as one
// paragraph: block structure takes precedence over spans (CommonMark §3.1), so splitting the text into blocks (fences,
// blank lines, list items, headings) is the caller's to do first; see `blocks`.

export type CodeSpan = {
  /** Offset of the opening run. */
  start: number;
  /** Offset just past the closing run. */
  end: number;
  /** Length of each delimiting run. */
  run: number;
  /** The content: line endings as spaces, then one space stripped from each side when it both begins and ends with a
   * space and holds a character other than a space. */
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
    } else if (c === "`") {
      const span = spanAt(text, i);
      if (span !== undefined) found.push(span);
      i = span?.end ?? i + runAt(text, i);
    } else {
      i++;
    }
  }
  return found;
}

/** The code span opened by the backtick run at `at`, or undefined when no run of the same length closes it. The caller
 * makes sure the run is not escaped and does not lie inside another span. */
export function spanAt(text: string, at: number): CodeSpan | undefined {
  const run = runAt(text, at);
  const close = closingRun(text, at + run, run);
  if (close === -1) return undefined;
  let content = text.slice(at + run, close).replace(/\r\n|\r|\n/g, " ");
  if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return { start: at, end: close + run, run, content };
}

/** The blocks of Markdown prose whose spans can be read apart: a blank line ends one, a list item's marker starts one,
 * and a heading is one line of its own; the lines of one paragraph stay together. Fenced blocks are the caller's to
 * remove first. */
export function blocks(prose: string): string[] {
  const found: string[][] = [];
  let current: string[] | undefined;
  for (const line of prose.split("\n")) {
    const heading = /^ {0,3}#{1,6}(?:\s|$)/.test(line);
    if (line.trim() === "") {
      current = undefined;
    } else if (current === undefined || heading || /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) {
      current = [line];
      found.push(current);
    } else {
      current.push(line);
    }
    if (heading) current = undefined;
  }
  return found.map((lines) => lines.join("\n"));
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
