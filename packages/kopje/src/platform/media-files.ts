// Where local media lives in R2 and how it is addressed (MEDIA-2, MEDIA-4).
//
//   originals/<id>                the uploaded bytes, never served (they may carry EXIF and location)
//   files/<token>/full            the re-encoded image, or the verified video or audio (#1828), that is served
//   files/<token>/small           the re-encoded preview (an image) that is served
//   kopje/pitr-restored/<store>   when that Store last scheduled a PITR restore (restoreMarkerKey), never served
//   incoming/<id>                 a video or audio upload's input while the media processor reads it (incomingKey,
//                                 #1828 design 4.7), never served
//   incoming/probe-<nonce>        a copy of the media processor's probe clip while a probe reads it (probeInputKey,
//                                 #1828 design 4.15), never served
//   remote/<token>/full           a cached remote file, verified, served (domain/remote-media.ts, MEDIA-7)
//   remote/<token>/still          the still of a cached animated image, served
//
// Every key is built here from a server-generated id or token that the Store holds; nothing from a request (file name,
// path segment, encoded separator) chooses a key. The serving route only ever builds files/ keys, from a token that
// matches FILE_TOKEN, so originals are not reachable from a URL. The remote media route builds remote/ keys only, the
// same way. The prefixes are disjoint, so no key of one is ever another's.

export type MediaVariant = "full" | "small";

// Outside the Store's database, so a PITR restore does not rewind it: the media rebuild counts its settle period from
// it (domain/media-rebuild.ts). Named by the Store's Durable Object id.
export function restoreMarkerKey(storeId: string): string {
  if (!/^[0-9a-f]{64}$/.test(storeId)) {
    throw new Error("not a Durable Object id");
  }
  return `kopje/pitr-restored/${storeId}`;
}

export const MEDIA_VARIANTS: readonly MediaVariant[] = ["full", "small"];

// The input of one probe of the media processor, named by a nonce the Worker draws (32 hex digits).
export function probeInputKey(nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw new Error("not a probe nonce");
  }
  return `incoming/probe-${nonce}`;
}

// A token the server made (base64url, as security/tokens.ts generates them).
export const FILE_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

const ID = /^\d{18}$/;

// The only types the instance serves media as, each under one extension. Re-encoding outputs one of these; nothing
// else (no HTML, no SVG, no script) is ever served from the instance origin, whatever an object's metadata says.
// SERVED_TYPES are the images, under either variant; SERVED_AV_TYPES the media processor's verified video and audio,
// under `full` only (`small` is always an image). VARIANT_TYPES is what each variant may be; mediaPath and keyOfPath
// derive their extensions from it.
export const SERVED_TYPES: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export const SERVED_AV_TYPES: ReadonlyMap<string, string> = new Map([
  ["video/mp4", "mp4"],
  ["audio/mpeg", "mp3"],
]);

export const VARIANT_TYPES: Readonly<Record<MediaVariant, ReadonlyMap<string, string>>> = {
  full: new Map([...SERVED_TYPES, ...SERVED_AV_TYPES]),
  small: SERVED_TYPES,
};

export function originalKey(id: string): string {
  if (!ID.test(id)) {
    throw new Error("media id is not a server id");
  }
  return `originals/${id}`;
}

export function fileKey(token: string, variant: MediaVariant): string {
  if (!FILE_TOKEN.test(token) || !MEDIA_VARIANTS.includes(variant)) {
    throw new Error("media file token is not a server token");
  }
  return `files/${token}/${variant}`;
}

export function incomingKey(id: string): string {
  if (!ID.test(id)) {
    throw new Error("media id is not a server id");
  }
  return `incoming/${id}`;
}

// Every key of one upload, for deleting it: its input (a video or audio upload's), original and served files.
export function mediaKeys(id: string, token: string): string[] {
  return [incomingKey(id), originalKey(id), ...MEDIA_VARIANTS.map((variant) => fileKey(token, variant))];
}

// The most keys one R2 delete takes (R2's bulk delete limit).
export const R2_DELETE_KEYS = 1000;

