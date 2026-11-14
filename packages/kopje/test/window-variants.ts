import { expect } from "vitest";

import { act, community, follow, ids, post } from "./status-helpers";

// The candidate windows of home, a list and a hashtag timeline (mergedWindow, src/domain/windows.ts) in each variant of
// their text: either order (a page by max_id, one by min_id), and for a hashtag timeline the most names it reads (the
// tag and four `any`, MAX_TAG_TIMELINE_NAMES) with and without request conditions (a walked read). A list's and home's
// streams have one text per order. Each page answers 200, so each statement prepared in the runtime that ran it.
export async function windowVariants(): Promise<void> {
  const h = await community(["alice", "bob"]);
  const { alice, bob } = h.users;
  await follow(h, alice, bob.id);
  const list = (await (await act(h, alice, "/api/v1/lists", { title: "l" })).json<{ id: string }>()).id;
  expect((await act(h, alice, `/api/v1/lists/${list}/accounts`, { account_ids: [bob.id] })).status).toBe(200);
  await post(h, alice, { status: "#a #b #c #d #e" });
  await post(h, bob, { status: "#a #e" });
  const any = "any[]=b&any[]=c&any[]=d&any[]=e";
  for (const order of ["max_id=9999999999999999999", "min_id=1"]) {
    await ids(h, `/api/v1/timelines/home?${order}`, alice.token);
    await ids(h, `/api/v1/timelines/list/${list}?${order}`, alice.token);
    await ids(h, `/api/v1/timelines/tag/a?${any}&${order}`, alice.token);
    await ids(h, `/api/v1/timelines/tag/a?${any}&all[]=e&none[]=z&local=true&only_media=false&${order}`);
  }
}

// A statement of mergedWindow's, by its family: home's (four kinds of stream), a list's, or a hashtag timeline's of
// the most names.
export const WINDOW_FAMILIES = {
  home: (sql: string) => sql.includes("json_group_array(id) AS members") && sql.includes("'own'"),
  list: (sql: string) => sql.includes("json_group_array(id) AS members") && sql.includes("FROM list_accounts la"),
  hashtag: (sql: string) =>
    sql.includes("json_group_array(id) AS members") && sql.includes("t.name = ?9") && !sql.includes("t.name = ?10"),
} as const;
