import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// Markdown as the docs checks read it: the mdast tree that mdast-util-from-markdown builds with GFM (tables,
// autolinks, strikethrough, task lists, footnotes), so blockquote markers, list indentation and fences never reach the
// text a check reads. Front matter (a leading `---` block) is not Markdown: it is blanked to spaces before parsing,
// so lines and offsets stay those of the file.

type Position = { start: { line: number; offset: number }; end: { line: number; offset: number } };

export type MarkdownNode = {
  type: string;
  value?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: Position;
};

/** The 1-based lines of a leading front matter block, both `---` lines included; empty when there is none. */
export function frontMatterLines(text: string): number[] {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return [];
  }
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : Array.from({ length: end + 1 }, (_, i) => i + 1);
}

export function parseMarkdown(text: string): MarkdownNode {
  const front = frontMatterLines(text).length;
  const lines = text.split("\n");
  const body = [...lines.slice(0, front).map((line) => " ".repeat(line.length)), ...lines.slice(front)].join("\n");
  return fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MarkdownNode;
}

/** Visits `node` and every node below it in document order. */
export function visit(node: MarkdownNode, each: (node: MarkdownNode) => void): void {
  each(node);
  for (const child of node.children ?? []) {
    visit(child, each);
  }
}

export type Run = { value: string; line: number; code: boolean };

/**
 * The text a reader sees, as runs: each `text` and `inlineCode` node's value (its soft line breaks kept as `\n`, with
 * no quote or list markers), and each line of a code block. `line` is the run's first line in the file.
 */
export function textRuns(text: string, root: MarkdownNode = parseMarkdown(text)): Run[] {
  const runs: Run[] = [];
  visit(root, (node) => {
    const line = node.position?.start.line ?? 0;
    if ((node.type === "text" || node.type === "inlineCode") && node.value !== undefined) {
      runs.push({ value: node.value, line, code: false });
    } else if (node.type === "code" && node.value !== undefined) {
      // A fenced block's content starts on the line after its opening fence; an indented one on its own first line.
      const fenced = /^\s*(?:`{3}|~{3})/.test(text.slice(node.position?.start.offset ?? 0));
      node.value.split("\n").forEach((value, i) => runs.push({ value, line: line + i + (fenced ? 1 : 0), code: true }));
    }
  });
  return runs;
}
