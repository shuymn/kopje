import { DETACHED_GRACE_MS } from "../src/domain/media";
import { sql } from "./api-helpers";
import { type AvWorld, fileToken } from "./media-processing-helpers";
import { posting } from "./status-helpers";

// The posting rules for video and audio (#1828 P10, decision C9), shared by the post, edit and schedule tests: the
// messages of Mastodon's media_attachments.validations, and rows the tests attach beside uploads the Store's own
// operations made (media-processing-helpers.ts).

export const IMAGES_AND_VIDEO = { error: "Cannot attach a video to a post that already contains images" };
export const NOT_READY = { error: "Cannot attach files that have not finished processing. Try again in a moment!" };

let images = 0;

// A completed, unattached image upload of alice's, attachable for DETACHED_GRACE_MS from the Store's time `at`.
export async function imageUpload(w: AvWorld, at = Date.now()): Promise<string> {
  const id = `9000000000000${String(++images).padStart(5, "0")}`;
  await sql(
    w.store,
    `INSERT INTO media_attachments (id, account_id, type, url, content_type, processed, gc_at, created_at)
		VALUES (?1, ?2, 'image', 'https://kopje.test/media/' || ?1 || '.png', 'image/png', 1, ?3, ?4)`,
    id,
    w.h.users.alice.id,
    new Date(at + DETACHED_GRACE_MS).toISOString(),
    new Date(at).toISOString(),
  );
  return id;
}

// An old image reservation that never completed (processed = 0, no URL) and has no processing row.
export async function imageReservation(w: AvWorld, at = Date.now()): Promise<string> {
  const id = `9100000000000${String(++images).padStart(5, "0")}`;
  await sql(
    w.store,
    `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
		VALUES (?1, ?2, 'image', '', ?3, 0, ?4, ?5)`,
    id,
    w.h.users.alice.id,
    fileToken(),
    new Date(at + 60 * 60 * 1000).toISOString(),
    new Date(at).toISOString(),
  );
  return id;
}

// The row `id` made a video as the cutover converts one (cli/lib/cutover/convert.js): a converted status may hold it
// beside images.
export async function convertToVideo(w: AvWorld, id: string): Promise<void> {
  await sql(
    w.store,
    `UPDATE media_attachments SET type = 'video', content_type = 'video/mp4',
			meta = '{"original":{"width":640,"height":360,"frame_rate":"30/1","duration":2.5,"bitrate":1000}}'
		WHERE id = ?`,
    id,
  );
}

export function postAs(w: AvWorld, body: Record<string, unknown>, who: "alice" | "bob" = "alice") {
  return posting(w.h, w.h.users[who].token, body);
}
