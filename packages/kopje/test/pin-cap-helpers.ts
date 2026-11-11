import { runInDurableObject } from "cloudflare:test";

import type { StoreStub } from "../src/platform/store-client";

// Drops the triggers of 0089_pin_cap, for a fixture of the pins a Store held before it (a converted or restored row
// set past an account's limit).
export async function withoutTriggers(store: StoreStub): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec("DROP TRIGGER status_pins_cap_insert");
    state.storage.sql.exec("DROP TRIGGER status_pins_cap_update");
  });
}
