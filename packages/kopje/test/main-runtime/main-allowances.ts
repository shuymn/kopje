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
  // The status presenter's rows (status-rows.ts STATUS_COLUMN_MAP), by id and by key.
  "8b44729707a6c0d5": {
    rows: 1,
    reason:
      "#1560: author_media_rejected's and media_rejected's guard (REJECT_MEDIA_BLOCKS_SQL, src/domain/audience.ts), one read of its partial index per statement",
  },
  b07f16bdb57732ff: {
    rows: 1,
    reason:
      "#1560: author_media_rejected's and media_rejected's guard (REJECT_MEDIA_BLOCKS_SQL, src/domain/audience.ts), one read of its partial index per statement",
  },
  // accountRowsOf (src/domain/accounts.ts).
  "1ac3d537002ad41f": {
    rows: 1,
    reason:
      "#1560: media_rejected's guard (REJECT_MEDIA_BLOCKS_SQL, src/domain/audience.ts), one read of its partial index per statement",
  },
};

// The statements the current flows run that main's never ran, by the current statement's id, each with its reason: no
// rewrite of one of main's, so the witnesses run it as it is on both sides, as often as recorded, and pair the other
// statements in order.
export const ADDED_STATEMENTS: Readonly<Record<string, { readonly reason: string }>> = {
  // featureApprovalReads (src/domain/audience.ts).
  "4dc5aeca990f6cc8": {
    reason: "#1589 D16: feature_approval.current_user, one read per chunk of the accounts presented to a viewer",
  },
  // taggedCollectionsOf's reference read (src/domain/collection-presenter.ts).
  "4a803b70c2e5aa07": {
    reason: "#1589 D26: a status's tagged collections, one read per chunk of the statuses an answer presents",
  },
};

// The leading parameters main's statement takes where the rewrite binds more: main's text runs with those alone.
export const MAIN_PARAMETERS: Readonly<Record<string, { readonly count: number; readonly reason: string }>> = {
  // notificationPolicySql (src/domain/audience.ts).
  ba1325440a987793: { count: 5, reason: "#1582 D5: the limited flag ?6" },
  // notify's delete of the row it replaces (src/domain/notifications.ts).
  caea065fa6952c2a: { count: 6, reason: "#1589: the collection keys ?7 and ?8 (migration 0107)" },
  // notify's insert (src/domain/notifications.ts).
  b32922276dba79b0: { count: 10, reason: "#1589: the collection keys ?11 and ?12 (migration 0107)" },
  // R, the chunk planner's row bound (statusRowBoundSql, src/domain/status-rows.ts).
  "498ac8adb066550d": { count: 3, reason: "#1589 D26: the page flag ?4, a page's statuses read no tagged collection" },
};
