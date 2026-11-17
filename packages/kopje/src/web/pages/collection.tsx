import type { FC } from "hono/jsx";

import type { Account } from "../../domain/accounts";
import type { Collection } from "../../domain/collection-presenter";
import type { Site } from "../../domain/web-pages/site";
import { AccountFeed } from "../components/accounts";
import { Layout } from "../components/layout";
import { ContentWarning, Who } from "../components/post";
import { useUi } from "../ui";
import { authorView } from "../view/account";
import { emojiAllowance } from "../view/emoji";
import { tagPath } from "./tag";

export type CollectionView = {
  collection: Collection;
  owner: Account;
  // The normalized name of the hashtag page its tag links, or null when none does.
  tag: string | null;
  // The accounts of its members, in their order.
  accounts: Account[];
  site: Site;
};

// The path of a local collection's page: its url (Mastodon's collection_url).
function collectionPath(id: string): string {
  return `/collections/${id}`;
}

// /collections/:id: a local collection as Mastodon's page and web client show it: its name, its owner, its
// description and hashtag, then its members as rows in one card. A sensitive collection keeps its description and
// members behind the post's disclosure, and its head names no description. Every collection page asks not to be
// indexed or archived, and links its FeaturedCollection, as Mastodon's (collections/show.html.haml).
export const CollectionPage: FC<CollectionView> = ({ collection, owner, tag, accounts, site }) => {
  const { lang, m } = useUi();
  const { domain } = site;
  const canonical = `https://${domain}${collectionPath(collection.id)}`;
  // The collection's language, else an unknown one: its name and description are written in it.
  const written = collection.language ?? "";
  // The page's emoji allowance, spent in document order: the owner's row, then the members.
  const allowance = emojiAllowance();
  const ownerView = authorView(owner, domain, allowance);
  const members = accounts.map((account) => authorView(account, domain, allowance));
  const description = collection.description ?? "";
  // The description in the head unless the collection is sensitive, as Mastodon's page.
  const summary = collection.sensitive || description === "" ? null : description;
  const body = (
    <>
      {description === "" ? null : <p lang={written}>{description}</p>}
      <section class="stack">
        <h2>{m.collection.accounts}</h2>
        <AccountFeed accounts={members} emptyText={m.collection.noAccounts} pager={{ newer: null, older: null }} />
      </section>
    </>
  );
  return (
    <Layout
      title={m.collection.title(collection.name)}
      chrome={site}
      head={
        <>
          <meta name="robots" content="noindex, noarchive" />
          {summary === null ? null : <meta name="description" content={summary} />}
          <meta property="og:site_name" content={domain} />
          <meta property="og:type" content="website" />
          <meta property="og:title" content={collection.name} />
          {summary === null ? null : <meta property="og:description" content={summary} />}
          <meta property="og:url" content={canonical} />
          {collection.language === null ? null : <meta property="og:locale" content={collection.language} />}
          <link rel="canonical" href={canonical} />
          <link rel="alternate" type="application/activity+json" href={collection.uri} />
        </>
      }
    >
      <div class="stack">
        <h1 lang={written}>{collection.name}</h1>
        <Who account={ownerView} size={40} />
        {collection.tag === null ? null : (
          <p class="muted">
            {tag === null ? `#${collection.tag.name}` : <a href={tagPath(tag)}>#{collection.tag.name}</a>}
          </p>
        )}
      </div>
      {collection.sensitive ? (
        <ContentWarning text={[m.collection.sensitive]} lang={lang}>
          {body}
        </ContentWarning>
      ) : (
        body
      )}
    </Layout>
  );
};
