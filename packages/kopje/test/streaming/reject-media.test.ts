import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../../src/db/sql";
import { journalStatusUpdate } from "../../src/domain/stream-journal";
import { DEFAULT_AVATAR } from "../../src/platform/brand-assets";
import { type ApiHarness, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { blockDomain } from "../domain-block-helpers";
import { BUILD } from "../helpers";
import { community, remoteAccount } from "../status-helpers";
import { drained, type Inbox, subscribed, takeAll } from "./stream-helpers";

// #1560, VIS-30: a streamed `update` and `status.update` are the presented status (status-presenter.ts presentRow), so a
// rejected domain's status arrives as REST shows it: attachments `unknown` with media_proxy URLs, no emoji, the default
// avatar. A control account on an unblocked domain arrives in the same stream with its media.

const ORIGIN = "https://kopje.test";
const EMOJI = [["blob", "https://files.example/e.png"]];

type Sent = {
  id: string;
  emojis: unknown[];
  account: { avatar: string; emojis: unknown[] };
  media_attachments: { id: string; type: string; url: string | null; preview_url: string | null; remote_url: string }[];
};

let next = 910000000000000000n;
async function remoteStatus(h: ApiHarness, author: string, domain: string): Promise<{ id: string; media: string }> {
  const id = String(next++);
  const media = String(next++);
  await sql(
    h.store,
    `INSERT INTO statuses (id, uri, account_id, visibility, content, emojis, published_at, created_at)
		VALUES (?, ?, ?, 'public', '<p>:blob:</p>', ?, ?, ?)`,
    id,
    `https://${domain}/objects/${id}`,
    author,
    JSON.stringify(EMOJI),
    new Date(NOW).toISOString(),
    new Date(NOW).toISOString(),
  );
  await sql(
    h.store,
    "INSERT INTO media_attachments (id, account_id, status_id, type, url) VALUES (?, ?, ?, 'image', ?)",
    media,
    author,
    id,
    `https://${domain}/m.png`,
  );
  return { id, media };
}

async function author(h: ApiHarness, domain: string): Promise<string> {
  const id = await remoteAccount(h.store, domain.split(".")[0]!, domain);
  await sql(
    h.store,
    "UPDATE accounts SET avatar_url = ?, emojis = ? WHERE id = ?",
    `https://${domain}/a.png`,
    JSON.stringify(EMOJI),
    id,
  );
  return id;
}

// The payloads left on the socket, by status id, each of `event`; they are taken.
async function sent(inbox: Inbox, event: string): Promise<Map<string, Sent>> {
  const out = new Map<string, Sent>();
  for (const message of inbox.rest()) {
    expect(message.event).toBe(event);
    const payload = JSON.parse(message.payload!) as Sent;
    out.set(payload.id, payload);
  }
  await takeAll(inbox);
  return out;
}

describe("reject_media on the streams (#1560)", () => {
  it("streams an update and a status.update of a rejected domain withheld", async () => {
    const h = await community(["alice"]);
    const rejected = await author(h, "rejected.example");
    const control = await author(h, "control.example");
    await blockDomain(h.store, "rejected.example", "noop", { rejectMedia: true });
    const inbox = await subscribed(h, h.users.alice.token, "public");
    const withheld = await remoteStatus(h, rejected, "rejected.example");
    const shown = await remoteStatus(h, control, "control.example");

    const check = (payloads: Map<string, Sent>) => {
      expect([...payloads.keys()].toSorted()).toEqual([withheld.id, shown.id].toSorted());
      const w = payloads.get(withheld.id)!;
      expect(w.emojis).toEqual([]);
      expect(w.account.emojis).toEqual([]);
      expect(w.account.avatar).toBe(`${ORIGIN}${DEFAULT_AVATAR}`);
      expect(w.media_attachments).toMatchObject([
        {
          id: withheld.media,
          type: "unknown",
          url: `${ORIGIN}/media_proxy/${withheld.media}/original`,
          preview_url: `${ORIGIN}/media_proxy/${withheld.media}/small`,
          remote_url: "https://rejected.example/m.png",
        },
      ]);
      const c = payloads.get(shown.id)!;
      expect([c.emojis.length, c.account.emojis.length]).toEqual([1, 1]);
      expect(c.account.avatar).not.toBe(`${ORIGIN}${DEFAULT_AVATAR}`);
      expect(c.media_attachments).toMatchObject([{ id: shown.media, type: "image" }]);
    };

    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    check(await sent(inbox, "update"));

    await runInDurableObject(h.store, (_instance, state) => {
      const db = new Db(state.storage.sql);
      for (const id of [withheld.id, shown.id]) {
        db.run("UPDATE statuses SET content = '<p>:blob: edited</p>', edited_at = ?2 WHERE id = ?1", id, NOW + 1000);
        journalStatusUpdate(db, id, NOW + 1000, { mentions: true });
      }
    });
    await h.store.streamTick(BUILD);
    await drained(h, inbox);
    check(await sent(inbox, "status.update"));
  });
});
