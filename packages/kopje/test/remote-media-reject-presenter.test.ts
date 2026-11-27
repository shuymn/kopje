import { describe, expect, it } from "vitest";

import { INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX } from "../src/db/indexes";
import { MAX_BLOCK_LABELS, presentedMediaRejectedSql } from "../src/domain/audience";
import { statusRowBoundSql } from "../src/domain/status-rows";
import { recordEdit } from "../src/domain/statuses";
import { publicTimeline } from "../src/domain/timelines";
import { DEFAULT_AVATAR, DEFAULT_HEADER } from "../src/platform/brand-assets";
import { sql } from "./api-helpers";
import { acceptQuote } from "./budget-helpers";
import { blockDomain, setRejectMedia, unblockDomain } from "./domain-block-helpers";
import { mastodonActor } from "./inbox-helpers";
import { accountId, followed, like, localStatus } from "./inbox-status-helpers";
import { measuredStatements, staleStatistics } from "./read-helpers";
import { mediaWorld, type MediaWorld, snapshot } from "./remote-media-helpers";
import { seedStatus } from "./status-helpers";

// #1560, VIS-30: while a domain block with reject_media rules a remote account's stored domain (the nearest block, read
// live in the row's own query: audience.ts presentedMediaRejectedSql), the presenters show nothing that makes a client
// load its media: the default profile images and no emoji. Each case reads a control account on a domain no such rule
// names in the same answer, and compares a withheld value with the same entity read before the block.

const ORIGIN = "https://kopje.test";
const REJECTED = "rejected.example";
const CONTROL = "control.example";

type Images = { avatar: string; avatar_static: string; header: string; header_static: string };
type Shown = Images & { id: string; emojis: { url: string }[]; display_name: string; moved?: Shown | null };

const DEFAULTS: Images = {
  avatar: `${ORIGIN}${DEFAULT_AVATAR}`,
  avatar_static: `${ORIGIN}${DEFAULT_AVATAR}`,
  header: `${ORIGIN}${DEFAULT_HEADER}`,
  header_static: `${ORIGIN}${DEFAULT_HEADER}`,
};

const images = ({ avatar, avatar_static, header, header_static }: Images): Images => ({
  avatar,
  avatar_static,
  header,
  header_static,
});

let tokens = 0;

// A remote account of `domain` (its actor id on `uriHost`) with an avatar, a header and one emoji its display name
// references, both images' slots enqueued; with `cached`, both stored, so the account presents its cached copies.
async function account(
  w: MediaWorld,
  domain: string,
  options: { cached?: boolean; uriHost?: string } = {},
): Promise<string> {
  const { id } = await w.remote({ avatar: `https://${domain}/a.png`, header: `https://${domain}/h.png` }, domain);
  await sql(
    w.t.store,
    "UPDATE accounts SET uri = ?2, display_name = ':e0: name', emojis = ?3 WHERE id = ?1",
    id,
    `https://${options.uriHost ?? domain}/users/u${id}`,
    snapshot("https://files.example/emoji/e0.png"),
  );
  if (options.cached === true) {
    await sql(
      w.t.store,
      `UPDATE remote_media SET token = ?2, ext = 'png', stored_at = 1, due_at = NULL
				WHERE owner_id = ?1 AND kind IN ('avatar', 'header')`,
      id,
      `T${String(++tokens).padStart(42, "0")}`,
    );
    await sql(
      w.t.store,
      "UPDATE remote_media_usage SET pending = (SELECT count(*) FROM remote_media WHERE due_at IS NOT NULL)",
    );
  }
  return id;
}

const shown = async (w: MediaWorld, id: string) => {
  const { status, body } = await w.t.api<Shown>(`/api/v1/accounts/${id}`, null);
  expect(status, id).toBe(200);
  return body;
};

const rejectMedia = (w: MediaWorld, domain: string, severity: "noop" | "suspend" = "noop") =>
  blockDomain(w.t.store, domain, severity, { rejectMedia: true });

