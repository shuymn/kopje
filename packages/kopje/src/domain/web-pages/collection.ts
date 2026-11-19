import { type Account, presentAccountsWithin } from "../accounts";
import type { Collection } from "../collection-presenter";
import { localCollectionOf, localCollectionPath } from "../collections";
import { admitMandatory, pageBudget } from "./budget";
import { pageAccountById } from "./profile";
import { pagePresent, pageRead, type Site } from "./site";
import { tagPageName } from "./tags";

export type CollectionPage =
  | {
      status: "ok";
      // The collection as the API presents it to an anonymous viewer: the accepted members R45 shows, in position
      // order, at most COLLECTION_MAX_ITEMS.
      collection: Collection;
      owner: Account;
      // The normalized name of the hashtag page its tag links (tagPageName), or null when none does.
      tag: string | null;
      // The accounts of its members, in their order, as many as the page admits.
      accounts: Account[];
    }
  | { status: "not_found" }
  | { status: "suspended" }
  // The path of its FeaturedCollection, for an ActivityPub client (`document`).
  | { status: "document"; path: string };

// /collections/:id, a local collection's url (Mastodon's CollectionsController#show, as HTML), as an anonymous viewer
// reads it (VIS-4): the collection localCollectionOf finds, its owner answered for as its profile is (a suspended
// owner's page is gone, 410). An unknown id, a remote collection's, or one R45 does not find is not found. document: an
// ActivityPub client's request, answered with the path of the local collection's FeaturedCollection, whose own read
// applies R45 (federation/routes.ts).
export const webCollectionPage = pageRead<{ id: string; document?: true }, CollectionPage>((db, input, site) => {
  if (input.document === true) {
    const path = localCollectionPath(db, input.id, `https://${site.domain}`);
    return path === null ? { status: "not_found" } : { status: "document", path };
  }
  const present = pagePresent(site);
  const found = localCollectionOf(db, input.id, present.origin, (owner) => pageAccountById(db, owner, site));
  if ("status" in found) {
    return found;
  }
  const { collection, owner } = found;
  // Within WEB_PAGE_BYTES: the collection, its owner and its tag's page name are the head; the members' accounts are
  // admitted in order while they fit, and the rest are left out: a collection holds at most COLLECTION_MAX_ITEMS
  // members, so the page has no pager.
  const budget = pageBudget({
    status: "ok",
    collection: null,
    owner: null,
    tag: null,
    accounts: [],
    site,
  } satisfies Record<keyof Extract<CollectionPage, { status: "ok" }>, unknown> & { site: Site });
  const tag = collection.tag === null ? null : tagPageName(collection.tag.name);
  admitMandatory(budget, collection);
  admitMandatory(budget, owner);
  admitMandatory(budget, tag);
  const ids = collection.items.flatMap((item) => (item.account_id === undefined ? [] : [item.account_id]));
  const accounts = presentAccountsWithin(db, ids, present, Math.max(0, budget.remaining), false);
  return { status: "ok", collection, owner, tag, accounts: accounts.items };
});
