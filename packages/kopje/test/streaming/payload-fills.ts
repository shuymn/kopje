import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

import { Db } from "../../src/db/sql";
import { MAX_DISPLAY_NAME, MAX_NOTE } from "../../src/domain/accounts";
import { MAX_OPTION_CHARS, MAX_OPTIONS, writePoll } from "../../src/domain/polls";
import { postStatus } from "../../src/domain/scheduled-statuses";
import { MAX_STATUS_MEDIA } from "../../src/domain/status-bounds";
import { MAX_RAW_LENGTH } from "../../src/domain/status-text";
import { utf8Length } from "../../src/platform/dump-format";
import {
  MAX_FIELD_NAME,
  MAX_FIELD_VALUE,
  MAX_FIELDS,
  MAX_MEDIA_DESCRIPTION_LENGTH,
} from "../../src/platform/stored-bounds";
import { sha256Hex } from "../../src/security/tokens";
import { type ApiHarness, bearer, json, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import type { User } from "../status-helpers";

// The fills of docs/mastodon-deviations.md's "Streaming." entry (D8 of #1584): local statuses whose media descriptions
// are at MAX_MEDIA_DESCRIPTION_LENGTH beside text, a poll and profiles at their limits, plain or expanding as they are
// presented, and what the stream hub's payload (the presented subject encoded as JSON, then again as a JSON string,
// stream-hub.ts) takes of them.

// One grapheme cluster of 20 UTF-16 code units, each a three-byte character neither HTML nor JSON escapes: あ and 19
// combining voiced sound marks (U+3099), which a grapheme segmenter joins to it.
const CLUSTER = `あ${"゙".repeat(19)}`;
// Half the raw bound in clusters: a text and a warning of these are at MAX_RAW_LENGTH together and count 500.
const HALF = CLUSTER.repeat(MAX_RAW_LENGTH / 2 / CLUSTER.length);
// A URL of `length` code units: https://example.com/ padded with '&', which the link's href and shown text each
// escape to `&amp;` (status-text.ts linkHtml).
const link = (length: number) => "https://example.com/".padEnd(length, "&");

export type Fill = {
  text: string;
  spoiler: string;
  // A field's name and value, each of the account's MAX_FIELDS.
  field: { name: string; value: string };
  // The poll's MAX_OPTIONS choices.
  choices: string[];
};

const PLAIN_PROFILE = { name: "あ".repeat(MAX_FIELD_NAME), value: "あ".repeat(MAX_FIELD_VALUE) };
const PLAIN_CHOICES = Array.from({ length: MAX_OPTIONS }, (_, i) => `${i}${"あ".repeat(MAX_OPTION_CHARS - 1)}`);

// plain: text and warning at the raw bound in plain three-byte characters within the 500 counted, plain profiles and
// choices. links: the text three URLs of '&' (3,332, 3,333 and 3,333 code units; 71 counted), no warning. every:
// links, with each field's name of '&' and its value a link of '&', and each choice of '"' (escaped twice as the
// payload encodes it, four bytes).
export const FILLS = {
  plain: { text: HALF, spoiler: HALF, field: PLAIN_PROFILE, choices: PLAIN_CHOICES },
  links: {
    text: [link(3332), link(3333), link(3333)].join(" "),
    spoiler: "",
    field: PLAIN_PROFILE,
    choices: PLAIN_CHOICES,
  },
  every: {
    text: [link(3332), link(3333), link(3333)].join(" "),
    spoiler: "",
    field: { name: "&".repeat(MAX_FIELD_NAME), value: link(MAX_FIELD_VALUE) },
    choices: Array.from({ length: MAX_OPTIONS }, (_, i) => `${i}${'"'.repeat(MAX_OPTION_CHARS - 1)}`),
  },
} as const satisfies Record<string, Fill>;

// Descriptions of MAX_MEDIA_DESCRIPTION_LENGTH code points of `char`, one for each attachment.
export const described = (char: string): string[] =>
  Array.from({ length: MAX_STATUS_MEDIA }, () => char.repeat(MAX_MEDIA_DESCRIPTION_LENGTH));

// What a description adds to the payload: each character encoded as JSON, then again as a JSON string (its quotes
// belong to the rest of the event).
export const encodedTwice = (text: string): number => utf8Length(JSON.stringify(JSON.stringify(text).slice(1, -1))) - 2;

// The hub's payload of a presented subject: its JSON encoded again as a JSON string, in UTF-8 bytes.
export const payloadBytes = (presentedJson: string): number => utf8Length(JSON.stringify(presentedJson));

// The account's profile at its limits for `fill`, through the API.
export async function fillProfile(h: ApiHarness, user: User, fill: Fill): Promise<void> {
  const response = await h.request(
    "/api/v1/accounts/update_credentials",
    bearer(user.token, {
      ...json({
        display_name: "あ".repeat(MAX_DISPLAY_NAME),
        note: "あ".repeat(MAX_NOTE),
        fields_attributes: Array.from({ length: MAX_FIELDS }, (_, i) => ({
          ...fill.field,
          name: `${i}${fill.field.name.slice(1)}`,
        })),
      }),
      method: "PATCH",
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

let nextMedia = 810000000000000000n;

// Uploads of `user`'s, completed and unattached, each described through the API (PUT /api/v1/media/:id).
export async function describedMedia(h: ApiHarness, user: User, descriptions: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const description of descriptions) {
    const id = String(nextMedia++);
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at)
			VALUES (?1, ?2, 'image', 'https://kopje.test/files/t' || ?1 || '/full', 't' || ?1, 1, ?3)`,
      id,
      user.id,
      new Date(NOW + 86_400_000).toISOString(),
    );
    const response = await h.request(
      `/api/v1/media/${id}`,
      bearer(user.token, json({ description }, { method: "PUT" })),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    ids.push(id);
  }
  return ids;
}

// A public status of `user`'s with `media`, the fill's text and warning, quoting `quoted` when given, posted by the
// Store's own operation (postStatus), and its poll written by the poll writer in the same call: no turn starts until
// both are written, so the event presents both. (The API refuses media with a poll until #1584's PR A.)
export async function writeFilled(
  h: ApiHarness,
  user: User,
  fill: Fill,
  media: readonly string[],
  quoted?: string,
): Promise<string> {
  const tokenHash = await sha256Hex(user.token);
  return runInDurableObject(h.store, (_instance, state) => {
    const result = postStatus.run(state.storage.sql, {
      credential: { tokenHash, scope: "write:statuses", now: NOW },
      text: fill.text,
      spoilerText: fill.spoiler,
      visibility: "public",
      mediaIds: [...media],
      ...(quoted === undefined ? {} : { quotedStatusId: quoted }),
      objectId: crypto.randomUUID(),
      now: NOW,
      present: { origin: "https://kopje.test" },
    });
    const posted = result.status === "ok" ? result.value : result;
    if (posted.status !== "ok" || !("value" in posted) || !("id" in posted.value)) {
      throw new Error(`not posted: ${JSON.stringify(posted)}`);
    }
    const { id } = posted.value;
    // Written two days back, so it has ended both by the test's clock (REST) and by the real one (the hub's).
    const poll = { options: [...fill.choices], expiresIn: 86_400, multiple: false, hideTotals: false };
    writePoll(new Db(state.storage.sql), id, poll, NOW - 2 * 86_400_000);
    return id;
  });
}
