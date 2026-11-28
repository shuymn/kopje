import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";

// #1564 D5: a creation time past midnight, so that a presenter showing it instead of its day differs, and that day as
// an Account shows it (REST::AccountSerializer#created_at) and as an actor publishes it (ActorSerializer#published).
export const CREATED_AT = "2026-10-12T13:14:15.678Z";
export const CREATED_DAY = "2026-10-12T00:00:00.000Z";
export const PUBLISHED_DAY = "2026-10-12T00:00:00Z";

// Stores `value` as the account `id`'s creation time.
export async function storeCreatedAt(store: StoreStub, id: string, value: string = CREATED_AT): Promise<void> {
  await sql(store, "UPDATE accounts SET created_at = ? WHERE id = ?", value, id);
}
