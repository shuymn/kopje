import type { FC } from "hono/jsx";

import type { Status } from "../../domain/status-presenter";
import type { StatusStub } from "../../domain/web-pages/budget";
import type { PageCursor, Paging } from "../../domain/web-pages/paging";
import type { ParentLink } from "../../domain/web-pages/parents";
import type { Site } from "../../domain/web-pages/site";
import { Layout } from "../components/layout";
import { useUi } from "../ui";
import { emojiAllowance } from "../view/emoji";
import { newestFirstPager } from "../view/pager";
import { StatusFeed } from "./status";

export type TagView = {
  // The hashtag's normalized name.
  tag: string;
  statuses: Status[];
  // The first post when it was too large to show here.
  stub: StatusStub | null;
  // The parents the anonymous viewer may see, by id.
  parents: Record<string, ParentLink>;
  cursor: PageCursor;
  paging: Paging;
  site: Site;
};

// The cursor-less path of a hashtag's page: its normalized name, percent-encoded, as a post's hashtag links it.
export function tagPath(tag: string): string {
  return `/tags/${encodeURIComponent(tag)}`;
}

// /tags/:name: the hashtag's local public posts newest first, paged both ways. Any spelling of the name serves the
// page, with the normalized one canonical; there is no redirect.
export const TagPage: FC<TagView> = ({ tag, statuses, stub, parents, cursor, paging, site }) => {
  const { m } = useUi();
  const { domain } = site;
  const base = tagPath(tag);
  // A page with a cursor names its cursor-less page as canonical, and is not indexed.
  const canonical = `https://${domain}${base}`;
  const title = m.tag.title(tag);
  const pager = newestFirstPager(base, cursor, paging);
  return (
    <Layout
      title={title}
      chrome={site}
      head={
        <>
          {cursor === null ? null : <meta name="robots" content="noindex, follow" />}
          <meta property="og:site_name" content={domain} />
          <meta property="og:type" content="website" />
          <meta property="og:title" content={title} />
          <meta property="og:url" content={canonical} />
          <link rel="canonical" href={canonical} />
        </>
      }
    >
      <h1>{title}</h1>
      <StatusFeed
        statuses={statuses}
        stub={stub}
        parentOf={(status) => (status.in_reply_to_id === null ? null : (parents[status.in_reply_to_id] ?? null))}
        emptyText={m.tag.noPosts}
        pager={pager}
        domain={domain}
        allowance={emojiAllowance()}
      />
    </Layout>
  );
};