describe("reject_media in the presented accounts (#1560)", () => {
  it("presents the default images in the Account, moved and partial accounts, cached or not", async () => {
    const w = await mediaWorld();
    const cached = await account(w, REJECTED, { cached: true });
    const plain = await account(w, REJECTED);
    const control = await account(w, CONTROL, { cached: true });
    // `moved` both ways: a rejected account moved to the control, and a control moved to a rejected account.
    const movedOut = await account(w, REJECTED);
    const movedIn = await account(w, CONTROL);
    await sql(w.t.store, "UPDATE accounts SET moved_to_account_id = ?2 WHERE id = ?1", movedOut, control);
    await sql(w.t.store, "UPDATE accounts SET moved_to_account_id = ?2 WHERE id = ?1", movedIn, cached);
    const ids = [cached, plain, control, movedOut, movedIn];
    const before = new Map<string, Shown>();
    for (const id of ids) {
      before.set(id, await shown(w, id));
    }
    // Before the block: the cached copies, and the remote images uncached.
    expect(before.get(cached)!.avatar).toMatch(/^https:\/\/kopje\.test\/media\/r\//);
    expect(before.get(plain)!.avatar).toBe(`https://${REJECTED}/a.png`);
    expect(before.get(movedIn)!.moved!.avatar).toBe(before.get(cached)!.avatar);

    await rejectMedia(w, REJECTED);
    const after = new Map<string, Shown>();
    for (const id of ids) {
      after.set(id, await shown(w, id));
    }
    expect(images(after.get(cached)!)).toEqual(DEFAULTS);
    expect(images(after.get(plain)!)).toEqual(DEFAULTS);
    expect(images(after.get(movedOut)!)).toEqual(DEFAULTS);
    expect(after.get(control)).toEqual(before.get(control));
    // `moved` judges the target by the target's own domain.
    expect(after.get(movedOut)!.moved).toEqual(before.get(movedOut)!.moved);
    expect(images(after.get(movedOut)!.moved!)).toEqual(images(before.get(control)!));
    expect(images(after.get(movedIn)!)).toEqual(images(before.get(movedIn)!));
    expect(images(after.get(movedIn)!.moved!)).toEqual(DEFAULTS);
    // The text stays.
    expect(after.get(cached)!.display_name).toBe(before.get(cached)!.display_name);
  });

  it("presents the default avatar in a grouped notification's partial and whole accounts", async () => {
    const w = await mediaWorld();
    const extra = (domain: string) => ({
      icon: { type: "Image", mediaType: "image/png", url: `https://${domain}/a.png` },
      image: { type: "Image", mediaType: "image/png", url: `https://${domain}/h.png` },
    });
    const rejected = await mastodonActor(w.t.web, "bob", { origin: `https://${REJECTED}`, extra: extra(REJECTED) });
    const control = await mastodonActor(w.t.web, "carol", { origin: `https://${CONTROL}`, extra: extra(CONTROL) });
    await followed(w.t, rejected);
    await followed(w.t, control);
    const status = await localStatus(w.t, { status: "hello" });
    // The rejected account first, so the later control is the group's whole account and the rejected one partial.
    expect(await w.t.post(rejected, like(rejected, status.uri))).toBe(202);
    expect(await w.t.post(control, like(control, status.uri))).toBe(202);
    const ids = {
      rejected: (await accountId(w.t.store, rejected.uri))!,
      control: (await accountId(w.t.store, control.uri))!,
    };
    type Partial = { id: string; avatar: string; avatar_static: string };
    type Grouped = { accounts: Partial[]; partial_accounts: Partial[] };
    const read = async () => {
      const { body } = await w.t.api<Grouped>("/api/v2/notifications?expand_accounts=partial_avatars");
      return body;
    };
    const before = await read();
    expect(before.partial_accounts.map((a) => a.id)).toContain(ids.rejected);
    expect(before.accounts.map((a) => a.id)).toContain(ids.control);
    expect(before.partial_accounts.find((a) => a.id === ids.rejected)!.avatar).toBe(`https://${REJECTED}/a.png`);
    await rejectMedia(w, REJECTED);
    const after = await read();
    expect(after.partial_accounts.find((a) => a.id === ids.rejected)).toMatchObject({
      avatar: DEFAULTS.avatar,
      avatar_static: DEFAULTS.avatar,
    });
    expect(after.accounts.find((a) => a.id === ids.control)).toEqual(before.accounts.find((a) => a.id === ids.control));
    // The rejected account presented whole (expand_accounts=full) is withheld too.
    const { body: full } = await w.t.api<{ accounts: Shown[] }>("/api/v2/notifications?expand_accounts=full");
    expect(images(full.accounts.find((a) => a.id === ids.rejected)!)).toEqual(DEFAULTS);
  });

  it("presents no emoji of the account and of moved, its display name unchanged", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const control = await account(w, CONTROL);
    const movedIn = await account(w, CONTROL);
    await sql(w.t.store, "UPDATE accounts SET moved_to_account_id = ?2 WHERE id = ?1", movedIn, rejected);
    const before = [await shown(w, rejected), await shown(w, control), await shown(w, movedIn)];
    expect(before[0]!.emojis).toHaveLength(1);
    expect(before[2]!.moved!.emojis).toHaveLength(1);
    await rejectMedia(w, REJECTED);
    const after = [await shown(w, rejected), await shown(w, control), await shown(w, movedIn)];
    expect(after[0]!.emojis).toEqual([]);
    expect(after[0]!.display_name).toBe(before[0]!.display_name);
    expect(after[0]!.display_name).toContain(":e0:");
    expect(after[1]).toEqual(before[1]);
    expect(after[2]!.emojis).toEqual(before[2]!.emojis);
    expect(after[2]!.moved!.emojis).toEqual([]);
    expect(after[2]!.moved!.display_name).toBe(before[2]!.moved!.display_name);
  });

  it("presents the media again after the flag is turned off, and after the block is deleted", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED, { cached: true });
    const before = await shown(w, rejected);
    const block = await rejectMedia(w, REJECTED);
    expect(images(await shown(w, rejected))).toEqual(DEFAULTS);
    await setRejectMedia(w.t.store, block.id, false);
    expect(await shown(w, rejected)).toEqual(before);
    await setRejectMedia(w.t.store, block.id, true);
    expect(images(await shown(w, rejected))).toEqual(DEFAULTS);
    await unblockDomain(w.t.store, block.id);
    expect(await shown(w, rejected)).toEqual(before);
  });

  it("keeps a child's subtree shown while its parent gains the flag", async () => {
    const w = await mediaWorld();
    const child = await account(w, `sub.${REJECTED}`);
    const sibling = await account(w, `other.${REJECTED}`);
    const before = [await shown(w, child), await shown(w, sibling)];
    await blockDomain(w.t.store, `sub.${REJECTED}`, "noop");
    const parent = await blockDomain(w.t.store, REJECTED, "noop");
    await setRejectMedia(w.t.store, parent.id, true);
    expect(await shown(w, child)).toEqual(before[0]);
    expect(images(await shown(w, sibling))).toEqual(DEFAULTS);
  });

  it("judges by the stored domain alone, not the actor host", async () => {
    const w = await mediaWorld();
    // The actor id on the rejected host, the stored domain elsewhere; and the reverse.
    const byHost = await account(w, CONTROL, { uriHost: REJECTED });
    const byDomain = await account(w, REJECTED, { uriHost: CONTROL });
    const before = await shown(w, byHost);
    await rejectMedia(w, REJECTED);
    expect(await shown(w, byHost)).toEqual(before);
    expect(images(await shown(w, byDomain))).toEqual(DEFAULTS);
  });

  it("presents a local account's media unchanged under any block", async () => {
    const w = await mediaWorld();
    const local = `${ORIGIN}/media/${"L".repeat(43)}/full.png`;
    await sql(w.t.store, "UPDATE accounts SET avatar_url = ?1, header_url = ?1 WHERE domain IS NULL", local);
    const rejected = await account(w, REJECTED);
    const [alice] = await sql<{ id: string }>(w.t.store, "SELECT id FROM accounts WHERE username = 'alice'");
    const before = await shown(w, alice!.id);
    expect(before.avatar).toBe(local);
    await rejectMedia(w, REJECTED);
    await rejectMedia(w, "kopje.test");
    expect(await shown(w, alice!.id)).toEqual(before);
    // The guarded branch ran: the rejected account is withheld in the same Store.
    expect(images(await shown(w, rejected))).toEqual(DEFAULTS);
  });

  // The over-long decision: a stored domain past DNS_NAME_UTF8_BYTES (1,012) bytes after rtrim is unruled in the
  // presenters, as before the rule was read, whether or not a block has reject_media; one of 1,012 bytes under the same
  // flagged suffix is withheld. The cache's half (it rejects the longer one) is test/domain-suffix-walk.test.ts's.
  it("shows an over-long domain's images, independent of unrelated blocks", async () => {
    const w = await mediaWorld();
    const suffix = `big.${REJECTED}`;
    const of = (bytes: number) => `${"a".repeat(bytes - suffix.length - 1)}.${suffix}`;
    const long = await account(w, `${of(1_013)}.`);
    const atBound = await account(w, `${of(1_012)}.`);
    const unrelated = await account(w, CONTROL);
    const before = [await shown(w, long), await shown(w, atBound)];
    await rejectMedia(w, "unrelated.example");
    expect([await shown(w, long), await shown(w, atBound)]).toEqual(before);
    await rejectMedia(w, suffix);
    expect(await shown(w, long)).toEqual(before[0]);
    expect(images(await shown(w, atBound))).toEqual(DEFAULTS);
    expect(images(await shown(w, unrelated))).not.toEqual(DEFAULTS);
  });
});

