import { bindAll } from "../platform/dump-literals";
import type { RowCheck } from "../platform/store-dump";
import { fetchableMove, namedMove } from "./collection-requests";
import { actorUriSql } from "./profile-bounds";

// A pending move (accounts.move_pending, 0125_account_move_pending) that the Store's writers never leave, refused at an
// import's verification (`move-pending-invalid`; platform/store-admin.ts runs it beside its own row checks): an account
// pending without an unread collection sync (generation > read_through), which no claim would ever end, or whose stored
// document names no destination the sync may fetch (fetchableMove, against the instance's origin `https://<domain>`).
// A valid pending row is kept with its sync and its lease as dumped, so the restored claim resumes or gives the read up.
// Checked on each accounts row the checksum scan reads, once every row is in: one seek of the account by key and one of
// its sync.
export function pendingMoveCheck(sql: SqlStorage, domain: string | null): RowCheck {
  const origin = domain === null ? "" : `https://${domain}`;
  return (spec, row) => {
    const pending = spec.name === "accounts" ? row.literals[spec.columns.indexOf("move_pending")] : undefined;
    const literal = row.literals[spec.columns.indexOf("id")];
    if (pending !== "1" || literal === undefined) {
      return null;
    }
    const bound = bindAll([literal]);
    const account = sql
      .exec<{ uri: SqlStorageValue; raw: SqlStorageValue; unread: number }>(
        `SELECT ${actorUriSql("a.uri")} AS uri, a.raw, EXISTS (SELECT 1 FROM collection_syncs c WHERE c.account_id = a.id
				AND c.generation > c.read_through) AS unread
			FROM accounts a WHERE a.id = ${bound.exprs[0]!}`,
        ...bound.params,
      )
      .toArray()[0];
    const fetchable =
      account !== undefined &&
      account.unread === 1 &&
      typeof account.uri === "string" &&
      typeof account.raw === "string" &&
      fetchableMove(namedMove(account.raw, account.uri), origin) !== null;
    return fetchable
      ? null
      : `move-pending-invalid: accounts ${literal} has a pending move without an unread collection sync or a movedTo the sync may fetch, which Kopje never stores; this dump cannot be restored`;
  };
}
