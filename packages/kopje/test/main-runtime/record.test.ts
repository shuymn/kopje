import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, it } from "vitest";

import { migratedStore } from "../helpers";
import { normalized } from "../plan-witness";
import { buildWorld, FLOWS, WORLDS, worldName } from "./witness-world";

// Records the statements each flow of witness-world.ts runs in each world, in order, for recorded.json: run once on
// main's code and once on the rewrite's, each through a project whose SQL_DEPTH service is replaced by a WITNESS_RECORD
// binding that writes them out (scripts kept outside the repository). Without that binding, as in every suite run,
// nothing runs here. Each flow runs in a savepoint rolled back after it, so each starts from its world as built.
const recorder = (env as unknown as { WITNESS_RECORD?: Fetcher }).WITNESS_RECORD;
const ROLLBACK = new Error("rolled back");

// A SqlStorage that records each statement it runs, whitespace collapsed.
function recording(real: SqlStorage, texts: string[]): SqlStorage {
  return {
    exec: (query: string, ...params: SqlStorageValue[]) => {
      texts.push(normalized(query));
      return real.exec(query, ...params);
    },
  } as unknown as SqlStorage;
}

describe.skipIf(recorder === undefined)("the flows' statements", () => {
  it.each(WORLDS.map((world) => [worldName(world), world] as const))(
    "%s",
    { timeout: 600_000 },
    async (_name, world) => {
      const store = await migratedStore();
      const runs = await runInDurableObject(store, (_instance, state) => {
        const sql = state.storage.sql;
        const transact = <T>(fn: () => T): T => state.storage.transactionSync(fn);
        const context = buildWorld(sql, world);
        const recorded: Record<string, string[]> = {};
        for (const [flow, { run }] of Object.entries(FLOWS)) {
          const texts: string[] = [];
          try {
            transact(() => {
              run(recording(sql, texts), transact, context);
              throw ROLLBACK;
            });
          } catch (error) {
            if (error !== ROLLBACK) {
              throw error;
            }
          }
          recorded[flow] = texts;
        }
        return recorded;
      });
      await recorder!.fetch("http://record/", {
        method: "POST",
        body: JSON.stringify({ world: worldName(world), runs }),
      });
    },
  );
});
