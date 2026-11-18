import { railsBlank } from "../platform/rails-blank";

// A media attachment's focus as Kopje reads it from an upload's `focus` and a remote attachment's `focalPoint`
// (Mastodon's MediaAttachment#focus=, media_attachment.rb:263-280, which casts each coordinate with Ruby's to_f,
// unclamped; docs/mastodon-deviations.md, "Media").

export type Focus = { x: number; y: number };

// One coordinate as stored (media_attachments.focus_x and focus_y: -1 to 1): a value that is not finite (parseFloat of
// no number, or a number past the double range) is 0, any other clamped to -1..1.
export function focusCoordinate(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0;
}

// "x,y", each part by parseFloat as focusCoordinate keeps it, a missing one as 0. A blank one (railsBlank) changes
// nothing (MediaAttachment#focus=: `return if point.blank?`).
export function parseFocus(value: string | undefined): Focus | undefined {
  if (value === undefined || railsBlank(value)) {
    return undefined;
  }
  // At most two components are split off, however many commas the value has.
  const [x = 0, y = 0] = value.split(",", 2).map((part) => focusCoordinate(Number.parseFloat(part)));
  return { x, y };
}
