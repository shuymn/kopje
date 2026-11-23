// Kopje's images, shipped as static assets (public/assets) under stable names and revalidated, not immutable
// (docs/web-pages.md). A changed icon takes a new file name, because browsers keep favicons in a cache of their own.

// The plain defaults for accounts without an avatar or header, and the instance thumbnail (no upload sets one).
export const DEFAULT_AVATAR = "/assets/avatar.jpg";
export const DEFAULT_HEADER = "/assets/header.jpg";
export const DEFAULT_THUMBNAIL = "/assets/thumbnail.jpg";
// The preview_url of a video or gifv attachment without a preview image of its own (status-presenter.ts
// presentedPreview): a plain dark 16:9 image, as Kopje cannot take a frame from a video. Clients give a video an image
// preview (Mastodon makes one from every video), and some drop a video whose preview_url is null.
export const VIDEO_POSTER = "/assets/video-poster.png";
// The thumbnail's alt text, /api/v2/instance's thumbnail.description.
export const DEFAULT_THUMBNAIL_DESCRIPTION =
  "A klipspringer, a small antelope, stands on the top boulder of a granite kopje against a large amber sun, with the " +
  "dry savanna, a distant acacia and blue hills around it.";

// The icons every page head links (the .ico holds 16, 32 and 48 px).
export const FAVICON = "/assets/favicon.ico";
export const FAVICON_192 = "/assets/favicon-192.png";
export const APPLE_TOUCH_ICON = "/assets/apple-touch-icon.png";

// Kopje's mark beside the server's name in every page header, drawn from the 48 px icon (sharp up to 2x at 20 px).
export const FAVICON_48 = "/assets/favicon-48.png";

// The icon sizes /api/v2/instance lists (Mastodon lists nine, 36 to 512 px; docs/mastodon-deviations.md).
export const INSTANCE_ICONS = [
  { path: FAVICON_48, size: "48x48" },
  { path: FAVICON_192, size: "192x192" },
  { path: "/assets/favicon-512.png", size: "512x512" },
] as const;
