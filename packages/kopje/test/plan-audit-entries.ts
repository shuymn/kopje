import type { PlanAuditEntry } from "./plan-audit.js";

// The reviewed scans of the plan audit (test/plan-audit.ts): one entry per statement identity, by site. Each lists the
// scans singleton statistics give it and what is known of them (Disposition); a pending or write entry names the
// #1468 group whose sweep removes it (test/plan-audit-1468.ts maps the issue's rows; group 9 holds the other request
// reads and writes).
export const PLAN_AUDIT_ENTRIES: readonly PlanAuditEntry[] = [
  {
    id: "5fba690f30f5621d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/account-actions.ts#followTarget < src/domain/account-actions.ts#followAccount < src/domain/account-actions.ts#<anonymous> in follow < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3a6b5bdee94135af",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/account-actions.ts#answerPendingFollow < src/domain/account-actions.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "33f13a83681454ff",
    scans: ["account_invitations: SCAN account_invitations"],
    site: "src/domain/account-invitations.ts#invitations < src/domain/account-invitations.ts#<anonymous> in addInvitation",
    disposition: "bounded",
    reason: "account_invitations holds at most 10 rows (account_invitations_cap, migration 0081_account_invitations)",
  },
  {
    id: "134cb5b52af22f18",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "b2878d3384ff3b83",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "867e56731d9847d8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in listFollowRequests < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9638abbafa99266e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/accounts.ts#<anonymous> in listFollows < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6ae229b5ef96a280",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/web-pages/follows.ts#followsPageWithin < src/domain/web-pages/follows.ts#<anonymous> in webFollowsPage < src/domain/web-pages/site.ts#<anonymous> in pageRead",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dfff07d570b3c378",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/web-pages/follows.ts#followsPageWithin < src/domain/web-pages/follows.ts#<anonymous> in webFollowsPage < src/domain/web-pages/site.ts#<anonymous> in pageRead",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "59da983ebffa7c3b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#movedOf < src/domain/accounts.ts#relatedOf < src/domain/accounts.ts#accountsOf < src/domain/status-presenter.ts#<anonymous> in hydrate < src/domain/status-presenter.ts#hydrate",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a8cf379931a5eb2c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#partialAccountsOf < src/domain/notification-groups.ts#admitGroups < src/domain/notification-groups.ts#<anonymous> in listGroupedNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2ca8b20d6e4aad61",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "585f553daa1eac7d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#windowAccountIds < src/domain/lists.ts#ownedAccountsWindow < src/domain/lists.ts#ownedAccountsPage < src/domain/endorsements.ts#endorsedPage < src/domain/endorsements.ts#<anonymous> in listEndorsements",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1ac3d537002ad41f",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#accountRowsOf < src/domain/accounts.ts#accountsOf < src/domain/status-presenter.ts#<anonymous> < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#present",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "972ff48c0d07c3be",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#accountRow < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dc1ee509b67978f1",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#presentAccountsById < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ae5406a1bf9d171c",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9d0948565b029046",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#presentedRemoteFields < src/domain/remote-actors.ts#upsertRemoteActor < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
  },
  {
    id: "d6be7877f4d97fdb",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#relationshipsOf < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e4bc490c23e81d6f",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e10b8e82e5f2de07",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions"); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)',
  },
  {
    id: "822ecfa15f846d25",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions"); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)',
  },
  {
    id: "458288c71711a582",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions"); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)',
  },
  {
    id: "958406ea29be0392",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions"); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)',
  },
  {
    id: "aa725c8cf76dbd6c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "b2161e1beef20d75",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "382565ddce9f80fa",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> < src/domain/federation-reads.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'NodeInfo counts the available local accounts (nodeInfoUsageOf, src/domain/actors.ts): local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "e087e97290cf7451",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/actors.ts#active < src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> < src/domain/federation-reads.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'NodeInfo\'s active users walk the local accounts, each probed newest first by statuses_account (nodeInfoUsageOf, src/domain/actors.ts): local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
    witness:
      'test/nodeinfo-usage.test.ts ("counts an active account without reading its older history, with stale statistics")',
  },
  {
    id: "a22117d33a2816a7",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> < src/domain/federation-reads.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "NodeInfo's local posts walk the local accounts, each one's originals by statuses_account_originals (nodeInfoUsageOf, src/domain/actors.ts): local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "7f892017c7ad80c4",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/actors.ts#<anonymous> in listLocalKeys",
    disposition: "deliberate",
    reason:
      'the health key check reads every local key (listLocalKeys, src/domain/actors.ts), each account by its key: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "f322f9a40a925aa1",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/actors.ts#<anonymous> in getCollection",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2c0b46cfbc6aa6ca",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/actors.ts#followerKeyOf < src/domain/actors.ts#fetchSignerOf < src/domain/inbox.ts#fetchPreparation < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "cd06801d1dce1dec",
    scans: ["local_accounts: SCAN local_accounts"],
    site: "src/domain/admin-accounts.ts#<anonymous> in setAccountEmail",
    disposition: "deliberate",
    reason:
      'no index serves the sign-in\'s email match, which the email repair applies to the other local accounts (setAccountEmail, src/domain/admin-accounts.ts): local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "71b67c065fd24966",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-authority.ts#oauthAdmin < src/domain/admin-authority.ts#adminAccountId < src/domain/admin-authority.ts#adminAccountIdOnce < src/domain/accounts.ts#presentIdentity < src/domain/accounts.ts#presentAccount",
    disposition: "deliberate",
    reason:
      'no index serves the sign-in\'s email match, so oauthAdmin reads every local account, each then by its key (src/domain/admin-authority.ts): their number is a deployment assumption of about 10, not a stored bound (docs/threat-model.md, "Deployment assumptions"); LIMIT 2 bounds the matches returned, not the rows read',
  },
  {
    id: "3a39994e8f70d9df",
    scans: ["reports: SCAN r"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "607fc035a5a3ff84",
    scans: ["reports: SCAN r"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "6bc414eca6f2b09c",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "bdf72c7b9ba57b07",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "d3b08cb9746f9019",
    scans: ["?: SCAN peers"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "d8589742ced03205",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "fe79c3ff8101310c",
    scans: ["reports: SCAN r"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "b4245fe9f65df15f",
    scans: [
      "announcements: SCAN announcements",
      "announcements: SCAN announcements USING INDEX announcements_published",
    ],
    site: "src/domain/announcements.ts#<anonymous> in announcementRound",
    disposition: "bounded",
    reason: "announcements holds at most 1,000 rows (announcements_cap, migration 0056_announcements)",
  },
  {
    id: "f8354a0faf31f48e",
    scans: ["announcements: SCAN announcements USING COVERING INDEX sqlite_autoindex_announcements_1"],
    site: "src/domain/announcements.ts#<anonymous> in createAnnouncement",
    disposition: "bounded",
    reason: "announcements holds at most 1,000 rows (announcements_cap, migration 0056_announcements)",
  },
  {
    id: "fd453bee5ce4722d",
    scans: ["announcements: SCAN a USING INDEX announcements_published"],
    site: "src/domain/announcements.ts#<anonymous> in listAnnouncements < src/domain/auth.ts#<anonymous> in tokenUserReadOperation",
    disposition: "bounded",
    reason: "announcements holds at most 1,000 rows (announcements_cap, migration 0056_announcements)",
  },
  {
    id: "f94ff60ce19603c0",
    scans: ["announcements: SCAN announcements USING COVERING INDEX announcements_published"],
    site: "src/domain/announcements.ts#liveCount < src/domain/announcements.ts#<anonymous> in createAnnouncement",
    disposition: "bounded",
    reason: "announcements holds at most 1,000 rows (announcements_cap, migration 0056_announcements)",
  },
  {
    id: "380af9bd36f5456a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#<anonymous> in deleteAudience < src/domain/audience.ts#deleteAudience",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a4fefe1500bc79f4",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#<anonymous> in deleteAudience < src/domain/audience.ts#deleteAudience",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0f40ed68676f008e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#Object.of in quoteApprovalReads < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit < src/domain/timelines.ts#answerAdmission",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "746ff58fbd066436",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#Object.of in quoteReads < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "17e29626ccc61143",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#addresses < src/domain/activities.ts#boostAnnounce < src/domain/statuses.ts#announceOf < src/domain/statuses.ts#<anonymous> in reblog < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9dfa8d77e2b83180",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#canView < src/domain/audience.ts#viewableStatusId < src/domain/remote-statuses.ts#status < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "faf0592983e05942",
    scans: ["accounts: SCAN a"],
    site: "src/domain/audience.ts#reachFollowers < src/domain/suspension.ts#reachRound < src/domain/suspension.ts#<anonymous> in moderationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "1f340ace00431562",
    scans: ["accounts: SCAN a"],
    site: "src/domain/audience.ts#reachFollowing < src/domain/suspension.ts#reachRound < src/domain/suspension.ts#<anonymous> in moderationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "bbbe8114cc0f87b3",
    scans: ["accounts: SCAN a"],
    site: "src/domain/audience.ts#reachMentioned < src/domain/suspension.ts#mentionsRound < src/domain/suspension.ts#reachRound < src/domain/suspension.ts#<anonymous> in moderationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "1807b174c1308ec9",
    scans: [
      "accounts: SCAN ra",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "c79c3012ca1ddc9f",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f51569b711149874",
    scans: [
      "?: SCAN ps",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost",
    disposition: "deliberate",
    reason:
      "ps is ruledSql's recursive CTE over a follower's domain suffixes (src/domain/audience.ts: its two keys, each walked only within DNS_NAME_UTF8_BYTES (1,012) bytes, so of at most 1,012 rows, a longer one covered unwalked; test/domain-suffix-walk.test.ts), which the classifier cannot bind under byInbox's derived tables, where the fragment's `accounts ps` shares its name; SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "19debcfdc5f0aafb",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.authorShown in statusReads < src/domain/timelines.ts#accountStatusIds < src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "026fcf652de9e66e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.authorShown in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0ec327b9c8182c79",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "15b5e5b897b53642",
    scans: [
      "?: SCAN s",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "22a7967fb5612cb2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "69670a5037cce46d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4b02e34fb3082afd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "563d70e4e039cfdf",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "635c7e6d558225da",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "79600bbfb9512fa2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7b14d2ac24d036fe",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/conversations.ts#conversationStream < src/domain/answer-budget.ts#admit < src/domain/conversations.ts#<anonymous> in listConversations",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "08f023fe00cbb59c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1d97ca3dd30d0698",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "55f33041f2e5fc1e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "66a3bc900a5d9669",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9477a50d0422cf1e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a1d30009da11b514",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a36f461647d0b46f",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3ee23084871734d6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#<anonymous> in getStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d181412df28c4da6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#<anonymous> in statusContext < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "713e25a61e61a6be",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#contextAncestors < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous> in webStatusPage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5f8e0ec8499232cc",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "69f7218535a37f4d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1feaf422d2346435",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusIds < src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "879fa200841e8c4b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8a7f9ce9bd5ff6e0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2764392c4a83b88a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6de9e61fe47b6176",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "cf4d22af3002f350",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6de9a4051e2b0896",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/web-pages/profile.ts#profilePageWithin < src/domain/web-pages/profile.ts#<anonymous> in webProfilePage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9a70663d385d494a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9dbb6a2d91b1fff1",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ab3a84915de2d712",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ca0cd069c4404cf1",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "18671a5b3bae7225",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#tagStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "51c6eb3bcd1757d5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#tagStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0f8549d1c658c387",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "86a77f60763ddc77",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "17c3a2c9147a8837",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1abaf4f1b660ed81",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6b6da83bb1294ec4",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5058c2235dae928e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#viewableStatusIds < src/domain/web-pages/parents.ts#parentLinks < src/domain/web-pages/parents.ts#parentLink < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous> in webStatusPage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "213dc32e9b748f69",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#statusPageWithin",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7fb4e46a877d4081",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#targetStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5b649a02c2ddf9a6",
    scans: [
      "?: SCAN ps",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/polls.ts#recordPollUpdate",
    disposition: "deliberate",
    reason:
      "ps is ruledSql's recursive CTE over a voter's domain suffixes (src/domain/audience.ts: its two keys, each walked only within DNS_NAME_UTF8_BYTES (1,012) bytes, so of at most 1,012 rows, a longer one covered unwalked; test/domain-suffix-walk.test.ts), which the classifier cannot bind under byInbox's derived tables, where the fragment's `accounts ps` shares its name; SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a15f00a754cc8ea0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f68173791689b176",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dd53b3f60380a2ba",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e8ed78d437270153",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9f9c39ceda133cf2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ab71ff4dae0b548e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "b0f7a4c432eb9849",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8e5cffd8bf6135fe",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#targetStatus < src/domain/web-pages/status.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d6a8b6b2e1b1a801",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d8cad5513e49a3e5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "eaa215a4bb4f503b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9c8a20d85844fa31",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "54b012d0bccf3e04",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4e35ed6c87cd6bba",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dbb85abfe90596c8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5cc738f48c8c8596",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5bee14c7006147a3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#streamedNotification",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d8f8e23bec60cc2f",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4df9dd223257f09e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select < src/domain/notification-requests.ts#requestStream < src/domain/notification-requests.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "580339d350fde9c2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#streamedNotification",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7c7260b8e262cf1a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notification-groups.ts#shownNotifications < src/domain/notification-groups.ts#firstOfGroup < src/domain/notification-groups.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "87263848bdc39aa9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#mentionedStatus < src/domain/streaming.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0ec0d095d0b23b86",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "67dfd17bf6954421",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications < src/domain/notification-groups.ts#shownNotifications < src/domain/notification-groups.ts#firstOfGroup < src/domain/notification-groups.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "31dde5cdf5785684",
    scans: [
      "accounts: SCAN ra",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds < src/domain/reports.ts#<anonymous> in adminReportStream < src/domain/reports.ts#adminReportStream < src/domain/reports.ts#presented",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "f9e061eec6bfcb55",
    scans: ["domain_block_cleanups: SCAN c", "domain_blocks: SCAN d USING COVERING INDEX domain_blocks_pair"],
    site: "src/domain/blocks.ts#nextCleanup < src/domain/blocks.ts#<anonymous> in runDomainBlockCleanups",
    disposition: "background",
    reason:
      'a job or round traversal (blocks.ts#<anonymous> in runDomainBlockCleanups); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "2015293d7bfdb5c7",
    scans: ["follows: SCAN follows"],
    site: "src/domain/blocks.ts#cleanupBatch < src/domain/blocks.ts#<anonymous> in cleanupItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "8469b7ffbdf3c6d9",
    scans: ["follows: SCAN f"],
    site: "src/domain/blocks.ts#cleanupBatch < src/domain/blocks.ts#<anonymous> < src/domain/job-attempts.ts#<anonymous>",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "4e4d83746a939ce9",
    scans: ["mutes: SCAN m"],
    site: "src/domain/blocks.ts#<anonymous> in listMutes < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "bb8f21d8c0950c13",
    scans: ["mutes: SCAN m"],
    site: "src/domain/blocks.ts#<anonymous> in listMutes < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "9ebfa8ad32d8ef68",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/card-images.ts#<anonymous> in startCardImage",
    disposition: "write",
    issue: "#1468 group 9",
  },
  {
    id: "483bcfadf028a776",
    scans: ["conversations: SCAN conversations"],
    site: "src/domain/conversations.ts#leaveConversationsWith < src/domain/blocks.ts#<anonymous> in block < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 9",
  },
  {
    id: "1191adb04d0f75f6",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in claimDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "542bada4bb571d53",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o LEFT-JOIN"],
    site: "src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in claimDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "7bf87fad46c9aa1b",
    scans: ["outbound_activities: SCAN o", "outbound_activities: SCAN r", "statuses: SCAN s"],
    site: "src/domain/deliveries.ts#<anonymous> in completeDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "b7eb6c56c31930ea",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o LEFT-JOIN"],
    site: "src/domain/deliveries.ts#<anonymous> in completeDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "19c057c4ebf7cf4d",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o LEFT-JOIN"],
    site: "src/domain/deliveries.ts#<anonymous> in confirmDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "0d26081c24de0db3",
    scans: ["outbound_targets: SCAN outbound_targets USING COVERING INDEX outbound_targets_activity"],
    site: "src/domain/deliveries.ts#<anonymous> in deliveriesReport",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "4e24afbeba55cd42",
    scans: ["deliveries: SCAN deliveries"],
    site: "src/domain/deliveries.ts#<anonymous> in deliveriesReport",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "b2453e3eaaab3616",
    scans: ["accounts: SCAN a LEFT-JOIN", "deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in deliveriesReport",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "613e3126e74a238a",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in retryDeliveries",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "6d9b1b73c6ca82a2",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in retryDeliveries",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "c205ffcef8ee4a83",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in retryDeliveries",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "2db6d724039943b5",
    scans: ["deliveries: SCAN deliveries", "outbound_activities: SCAN o USING INDEX outbound_activities_follow_swept"],
    site: "src/domain/deliveries.ts#<anonymous> in sweepDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in sweepDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "835bb69e5a883dd2",
    scans: ["deliveries: SCAN deliveries"],
    site: "src/domain/deliveries.ts#<anonymous> in sweepDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in sweepDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "335e707dbb1daaf0",
    scans: ["deliveries: SCAN deliveries"],
    site: "src/domain/deliveries.ts#activeCount < src/domain/deliveries.ts#Admission.admits in activeCount < src/domain/deliveries.ts#expandPending < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "0d7193e6184aeba1",
    scans: ["outbound_targets: SCAN c"],
    site: "src/domain/deliveries.ts#expandPending < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "34a88d39f6885dc4",
    scans: ["outbound_activities: SCAN o", "outbound_targets: SCAN c"],
    site: "src/domain/deliveries.ts#expandPending < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "fb743767a7db9d47",
    scans: ["outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#followAnswersOf < src/domain/inbox.ts#cancelUndoneAnswers < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "34d6a8b0dc38a476",
    scans: ["deliveries: SCAN d"],
    site: "src/domain/deliveries.ts#forwardFallback < src/domain/deliveries.ts#personalFallback < src/domain/deliveries.ts#<anonymous> in completeDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "68ece3c46ec44dc5",
    scans: ["outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#holdHandshake < src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in claimDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "f272bcbd822ca053",
    scans: ["outbound_targets: SCAN outbound_targets USING COVERING INDEX outbound_targets_activity"],
    site: "src/domain/deliveries.ts#nextDueAt < src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in claimDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "0b29b51f1d1d3bf9",
    scans: [
      "deliveries: SCAN d",
      "deliveries: SCAN e",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "outbound_activities: SCAN o",
      "outbound_targets: SCAN c",
    ],
    site: "src/domain/deliveries.ts#personalFallback < src/domain/deliveries.ts#<anonymous> in completeDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "27a4573d075eb9bf",
    scans: ["outbound_activities: SCAN o", "outbound_targets: SCAN c"],
    site: "src/domain/deliveries.ts#receiversOf < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#<anonymous> in revokeQuote",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "97a57f06dc7bf735",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#receiversOf < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#<anonymous> in revokeQuote",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "403395117854549a",
    scans: ["deliveries: SCAN deliveries"],
    site: "src/domain/deliveries.ts#replaceWaiting < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/quotes.ts#recordStampUpdate < src/domain/quotes.ts#acceptOurQuote",
    disposition: "write",
    issue: "#1468 group 8",
  },
  {
    id: "49fa63915b16b036",
    scans: ["outbound_targets: SCAN outbound_targets"],
    site: "src/domain/deliveries.ts#replaceWaiting < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/quotes.ts#recordStampUpdate < src/domain/quotes.ts#acceptOurQuote",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "a9e710dd668ef93f",
    scans: ["outbound_activities: SCAN outbound_activities"],
    site: "src/domain/deliveries.ts#replaceWaiting < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/quotes.ts#recordStampUpdate < src/domain/quotes.ts#acceptOurQuote",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "140d182336c23f40",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/deliveries.ts#sendRefused < src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "db03fc43fe6fb808",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/deliveries.ts#sendRefused < src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e340d1dcebf0f9b2",
    scans: ["retraction_stagings: SCAN retraction_stagings USING COVERING INDEX retraction_stagings_ended"],
    site: "src/domain/deliveries.ts#sweepStagings < src/domain/deliveries.ts#<anonymous> in sweepDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in sweepDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "cacc6c5c1e413ee6",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_new",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "56fbdb284ae24ea9",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_local_active",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "c8b5781765c9dc40",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_local_new",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "ee420686f7bc1093",
    scans: [
      "accounts: SCAN accounts USING COVERING INDEX accounts_directory_active",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "66b5bbbd8d4addad",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/endorsements.ts#endorsementsShown < src/domain/endorsements.ts#endorsedPage < src/domain/endorsements.ts#<anonymous> in listEndorsements < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3745283156aa94cd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/featured-tags.ts#accountFeaturedTagsOf < src/domain/featured-tags.ts#<anonymous> in accountFeaturedTags",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "746f7acbaf051934",
    scans: ["featured_tags: SCAN featured_tags"],
    site: "src/domain/featured-tags.ts#recountFeatured < src/domain/inbox.ts#deleteLocalStatusBatch < src/domain/inbox.ts#deleteStatusBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6c98c25ae08c0076",
    scans: ["fedify_kv: SCAN fedify_kv"],
    site: "src/domain/fedify-kv.ts#<anonymous> in kvList",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "f05478ccc7013224",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/field-links.ts#<anonymous> in claimFieldLinks",
    disposition: "background",
    reason:
      'a job or round traversal (field-links.ts#<anonymous> in claimFieldLinks); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "fdbeafea0226c2cc",
    scans: ["local_accounts: SCAN local_accounts"],
    site: "src/domain/field-links.ts#<anonymous> in claimFieldLinks",
    disposition: "background",
    reason:
      'a job or round traversal (field-links.ts#<anonymous> in claimFieldLinks); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6fae014d62294a77",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/field-links.ts#held < src/domain/field-links.ts#<anonymous> in recordFieldLink",
    disposition: "background",
    reason:
      'a job or round traversal (field-links.ts#<anonymous> in recordFieldLink); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6e80489968ad0885",
    scans: ["filter_statuses: SCAN fs"],
    site: "src/domain/filters.ts#ownFilterStatus < src/domain/filters.ts#<anonymous> in getFilterStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "fcdc93860041ecee",
    scans: ["local_accounts: SCAN l USING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/follower-signer.ts#localFollower < src/domain/quotes.ts#quoteArrival < src/domain/remote-statuses.ts#arrivalOf < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/inbox.ts#create",
    disposition: "deliberate",
    reason:
      'localFollower (src/domain/follower-signer.ts) walks the local accounts, each a key lookup of its follow, so the account\'s remote followers are never read: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "b0194450ec5a0782",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/handshake-replays.ts#replay < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d51500418d49c492",
    scans: ["follows: SCAN f"],
    site: "src/domain/handshake-replays.ts#replay < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "52e1329b68591d0a",
    scans: ["collection_syncs: SCAN collection_syncs"],
    site: "src/domain/inbox.ts#<anonymous> in spend < src/domain/inbox.ts#JobBudget.progress in purgeBatch < src/domain/inbox.ts#spend < src/domain/inbox.ts#purgeRelationships < src/domain/inbox.ts#purgeBatch",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#purgeBatch); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "1723537c01e95b32",
    scans: ["accounts: SCAN a", "statuses: SCAN o"],
    site: "src/domain/inbox.ts#deleteStatusWithin < src/domain/inbox.ts#withdrawLocalBoosts < src/domain/inbox.ts#deleteStatusBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "32282320c9eb1b61",
    scans: ["follows: SCAN f USING COVERING INDEX follows_accepted"],
    site: "src/domain/inbox.ts#moveBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "50715a1639ee7036",
    scans: ["follows: SCAN f"],
    site: "src/domain/inbox.ts#moveBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "94039c072d68bb07",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/inbox.ts#moveBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "79bfd658ce83ddaf",
    scans: ["sqlite_sequence: SCAN sqlite_sequence"],
    site: "src/domain/inbox.ts#outboundMark < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "pending",
    issue: "#1468 group 9",
    reason:
      "sqlite_sequence is not bounded: an imported dump may name any table in it (src/platform/dump-catalog.ts, src/platform/store-import.ts)",
  },
  {
    id: "8b7c5c8e7643177f",
    scans: ["sqlite_sequence: SCAN sqlite_sequence"],
    site: "src/domain/inbox.ts#outboundSince < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "pending",
    issue: "#1468 group 9",
    reason:
      "sqlite_sequence is not bounded: an imported dump may name any table in it (src/platform/dump-catalog.ts, src/platform/store-import.ts)",
  },
  {
    id: "54a0d7dbe28e2596",
    scans: ["outbound_activities: SCAN o"],
    site: "src/domain/inbox.ts#stageForwards < src/domain/inbox.ts#withdrawLocalBoosts < src/domain/inbox.ts#deleteStatusBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "76867a7a569b5004",
    scans: ["mutes: SCAN mutes"],
    site: "src/domain/inbox.ts#sweep < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#<anonymous> in runInboundJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "44b0ff32c8c62ec0",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#cancelUndoneAnswers < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "an undone Follow's answers: UNDONE_ANSWER_SIGNERS_SQL (src/domain/inbox.ts) walks the local accounts, each one's outbound answers sought by outbound_activities_follow_pair up to FOLLOW_ANSWER_INTENTS + 1: local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "cbfddd7d3c9f4c0f",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#forwardable < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "a deleted status's forwarding: KEPT_LOCAL_BOOSTS (src/domain/inbox.ts) walks the local accounts, each one's kept boost sought by statuses_account_reblogs_kept: local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "aea206e79a827d22",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#recordForwards < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "a deleted status's forwarding: KEPT_LOCAL_BOOSTS (src/domain/inbox.ts) walks the local accounts, each one's kept boost sought by statuses_account_reblogs_kept, up to MAX_FORWARD_OWNERS + 1: local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "a099efaec4b6c8dd",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#ourFollow < src/domain/inbox.ts#accept < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "an Accept's follow by its id: the local accounts drive, each one's follow of the actor sought by follows_pair (ourFollow, src/domain/inbox.ts): local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "c507c60814b4afbe",
    scans: ["instance_domain_blocks: SCAN instance_domain_blocks"],
    site: "src/domain/instance-domain-blocks.ts#blocksPage < src/domain/admin-domain-blocks.ts#<anonymous> in listAdminDomainBlocks < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "40441f03ad0b8958",
    scans: ["instance_domain_blocks: SCAN instance_domain_blocks"],
    site: "src/domain/instance-domain-blocks.ts#blocksPage < src/domain/admin-domain-blocks.ts#<anonymous> in listAdminDomainBlocks < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "05c420b40a06b916",
    scans: ["instance_domain_blocks: SCAN instance_domain_blocks"],
    site: "src/domain/instance-domain-blocks.ts#ruleFor < src/domain/instance-domain-blocks.ts#createBlock",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "782bd4dc8403b718",
    scans: ["accounts: SCAN accounts", "local_accounts: SCAN l"],
    site: "src/domain/instance.ts#<anonymous> in instanceInfo",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "4b49e35df6db769a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/interaction.ts#<anonymous> in resolveInteraction < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0d98fbbbd2c7af1d",
    scans: ["moderation_jobs: SCAN moderation_jobs USING INDEX moderation_jobs_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "18b85820c661527e",
    scans: ["notification_request_jobs: SCAN notification_request_jobs USING INDEX notification_request_jobs_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "2d1fdc60e0bffad6",
    scans: ["notification_clears: SCAN notification_clears USING INDEX notification_clears_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6f8d54ea42e34c72",
    scans: ["notification_dismissals: SCAN notification_dismissals USING INDEX notification_dismissals_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "94d4ca8a6826f683",
    scans: ["remote_moderation_jobs: SCAN remote_moderation_jobs USING INDEX remote_moderation_jobs_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "99231888d3847490",
    scans: ["handshake_replays: SCAN handshake_replays USING INDEX handshake_replays_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e586930aa6a1b90d",
    scans: ["inbound_jobs: SCAN inbound_jobs USING INDEX inbound_jobs_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e9732661e3135666",
    scans: ["quote_revocations: SCAN quote_revocations USING INDEX quote_revocations_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "ff5d88362f08caed",
    scans: ["domain_block_cleanups: SCAN domain_block_cleanups USING INDEX domain_block_cleanups_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "4004942385b0d5a9",
    scans: ["domain_block_cleanups: SCAN domain_block_cleanups USING COVERING INDEX domain_block_cleanups_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/blocks.ts#nextCleanup < src/domain/blocks.ts#<anonymous> in runDomainBlockCleanups",
    disposition: "background",
    reason:
      'a job or round traversal (blocks.ts#<anonymous> in runDomainBlockCleanups); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "5f0a68ad4019e8fd",
    scans: ["handshake_replays: SCAN handshake_replays USING INDEX handshake_replays_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/handshake-replays.ts#next < src/domain/handshake-replays.ts#dueHold < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep",
    disposition: "background",
    reason:
      'a job or round traversal (handshake-replays.ts#<anonymous> in handshakeReplayStep); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "5f6367601c3770cd",
    scans: ["reject_replays: SCAN reject_replays USING INDEX reject_replays_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/handshake-replays.ts#next < src/domain/handshake-replays.ts#dueHold < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep",
    disposition: "background",
    reason:
      'a job or round traversal (handshake-replays.ts#<anonymous> in handshakeReplayStep); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "2bda29dd77f049ef",
    scans: ["reject_replays: SCAN reject_replays USING INDEX reject_replays_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "419d5b7d6682fe66",
    scans: ["reject_replays: SCAN reject_replays USING INDEX reject_replays_failing"],
    site: "src/domain/job-attempts.ts#<anonymous> in retryParkedJobs < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "9736a0ab2fda848c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/handshake-replays.ts#replayReject < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "34a11dd79061b053",
    scans: ["inbound_jobs: SCAN inbound_jobs USING INDEX inbound_jobs_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#<anonymous> in runInboundJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "06859ec0581ebcf1",
    scans: ["quote_revocations: SCAN quote_revocations USING COVERING INDEX quote_revocations_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/quotes.ts#nextRevocation < src/domain/quotes.ts#continueRevocations < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#<anonymous> in runInboundJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "3b3835c5a8d7f0b9",
    scans: ["inbound_jobs: SCAN inbound_jobs USING INDEX inbound_jobs_failing"],
    site: "src/domain/job-attempts.ts#retryKeys < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e2a1e0c0071d626c",
    scans: ["quote_revocations: SCAN quote_revocations USING INDEX quote_revocations_failing"],
    site: "src/domain/job-attempts.ts#retryKeys < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "276315267139d0b2",
    scans: ["domain_block_cleanups: SCAN domain_block_cleanups USING INDEX domain_block_cleanups_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "676324455c9387d8",
    scans: ["notification_dismissals: SCAN notification_dismissals USING INDEX notification_dismissals_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6b9ca2cca2dbefa4",
    scans: ["handshake_replays: SCAN handshake_replays USING INDEX handshake_replays_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "707611546502bbdc",
    scans: ["remote_moderation_jobs: SCAN remote_moderation_jobs USING INDEX remote_moderation_jobs_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "a457ca4e80a4c3eb",
    scans: ["moderation_jobs: SCAN moderation_jobs USING INDEX moderation_jobs_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "a5e8aab321cd2080",
    scans: ["notification_clears: SCAN notification_clears USING INDEX notification_clears_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "d18f3397b5904cfa",
    scans: ["notification_request_jobs: SCAN notification_request_jobs USING INDEX notification_request_jobs_failing"],
    site: "src/domain/job-attempts.ts#retryRowids < src/domain/job-attempts.ts#<anonymous> in retryParkedJobs",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in retryParkedJobs); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "f69ff61a5c2e4fcb",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#<anonymous> in claimCards",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "64488aee6c8f6b12",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#<anonymous> in recordCard",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f54d686d9fda2318",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#<anonymous> in recordCard",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "04dd86e5255280f2",
    scans: ["card_oembed_endpoints: SCAN card_oembed_endpoints USING COVERING INDEX card_oembed_endpoints_expiry"],
    site: "src/domain/link-cards.ts#cacheEndpoint < src/domain/link-cards.ts#<anonymous> in recordCard",
    disposition: "background",
    reason:
      'a job or round traversal (link-cards.ts#<anonymous> in recordCard); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "8038f52ebc5bd038",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#enqueueCard < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "28567507fc2af2e0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN l USING INDEX sqlite_autoindex_lists_1",
    ],
    site: "src/domain/lists.ts#<anonymous> in accountLists < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "c062eb1780f68065",
    scans: ["lists: SCAN lists USING INDEX sqlite_autoindex_lists_1"],
    site: "src/domain/lists.ts#<anonymous> in listLists < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "a2ae66f512e72566",
    scans: ["lists: SCAN l"],
    site: "src/domain/lists.ts#listsHolding < src/domain/inbox.ts#moveBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "c5b6b541bb25507c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/local-notes.ts#<anonymous> in getOutbox",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4c8b97dcc2191d66",
    scans: ["media_attachments: SCAN media_attachments"],
    site: "src/domain/media.ts#<anonymous> in purgeMedia",
    disposition: "background",
    reason:
      'a job or round traversal (media.ts#<anonymous> in purgeMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "c10d6d4de870645f",
    scans: ["admin_actions: SCAN admin_actions"],
    site: "src/domain/moderation-log.ts#<anonymous> in moderationLog",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "85e75d83d6d3987a",
    scans: ["admin_actions: SCAN admin_actions"],
    site: "src/domain/moderation-log.ts#logAction < src/domain/remote-suspension.ts#suspendRemote < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "write",
    issue: "#1468 group 9",
  },
  {
    id: "2fb9c118025c0214",
    scans: ["notification_request_jobs: SCAN j"],
    site: "src/domain/notification-requests.ts#runJobs < src/domain/notification-requests.ts#accept < src/domain/notification-requests.ts#<anonymous> in acceptNotificationRequest < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "background",
    reason:
      'a job or round traversal (auth.ts#<anonymous> in guarded); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "f584c8d416234657",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notification-requests.ts#summaryOf < src/domain/notification-requests.ts#<anonymous> in getNotificationPolicy < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3ad5ebdd2b538d0f",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notification-requests.ts#startJob < src/domain/notification-requests.ts#accept < src/domain/notification-requests.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "startJob reads the newest notification: the table in rowid order from its end, LIMIT 1, NOT INDEXED (src/domain/notification-requests.ts)",
  },
  {
    id: "596e58d25a6bf507",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notification-requests.ts#jobBatch < src/domain/notification-requests.ts#<anonymous> < src/domain/job-attempts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d8e5eadce8a58ff8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notification-requests.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "01ac9301afe35078",
    scans: ["notifications: SCAN n USING COVERING INDEX notifications_natural", "push_subscriptions: SCAN p"],
    site: "src/domain/notifications.ts#queuePushes < src/domain/notifications.ts#notify < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "0ff60790ddf8dcbb",
    scans: ["push_deliveries: SCAN push_deliveries USING COVERING INDEX push_deliveries_notification"],
    site: "src/domain/notifications.ts#queuePushes < src/domain/notifications.ts#notify < src/domain/account-actions.ts#followAccount < src/domain/account-actions.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "the push backlog's count reads at most MAX_PUSH_BACKLOG (1,000) entries: its LIMIT (src/domain/notifications.ts queuePushes)",
  },
  {
    id: "d3ceb762565786aa",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notifications.ts#removalBatch < src/domain/notifications.ts#<anonymous> in removalItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e56f8ce0555a60a2",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notifications.ts#removalBatch < src/domain/notifications.ts#<anonymous> in removalItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "b32922276dba79b0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notifications.ts#notify < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f57fc2caf497025d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notifications.ts#notify < src/domain/remote-statuses.ts#updateRemoteStatus < src/domain/inbox.ts#updateStatus < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "598392e2e4ef590d",
    scans: ["oauth_tokens: SCAN oauth_tokens USING INDEX oauth_tokens_client"],
    site: "src/domain/oauth.ts#<anonymous> in sweepOAuth",
    disposition: "background",
    reason:
      'a job or round traversal (oauth.ts#<anonymous> in sweepOAuth); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "097a7da331db250a",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/oauth.ts#loginAccount < src/domain/oauth.ts#<anonymous> in issueCode",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "7e7121a3e8e907cd",
    scans: ["oauth_clients: SCAN c USING COVERING INDEX oauth_clients_pending"],
    site: "src/domain/oauth.ts#pendingApps < src/domain/oauth.ts#<anonymous> in registerApp",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "4ad13738b4c4f7ef",
    scans: ["polls: SCAN p"],
    site: "src/domain/polls.ts#<anonymous> in pollRound",
    disposition: "background",
    reason:
      'a job or round traversal (polls.ts#<anonymous> in pollRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "4adad313e3300330",
    scans: ["statuses: SCAN s"],
    site: "src/domain/polls.ts#<anonymous> in pollRound",
    disposition: "background",
    reason:
      'a job or round traversal (polls.ts#<anonymous> in pollRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "815da82c0f4180f3",
    scans: ["accounts: SCAN a", "statuses: SCAN s"],
    site: "src/domain/polls.ts#<anonymous> in pollRound",
    disposition: "background",
    reason:
      'a job or round traversal (polls.ts#<anonymous> in pollRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "1b89639f50a260d3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/polls.ts#mayVote < src/domain/polls.ts#<anonymous> in vote < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c81d9446b4fc1d82",
    scans: ["polls: SCAN polls USING INDEX polls_stale"],
    site: "src/domain/polls.ts#sweepStaleVotes < src/domain/polls.ts#<anonymous> in pollRound",
    disposition: "background",
    reason:
      'a job or round traversal (polls.ts#<anonymous> in pollRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6eb8ed0fa68f3228",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/push.ts#target < src/domain/push.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "db73259f82c71e2c",
    scans: ["quotes: SCAN quotes"],
    site: "src/domain/quotes.ts#<anonymous> in claimQuotes",
    disposition: "background",
    reason:
      'a job or round traversal (quotes.ts#<anonymous> in claimQuotes); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "7b5844a380af7b17",
    scans: ["quotes: SCAN quotes"],
    site: "src/domain/quotes.ts#revocationBatch < src/domain/quotes.ts#<anonymous> in revocationItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "61de90b4a6d1e892",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "30bd3d273548c280",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-actors.ts#staleAccount < src/domain/quotes.ts#authorDue < src/domain/quotes.ts#stageOf < src/domain/quotes.ts#<anonymous> in quoteWork",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a3433847dbd84208",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-actors.ts#unavailableRemote < src/domain/remote-actors.ts#upsertRemoteActor < src/domain/remote-statuses.ts#storedActor < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dc5a765b93e3a069",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-collections.ts#<anonymous> in claimCollectionSync",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d5affa2884b5e300",
    scans: ["featured_tags: SCAN featured_tags"],
    site: "src/domain/remote-collections.ts#replaceFeaturedTags < src/domain/remote-collections.ts#<anonymous> in completeCollectionRead",
    disposition: "background",
    reason:
      'a job or round traversal (remote-collections.ts#<anonymous> in completeCollectionRead); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "82beb1e260757671",
    scans: [
      "accounts: SCAN a",
      "collection_syncs: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-collections.ts#roundAccount < src/domain/remote-collections.ts#<anonymous> in completeCollectionRead",
    disposition: "background",
    reason:
      'a job or round traversal (remote-collections.ts#<anonymous> in completeCollectionRead); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "b2078d2a1e2f8c2b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-field-links.ts#claimRemoteFieldLinks < src/domain/field-links.ts#<anonymous> in claimFieldLinks",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "77a009b5b20b2cee",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-field-links.ts#remoteLinksHeld < src/domain/field-links.ts#held < src/domain/field-links.ts#<anonymous> in recordFieldLink",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c815159d143e7f09",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "remote_media: SCAN r",
    ],
    site: "src/domain/remote-media.ts#<anonymous> in claimRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in claimRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "257fb0575288137b",
    scans: ["remote_media: SCAN r"],
    site: "src/domain/remote-media.ts#<anonymous> in demand < src/domain/remote-media.ts#demand < src/domain/remote-media.ts#reclaim < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "d8ade24f6710c465",
    scans: ["remote_media: SCAN remote_media USING INDEX remote_media_expiry"],
    site: "src/domain/remote-media.ts#audit < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "936d2274e1dd5f9b",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-media.ts#backfill < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e3baadedab9c6595",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "remote_media: SCAN r USING INDEX remote_media_expiry",
    ],
    site: "src/domain/remote-media.ts#fenced < src/domain/remote-media.ts#<anonymous> in admitRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in admitRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "bef5a571e43f35a7",
    scans: ["remote_media: SCAN r"],
    site: "src/domain/remote-media.ts#missing < src/domain/remote-media.ts#<anonymous> in recordRemoteMediaValidation",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in recordRemoteMediaValidation); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "05c4e0ad0523a85f",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "remote_media: SCAN r",
      "remote_media: SCAN remote_media",
    ],
    site: "src/domain/remote-media.ts#validityWalk < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "3dcb00d8c2cd9958",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-statuses.ts#account < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "841e4849b7517078",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4278d40f9cfbbc75",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/remote-statuses.ts#notifyCreated < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/inbox.ts#create < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "an arriving status's post subscribers: the local accounts drive, each one's accepted follow of the author sought by follows_accepted (notifyCreated, src/domain/remote-statuses.ts): local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
  },
  {
    id: "ecb815c73e12125d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-suspension.ts#clearRound < src/domain/remote-suspension.ts#remoteRound < src/domain/remote-suspension.ts#<anonymous> in remoteModerationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7d72791fccd613d7",
    scans: ["push_deliveries: SCAN push_deliveries"],
    site: "src/domain/remote-suspension.ts#prepared < src/domain/remote-suspension.ts#sever < src/domain/remote-suspension.ts#accountSeverRound < src/domain/remote-suspension.ts#remoteRound < src/domain/remote-suspension.ts#<anonymous> in remoteModerationRound",
    disposition: "background",
    reason:
      'a job or round traversal (remote-suspension.ts#<anonymous> in remoteModerationRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "8cce3a6763f05d42",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "df262b468ace6d45",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/reports.ts#fileRemoteReports < src/domain/inbox.ts#flag < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c9c386511d0a563e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/scheduled-statuses.ts#<anonymous> in publishScheduled",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d634d9244eae5d1e",
    scans: ["scheduled_statuses: SCAN ss"],
    site: "src/domain/scheduled-statuses.ts#scheduleErrors < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "29d9fa4322758555",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN statuses USING INDEX statuses_public",
    ],
    site: "src/domain/search.ts#searchHashtags < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "3ae16a72600377c8",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "write",
    issue: "#1468 group 9",
  },
  {
    id: "f8c1f4e4265e3864",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#<anonymous> in bootstrapInstance",
    disposition: "write",
    issue: "#1468 group 9",
  },
  {
    id: "467093ef10eaf7ee",
    scans: ["local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_2"],
    site: "src/domain/setup.ts#bootstrapped < src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "883afee3d9b87bd9",
    scans: [
      "?: SCAN quotes",
      "announcement_reactions: SCAN announcement_reactions USING COVERING INDEX announcement_reactions_name",
    ],
    site: "src/domain/setup.ts#insertLocalAccount < src/domain/setup.ts#<anonymous> in bootstrapInstance",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "3eb05efdf63fcd2b",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#sessionNames < src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "74337db9b1e41efd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/status-presenter.ts#idRows < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#filterTextTargets < src/domain/status-presenter.ts#textLevel < src/domain/status-presenter.ts#presentationOf",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8b44729707a6c0d5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/status-presenter.ts#statusRows < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "498ac8adb066550d",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/status-presenter.ts#statusRowBounds < src/domain/status-presenter.ts#plannedChunks < src/domain/status-presenter.ts#statusStream",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); the local accounts are OAUTH_ADMIN_HEAP_SQL's bound of oauthAdmin's read (src/domain/admin-authority.ts), and local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\"); SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e659d49c3335176a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/statuses.ts#resolveMentions < src/domain/statuses.ts#mentionedIds < src/domain/statuses.ts#preparePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "60ce973e773597d7",
    scans: ["accounts: SCAN a", "statuses: SCAN o"],
    site: "src/domain/statuses.ts#withdrawLocalBoost < src/domain/inbox.ts#<anonymous> in withdrawLocalBoosts < src/domain/inbox.ts#JobBudget.progress in purgeBatch < src/domain/inbox.ts#withdrawLocalBoosts < src/domain/inbox.ts#deleteStatusBatch",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#deleteStatusBatch); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "f70b3934f0dd018f",
    scans: ["statuses: SCAN r"],
    site: "src/domain/statuses.ts#withdrawLocalBoost < src/domain/inbox.ts#<anonymous> in withdrawLocalBoosts < src/domain/inbox.ts#JobBudget.progress in purgeBatch < src/domain/inbox.ts#withdrawLocalBoosts < src/domain/inbox.ts#deleteStatusBatch",
    disposition: "background",
    reason:
      'a job or round traversal (inbox.ts#deleteStatusBatch); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "29b9f081a57ea953",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/statuses.ts#interactorsWithin < src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2dbb65a0068ebdb6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/statuses.ts#interactorsWithin < src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c4e449d9650357ad",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/statuses.ts#quotable < src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2e2b65979d04e6c3",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'an edit notifies the local boosters: LOCAL_BOOSTERS_SQL (src/domain/statuses.ts) walks the local accounts, each one\'s kept boost sought by statuses_account_reblogs_kept: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "299c24c9deb20581",
    scans: ["stream_delete_tombstones: SCAN stream_delete_tombstones"],
    site: "src/domain/streaming.ts#<anonymous> in streamPrune",
    disposition: "background",
    reason:
      'a job or round traversal (streaming.ts#<anonymous> in streamPrune); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "a402b3ee4af6b839",
    scans: ["stream_delete_tombstones: SCAN stream_delete_tombstones", "stream_events: SCAN stream_events"],
    site: "src/domain/streaming.ts#<anonymous> in streamPrune",
    disposition: "background",
    reason:
      'a job or round traversal (streaming.ts#<anonymous> in streamPrune); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "d417813ecf17b75f",
    scans: ["stream_events: SCAN stream_events"],
    site: "src/domain/streaming.ts#<anonymous> in streamPrune",
    disposition: "background",
    reason:
      'a job or round traversal (streaming.ts#<anonymous> in streamPrune); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "42fc39fb4b373597",
    scans: ["stream_events: SCAN e"],
    site: "src/domain/streaming.ts#<anonymous> in streamEvents",
    disposition: "bounded",
    reason:
      "stream_events holds at most 4,097 rows: its triggers insert only while max(id) - min(id) < 4,096, so its ids span at most 4,096 (migration 0026_streaming)",
  },
  {
    id: "6c20d93b9d43e0dc",
    scans: ["stream_subscriptions: SCAN stream_subscriptions USING COVERING INDEX stream_subscriptions_key"],
    site: "src/domain/streaming.ts#listening < src/domain/streaming.ts#<anonymous> < src/domain/streaming.ts#<anonymous>",
    disposition: "bounded",
    reason:
      "stream_subscriptions holds the registry of open sockets: at most socketsPerInstance (256) sockets' accounts, keysPerAccount (16) keys each (STREAM_LIMITS, src/stream-hub.ts)",
  },
  {
    id: "a37c4bf18560862e",
    scans: ["stream_subscriptions: SCAN stream_subscriptions USING COVERING INDEX stream_subscriptions_key"],
    site: "src/domain/streaming.ts#streamDelete < src/domain/statuses.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "bounded",
    reason:
      "stream_subscriptions holds the registry of open sockets: at most socketsPerInstance (256) sockets' accounts, keysPerAccount (16) keys each (STREAM_LIMITS, src/stream-hub.ts)",
  },
  {
    id: "1ff7e061a92c03fe",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/suggestions.ts#<anonymous> in suggestions < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a7802aa0e24dce31",
    scans: ["push_deliveries: SCAN push_deliveries"],
    site: "src/domain/suspension.ts#tokensRound < src/domain/suspension.ts#<anonymous> in moderationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "c46111791f6ddd31",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/tags.ts#tagHistory < src/domain/tags.ts#<anonymous> in presentTags < src/domain/tags.ts#presentTags < src/domain/search.ts#searchHashtags < src/domain/search.ts#<anonymous> in search",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "a85388cc8a507b53",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/tags.ts#tagHistory < src/domain/tags.ts#<anonymous> in presentTags < src/domain/tags.ts#presentTags < src/domain/tags.ts#presentTag < src/domain/tags.ts#<anonymous> in tagWrite",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "fb9f6886321b49e0",
    scans: ["link_provider_reviews: SCAN link_provider_reviews"],
    site: "src/domain/trends.ts#<anonymous> in adminTrendPublishers",
    disposition: "bounded",
    reason: "each link review table holds at most 10,000 rows (its _cap trigger, migration 0071_link_trends)",
  },
  {
    id: "2a07ae53b5b56587",
    scans: ["account_trend_reviews: SCAN account_trend_reviews"],
    site: "src/domain/trends.ts#<anonymous> in reviewTrendStatus",
    disposition: "bounded",
    reason: "each trend review table holds at most 10,000 rows (its _cap trigger, migration 0057_trends)",
  },
  {
    id: "a29ca369e4948f77",
    scans: ["status_trend_reviews: SCAN status_trend_reviews"],
    site: "src/domain/trends.ts#<anonymous> in reviewTrendStatus",
    disposition: "bounded",
    reason: "each trend review table holds at most 10,000 rows (its _cap trigger, migration 0057_trends)",
  },
  {
    id: "50eb958ac7931a1e",
    scans: ["tag_trend_reviews: SCAN tag_trend_reviews"],
    site: "src/domain/trends.ts#<anonymous> in reviewTrendTag",
    disposition: "bounded",
    reason: "each trend review table holds at most 10,000 rows (its _cap trigger, migration 0057_trends)",
  },
  {
    id: "eeafcc8f7d035251",
    scans: ["trend_statuses: SCAN trend_statuses USING COVERING INDEX trend_statuses_account"],
    site: "src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends)",
  },
  {
    id: "81ae782a1128780d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#linkCandidates < src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d64e1a3f8e59b29e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#linkHistory < src/domain/trends.ts#presentTrendLink < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d3b188bb4dd28bee",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#presentable < src/domain/trends.ts#presentableCopy < src/domain/trends.ts#presentTrendLink < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/trends.ts#<anonymous> in trendingLinks",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4390f30bf71ce2e4",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#presentable < src/domain/trends.ts#presentableCopyLanguage < src/domain/trends.ts#shownOf < src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "18359c3baf3a88b8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "trend_links: SCAN t",
    ],
    site: "src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks); trend_links holds at most 250 rows (trend_links_cap, migration 0071_link_trends)",
  },
  {
    id: "052fba3357b901bf",
    scans: ["trend_statuses: SCAN trend_statuses USING COVERING INDEX trend_statuses_account"],
    site: "src/domain/trends.ts#roundStatuses < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends)",
  },
  {
    id: "d0bf2ebfba68cbc5",
    scans: ["trend_statuses: SCAN trend_statuses USING COVERING INDEX trend_statuses_account"],
    site: "src/domain/trends.ts#roundStatuses < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends)",
  },
  {
    id: "2887cf1a53509f1f",
    scans: ["trend_tags: SCAN t"],
    site: "src/domain/trends.ts#roundTags < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends)",
  },
  {
    id: "d62c900e0fa17a4a",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN s_tq",
      "statuses: SCAN s",
      "statuses: SCAN s_tqs",
      "trend_statuses: SCAN t USING COVERING INDEX trend_statuses_account",
    ],
    site: "src/domain/trends.ts#statusCandidates < src/domain/trends.ts#roundStatuses < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "background",
    reason: "trend rounds read the bounded trend pools (src/domain/trends.ts)",
  },
  {
    id: "70444f3748ae14d2",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN s_tq",
      "statuses: SCAN s",
      "statuses: SCAN s_tqs",
    ],
    site: "src/domain/trends.ts#statusCandidates < src/domain/trends.ts#roundStatuses < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "background",
    reason:
      'a job or round traversal (trends.ts#<anonymous> in trendsRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "7c935f1bb9cbd674",
    scans: [
      "?: SCAN a",
      "?: SCAN ps",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#tagGroups < src/domain/trends.ts#candidateTags < src/domain/trends.ts#roundTags < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "background",
    reason:
      'a job or round traversal (trends.ts#<anonymous> in trendsRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "6a227f26ea459092",
    scans: ["link_provider_reviews: SCAN link_provider_reviews"],
    site: "src/domain/trends.ts#writeReview < src/domain/trends.ts#<anonymous> in reviewTrendLink",
    disposition: "bounded",
    reason: "each link review table holds at most 10,000 rows (its _cap trigger, migration 0071_link_trends)",
  },
  {
    id: "ad68d218b1d7a749",
    scans: ["link_trend_reviews: SCAN link_trend_reviews"],
    site: "src/domain/trends.ts#writeReview < src/domain/trends.ts#<anonymous> in reviewTrendLink",
    disposition: "bounded",
    reason: "each link review table holds at most 10,000 rows (its _cap trigger, migration 0071_link_trends)",
  },
  {
    id: "ee327e1ebdc531fd",
    scans: ["trend_links: SCAN trend_links"],
    site: "src/domain/trends.ts#writeTrendRows < src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "trend_links holds at most 250 rows (trend_links_cap, migration 0071_link_trends)",
  },
  {
    id: "03a92aa21d49861c",
    scans: ["trend_tags: SCAN trend_tags"],
    site: "src/domain/trends.ts#writeTrendRows < src/domain/trends.ts#roundTags < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "bounded",
    reason: "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends)",
  },
  {
    id: "2bb9d7eb91bcae90",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/unlock-accepts.ts#<anonymous> in unlockAcceptStep",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5018c77751eeb712",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l USING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/unlock-accepts.ts#<anonymous> in unlockAcceptStep",
    disposition: "background",
    reason:
      'a job or round traversal (unlock-accepts.ts#<anonymous> in unlockAcceptStep); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "011218312cade1e0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/web-pages/profile.ts#localPageAccount < src/domain/web-pages/profile.ts#profilePageWithin < src/domain/web-pages/profile.ts#<anonymous> in webProfilePage < src/domain/web-pages/site.ts#<anonymous> in pageRead",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ebcd829363705cba",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/web-state.ts#sweepPrefix < src/domain/web-state.ts#<anonymous> in sweepWebState < src/domain/web-state.ts#sweepWebState < src/domain/oauth.ts#<anonymous> in sweepOAuth",
    disposition: "background",
    reason:
      'a job or round traversal (oauth.ts#<anonymous> in sweepOAuth); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "62885c9adc4d3b6d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "90c8ee4bf2eb6581",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a8fb51b20aee2af5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c5debd43be1ec43d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d71640cce03180a9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f62c0ddbdd9c58dd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1aac6c8c6a846381",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2282a73e78bd9d86",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "30fe77d39851010b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "478a5b428dcde212",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c08412102eb46881",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f154862e6e7b1b9a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
];