type Media = {
  id: string;
  type: string;
  url: string | null;
  preview_url: string | null;
  remote_url: string | null;
  preview_remote_url: string | null;
  description: string | null;
  meta: unknown;
  blurhash: string | null;
  withheld?: true;
};
type ShownStatus = {
  id: string;
  media_attachments: Media[];
  emojis: unknown[];
  content: string;
  reblog: ShownStatus | null;
  quote: { quoted_status: ShownStatus | null } | null;
  poll: { emojis: unknown[] } | null;
  account: Images;
};
type Version = { media_attachments: Media[]; emojis: unknown[]; content: string };

// A remote status of `account` with one image attachment at `file` (its icon `file` with `s`), its text and emoji
// snapshot referencing one emoji, a description, meta and a stored blurhash.
async function statusOf(w: MediaWorld, account: string, file: string) {
  const { status, media } = await w.attach(account, file, { preview: `${file}s` });
  await sql(
    w.t.store,
    "UPDATE statuses SET content = '<p>:e0: text</p>', emojis = ?2 WHERE id = ?1",
    status,
    snapshot("https://files.example/emoji/e0.png"),
  );
  await sql(
    w.t.store,
    `UPDATE media_attachments SET description = 'A cat', blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
			meta = '{"original":{"width":640,"height":480},"small":{"width":64,"height":48}}' WHERE id = ?`,
    media,
  );
  return { status, media };
}

