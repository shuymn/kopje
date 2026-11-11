import type { PlanAuditEntry } from "./plan-audit.js";

// The reviewed scans of the plan audit (test/plan-audit.ts): one entry per statement identity, by site. Each lists the
// scans singleton statistics give it and what is known of them (Disposition); a pending or write entry names the
// #1468 group whose sweep removes it (test/plan-audit-1468.ts maps the issue's rows; group 9 holds the other request
// reads and writes).
export const PLAN_AUDIT_ENTRIES: readonly PlanAuditEntry[] = [
  {
    id: "9cecef5e7daa2045",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "e714d75336a0d4d1",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "2a8739eb65f8cfb7",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/account-actions.ts#answerPendingFollow < src/domain/account-actions.ts#<anonymous> in answerFollowRequest < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "7974714b0014713a",
    scans: [
      "accounts: SCAN a",
      "follows: SCAN f",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/account-actions.ts#answerPendingFollow < src/domain/account-actions.ts#<anonymous> in answerFollowRequest < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "b4188be0a7505d09",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/account-actions.ts#followTarget < src/domain/account-actions.ts#followAccount < src/domain/account-actions.ts#<anonymous> in follow < src/domain/auth.ts#<anonymous> in guarded",
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
    id: "74abf4d3c9ade76b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "badf0ac5e0c91991",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/accounts.ts#<anonymous> in familiarFollowers < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "60944cd5916b02f8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#<anonymous> in listFollowRequests < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "01d04f4854af962e",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#accountRow < src/domain/accounts.ts#<anonymous> in getAccount",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "423a5bd16841ae8c",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#accountRowsOf < src/domain/accounts.ts#accountsOf < src/domain/status-presenter.ts#<anonymous> in hydrate < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "4d71eacb508c9942",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/instance.ts#contactAccount < src/domain/instance.ts#<anonymous> in instanceInfo",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "f41eaac91fbef4a6",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/web-pages/profile.ts#remoteTagged < src/domain/web-pages/profile.ts#profilePageWithin < src/domain/web-pages/profile.ts#<anonymous> in webProfilePage",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "3f1bb43d70c34dae",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> in searchAccounts < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "a7674348f265200f",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> in searchAccounts < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "4e2b4eb3c8b60652",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "caac4bdb43e7d013",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "d5b29f6a647583ff",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "dcbca4c1c0a933ae",
    scans: [
      "accounts: SCAN accounts",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "27744999cd63c372",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/accounts.ts#<anonymous> in listFollows < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "362114cc999e92ce",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/web-pages/follows.ts#followsPageWithin < src/domain/web-pages/follows.ts#<anonymous> in webFollowsPage < src/domain/web-pages/site.ts#<anonymous> in pageRead",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5966a81224013482",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#listFollowsWithin < src/domain/web-pages/follows.ts#followsPageWithin < src/domain/web-pages/follows.ts#<anonymous> in webFollowsPage < src/domain/web-pages/site.ts#<anonymous> in pageRead",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c8512a01de3f6f0b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#movedOf < src/domain/accounts.ts#relatedOf < src/domain/accounts.ts#accountsOf < src/domain/status-presenter.ts#<anonymous> in hydrate < src/domain/status-presenter.ts#hydrate",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "dd7cc740565b5969",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#partialAccountsOf < src/domain/notification-groups.ts#admitGroups < src/domain/notification-groups.ts#<anonymous> in listGroupedNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6688be0e3c7d4946",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#presentAccountsById < src/domain/accounts.ts#<anonymous> in getAccounts",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "9d0948565b029046",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#presentedRemoteFields < src/domain/remote-actors.ts#upsertRemoteActor < src/domain/remote-statuses.ts#storedActor < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "bd9adbfd4e7d7477",
    scans: [
      "follows: SCAN fb LEFT-JOIN",
      "follows: SCAN fo LEFT-JOIN",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "mutes: SCAN m LEFT-JOIN",
    ],
    site: "src/domain/accounts.ts#relationshipsOf < src/domain/accounts.ts#<anonymous> in relationships < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "f85d063a45eb3ba9",
    scans: ["follows: SCAN fb LEFT-JOIN", "follows: SCAN fo LEFT-JOIN", "mutes: SCAN m LEFT-JOIN"],
    site: "src/domain/accounts.ts#relationshipsOf < src/domain/accounts.ts#relationshipResult < src/domain/blocks.ts#<anonymous> in block < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "2ca6935366900eb9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#searchAccountIds < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c8d0e846388ce8b0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/accounts.ts#windowAccountIds < src/domain/lists.ts#ownedAccountsWindow < src/domain/lists.ts#ownedAccountsPage < src/domain/endorsements.ts#endorsedPage < src/domain/endorsements.ts#<anonymous> in listEndorsements",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7c7191d9b1564634",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/activities.ts#<anonymous> in getLegacyObject",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "83e5656634fa146b",
    scans: ["accounts: SCAN a"],
    site: "src/domain/activities.ts#<anonymous> in getLegacyObject",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "8a6f496c83009a36",
    scans: ["accounts: SCAN a", "statuses: SCAN s"],
    site: "src/domain/activities.ts#statusFacts < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "4cf2c47def97fc1c",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actor-update.ts#actorRow < src/domain/actor-update.ts#actorDocument < src/domain/actor-update.ts#actorSnapshot < src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "b56b064387f46a4a",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actors.ts#<anonymous> in featuredTagsOfActor",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "72ccd75416468a1a",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/actors.ts#<anonymous> in getCollection",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "9fa16b2cfecbfc09",
    scans: ["accounts: SCAN a", "follows: SCAN f"],
    site: "src/domain/actors.ts#<anonymous> in getCollection",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "a628e8cb8ab09421",
    scans: ["accounts: SCAN a"],
    site: "src/domain/actors.ts#<anonymous> in getCollection",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "3feb11fab2be4530",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actors.ts#<anonymous> in getLocalKey",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "df48f112717779a7",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actors.ts#<anonymous> in listLocalKeys",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "8fadf90d25903087",
    scans: ["accounts: SCAN a"],
    site: "src/domain/actors.ts#<anonymous> in listRewrapKeys",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "ed63e5d8393e7e15",
    scans: ["statuses: SCAN s USING INDEX statuses_account"],
    site: "src/domain/actors.ts#active < src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> in apNodeInfo < src/domain/federation-reads.ts#<anonymous> in federationRead",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "b663d8b514ae0829",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/actors.ts#followerKeyOf < src/domain/actors.ts#fetchSignerOf < src/domain/actors.ts#<anonymous> in getFetchSigner",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "d4eedb513385d18d",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actors.ts#localActorOf < src/domain/actors.ts#<anonymous> in getLocalActor",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "16a2f961fff1dfe0",
    scans: ["statuses: SCAN s"],
    site: "src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> in apNodeInfo < src/domain/federation-reads.ts#<anonymous> in federationRead",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "382565ddce9f80fa",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> in apNodeInfo < src/domain/federation-reads.ts#<anonymous> in federationRead",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "7a25d6886118f2e4",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/actors.ts#signingKeyOf < src/domain/actors.ts#fetchSignerOf < src/domain/inbox.ts#fetchPreparation < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "da96c2c02866408c",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l LEFT-JOIN"],
    site: "src/domain/admin-account-presenter.ts#adminAccountStream < src/domain/reports.ts#adminReportStream < src/domain/reports.ts#presented < src/domain/reports.ts#<anonymous> in getAdminReport < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "cd06801d1dce1dec",
    scans: ["local_accounts: SCAN local_accounts"],
    site: "src/domain/admin-accounts.ts#<anonymous> in setAccountEmail",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "6f6e9212c7a8f43c",
    scans: ["accounts: SCAN a"],
    site: "src/domain/admin-accounts.ts#<anonymous> in unsuspendAccount",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "004e878168744bca",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#range < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "63db12281fd95476",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#range < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "0864883bb20dae71",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "2fb8120b16b76dbd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "343544316569a3b2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "61158970f7002537",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "6c8e1e8a6746ffe8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "9a522aa76dc11d03",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "9df8696f1185b3b9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "a222cbe698121287",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "a4b628ddb6b77f52",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "d4d8c8cf5a640647",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "e621f2305792421b",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "f630b2583c6b55ad",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l LEFT-JOIN",
    ],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "7511bb5f1914c901",
    scans: ["accounts: SCAN a"],
    site: "src/domain/admin-accounts.ts#textMatches < src/domain/admin-accounts.ts#ordered < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "78569b4e54647cc3",
    scans: ["accounts: SCAN a"],
    site: "src/domain/admin-accounts.ts#textMatches < src/domain/admin-accounts.ts#ordered < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "82fc0e40127c6e76",
    scans: ["local_accounts: SCAN l LEFT-JOIN"],
    site: "src/domain/admin-accounts.ts#textMatches < src/domain/admin-accounts.ts#ordered < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "86e3b5718de79c79",
    scans: ["accounts: SCAN a"],
    site: "src/domain/admin-accounts.ts#textMatches < src/domain/admin-accounts.ts#ordered < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "b0133054d2369745",
    scans: ["accounts: SCAN a"],
    site: "src/domain/admin-accounts.ts#textMatches < src/domain/admin-accounts.ts#ordered < src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "71b67c065fd24966",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-authority.ts#oauthAdmin < src/domain/admin-authority.ts#adminAccountId < src/domain/admin-authority.ts#adminAccountIdOnce < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> in listNotifications",
    disposition: "pending",
    issue: "#1468 group 4",
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
    id: "8b964bbf6af22772",
    scans: ["announcement_reactions: SCAN announcement_reactions"],
    site: "src/domain/announcements.ts#<anonymous> in deleteAnnouncement",
    disposition: "write",
    issue: "#1468 group 7",
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
    id: "4b444c31c87c91ff",
    scans: ["announcement_reactions: SCAN r", "media_attachments: SCAN m LEFT-JOIN"],
    site: "src/domain/announcements.ts#reactionRows < src/domain/announcements.ts#presentAnnouncement < src/domain/announcements.ts#entries < src/domain/answer-budget.ts#admit < src/domain/announcements.ts#<anonymous> in listAnnouncements",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "cf99c3ed84341d2c",
    scans: ["announcement_reactions: SCAN r", "media_attachments: SCAN m LEFT-JOIN"],
    site: "src/domain/announcements.ts#reactionRows < src/domain/announcements.ts#streamedAnnouncementReaction < src/domain/streaming.ts#<anonymous> in streamUnit",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "b35fccc1203f6e8a",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/announcements.ts#resolveMentions < src/domain/announcements.ts#render < src/domain/announcements.ts#presentAnnouncement < src/domain/announcements.ts#entries < src/domain/answer-budget.ts#admit",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "b32e113979fa3fc0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#<anonymous> in deleteAudience < src/domain/audience.ts#deleteAudience",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "cba42f5ce5cbdf45",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#<anonymous> in deleteAudience < src/domain/audience.ts#deleteAudience",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2bcf3bc293a528df",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#<anonymous> in notificationGroupAccounts < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "f3b7dbce1096c653",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#<anonymous> in unreadCount < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "07aaf986c8dcd890",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#firstOfGroup < src/domain/notification-groups.ts#<anonymous> in getNotificationGroup < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "0efa720bc1e1e5bf",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#membersOf < src/domain/notification-groups.ts#admitGroups < src/domain/notification-groups.ts#<anonymous> in listGroupedNotifications",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "0ad843d4adfdd79e",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#oldestOf < src/domain/notification-groups.ts#admitGroups < src/domain/notification-groups.ts#<anonymous> in listGroupedNotifications",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "6b69fd03d93ff321",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#walkGroups < src/domain/notification-groups.ts#<anonymous> in listGroupedNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "a077770e4457cf0c",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notification-groups.ts#walkGroups < src/domain/notification-groups.ts#<anonymous> in unreadGroupCount < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "b067edaa8d8ec94e",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> in listNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "feabd3194ea08772",
    scans: ["notifications: SCAN n"],
    site: "src/domain/audience.ts#Object.notificationWindow in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> in listNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "d4e1d23e249b53dd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#Object.of in quoteApprovalReads < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit < src/domain/timelines.ts#answerAdmission",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "80bb7e94eb81b3dd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#Object.of in quoteReads < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8a72321203c817fa",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#addresses < src/domain/activities.ts#boostAnnounce < src/domain/statuses.ts#announceOf < src/domain/statuses.ts#<anonymous> in reblog < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a56eaee653dfbb6d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#canView < src/domain/audience.ts#viewableStatusId < src/domain/remote-statuses.ts#status < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0ead5423467132e8",
    scans: ["accounts: SCAN a"],
    site: "src/domain/audience.ts#hasFollowerOn < src/domain/audience.ts#remoteReportStatusIds",
    disposition: "pending",
    issue: "#1468 group 6",
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
    id: "4d8a3772d696dcd2",
    scans: [
      "accounts: SCAN ra",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "1966b7b779c0598e",
    scans: [
      "accounts: SCAN ra",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds < src/domain/reports.ts#<anonymous> in adminReportStream < src/domain/reports.ts#adminReportStream < src/domain/reports.ts#presented",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "58a81cfb2fc2e6aa",
    scans: ["?: SCAN pp", "accounts: SCAN a USING INDEX sqlite_autoindex_accounts_1"],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#audienceTargets",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "76d96a0d433f6afc",
    scans: [
      "?: SCAN pp",
      "?: SCAN ps",
      "accounts: SCAN a USING INDEX sqlite_autoindex_accounts_1",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/polls.ts#recordPollUpdate",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "8e5c13863aa791c4",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e1e8dbc1cd71d41a",
    scans: [
      "?: SCAN ps",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "0d56e46d5f99e045",
    scans: ["accounts: SCAN a USING INDEX sqlite_autoindex_accounts_1", "accounts: SCAN t"],
    site: "src/domain/audience.ts#reportForwardees < src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "3bef8ae1b32e7326",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.authorShown in statusReads < src/domain/timelines.ts#accountStatusIds < src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8999f13e6866e9e7",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.authorShown in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6393721fdd0d5e3e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notification-groups.ts#shownNotifications < src/domain/notification-groups.ts#firstOfGroup < src/domain/notification-groups.ts#<anonymous> in getNotificationGroup",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "76f6ef448e04968d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notification-groups.ts#shownNotifications < src/domain/notification-groups.ts#firstOfGroup < src/domain/notification-groups.ts#<anonymous> in getNotificationGroup",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "479628dcbb7c89c1",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#mentionedStatus < src/domain/streaming.ts#<anonymous> in streamUnit",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "5423e75a20d14397",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#<anonymous> in getNotification < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "94d39482438b624d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#<anonymous> in getNotification < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "dd3a7482337e4207",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#streamedNotification",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "100b5cf9d09625aa",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#notificationById < src/domain/notifications.ts#streamedNotification < src/domain/streaming.ts#<anonymous> in streamUnit",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "578dca3cba8b808c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "notifications: SCAN n",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> in listNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "a0225cf80ad4e596",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "notifications: SCAN n",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.notifications in statusReads < src/domain/notifications.ts#shownWindow < src/domain/notifications.ts#<anonymous> in listNotifications < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "2787ff111e48b5c3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "8110b6986ade9775",
    scans: [
      "?: SCAN s",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "ab7eba8591840caf",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "bb00f9a9c723ad2b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c2d9535cba4d691b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "e78259d3b695046c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "f32a157a2519174d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "fd45f38c8c07cd12",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c794f7609ac597a2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/conversations.ts#conversationStream < src/domain/answer-budget.ts#admit < src/domain/conversations.ts#<anonymous> in listConversations",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "a38f47e1d1e834b8",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "notification_requests: SCAN r",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nt",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/notification-requests.ts#requestStream < src/domain/answer-budget.ts#admit < src/domain/notification-requests.ts#<anonymous> in listNotificationRequests",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "16b2091a135d349d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1aa70db678c15369",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6ba0bb27d0467886",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6fbbd4b1209dd7e3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7c3a885bc67c4546",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e9b8b68d326bf2a5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ef85930e943987f2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/search.ts#searchStatuses < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "b5007a215ea4a47a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#<anonymous> in getStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "babe4a93114fc3c6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#<anonymous> in statusContext < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "272605a178036681",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#contextAncestors < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous> in webStatusPage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "b4aa60b577e86c00",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e234ce58204faf15",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "41259814be0ae640",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#<anonymous> in edgeList < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "552621fdbcbb1eb1",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#<anonymous> in edgeList < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "79c6e7a6bfa0c447",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusIds < src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "179d6213b8bd50e3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "23f32f3bf1806a1b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4c59b78ab5f1f81a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "60c71eb09107474c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f4a92f6266c4e93a",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "527712bdf7a891d7",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#accountStatusesWithin < src/domain/web-pages/profile.ts#profilePageWithin < src/domain/web-pages/profile.ts#<anonymous> in webProfilePage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3ded8e67d4d07184",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "4426df65fba078bd",
    scans: [
      "accounts: SCAN pa",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "9e03bd13db6a27dc",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "cc3382d2b0480efd",
    scans: [
      "accounts: SCAN pa",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "d15f59ad89ed6975",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "ebf02560dee729d0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#publicStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1dbbd74a56fd5fa2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#tagStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "8c25e807eb3a019d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#tagStatus < src/domain/streaming.ts#feedStatus < src/domain/streaming.ts#<anonymous> in fedIn",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5246018447bc59db",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#accountStatusesWithin < src/domain/timelines.ts#<anonymous> in accountStatuses",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "bf44cd63f3b188b5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#tagTimelineWithin < src/domain/timelines.ts#<anonymous> in tagTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "607e343b2506a93d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#windowStatuses < src/domain/timelines.ts#<anonymous> in homeTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "970ef528564985ee",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#windowStatuses < src/domain/timelines.ts#<anonymous> in linkTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "9b515b482a7bd33d",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#windowStatuses < src/domain/timelines.ts#<anonymous> in listTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "cc0fe07227011e9f",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#windowStatuses < src/domain/timelines.ts#<anonymous> in listTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "d82104417fdf2f03",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/timelines.ts#windowStatusesWithin < src/domain/timelines.ts#windowStatuses < src/domain/timelines.ts#<anonymous> in listTimeline",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "af077b4805776d2c",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN e_tq",
      "statuses: SCAN e",
      "statuses: SCAN e_tqs",
      "statuses: SCAN s",
      "trend_statuses: SCAN t USING COVERING INDEX trend_statuses_account",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/trends.ts#<anonymous> in trendingStatuses < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "f160900d4ac615e2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous> in webStatusPage",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "d21f97ba649047ca",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads < src/domain/web-pages/status.ts#pageStatus < src/domain/web-pages/status.ts#targetStatus < src/domain/web-pages/status.ts#<anonymous> in embeddedStatus",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "baf802fcc7e26dba",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e01a130328734aa7",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "c8e0da8ce3388b5c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN l",
      "statuses: SCAN s",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#homeRows < src/domain/timelines.ts#homeStatus < src/domain/streaming.ts#<anonymous> in streamUnit",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "15e9a09a7b79b1a6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "1a47fe943e8910ed",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "61fdf9b30b49b0ab",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads < src/domain/timelines.ts#listRows < src/domain/timelines.ts#ownListStatus < src/domain/timelines.ts#listStatus",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "cf1923b8059609ba",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#viewableStatusIds < src/domain/web-pages/parents.ts#parentLinks < src/domain/web-pages/parents.ts#parentLink < src/domain/web-pages/status.ts#statusPageWithin < src/domain/web-pages/status.ts#<anonymous> in webStatusPage",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
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
    id: "2015293d7bfdb5c7",
    scans: ["follows: SCAN follows"],
    site: "src/domain/blocks.ts#cleanupBatch < src/domain/blocks.ts#<anonymous> in cleanupItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "f7fa41e22b4c5e65",
    scans: ["accounts: SCAN a", "follows: SCAN f"],
    site: "src/domain/blocks.ts#cleanupBatch < src/domain/blocks.ts#<anonymous> in cleanupItem < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "6624b051aa030764",
    scans: ["accounts: SCAN a", "follows: SCAN f USING COVERING INDEX follows_accepted"],
    site: "src/domain/blocks.ts#count < src/domain/blocks.ts#<anonymous> in previewDomainBlock < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "c829232584296b86",
    scans: ["accounts: SCAN a"],
    site: "src/domain/blocks.ts#count < src/domain/blocks.ts#<anonymous> in previewDomainBlock < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "92ed6178962ba241",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/blocks.ts#endFollow < src/domain/blocks.ts#<anonymous> in block < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
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
    id: "8a60356d41a087d5",
    scans: ["media_attachments: SCAN m"],
    site: "src/domain/custom-emojis.ts#localEmojiSnapshot < src/domain/announcements.ts#presentAnnouncement < src/domain/announcements.ts#entries < src/domain/answer-budget.ts#admit < src/domain/announcements.ts#<anonymous> in listAnnouncements",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "4ebf3d4105b48e91",
    scans: ["custom_emojis: SCAN e", "media_attachments: SCAN m"],
    site: "src/domain/custom-emojis.ts#localEmojiTags < src/domain/activities.ts#statusFacts",
    disposition: "pending",
    issue: "#1468 group 2",
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
    id: "204d208b7d2b3b91",
    scans: ["outbound_activities: SCAN outbound_activities"],
    site: "src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/actor-update.ts#recordActorUpdate < src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
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
    id: "1460c2b4b5225dae",
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
    id: "4db9fda6faa5e784",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/deliveries.ts#sendRefused < src/domain/deliveries.ts#<anonymous> in claimDeliveries",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "650c66ba4101fa79",
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
    id: "117cbdf2e32377d3",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_new",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "62fdf59bebe9a6b2",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_local_active",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "c396eb9b767c8ba6",
    scans: [
      "accounts: SCAN accounts USING INDEX accounts_directory_local_new",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "edb94cd82695abfa",
    scans: [
      "accounts: SCAN accounts USING COVERING INDEX accounts_directory_active",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "cac99adb579bd76b",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/endorsements.ts#endorsementsShown < src/domain/endorsements.ts#endorsedPage < src/domain/endorsements.ts#<anonymous> in listEndorsements < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "efee9218654aa715",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/featured-tags.ts#accountFeaturedTagsOf < src/domain/featured-tags.ts#<anonymous> in accountFeaturedTags",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "70567aebaf77664b",
    scans: ["featured_tags: SCAN featured_tags"],
    site: "src/domain/featured-tags.ts#countFeaturedTags < src/domain/statuses.ts#writeTags < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus",
    disposition: "write",
    issue: "#1468 group 2",
  },
  {
    id: "c52d2af2065d8724",
    scans: ["featured_tags: SCAN featured_tags"],
    site: "src/domain/featured-tags.ts#decrement < src/domain/featured-tags.ts#countFeaturedTags < src/domain/statuses.ts#writeTags < src/domain/statuses.ts#<anonymous> in editStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 2",
  },
  {
    id: "71335659b70245ba",
    scans: ["statuses: SCAN s"],
    site: "src/domain/featured-tags.ts#featuredOfStatus < src/domain/statuses.ts#writeTags < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch",
    disposition: "pending",
    issue: "#1468 group 2",
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
    id: "9c10c3977d897319",
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
    id: "c4db3f67a714b259",
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
    id: "2824cc03e02440f8",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/field-links.ts#linkCandidates < src/domain/field-links.ts#armFieldLinks < src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
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
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "03910bd9e7047358",
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
    id: "44b0ff32c8c62ec0",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#cancelUndoneAnswers < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
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
    id: "202c61f362793a9c",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/inbox.ts#deliveredTo < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "cbfddd7d3c9f4c0f",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#forwardable < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "86c8e0c1571ad573",
    scans: ["favourites: SCAN f", "statuses: SCAN s"],
    site: "src/domain/inbox.ts#legacyFavourite < src/domain/inbox.ts#undoInteraction < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "bb73dff71750e00e",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/inbox.ts#localAccount < src/domain/inbox.ts#follow < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 1",
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
    id: "d747ac007615c57c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/inbox.ts#moveBatch < src/domain/inbox.ts#<anonymous> in runJobBatch < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6f988178f10492e5",
    scans: ["statuses: SCAN s"],
    site: "src/domain/inbox.ts#originalByUri < src/domain/inbox.ts#announce < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "aa25997d56f78c4d",
    scans: ["follows: SCAN f"],
    site: "src/domain/inbox.ts#ourFollow < src/domain/inbox.ts#accept < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
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
    id: "7fc72a03f44b055c",
    scans: ["accounts: SCAN a"],
    site: "src/domain/inbox.ts#ownerExists < src/domain/inbox.ts#<anonymous> in inboxOwnerExists",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "aea206e79a827d22",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/inbox.ts#recordForwards < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "9d5a43cb9081615f",
    scans: ["accounts: SCAN a"],
    site: "src/domain/inbox.ts#remoteKeyOf < src/domain/inbox.ts#<anonymous> in inboxGate",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "17e6cb8ea43c9599",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/inbox.ts#removeBoost < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "write",
    issue: "#1468 group 5",
  },
  {
    id: "130b803cb3b9a5c4",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/inbox.ts#removeFavourite < src/domain/inbox.ts#undoInteraction < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "write",
    issue: "#1468 group 5",
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
    id: "7e15c69c6539d7be",
    scans: ["blocks: SCAN blocks"],
    site: "src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "write",
    issue: "#1468 group 5",
  },
  {
    id: "83d4c93abba9e172",
    scans: ["follows: SCAN follows"],
    site: "src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "c24ea88434f156e1",
    scans: ["blocks: SCAN blocks"],
    site: "src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "40441f03ad0b8958",
    scans: ["instance_domain_blocks: SCAN instance_domain_blocks"],
    site: "src/domain/instance-domain-blocks.ts#blocksPage < src/domain/admin-domain-blocks.ts#<anonymous> in listAdminDomainBlocks < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "c507c60814b4afbe",
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
    id: "a7cd9186f112186a",
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
    id: "9cc1572be763c072",
    scans: ["handshake_replays: SCAN handshake_replays USING COVERING INDEX handshake_replays_fresh"],
    site: "src/domain/job-attempts.ts#fresh < src/domain/job-attempts.ts#nextJob < src/domain/handshake-replays.ts#dueHold < src/domain/handshake-replays.ts#<anonymous> in handshakeReplayStep",
    disposition: "background",
    reason:
      'a job or round traversal (handshake-replays.ts#<anonymous> in handshakeReplayStep); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "fc655ccc154c491e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#<anonymous> in claimCards",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "3c198aa1d9a23610",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#<anonymous> in recordCard",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "7040cdbddf87202e",
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
    id: "68440c9e29d37aa3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/link-cards.ts#enqueueCard < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "972f6bae1f7e2247",
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
    id: "8d54bf10c382eb21",
    scans: ["media_attachments: SCAN m"],
    site: "src/domain/local-emojis.ts#<anonymous> in adminEmojis",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "b2ba7bd7c87d186e",
    scans: ["accounts: SCAN a", "media_attachments: SCAN m"],
    site: "src/domain/local-emojis.ts#<anonymous> in completeEmoji",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "9ce2b4bc7b5d421c",
    scans: ["custom_emojis: SCAN e USING INDEX custom_emojis_enabled", "media_attachments: SCAN m"],
    site: "src/domain/local-emojis.ts#<anonymous> in customEmojis",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "80b7909111a47fc3",
    scans: ["custom_emojis: SCAN e", "media_attachments: SCAN m"],
    site: "src/domain/local-emojis.ts#emojiById < src/domain/local-emojis.ts#<anonymous> in completeEmoji",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "0b3e529f288063a3",
    scans: ["custom_emojis: SCAN custom_emojis USING COVERING INDEX custom_emojis_enabled"],
    site: "src/domain/local-emojis.ts#enabledCount < src/domain/local-emojis.ts#placeRefusal < src/domain/local-emojis.ts#<anonymous> in reserveEmoji",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "8f2413f482d1c147",
    scans: ["custom_emojis: SCAN e", "media_attachments: SCAN m"],
    site: "src/domain/local-emojis.ts#localEmojiObjectOf < src/domain/federation-reads.ts#<anonymous> in apEmoji < src/domain/federation-reads.ts#<anonymous> in federationRead",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "164788f25317d707",
    scans: ["local_accounts: SCAN l", "statuses: SCAN s"],
    site: "src/domain/local-notes.ts#<anonymous> in getLocalNote",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "1c6e52b49191e614",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/local-notes.ts#<anonymous> in getOutbox",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "27833270a8c036f5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
      "statuses: SCAN o LEFT-JOIN",
    ],
    site: "src/domain/local-notes.ts#<anonymous> in getOutbox",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "4ec0ae054c56140a",
    scans: ["accounts: SCAN a", "media_attachments: SCAN m"],
    site: "src/domain/media.ts#<anonymous> in completeMedia < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 7",
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
    id: "c9fe4d5856b6c794",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/media.ts#<anonymous> in startTransforms < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 7",
  },
  {
    id: "1246f45674d92e3d",
    scans: ["media_attachments: SCAN media_attachments"],
    site: "src/domain/media.ts#applyProfileImage < src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "20a111b63d6283a0",
    scans: ["media_attachments: SCAN media_attachments"],
    site: "src/domain/media.ts#applyProfileImage < src/domain/account-actions.ts#<anonymous> in updateCredentials < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 1",
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
    id: "aa16fa3f052bfb46",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "notification_requests: SCAN r",
    ],
    site: "src/domain/notification-requests.ts#<anonymous> in listNotificationRequests < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "3185fcf576d7b8d6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nc",
      "statuses: SCAN nt",
    ],
    site: "src/domain/notification-requests.ts#jobBatch < src/domain/notification-requests.ts#<anonymous> in runJobs < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "36e2f8cf43097e70",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notification-requests.ts#jobBatch < src/domain/notification-requests.ts#<anonymous> in runJobs < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "8912838ed5fd5c3a",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notification-requests.ts#jobBatch < src/domain/notification-requests.ts#<anonymous> in runJobs < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "548cc7062034067d",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notification-requests.ts#startJob < src/domain/notification-requests.ts#accept < src/domain/notification-requests.ts#<anonymous> in acceptNotificationRequest < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "40b77b4c43b03b35",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/notification-requests.ts#summaryOf < src/domain/notification-requests.ts#<anonymous> in getNotificationPolicy < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "bd1efe6af817e336",
    scans: ["notification_requests: SCAN notification_requests"],
    site: "src/domain/notification-requests.ts#takeRequests < src/domain/notification-requests.ts#<anonymous> in acceptNotificationRequest < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 4",
  },
  {
    id: "8a3cd7d0f90da839",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notifications.ts#notify < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "write",
    issue: "#1468 group 4",
  },
  {
    id: "bfbf501d314fef26",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nc",
      "statuses: SCAN nt",
    ],
    site: "src/domain/notifications.ts#notify < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "d95c075c3dd23426",
    scans: ["statuses: SCAN pa", "statuses: SCAN ps"],
    site: "src/domain/notifications.ts#notify < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "79b50cea608cbb03",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "quotes: SCAN nq USING COVERING INDEX quotes_accepted",
      "statuses: SCAN nc",
      "statuses: SCAN nt",
    ],
    site: "src/domain/notifications.ts#notify < src/domain/remote-statuses.ts#updateRemoteStatus < src/domain/inbox.ts#updateStatus < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "8258b58b610c21f0",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notifications.ts#notify < src/domain/remote-statuses.ts#updateRemoteStatus < src/domain/inbox.ts#updateStatus < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "write",
    issue: "#1468 group 4",
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
    site: "src/domain/notifications.ts#queuePushes < src/domain/notifications.ts#notify < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive",
    disposition: "pending",
    issue: "#1468 group 4",
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
    id: "b854da78c7c8c6ca",
    scans: ["statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/polls.ts#isLocalPoll < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/inbox.ts#create < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "030b3c4d53f4539b",
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
    id: "018959d76d72df60",
    scans: ["accounts: SCAN a", "polls: SCAN p", "statuses: SCAN s"],
    site: "src/domain/polls.ts#votedPoll < src/domain/polls.ts#<anonymous> in vote < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "a7f79d8ff5d2365e",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
      "notifications: SCAN n USING INDEX notifications_unfiltered",
      "push_deliveries: SCAN d USING COVERING INDEX sqlite_autoindex_push_deliveries_1",
      "push_subscriptions: SCAN p",
      "statuses: SCAN nt",
      "statuses: SCAN s LEFT-JOIN",
    ],
    site: "src/domain/push.ts#target < src/domain/push.ts#<anonymous> in claimPushes",
    disposition: "pending",
    issue: "#1468 group 4",
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
    id: "589dc940523cf19f",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/quotes.ts#<anonymous> in quoteWork",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "407e76bf486325c4",
    scans: ["statuses: SCAN s"],
    site: "src/domain/quotes.ts#acceptedQuoteWindow < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "ea84f890d3875c8b",
    scans: ["statuses: SCAN s"],
    site: "src/domain/quotes.ts#acceptedQuoteWindow < src/domain/statuses.ts#statusQuotesWithin < src/domain/statuses.ts#<anonymous> in statusQuotes < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "886a0b6af34f7a45",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
      "statuses: SCAN t",
    ],
    site: "src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "b1accf01c6e1f787",
    scans: ["quotes: SCAN q"],
    site: "src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "08b9392b70338eeb",
    scans: ["quotes: SCAN q", "statuses: SCAN s"],
    site: "src/domain/quotes.ts#answeredQuote < src/domain/quotes.ts#acceptOurQuote < src/domain/inbox.ts#accept < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "51b1202e42b6a7df",
    scans: ["statuses: SCAN s", "statuses: SCAN t"],
    site: "src/domain/quotes.ts#answeredQuote < src/domain/quotes.ts#acceptOurQuote < src/domain/inbox.ts#accept < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "3c0c4011614c16b3",
    scans: ["quotes: SCAN quotes"],
    site: "src/domain/quotes.ts#linkQuotes < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 3",
  },
  {
    id: "7352dd5e4b3a0d95",
    scans: ["accounts: SCAN a LEFT-JOIN"],
    site: "src/domain/quotes.ts#noteQuote < src/domain/activities.ts#statusFacts < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "8f408d3fcbcc7f6b",
    scans: ["accounts: SCAN qa", "local_accounts: SCAN l", "statuses: SCAN s"],
    site: "src/domain/quotes.ts#quoteAuthorizationOf < src/domain/federation-reads.ts#<anonymous> in apQuoteAuthorization < src/domain/federation-reads.ts#<anonymous> in federationRead",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "56da100fdf19b432",
    scans: ["statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/quotes.ts#quotedUpdates < src/domain/statuses.ts#notifyQuotedUpdate < src/domain/remote-statuses.ts#updateRemoteStatus < src/domain/inbox.ts#updateStatus < src/domain/inbox.ts#receive",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "2991528cf9cd7dfd",
    scans: ["quotes: SCAN quotes"],
    site: "src/domain/quotes.ts#recheckStamp",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "89b3f8f60e83f213",
    scans: ["statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/quotes.ts#recheckStamp",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "c1681e65d1e0a9a7",
    scans: ["statuses: SCAN t LEFT-JOIN"],
    site: "src/domain/quotes.ts#recordQuote < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/quotes.ts#answerQuoteRequest < src/domain/inbox.ts#quoteRequest < src/domain/inbox.ts#receive",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "9b6ac9e9d41995c5",
    scans: ["accounts: SCAN a", "quotes: SCAN q", "statuses: SCAN s"],
    site: "src/domain/quotes.ts#revocableQuote < src/domain/statuses.ts#ownQuote < src/domain/statuses.ts#<anonymous> in prepareRevoke < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 3",
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
    id: "54ace832325e5a5e",
    scans: ["statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/quotes.ts#revokeLocalStamp < src/domain/quotes.ts#revokeStamp < src/domain/inbox.ts#retractUnknown < src/domain/inbox.ts#deleteObject < src/domain/inbox.ts#receive",
    disposition: "pending",
    issue: "#1468 group 3",
  },
  {
    id: "34f2d2efaf2715c3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-actors.ts#staleAccount < src/domain/quotes.ts#authorDue < src/domain/quotes.ts#stageOf < src/domain/quotes.ts#<anonymous> in quoteWork",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "9460ea9047cf7700",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-actors.ts#unavailableRemote < src/domain/remote-actors.ts#upsertRemoteActor < src/domain/remote-statuses.ts#storedActor < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "617fbb83ad9fdd49",
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
    id: "47bff26dc640109d",
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
    id: "42f1513938c8f885",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-field-links.ts#claimRemoteFieldLinks < src/domain/field-links.ts#<anonymous> in claimFieldLinks",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "95a8eaae2785a7b7",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-field-links.ts#remoteLinksHeld < src/domain/field-links.ts#held < src/domain/field-links.ts#<anonymous> in recordFieldLink",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "34198c810f7e9c22",
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
    id: "b89117f15d84a4aa",
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
    id: "4d0cfd953c1dd1ef",
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
    id: "bf4e1e94e5c50312",
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
    id: "36ae5bec7dea2c80",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-statuses.ts#account < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "5c0423fb4792f8f2",
    scans: ["statuses: SCAN statuses"],
    site: "src/domain/remote-statuses.ts#linkReplies < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "write",
    issue: "#1468 group 5",
  },
  {
    id: "779741b80affd19c",
    scans: ["follows: SCAN f"],
    site: "src/domain/remote-statuses.ts#notifyCreated < src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/inbox.ts#create < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
  },
  {
    id: "caf85e0d6e34bb14",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/remote-statuses.ts#storeRemoteStatus < src/domain/remote-statuses.ts#storeResolved < src/domain/remote-statuses.ts#<anonymous> in resolveSearch < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "2e2b65979d04e6c3",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/remote-statuses.ts#updateRemoteStatus < src/domain/inbox.ts#updateStatus < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "pending",
    issue: "#1468 group 5",
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
    id: "9047202ef8c391e2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/reports.ts#<anonymous> in createReport < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "d6f2aca5bea01c97",
    scans: ["accounts: SCAN a", "reports: SCAN r USING COVERING INDEX reports_pair_state"],
    site: "src/domain/reports.ts#<anonymous> in reportTargetPage",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "e2606b9f8da800e2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/reports.ts#fileRemoteReports < src/domain/inbox.ts#flag < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "787a7df6c149826a",
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
    id: "7aeb47cb134c61db",
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
    id: "d677c9d551b09f23",
    scans: ["accounts: SCAN a"],
    site: "src/domain/snapshot.ts#forgetActorSnapshots < src/domain/suspension.ts#suspendLocal",
    disposition: "pending",
    issue: "#1468 group 1",
  },
  {
    id: "a04d6b85351cb8d6",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/status-presenter.ts#idRows < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#filterTextTargets < src/domain/status-presenter.ts#textLevel < src/domain/status-presenter.ts#presentationOf",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c0110d0368169fb1",
    scans: [
      "?: SCAN c",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "local_accounts: SCAN l",
    ],
    site: "src/domain/status-presenter.ts#statusRowBounds < src/domain/status-presenter.ts#plannedChunks < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit < src/domain/timelines.ts#answerAdmission",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "01cd70de42b82825",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/status-presenter.ts#statusRows < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "39817cd0709e153b",
    scans: ["accounts: SCAN a", "statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/statuses.ts#<anonymous> in unfavourite < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "f30f615445457b9e",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/statuses.ts#<anonymous> in unfavourite < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "50c50731f8ff93c1",
    scans: ["accounts: SCAN a", "statuses: SCAN o", "statuses: SCAN s"],
    site: "src/domain/statuses.ts#actionTarget < src/domain/statuses.ts#<anonymous> in reblog < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "60dab03d57cfd21f",
    scans: ["accounts: SCAN a"],
    site: "src/domain/statuses.ts#deletedStatus < src/domain/statuses.ts#<anonymous> in deleteStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "1e058804dcf008b9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN e USING COVERING INDEX statuses_account",
    ],
    site: "src/domain/statuses.ts#interactorsWithin < src/domain/statuses.ts#<anonymous> in interactors < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "b920941e4b687b5b",
    scans: [
      "favourites: SCAN e USING COVERING INDEX favourites_account_status",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/statuses.ts#interactorsWithin < src/domain/statuses.ts#<anonymous> in interactors < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "8955ceeb96e6de7c",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/statuses.ts#localAuthor < src/domain/statuses.ts#preparePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "4491bc5dcad1d3c2",
    scans: ["media_attachments: SCAN m LEFT-JOIN"],
    site: "src/domain/statuses.ts#mediaToAttach < src/domain/statuses.ts#preparePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "d6ebdbae15afb66e",
    scans: ["accounts: SCAN a", "statuses: SCAN s USING COVERING INDEX statuses_account"],
    site: "src/domain/statuses.ts#ownQuote < src/domain/statuses.ts#<anonymous> in prepareRevoke < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "904c14204dd80836",
    scans: [
      "accounts: SCAN a",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "statuses: SCAN s",
    ],
    site: "src/domain/statuses.ts#quotable < src/domain/statuses.ts#<anonymous> in postTargets < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "5988eee721766944",
    scans: ["accounts: SCAN a", "statuses: SCAN s"],
    site: "src/domain/statuses.ts#quoteLink < src/domain/statuses.ts#preparePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "ebd3bb7c99c15348",
    scans: ["statuses: SCAN o", "statuses: SCAN s"],
    site: "src/domain/statuses.ts#replyParent < src/domain/statuses.ts#preparePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "bd8faa6627ec0e13",
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
    id: "9c23e4568aa718e0",
    scans: ["follows: SCAN follows"],
    site: "src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow < src/domain/scheduled-statuses.ts#<anonymous> in postStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "4a804b3a420186c0",
    scans: ["notifications: SCAN n USING COVERING INDEX notifications_account LEFT-JOIN", "stream_events: SCAN e"],
    site: "src/domain/streaming.ts#<anonymous> in streamEvents",
    disposition: "pending",
    issue: "#1468 group 2",
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
    id: "6c20d93b9d43e0dc",
    scans: ["stream_subscriptions: SCAN stream_subscriptions USING COVERING INDEX stream_subscriptions_key"],
    site: "src/domain/streaming.ts#listening < src/domain/streaming.ts#<anonymous> in streamEvents < src/domain/streaming.ts#<anonymous> in streamEvents",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "a37c4bf18560862e",
    scans: ["stream_subscriptions: SCAN stream_subscriptions USING COVERING INDEX stream_subscriptions_key"],
    site: "src/domain/streaming.ts#streamDelete < src/domain/statuses.ts#<anonymous> in deleteStatus < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "48aabd77dab3f50e",
    scans: ["stream_delete_tombstones: SCAN t", "stream_events: SCAN e"],
    site: "src/domain/streaming.ts#tombstoneFeeds < src/domain/streaming.ts#<anonymous> in streamUnit",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "7e3ebb52bf228c1d",
    scans: ["accounts: SCAN a"],
    site: "src/domain/streaming.ts#tombstoneOf < src/domain/streaming.ts#streamDelete",
    disposition: "pending",
    issue: "#1468 group 2",
  },
  {
    id: "046f06e372f32ba7",
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
    id: "b59ea7ca39f27921",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/tags.ts#tagHistory < src/domain/tags.ts#<anonymous> in presentTags < src/domain/tags.ts#presentTags < src/domain/search.ts#searchHashtags < src/domain/search.ts#<anonymous> in search",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "054ddcca38c0fc07",
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
    id: "bae3ad0bc2fa20e3",
    scans: [
      "accounts: SCAN a",
      "statuses: SCAN s",
      "trend_statuses: SCAN t USING COVERING INDEX trend_statuses_account",
    ],
    site: "src/domain/trends.ts#adminStatusRows < src/domain/trends.ts#<anonymous> in adminTrendStatuses",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "e346544063f81fca",
    scans: ["accounts: SCAN a", "statuses: SCAN s"],
    site: "src/domain/trends.ts#adminStatusRows < src/domain/trends.ts#<anonymous> in reviewTrendStatus",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "277a05072dc7d0e2",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#linkCandidates < src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "6ad89b470b6f57e9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#linkHistory < src/domain/trends.ts#presentTrendLink < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f6b3dd5e78a6b221",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#presentable < src/domain/trends.ts#presentableCopy < src/domain/trends.ts#presentTrendLink < src/domain/trends.ts#<anonymous> in trendingLinks < src/domain/trends.ts#<anonymous> in trendingLinks",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "fa28d5fbae55fdcd",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/trends.ts#presentable < src/domain/trends.ts#presentableCopyLanguage < src/domain/trends.ts#shownOf < src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e7613d9b828a5388",
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
    id: "0542988c73c5b820",
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
    id: "259482a3c6eac5b0",
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
    id: "7c3fa1df1508b446",
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
    id: "59ec73cef4e3e7b0",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/unlock-accepts.ts#<anonymous> in unlockAcceptStep",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "c504e683d75cf1bc",
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
    id: "0f7ab9e63f9810d1",
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
    id: "1352d004500b03f3",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "19bb76492ec2f575",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "2efb8cc068cd8153",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "44535cd848f9ca52",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "6cc5031ca8c371d7",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "c7dd911d5f944d66",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
      "lists: SCAN el",
      "statuses: SCAN s",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#homeWindow < src/domain/timelines.ts#<anonymous> in homeTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "013c3cc16f6411b9",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "04dcc6c59e330afb",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "0d82c2cb55663f65",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "64f8d26da3db27e5",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "e462e3b791d49b2c",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "f95d48b87eabf141",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/windows.ts#mergedWindow < src/domain/timelines.ts#listWindow < src/domain/timelines.ts#<anonymous> in listTimeline < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) tests whether any suspend block exists: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
  },
  {
    id: "453eda0d0efa810f",
    scans: ["accounts: SCAN pa"],
    site: "src/domain/windows.ts#singleWindow < src/domain/timelines.ts#<anonymous> in publicTimeline < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 4",
  },
  {
    id: "47f2c318f1210259",
    scans: ["accounts: SCAN pa"],
    site: "src/domain/windows.ts#singleWindow < src/domain/timelines.ts#<anonymous> in publicTimeline < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "pending",
    issue: "#1468 group 4",
  },
];
