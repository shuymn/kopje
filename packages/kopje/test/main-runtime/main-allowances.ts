// What the main-runtime witnesses (test/main-runtime/policy.witness.test.ts, test-node/shown-walk-work.test.ts) let a
// statement of main's flows do beside main's literal text, where a later change gave it a new meaning as well, by
// main's statement id (test/plan-audit.ts statementId of the text recorded.json holds), each with its reason (the
// issue and its decision). Every other statement is compared with main's as it is.

// The rows a run of the statement may read beyond main's (expectBeside's rowAllowances).
// The shape mirrors plan-witness.ts's RowAllowance: the Node witness type-checks this module without Workers types.
export const ROW_ALLOWANCES: Readonly<Record<string, { readonly rows: number; readonly reason: string }>> = {
  // notificationPolicySql (src/domain/audience.ts).
  ba1325440a987793: {
    rows: 2,
    reason: "#1582 D4: the for_bots key lookup; D5: the for_limited_accounts key lookup of a limited notification",
  },
};

// The leading parameters main's statement takes where the rewrite binds more: main's text runs with those alone.
export const MAIN_PARAMETERS: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  // notificationPolicySql (src/domain/audience.ts).
  ba1325440a987793: { count: 5, reason: "#1582 D5: the limited flag ?6" },
};
