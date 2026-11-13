import { SUSPEND_BLOCKS_SQL } from "../src/domain/audience";
import type { FragmentAllowance } from "./plan-audit";

// The reviewed scans shared SQL fragments make wherever a statement includes them (FragmentAllowance,
// test/plan-audit.ts), which no entry of test/plan-audit-entries.ts lists. Each fragment is the constant the domain code
// composes.
export const PLAN_AUDIT_ALLOWANCES: readonly FragmentAllowance[] = [
  {
    fragment: SUSPEND_BLOCKS_SQL,
    scan: "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: an uncorrelated EXISTS over the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks), whose condition is its whole WHERE, so each line of this scan reads the index's first entry and stops",
    witness: 'test/plan-audit.test.ts ("reads one suspend block however many there are")',
  },
];