const status = async (w: MediaWorld, id: string) => {
  const { status: code, body } = await w.t.api<ShownStatus>(`/api/v1/statuses/${id}`, null);
  expect(code, id).toBe(200);
  return body;
};

const history = async (w: MediaWorld, id: string) => {
  const { status: code, body } = await w.t.api<Version[]>(`/api/v1/statuses/${id}/history`, null);
  expect(code, id).toBe(200);
  return body;
};

// `media` as presented while withheld: Mastodon's shape for an attachment received under the rule.
const withheld = (media: Media): Media => ({
  ...media,
  type: "unknown",
  url: `${ORIGIN}/media_proxy/${media.id}/original`,
  preview_url: `${ORIGIN}/media_proxy/${media.id}/small`,
});

const edit = (w: MediaWorld, id: string) => w.db((d) => recordEdit(d, id, new Date(w.clock.now).toISOString()));

describe("reject_media in the presented statuses (#1560)", () => {
  it("presents each attachment as unknown with media_proxy URLs, in the status, a boost, quotes both ways and its history", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const control = await account(w, CONTROL);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const c = await statusOf(w, control, `https://${CONTROL}/m/1.png`);
    const boost = await seedStatus(w.t.store, { accountId: control, visibility: "public", reblogOfId: r.status });
    // A control's status quoting the rejected one, and the reverse.
    const quoting = await statusOf(w, control, `https://${CONTROL}/m/2.png`);
    await acceptQuote(w.t, quoting.status, r.status);
    const quoted = await statusOf(w, rejected, `https://${REJECTED}/m/2.png`);
    await acceptQuote(w.t, quoted.status, c.status);
    await edit(w, r.status);
    const read = async () => ({
      r: await status(w, r.status),
      c: await status(w, c.status),
      boost: await status(w, boost),
      quoting: await status(w, quoting.status),
      quoted: await status(w, quoted.status),
      history: await history(w, r.status),
    });
    const before = await read();
    const [own] = before.r.media_attachments;
    expect(own!.remote_url).toBe(`https://${REJECTED}/m/1.png`);
    expect(own!.preview_remote_url).toBe(`https://${REJECTED}/m/1.pngs`);
    expect(before.history.map((v) => v.media_attachments)).toEqual([[own]]);
    await rejectMedia(w, REJECTED);
    const after = await read();
    expect(after.r.media_attachments).toEqual([withheld(own!)]);
    expect(after.r.media_attachments[0]!.remote_url).not.toBeNull();
    expect(after.c).toEqual(before.c);
    expect(after.boost.reblog!.media_attachments).toEqual([withheld(own!)]);
    expect(after.quoting.media_attachments).toEqual(before.quoting.media_attachments);
    expect(after.quoting.quote!.quoted_status!.media_attachments).toEqual([withheld(own!)]);
    expect(after.quoted.media_attachments).toEqual(before.quoted.media_attachments.map(withheld));
    expect(after.quoted.quote!.quoted_status!.media_attachments).toEqual(before.c.media_attachments);
    expect(after.history.map((v) => v.media_attachments)).toEqual([[withheld(own!)]]);
    // No API answer carries the pages' flag.
    expect(JSON.stringify(after)).not.toContain('"withheld"');
  });

  it("presents no emoji of its statuses, their polls and history, the shortcodes kept", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const control = await account(w, CONTROL);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const c = await statusOf(w, control, `https://${CONTROL}/m/1.png`);
    for (const id of [r.status, c.status]) {
      await sql(
        w.t.store,
        `INSERT INTO polls (status_id, options, tallies, expires_at) VALUES (?, '[":e0: yes","no"]', '[0,0]',
					'2099-01-01T00:00:00.000Z')`,
        id,
      );
    }
    await edit(w, r.status);
    const poll = async (id: string) => (await w.t.api<{ emojis: unknown[] }>(`/api/v1/polls/${id}`, null)).body;
    const read = async () => ({
      r: await status(w, r.status),
      c: await status(w, c.status),
      polls: [await poll(r.status), await poll(c.status)],
      history: await history(w, r.status),
    });
    const before = await read();
    expect(before.r.emojis).toHaveLength(1);
    expect(before.r.poll!.emojis).toHaveLength(1);
    expect(before.polls[0]!.emojis).toHaveLength(1);
    expect(before.history.map((v) => v.emojis.length)).toEqual([1]);
    await rejectMedia(w, REJECTED);
    const after = await read();
    expect([after.r.emojis, after.r.poll!.emojis, after.polls[0]!.emojis]).toEqual([[], [], []]);
    expect(after.history.map((v) => v.emojis)).toEqual([[]]);
    expect(after.r.content).toBe(before.r.content);
    expect(after.r.content).toContain(":e0:");
    expect(after.history.map((v) => v.content)).toEqual(before.history.map((v) => v.content));
    expect([after.c, after.polls[1]]).toEqual([before.c, before.polls[1]]);
  });

  it("withholds a cached copy from the block's commit, before the validity walk", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED, { cached: true });
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    await sql(
      w.t.store,
      `UPDATE remote_media SET token = ?2, ext = 'png', stored_at = 1, due_at = NULL
				WHERE owner_id = ?1 AND kind = 'attachment'`,
      r.media,
      `C${"0".repeat(42)}`,
    );
    const before = await status(w, r.status);
    expect(before.media_attachments[0]!.url).toMatch(/^https:\/\/kopje\.test\/media\/r\//);
    await rejectMedia(w, REJECTED);
    const after = await status(w, r.status);
    expect(after.media_attachments[0]).toMatchObject({
      type: "unknown",
      url: `${ORIGIN}/media_proxy/${r.media}/original`,
      remote_url: `https://${REJECTED}/m/1.png`,
    });
    expect(images(after.account)).toEqual(DEFAULTS);
    // The slots are still stored: the validity walk has not run.
    expect(
      await sql(
        w.t.store,
        "SELECT count(*) AS n FROM remote_media WHERE token IS NOT NULL AND account_id = ?",
        rejected,
      ),
    ).toEqual([{ n: 3 }]);
  });

  it("presents the media again after the flag is turned off, and after the block is deleted", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const before = await status(w, r.status);
    const block = await rejectMedia(w, REJECTED);
    expect((await status(w, r.status)).media_attachments).toEqual(before.media_attachments.map(withheld));
    await setRejectMedia(w.t.store, block.id, false);
    expect(await status(w, r.status)).toEqual(before);
    await setRejectMedia(w.t.store, block.id, true);
    await unblockDomain(w.t.store, block.id);
    expect(await status(w, r.status)).toEqual(before);
  });

  it("judges an imported attachment by its owner in the status and its history, both ways", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const control = await account(w, CONTROL);
    // A control's status whose attachment row is the rejected account's, and the reverse.
    const foreign = await statusOf(w, control, `https://${CONTROL}/m/1.png`);
    await sql(w.t.store, "UPDATE media_attachments SET account_id = ? WHERE id = ?", rejected, foreign.media);
    const own = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    await sql(w.t.store, "UPDATE media_attachments SET account_id = ? WHERE id = ?", control, own.media);
    await edit(w, foreign.status);
    await edit(w, own.status);
    const read = async () => ({
      foreign: (await status(w, foreign.status)).media_attachments,
      own: (await status(w, own.status)).media_attachments,
      foreignHistory: (await history(w, foreign.status)).map((v) => v.media_attachments),
      ownHistory: (await history(w, own.status)).map((v) => v.media_attachments),
    });
    const before = await read();
    await rejectMedia(w, REJECTED);
    const after = await read();
    expect(after.foreign).toEqual(before.foreign.map(withheld));
    expect(after.foreignHistory).toEqual([after.foreign]);
    expect(after.own).toEqual(before.own);
    expect(after.ownHistory).toEqual(before.ownHistory);
  });

  it("keeps the stored texts and blurhash", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const before = (await status(w, r.status)).media_attachments[0]!;
    await rejectMedia(w, REJECTED);
    const after = (await status(w, r.status)).media_attachments[0]!;
    expect(after).toMatchObject({ description: "A cat", blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" });
    expect([after.description, after.meta, after.blurhash]).toEqual([before.description, before.meta, before.blurhash]);
  });

  // A converted history (cli/lib/cutover/convert.js) may record the origin's file as `url` with no remote_url, and even
  // an instance URL: a withheld entry names the origin's file as its remote_url, never an instance URL in any spelling.
  it("keeps a converted version's file as its remote_url when withheld, never an instance URL", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const entry = (id: string, url: string) => ({
      id,
      type: "image",
      url,
      preview_url: url,
      remote_url: null,
      preview_remote_url: null,
      meta: null,
      description: null,
      blurhash: null,
    });
    const urls = [
      `https://${REJECTED}/m/old.png`,
      "https://KOPJE.TEST./media/x.png",
      "https://kopje.test:443/media/x.png",
      "https://kopje.test/media/x.png",
    ];
    await sql(
      w.t.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at)
				VALUES (?1, '', '', 0, ?2, ?3)`,
      r.status,
      JSON.stringify(urls.map((url, i) => entry(`10${i}`, url))),
      new Date(w.clock.now).toISOString(),
    );
    const remotes = async () => (await history(w, r.status))[0]!.media_attachments.map((m) => m.remote_url);
    expect(await remotes()).toEqual([null, null, null, null]);
    await rejectMedia(w, REJECTED);
    expect(await remotes()).toEqual([urls[0], null, null, null]);
  });

  // An entry's id whose cut names a current attachment (a NUL, then more than SNAPSHOT_KEY_LIMIT bytes in all) is not
  // that attachment: it takes no URL from it, and no owner's verdict, so the author's withholds it.
  it("does not match a NUL-truncated snapshot id to a live attachment", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const control = await account(w, CONTROL);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const nulId = `${r.media}\u0000${"a".repeat(20)}`;
    const file = `https://${REJECTED}/m/leak.png`;
    await sql(
      w.t.store,
      `INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at)
				VALUES (?1, '', '', 0, ?2, ?3)`,
      r.status,
      JSON.stringify([{ id: nulId, type: "image", url: file, preview_url: null, remote_url: file }]),
      new Date(w.clock.now).toISOString(),
    );
    await rejectMedia(w, REJECTED);
    const [sameOwner] = (await history(w, r.status))[0]!.media_attachments;
    expect([sameOwner!.type, sameOwner!.url, sameOwner!.preview_url]).toEqual(["unknown", null, null]);
    // The current attachment of an unruled owner (an imported row) lends the entry no verdict either.
    await sql(w.t.store, "UPDATE media_attachments SET account_id = ? WHERE id = ?", control, r.media);
    const [foreignOwner] = (await history(w, r.status))[0]!.media_attachments;
    expect([foreignOwner!.type, foreignOwner!.url, foreignOwner!.preview_url]).toEqual(["unknown", null, null]);
  });

  it("withholds a snapshot entry with an unsafe id without a URL", async () => {
    const w = await mediaWorld();
    const rejected = await account(w, REJECTED);
    const r = await statusOf(w, rejected, `https://${REJECTED}/m/1.png`);
    const digits = "1".repeat(32);
    const ids: unknown[] = [
      null,
      undefined,
      "../x",
      "a/b",
      "%2F",
      "ab\u0000cd",
      `\u0000${"a".repeat(40)}`,
      `${digits}2`,
      // Not text: a number's digits would name a path segment, so the JSON type decides.
      7,
    ];
    const all = [...ids, digits, "Ab_9-"];
    // One version per entry (a version presents at most MAX_STATUS_MEDIA), its file naming its place.
    for (const [i, id] of all.entries()) {
      const file = `https://${REJECTED}/m/e${String(i).padStart(2, "0")}.png`;
      const entry = {
        ...(id === undefined ? {} : { id }),
        type: "image",
        url: file,
        preview_url: null,
        remote_url: file,
        preview_remote_url: null,
        meta: null,
        description: null,
        blurhash: null,
      };
      await sql(
        w.t.store,
        `INSERT INTO status_edits (status_id, content, spoiler_text, sensitive, media_json, created_at)
					VALUES (?1, '', '', 0, ?2, ?3)`,
        r.status,
        JSON.stringify([entry]),
        new Date(w.clock.now + i).toISOString(),
      );
    }
    await rejectMedia(w, REJECTED);
    // The cut takes 32 code points of an id: the 33 digits read as the 32 beside them, whose URL they do not get.
    const shown = (await history(w, r.status))
      .flatMap((v) => v.media_attachments)
      .toSorted((a, b) => (a.remote_url! < b.remote_url! ? -1 : 1));
    expect(shown.map((m) => [m.type, m.url, m.preview_url])).toEqual([
      ...ids.map(() => ["unknown", null, null]),
      ["unknown", `${ORIGIN}/media_proxy/${digits}/original`, `${ORIGIN}/media_proxy/${digits}/small`],
      ["unknown", `${ORIGIN}/media_proxy/Ab_9-/original`, `${ORIGIN}/media_proxy/Ab_9-/small`],
    ]);
    expect(JSON.stringify(shown)).not.toContain("proxy_id");
  });
});

