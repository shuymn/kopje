import { describe, expect, it } from "vitest";

import { DEFAULT_AVATAR, DEFAULT_HEADER } from "../src/platform/brand-assets";
import { sql } from "./api-helpers";
import { blockDomain, setRejectMedia, unblockDomain } from "./domain-block-helpers";
import { mastodonActor } from "./inbox-helpers";
import { accountId, followed, like, localStatus } from "./inbox-status-helpers";
import { mediaWorld, type MediaWorld, snapshot } from "./remote-media-helpers";

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
