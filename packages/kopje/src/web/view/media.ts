import type { MediaAttachment } from "../../domain/status-presenter";
import { VIDEO_POSTER } from "../../platform/brand-assets";
import { httpUrl } from "../../platform/http-url";
import { type Link, linkTo } from "./link";

// A media attachment as the pages show it (HTML-3: http(s) URLs only). `kind` is its Mastodon type; any other stored
// type is `unknown`, shown as a link, and the type itself is never written. `preview` is the attachment's own preview
// image, or null when it has none: the presenter stands an image's or an unknown file's url in for a missing preview,
// which for an unknown file need be no image, so a preview equal to the url is none, and gives a video without a
// preview image this server's VIDEO_POSTER, which a page does not show. `alt` is its description, or '' when it has
// none (the page shows no marker for that). Sizes come from the small variant when it has one, a video's then from its
// original. `link` opens the file itself (through linkTo: another host's is marked). An attachment withheld by a domain
// block's reject_media (#1560, `withheld`) is a link to its http(s) remote_url, with no preview, size or poster, so the
// browser loads none of its files and nothing under /media_proxy/; one without such a remote_url is left out.
type MediaKind = "image" | "video" | "gifv" | "audio" | "unknown";

export type MediaView = {
  kind: MediaKind;
  full: string;
  link: Link | null;
  preview: string | null;
  alt: string;
  width?: number;
  height?: number;
};

const KINDS: readonly string[] = ["image", "video", "gifv", "audio"] satisfies MediaKind[];

export function mediaView(media: MediaAttachment, domain: string): MediaView | null {
  if (media.withheld === true) {
    const remote = httpUrl(media.remote_url)?.href;
    return remote === undefined
      ? null
      : { kind: "unknown", full: remote, link: linkTo(remote, domain), preview: null, alt: altOf(media) };
  }
  const full = httpUrl(media.url)?.href;
  if (full === undefined) {
    return null;
  }
  const previewUrl = httpUrl(media.preview_url);
  const preview =
    previewUrl === null || (previewUrl.host === domain && previewUrl.pathname === VIDEO_POSTER)
      ? undefined
      : previewUrl.href;
  // A video or gifv with meta.small, which may be a custom thumbnail's (only its poster, #1828 PR6), is sized by its
  // original; one without stays in the 16/9 box.
  const small = media.meta?.small;
  const original = media.meta?.original;
  const size =
    small !== undefined &&
    (media.type === "video" || media.type === "gifv") &&
    typeof original?.width === "number" &&
    typeof original.height === "number"
      ? { width: original.width, height: original.height }
      : small;
  return {
    kind: KINDS.includes(media.type) ? (media.type as MediaKind) : "unknown",
    full,
    link: linkTo(full, domain),
    preview: preview === undefined || preview === full ? null : preview,
    alt: altOf(media),
    ...(size === undefined ? {} : { width: size.width, height: size.height }),
  };
}

// A description of only white space is none.
function altOf(media: MediaAttachment): string {
  return (media.description ?? "").trim() === "" ? "" : (media.description ?? "");
}

// The image a page shows for an attachment: an image's preview, or the image itself without one; a video's poster
// only when it has a preview of its own; none for audio or another type.
export function shownImage(media: MediaView): string | null {
  switch (media.kind) {
    case "image":
      return media.preview ?? media.full;
    case "video":
    case "gifv":
      return media.preview;
    default:
      return null;
  }
}