// RES-7, RES-3: the verdict's cost on a public timeline page (timelines.ts publicTimeline, the heap estimate
// statusRowBoundSql included), measured by the rows its statements read.
describe("the cost of the presented verdict (#1560)", () => {
  // The deepest walk: a stored domain past MAX_BLOCK_LABELS labels whose suffix far.example a noop block without
  // reject_media names, so every suffix is sought.
  const DEEP = [...Array.from({ length: MAX_BLOCK_LABELS + 2 }, (_, i) => `l${i}`), "far", "example"].join(".");
  const PAGE = { limit: 20 };

  // 10 statuses of 10 accounts of DEEP, each with one attachment of its author (`media`).
  async function page(media = true) {
    const w = await mediaWorld();
    for (let i = 0; i < 10; i++) {
      const author = await account(w, DEEP);
      if (media) {
        await statusOf(w, author, `https://files.example/m/${i}.png`);
      } else {
        await seedStatus(w.t.store, { accountId: author, visibility: "public" });
      }
    }
    const rows = async () => {
      const { output, statements } = await measuredStatements(w.t, publicTimeline, {
        credential: null,
        now: w.clock.now,
        page: PAGE,
        local: false,
        remote: false,
        onlyMedia: false,
        present: { origin: ORIGIN },
      });
      expect(output.status === "ok" && output.value.items.length).toBe(10);
      return statements.reduce((sum, s) => sum + s.rows, 0);
    };
    const grow = (flag: number) =>
      sql(
        w.t.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
				INSERT INTO instance_domain_blocks (domain, severity, reject_media, created_at, updated_at)
				SELECT 'g' || i || '.example', 'noop', ?1, 'x', 'x' FROM n`,
        flag,
      );
    return { w, rows, grow };
  }

  it("reads no domain walk without a reject_media block, after growth", async () => {
    const { w, rows, grow } = await page();
    const suffix = await blockDomain(w.t.store, "far.example", "noop");
    const { before, after } = await staleStatistics(w.t, { capture: rows, grow: () => grow(0) });
    await unblockDomain(w.t.store, suffix.id);
    // The matching noop block, which every presented row's walk would read, adds no row read.
    expect([before, after]).toEqual([await rows(), await rows()]);
  });

  it("bounds the reject_media walk per row", async () => {
    // Structurally: the walk seeks suffixes of at most MAX_BLOCK_LABELS labels, two keyed seeks each, and the heap
    // estimate runs none.
    const walk = presentedMediaRejectedSql("a");
    expect(walk).toContain(`BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1}`);
    expect(walk.split(`INDEXED BY ${INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX}`)).toHaveLength(3);
    expect(statusRowBoundSql()).not.toContain("instance_domain_blocks_reject_media");
    // At runtime: with a reject_media block, the rows read grow with the walking rows, not with 3,000 blocks.
    const { w, rows, grow } = await page();
    await blockDomain(w.t.store, "far.example", "noop");
    await rejectMedia(w, "unrelated.example");
    const { before, after } = await staleStatistics(w.t, { capture: rows, grow: () => grow(1) });
    expect(after).toBe(before);
    // A page whose attachments are their authors' walks no attachment: it reads as many rows more with the flag as a
    // page of the same statuses without attachments.
    const bare = await page(false);
    await blockDomain(bare.w.t.store, "far.example", "noop");
    const [withMedia, withoutMedia] = [await rows(), await bare.rows()];
    await sql(w.t.store, "DELETE FROM instance_domain_blocks WHERE reject_media = 1");
    await rejectMedia(bare.w, "unrelated.example");
    const [unflagged, flagged] = [await rows(), await bare.rows()];
    expect(withMedia - unflagged).toBe(flagged - withoutMedia);
  });
});
