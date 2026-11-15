// A local profile note is written as plain text and stored as HTML (accounts.note holds HTML for every row). The
// HTML is generated here only, so it can be turned back into the source (with line endings and blank lines
// normalized) for the edit form.

import { railsBlank } from "../platform/rails-blank";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, k]));

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Mastodon's TextFormatter for a local note: '' for a blank text (Rails' blank?; so a blank note's source is '' too,
// docs/mastodon-deviations.md), else Rails' simple_format: blank lines separate paragraphs and single newlines become
// <br>, every other character kept (no paragraph or line is trimmed). The note comes stripped as
// Account#prepare_contents strips it (credentialChanges), so no paragraph is empty; one at an end of other input is
// dropped.
export function plainTextToHtml(text: string): string {
  if (railsBlank(text)) {
    return "";
  }
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// The inverse of plainTextToHtml, for HTML it produced.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/^<p>|<\/p>$/g, "")
    .split("</p><p>")
    .join("\n\n")
    .replace(/<br>/g, "\n")
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity] ?? entity);
}