// Deletes `keys` in calls of at most R2_DELETE_KEYS, in order; a failed call throws and leaves the later keys.
export async function deleteKeys(
  bucket: { delete(keys: string[]): Promise<void> },
  keys: readonly string[],
): Promise<void> {
  for (let at = 0; at < keys.length; at += R2_DELETE_KEYS) {
    await bucket.delete(keys.slice(at, at + R2_DELETE_KEYS));
  }
}

// The public path of a served file: /media/<token>/<variant>.<ext>.
export function mediaPath(token: string, variant: MediaVariant, contentType: string): string {
  const extension = VARIANT_TYPES[variant]?.get(contentType);
  if (extension === undefined) {
    throw new Error(`not a served media type: ${contentType}`);
  }
  fileKey(token, variant);
  return `/media/${token}/${variant}.${extension}`;
}

// The URL of a served file on the instance origin, as a media row with a file token stores it (the Worker's uploads,
// domain/media.ts, and the cutover's mapped images, cli/lib/cutover/convert.js). With a host of at most 253
// characters it stays far within the stored media URL bound (platform/stored-bounds.ts MEDIA_URL_LIMIT). No imports:
// the cutover runs this module from the sources on Node (cli/lib/cutover/kopje-runtime.js).
export function mediaUrl(origin: string, token: string, variant: MediaVariant, contentType: string): string {
  return `${origin}${mediaPath(token, variant, contentType)}`;
}

// The R2 key a request path names, or null: the token must look like a server token, the variant and extension must
// be known, and the extension must belong to a type the variant is served as (VARIANT_TYPES: an AV extension under
// `small` does not match). Anything else (other segments, encoded separators, dots) does not match.
export function keyOfPath(token: string, file: string): { key: string; extension: string } | null {
  const match = /^(full|small)\.([a-z0-9]{3,4})$/.exec(file);
  if (match === null || !FILE_TOKEN.test(token)) {
    return null;
  }
  const [, variant = "", extension = ""] = match;
  if (![...VARIANT_TYPES[variant as MediaVariant].values()].includes(extension)) {
    return null;
  }
  return { key: fileKey(token, variant as MediaVariant), extension };
}

// ---- Remote media (domain/remote-media.ts)

export type RemoteVariant = "full" | "still";

const REMOTE_VARIANTS: readonly RemoteVariant[] = ["full", "still"];

// The types the remote media route serves, each under one extension (the same map as platform/stored-bounds.ts
// REMOTE_MEDIA_TYPES, which test/remote-media-serving.test.ts pins equal; this module imports nothing).
export const REMOTE_SERVED_TYPES: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/webm", "webm"],
  ["audio/mpeg", "mp3"],
  ["audio/flac", "flac"],
  ["audio/wav", "wav"],
]);

const REMOTE_EXTENSIONS = new Set(REMOTE_SERVED_TYPES.values());

export function remoteFileKey(token: string, variant: RemoteVariant): string {
  if (!FILE_TOKEN.test(token) || !REMOTE_VARIANTS.includes(variant)) {
    throw new Error("remote file token is not a server token");
  }
  return `remote/${token}/${variant}`;
}

// The public path of a cached remote file: /media/r/<token>/<variant>.<ext>.
export function remoteMediaPath(token: string, variant: RemoteVariant, contentType: string): string {
  const extension = REMOTE_SERVED_TYPES.get(contentType);
  if (extension === undefined) {
    throw new Error(`not a served remote media type: ${contentType}`);
  }
  remoteFileKey(token, variant);
  return `/media/r/${token}/${variant}.${extension}`;
}

// The R2 key a remote media request path names, or null: a server token, a known variant and a served extension.
export function keyOfRemotePath(token: string, file: string): { key: string; extension: string } | null {
  const match = /^(full|still)\.([a-z0-9]{3,4})$/.exec(file);
  if (match === null || !FILE_TOKEN.test(token)) {
    return null;
  }
  const [, variant = "", extension = ""] = match;
  if (!REMOTE_EXTENSIONS.has(extension)) {
    return null;
  }
  return { key: remoteFileKey(token, variant as RemoteVariant), extension };
}
