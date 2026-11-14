import type { DatabaseSync } from "node:sqlite";

// SQLite's instr() on `db`, overridden by a function of the same behavior that counts its calls: a domain coverage
// walk calls it at every label it steps (src/domain/audience.ts ruledSql), so the calls measure the walks. Workerd's
// rows-read counter does not count a walk that finds no block, and node:sqlite exposes no SQLITE_STMTSTATUS_VM_STEP.
// `uncounted` runs `fn` with the counter paused.
export function countingInstr(db: DatabaseSync) {
  let calls = 0;
  let counting = true;
  db.function("instr", { deterministic: true }, (haystack, needle) => {
    if (counting) {
      calls++;
    }
    return typeof haystack === "string" && typeof needle === "string" ? haystack.indexOf(needle) + 1 : null;
  });
  return {
    calls: () => calls,
    reset: () => {
      calls = 0;
    },
    uncounted: <T>(fn: () => T): T => {
      counting = false;
      try {
        return fn();
      } finally {
        counting = true;
      }
    },
  };
}
