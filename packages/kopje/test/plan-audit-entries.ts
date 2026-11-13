import type { PlanAuditEntry } from "./plan-audit.js";

// The reviewed scans of the plan audit (test/plan-audit.ts): one entry per statement identity, by site. Each lists the
// scans singleton statistics give it and what is known of them (Disposition); a pending or write entry names the
// #1468 group whose sweep removes it (test/plan-audit-1468.ts maps the issue's rows; group 9 holds the other request
// reads and writes). A scan a fragment allowance stands for (test/plan-audit-allowances.ts) is listed only for a
// statement whose plan shows it more often than the statement contains the fragment.
export const PLAN_AUDIT_ENTRIES: readonly PlanAuditEntry[] = [
  {
    id: "33f13a83681454ff",
    scans: ["account_invitations: SCAN account_invitations"],
    site: "src/domain/account-invitations.ts#invitations < src/domain/account-invitations.ts#<anonymous> in addInvitation",
    disposition: "bounded",
    reason: "account_invitations holds at most 10 rows (account_invitations_cap, migration 0081_account_invitations)",
  },
  {
    id: "1ac3d537002ad41f",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#accountRowsOf < src/domain/accounts.ts#accountsOf < src/domain/status-presenter.ts#<anonymous> < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#present",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
  },
  {
    id: "972ff48c0d07c3be",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#accountRow < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
  },
  {
    id: "dc1ee509b67978f1",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#presentAccountsById < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
  },
  {
    id: "ae5406a1bf9d171c",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
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
    id: "e4bc490c23e81d6f",
    scans: ["?: SCAN c"],
    site: "src/domain/accounts.ts#addressRow < src/domain/accounts.ts#accountByAddress < src/domain/accounts.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts)",
  },
  {
    id: "e10b8e82e5f2de07",
    scans: [
      "accounts: SCAN accounts",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "822ecfa15f846d25",
    scans: [
      "accounts: SCAN accounts",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "458288c71711a582",
    scans: [
      "accounts: SCAN accounts",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "958406ea29be0392",
    scans: [
      "accounts: SCAN accounts",
      "local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_1",
    ],
    site: "src/domain/accounts.ts#findAccountIds < src/domain/accounts.ts#searchAccountIds < src/domain/accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the account search\'s candidates (findAccountIds, src/domain/accounts.ts): the newest accounts are read newest first up to ACCOUNT_RECENT_LIMIT (5,000), and every local account is one: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
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
    id: "3be2de1ba3e95caa",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/actors.ts#active < src/domain/actors.ts#nodeInfoUsageOf < src/domain/federation-reads.ts#<anonymous> < src/domain/federation-reads.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'NodeInfo\'s active users walk the local accounts, each available one probed newest first by statuses_account (nodeInfoUsageOf, src/domain/actors.ts): local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
    witness:
      'test/nodeinfo-usage.test.ts ("counts an active account without reading its older history, with stale statistics"; "NodeInfo\'s active probe beside main\'s (RES-7)")',
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
    id: "cd06801d1dce1dec",
    scans: ["local_accounts: SCAN local_accounts"],
    site: "src/domain/admin-accounts.ts#<anonymous> in setAccountEmail",
    disposition: "deliberate",
    reason:
      'no index serves the sign-in\'s email match, which the email repair applies to the other local accounts (setAccountEmail, src/domain/admin-accounts.ts): local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "b3b09989aac94806",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the admin account list over the local accounts (readMatches, src/domain/admin-accounts.ts), each account read by key: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
  },
  {
    id: "9224cf8bf25be7f1",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-accounts.ts#readMatches < src/domain/admin-accounts.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      'the admin account list over the local accounts (readMatches, src/domain/admin-accounts.ts), each account read by key: local accounts are operator-sized (docs/threat-model.md, "Deployment assumptions")',
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
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only; each reads at most MEASURE_ROWS + 1 rows of its window and MEASURE_DOMAINS + 1 peers (src/domain/admin-measures.ts:53-54, the LIMITs at :189 and :261)",
  },
  {
    id: "607fc035a5a3ff84",
    scans: ["reports: SCAN r"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only; each reads at most MEASURE_ROWS + 1 rows of its window and MEASURE_DOMAINS + 1 peers (src/domain/admin-measures.ts:53-54, the LIMITs at :189 and :261)",
  },
  {
    id: "6bc414eca6f2b09c",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only. The follow measures loop over local_accounts (src/domain/admin-measures.ts:238-241): their candidates are capped at MEASURE_ROWS + 1 (:53, the LIMIT at :261), which does not stop the loop over local accounts with no follow, so a measure is O(local accounts), a deployment assumption (one person or a small group; an import may bring more)",
  },
  {
    id: "bdf72c7b9ba57b07",
    scans: ["local_accounts: SCAN l USING COVERING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only. The follow measures loop over local_accounts (src/domain/admin-measures.ts:238-241): their candidates are capped at MEASURE_ROWS + 1 (:53, the LIMIT at :261), which does not stop the loop over local accounts with no follow, so a measure is O(local accounts), a deployment assumption (one person or a small group; an import may bring more)",
  },
  {
    id: "d3b08cb9746f9019",
    scans: ["?: SCAN peers"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only; each reads at most MEASURE_ROWS + 1 rows of its window and MEASURE_DOMAINS + 1 peers (src/domain/admin-measures.ts:53-54, the LIMITs at :189 and :261)",
  },
  {
    id: "d8589742ced03205",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only; each reads at most MEASURE_ROWS + 1 rows of its window and MEASURE_DOMAINS + 1 peers (src/domain/admin-measures.ts:53-54, the LIMITs at :189 and :261)",
  },
  {
    id: "fe79c3ff8101310c",
    scans: ["reports: SCAN r"],
    site: "src/domain/admin-measures.ts#measureOf < src/domain/admin-measures.ts#<anonymous> in adminMeasure < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "the OAuth admin's measures (POST /api/v1/admin/measures, adminGuarded), operator-only; each reads at most MEASURE_ROWS + 1 rows of its window and MEASURE_DOMAINS + 1 peers (src/domain/admin-measures.ts:53-54, the LIMITs at :189 and :261)",
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
    id: "0d17e63234debf2b",
    scans: ["accounts: SCAN a"],
    site: "src/domain/announcements.ts#resolveMentions < src/domain/announcements.ts#render < src/domain/announcements.ts#presentAnnouncement < src/domain/announcements.ts#entries < src/domain/answer-budget.ts#admit",
    disposition: "pending",
    issue: "#1468 group 7",
  },
  {
    id: "746ff58fbd066436",
    scans: [
      "instance_domain_blocks: SCAN main.instance_domain_blocks USING COVERING INDEX instance_domain_blocks_suspend",
    ],
    site: "src/domain/audience.ts#Object.of in quoteReads < src/domain/status-presenter.ts#statusGraph < src/domain/status-presenter.ts#hydrate < src/domain/status-presenter.ts#statusStream < src/domain/answer-budget.ts#admit",
    disposition: "deliberate",
    reason:
      "SUSPEND_BLOCKS_SQL (src/domain/audience.ts) occurs once, but the flattened quote state repeats the expression that holds it, so the plan prints its one scalar subquery three times and the fragment allowance (test/plan-audit-allowances.ts) does not stand for it: EXISTS reads the first entry of the partial index instance_domain_blocks_suspend (migration 0046_instance_domain_blocks)",
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
    scans: ["accounts: SCAN ra"],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds",
    disposition: "pending",
    issue: "#1468 group 9",
  },
  {
    id: "f51569b711149874",
    scans: ["?: SCAN ps"],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost",
    disposition: "deliberate",
    reason:
      "ps is ruledSql's recursive CTE over a follower's domain suffixes (src/domain/audience.ts: its two keys, each walked only within DNS_NAME_UTF8_BYTES (1,012) bytes, so of at most 1,012 rows, a longer one covered unwalked; test/domain-suffix-walk.test.ts), which the classifier cannot bind under byInbox's derived tables, where the fragment's `accounts ps` shares its name",
  },
  {
    id: "0ec327b9c8182c79",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "15b5e5b897b53642",
    scans: ["?: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "22a7967fb5612cb2",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "4b02e34fb3082afd",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "563d70e4e039cfdf",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "635c7e6d558225da",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.select in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "86a77f60763ddc77",
    scans: ["statuses: SCAN s"],
    site: "src/domain/audience.ts#run < src/domain/audience.ts#Object.union in statusReads",
    disposition: "deliberate",
    reason:
      "a shape only the reader's own contract test writes (test/audience.test.ts:333-409: conditions around the rule, a WITH table, a union); no src caller passes it, and each src reader is audited under its own identity",
  },
  {
    id: "5b649a02c2ddf9a6",
    scans: ["?: SCAN ps"],
    site: "src/domain/audience.ts#recipientsFor < src/domain/deliveries.ts#targetsOf < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/polls.ts#recordPollUpdate",
    disposition: "deliberate",
    reason:
      "ps is ruledSql's recursive CTE over a voter's domain suffixes (src/domain/audience.ts: its two keys, each walked only within DNS_NAME_UTF8_BYTES (1,012) bytes, so of at most 1,012 rows, a longer one covered unwalked; test/domain-suffix-walk.test.ts), which the classifier cannot bind under byInbox's derived tables, where the fragment's `accounts ps` shares its name",
  },
  {
    id: "31dde5cdf5785684",
    scans: ["accounts: SCAN ra"],
    site: "src/domain/audience.ts#read < src/domain/audience.ts#remoteReportStatusIds < src/domain/reports.ts#<anonymous> in adminReportStream < src/domain/reports.ts#adminReportStream < src/domain/reports.ts#presented",
    disposition: "pending",
    issue: "#1468 group 6",
  },
  {
    id: "38ef2079b0de598f",
    scans: [
      "follows: SCAN fo USING COVERING INDEX follows_accepted",
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
    id: "e340d1dcebf0f9b2",
    scans: ["retraction_stagings: SCAN retraction_stagings USING COVERING INDEX retraction_stagings_ended"],
    site: "src/domain/deliveries.ts#sweepStagings < src/domain/deliveries.ts#<anonymous> in sweepDeliveries",
    disposition: "background",
    reason:
      'a job or round traversal (deliveries.ts#<anonymous> in sweepDeliveries); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "fb743767a7db9d47",
    scans: ["outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#followAnswersOf < src/domain/inbox.ts#cancelUndoneAnswers < src/domain/inbox.ts#undo < src/domain/inbox.ts#receive < src/domain/inbox.ts#<anonymous> in receiveActivity",
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
    id: "6d9b1b73c6ca82a2",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in retryDeliveries",
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
    id: "c205ffcef8ee4a83",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o"],
    site: "src/domain/deliveries.ts#<anonymous> in retryDeliveries",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "462ca529dc81901c",
    scans: ["outbound_targets: SCAN c"],
    site: "src/domain/deliveries.ts#expandPending < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound < src/domain/statuses.ts#writePost < src/domain/statuses.ts#postNow",
    disposition: "deliberate",
    reason:
      "expandPending's oldest chunk (src/domain/deliveries.ts): outbound_targets in rowid order from its start, LIMIT 1 and no filter, so one row; its activity read once by its rowid",
  },
  {
    id: "16731d8b485e0e6f",
    scans: ["deliveries: SCAN deliveries USING INDEX deliveries_lane"],
    site: "src/domain/deliveries.ts#activeCount < src/domain/deliveries.ts#Admission.admits < src/domain/deliveries.ts#expandPending < src/domain/deliveries.ts#enqueueActivity < src/domain/activities.ts#recordOutbound",
    disposition: "deliberate",
    reason:
      "the active rows counted through the partial index deliveries_lane (state queued, pending or leased), at most the statement's LIMIT (MAX_BACKLOG or MAX_LANE_BACKLOG, src/domain/deliveries.ts activeCount: RES-4)",
  },
  {
    id: "4e24afbeba55cd42",
    scans: ["deliveries: SCAN deliveries"],
    site: "src/domain/deliveries.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "the operator's delivery report (deliveriesReport, src/domain/deliveries.ts) counts every delivery by state: the walk is the report, which only the Access admin reads (GET /admin/deliveries, src/app/admin.ts)",
  },
  {
    id: "0d26081c24de0db3",
    scans: ["outbound_targets: SCAN outbound_targets USING COVERING INDEX outbound_targets_activity"],
    site: "src/domain/deliveries.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "the operator's delivery report (deliveriesReport, src/domain/deliveries.ts) counts the activities still expanding: the walk is the report, which only the Access admin reads (GET /admin/deliveries, src/app/admin.ts)",
  },
  {
    id: "19c057c4ebf7cf4d",
    scans: ["deliveries: SCAN d", "outbound_activities: SCAN o LEFT-JOIN"],
    site: "src/domain/deliveries.ts#<anonymous> in confirmDelivery",
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
    id: "0b29b51f1d1d3bf9",
    scans: ["deliveries: SCAN d", "deliveries: SCAN e", "outbound_activities: SCAN o", "outbound_targets: SCAN c"],
    site: "src/domain/deliveries.ts#personalFallback < src/domain/deliveries.ts#<anonymous> in completeDelivery",
    disposition: "pending",
    issue: "#1468 group 8",
  },
  {
    id: "cacc6c5c1e413ee6",
    scans: ["accounts: SCAN accounts USING INDEX accounts_directory_new"],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "the directory's window: a partial index of the discoverable accounts in the page's order, read to at most DIRECTORY_WINDOW * (offset + limit) entries, so at most 2 * (MAX_DIRECTORY_OFFSET + DIRECTORY_MAX_LIMIT) = 960 (src/domain/directory.ts:30-33, the LIMIT ?1 at :58 bound at :61; the limit is capped at 80 where the request is read, src/mastodon/accounts.ts:550, and an offset past 400 answers nothing, directory.ts:51)",
  },
  {
    id: "56fbdb284ae24ea9",
    scans: ["accounts: SCAN accounts USING INDEX accounts_directory_local_active"],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "the directory's window: a partial index of the discoverable accounts in the page's order, read to at most DIRECTORY_WINDOW * (offset + limit) entries, so at most 2 * (MAX_DIRECTORY_OFFSET + DIRECTORY_MAX_LIMIT) = 960 (src/domain/directory.ts:30-33, the LIMIT ?1 at :58 bound at :61; the limit is capped at 80 where the request is read, src/mastodon/accounts.ts:550, and an offset past 400 answers nothing, directory.ts:51)",
  },
  {
    id: "c8b5781765c9dc40",
    scans: ["accounts: SCAN accounts USING INDEX accounts_directory_local_new"],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "the directory's window: a partial index of the discoverable accounts in the page's order, read to at most DIRECTORY_WINDOW * (offset + limit) entries, so at most 2 * (MAX_DIRECTORY_OFFSET + DIRECTORY_MAX_LIMIT) = 960 (src/domain/directory.ts:30-33, the LIMIT ?1 at :58 bound at :61; the limit is capped at 80 where the request is read, src/mastodon/accounts.ts:550, and an offset past 400 answers nothing, directory.ts:51)",
  },
  {
    id: "ee420686f7bc1093",
    scans: ["accounts: SCAN accounts USING COVERING INDEX accounts_directory_active"],
    site: "src/domain/directory.ts#<anonymous> in directory < src/domain/auth.ts#<anonymous> in optionalUserReadOperation",
    disposition: "deliberate",
    reason:
      "the directory's window: a partial index of the discoverable accounts in the page's order, read to at most DIRECTORY_WINDOW * (offset + limit) entries, so at most 2 * (MAX_DIRECTORY_OFFSET + DIRECTORY_MAX_LIMIT) = 960 (src/domain/directory.ts:30-33, the LIMIT ?1 at :58 bound at :61; the limit is capped at 80 where the request is read, src/mastodon/accounts.ts:550, and an offset past 400 answers nothing, directory.ts:51)",
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
    disposition: "deliberate",
    reason:
      "the KvStore contract's listing with no prefix (src/domain/fedify-kv.ts:63-67, federation/kv-store.ts:47-52); Fedify lists only under a prefix (its middleware's this.#kv.list(this.#prefix)), a range of the key",
  },
  {
    id: "f05478ccc7013224",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
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
    scans: ["accounts: SCAN a", "local_accounts: SCAN l"],
    site: "src/domain/field-links.ts#held < src/domain/field-links.ts#<anonymous> in recordFieldLink",
    disposition: "background",
    reason:
      'a job or round traversal (field-links.ts#<anonymous> in recordFieldLink); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "79bfd658ce83ddaf",
    scans: ["sqlite_sequence: SCAN sqlite_sequence"],
    site: "src/domain/inbox.ts#outboundMark < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "bounded",
    reason:
      "sqlite_sequence holds at most one row per AUTOINCREMENT table of the schema: SQLite writes counters of those tables only, and an import restores a counter only of a table the live schema declares AUTOINCREMENT, replacing that table's row (src/platform/store-import.ts:141 and :192-204, refused as sequence-not-allowed otherwise; test/import-bounds.test.ts); the two names are read by equality",
    witness: "test/import-bounds.test.ts",
  },
  {
    id: "8b7c5c8e7643177f",
    scans: ["sqlite_sequence: SCAN sqlite_sequence"],
    site: "src/domain/inbox.ts#outboundSince < src/domain/inbox.ts#<anonymous> in runInboundJobs",
    disposition: "bounded",
    reason:
      "sqlite_sequence holds at most one row per AUTOINCREMENT table of the schema: SQLite writes counters of those tables only, and an import restores a counter only of a table the live schema declares AUTOINCREMENT, replacing that table's row (src/platform/store-import.ts:141 and :192-204, refused as sequence-not-allowed otherwise; test/import-bounds.test.ts); the two names are read by equality",
    witness: "test/import-bounds.test.ts",
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
    id: "87ac6fd3852e69b1",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/instance.ts#<anonymous> in instanceInfo",
    disposition: "deliberate",
    reason:
      "the users and active counts are of every available local account, in the one scan of local_accounts they need (INSTANCE_COUNTS_SQL, src/domain/instance.ts; test/activity.test.ts asserts it)",
  },
  {
    id: "0cad65b4d4b31af7",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/instance.ts#<anonymous> in instanceInfo",
    disposition: "deliberate",
    reason:
      "the users and active counts are of every available local account, in the one scan of local_accounts they need (INSTANCE_COUNTS_KEPT_SQL, src/domain/instance.ts; test/other-request-rewrites.test.ts runs it beside main's)",
  },
  {
    id: "2d0b6b5651861525",
    scans: ["local_accounts: SCAN l"],
    site: "src/domain/instance.ts#<anonymous> in instanceUsage",
    disposition: "deliberate",
    reason:
      "the active count is of every available local account, in the one scan of local_accounts it needs (INSTANCE_ACTIVE_SQL, src/domain/instance.ts; test/instance-counts.test.ts asserts it)",
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
    id: "04dd86e5255280f2",
    scans: ["card_oembed_endpoints: SCAN card_oembed_endpoints USING COVERING INDEX card_oembed_endpoints_expiry"],
    site: "src/domain/link-cards.ts#cacheEndpoint < src/domain/link-cards.ts#<anonymous> in recordCard",
    disposition: "background",
    reason:
      'a job or round traversal (link-cards.ts#<anonymous> in recordCard); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "2a0ee985d5c04980",
    scans: ["custom_emojis: SCAN e USING INDEX custom_emojis_enabled"],
    site: "src/domain/local-emojis.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "custom_emojis holds at most 1,000 enabled emoji, on every insert and re-enable, imports included (custom_emojis_enabled_insert, custom_emojis_enabled_update, migration 0055_local_custom_emojis); each image is read by key",
  },
  {
    id: "0b3e529f288063a3",
    scans: ["custom_emojis: SCAN custom_emojis USING COVERING INDEX custom_emojis_enabled"],
    site: "src/domain/local-emojis.ts#enabledCount < src/domain/local-emojis.ts#placeRefusal < src/domain/local-emojis.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "custom_emojis holds at most 1,000 enabled emoji, on every insert and re-enable, imports included (custom_emojis_enabled_insert, custom_emojis_enabled_update, migration 0055_local_custom_emojis)",
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
    id: "c10d6d4de870645f",
    scans: ["admin_actions: SCAN admin_actions"],
    site: "src/domain/moderation-log.ts#<anonymous> in moderationLog",
    disposition: "deliberate",
    reason:
      "an operator-only cost: the Access-gated GET /admin/moderation-log and the admin writes that log a row (src/domain/moderation-log.ts:14-15). logAction keeps the newest MODERATION_LOG_KEEP (10,000) rows by deleting at most MODERATION_LOG_PRUNE (10) below the window per write (:17-18, :65-69), but an import inserts admin_actions uncapped (src/platform/store-import.ts), so the table can hold more than the window until the writes prune it",
  },
  {
    id: "85e75d83d6d3987a",
    scans: ["admin_actions: SCAN admin_actions"],
    site: "src/domain/moderation-log.ts#logAction < src/domain/remote-suspension.ts#suspendRemote < src/domain/admin-accounts.ts#<anonymous> in adminAccountOperations < src/domain/auth.ts#<anonymous> in adminGuarded",
    disposition: "deliberate",
    reason:
      "an operator-only cost: the Access-gated GET /admin/moderation-log and the admin writes that log a row (src/domain/moderation-log.ts:14-15). logAction keeps the newest MODERATION_LOG_KEEP (10,000) rows by deleting at most MODERATION_LOG_PRUNE (10) below the window per write (:17-18, :65-69), but an import inserts admin_actions uncapped (src/platform/store-import.ts), so the table can hold more than the window until the writes prune it",
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
    id: "3ad5ebdd2b538d0f",
    scans: ["notifications: SCAN notifications"],
    site: "src/domain/notification-requests.ts#startJob < src/domain/notification-requests.ts#accept < src/domain/notification-requests.ts#<anonymous> < src/domain/auth.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "startJob reads the newest notification: the table in rowid order from its end, LIMIT 1, NOT INDEXED (src/domain/notification-requests.ts)",
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
    id: "c81d9446b4fc1d82",
    scans: ["polls: SCAN polls USING INDEX polls_stale"],
    site: "src/domain/polls.ts#sweepStaleVotes < src/domain/polls.ts#<anonymous> in pollRound",
    disposition: "background",
    reason:
      'a job or round traversal (polls.ts#<anonymous> in pollRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "d5affa2884b5e300",
    scans: ["featured_tags: SCAN featured_tags"],
    site: "src/domain/remote-collections.ts#replaceFeaturedTags < src/domain/remote-collections.ts#<anonymous> in completeCollectionRead",
    disposition: "background",
    reason:
      'a job or round traversal (remote-collections.ts#<anonymous> in completeCollectionRead); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "82beb1e260757671",
    scans: ["accounts: SCAN a", "collection_syncs: SCAN c"],
    site: "src/domain/remote-collections.ts#roundAccount < src/domain/remote-collections.ts#<anonymous> in completeCollectionRead",
    disposition: "background",
    reason:
      'a job or round traversal (remote-collections.ts#<anonymous> in completeCollectionRead); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "c815159d143e7f09",
    scans: ["remote_media: SCAN r"],
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
    scans: ["accounts: SCAN a"],
    site: "src/domain/remote-media.ts#backfill < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "e3baadedab9c6595",
    scans: ["remote_media: SCAN r USING INDEX remote_media_expiry"],
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
    scans: ["remote_media: SCAN r", "remote_media: SCAN remote_media"],
    site: "src/domain/remote-media.ts#validityWalk < src/domain/remote-media.ts#<anonymous> in maintainRemoteMedia",
    disposition: "background",
    reason:
      'a job or round traversal (remote-media.ts#<anonymous> in maintainRemoteMedia); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
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
    id: "7d72791fccd613d7",
    scans: ["push_deliveries: SCAN push_deliveries"],
    site: "src/domain/remote-suspension.ts#prepared < src/domain/remote-suspension.ts#sever < src/domain/remote-suspension.ts#accountSeverRound < src/domain/remote-suspension.ts#remoteRound < src/domain/remote-suspension.ts#<anonymous> in remoteModerationRound",
    disposition: "background",
    reason:
      'a job or round traversal (remote-suspension.ts#<anonymous> in remoteModerationRound); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "29d9fa4322758555",
    scans: ["statuses: SCAN statuses USING INDEX statuses_public"],
    site: "src/domain/search.ts#searchHashtags < src/domain/search.ts#<anonymous> in search < src/domain/auth.ts#<anonymous> in guarded",
    disposition: "deliberate",
    reason:
      "the newest HASHTAG_PUBLIC_WINDOW (2,000) public statuses, read in order from the partial index statuses_public (src/domain/search.ts:41 and :190, migrations/0000_initial.sql:132)",
  },
  {
    id: "3ae16a72600377c8",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "deliberate",
    reason:
      "setup before bootstrap only: SETUP_TOKEN-gated, and refused once bootstrapped (SETUP-2, src/domain/setup.ts:275 and :545), when kopje_state holds at most MAX_SETUP_SESSIONS (8, setup.ts:51) sessions besides the Store's own names and the monthly transform counters the setup's Images check charges (src/domain/media.ts:237), one per month it ran",
  },
  {
    id: "f8c1f4e4265e3864",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#<anonymous> in bootstrapInstance",
    disposition: "deliberate",
    reason:
      "setup before bootstrap only: SETUP_TOKEN-gated, and refused once bootstrapped (SETUP-2, src/domain/setup.ts:275 and :545), when kopje_state holds at most MAX_SETUP_SESSIONS (8, setup.ts:51) sessions besides the Store's own names and the monthly transform counters the setup's Images check charges (src/domain/media.ts:237), one per month it ran",
  },
  {
    id: "6f1738c70c69cc55",
    scans: ["local_accounts: SCAN local_accounts USING COVERING INDEX sqlite_autoindex_local_accounts_2"],
    site: "src/domain/setup.ts#bootstrapped < src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "deliberate",
    reason:
      "an existence probe of the local accounts: LIMIT 1 reads the first entry of local_accounts' email index whatever their number, and only while no configuration row exists (src/domain/setup.ts, bootstrapped)",
    witness: "test/other-request-plans.test.ts",
  },
  {
    id: "883afee3d9b87bd9",
    scans: [
      "?: SCAN quotes",
      "announcement_reactions: SCAN announcement_reactions USING COVERING INDEX announcement_reactions_name",
    ],
    site: "src/domain/setup.ts#insertLocalAccount < src/domain/setup.ts#<anonymous> in bootstrapInstance",
    disposition: "deliberate",
    reason:
      "the child-key lookups SQLite plans for a new parent row run only while a deferred foreign-key violation is outstanding (OP_FkIfZero); the Store's keys are immediate, so a new local account reads no quotes nor announcement_reactions",
    witness: "test/other-request-plans.test.ts",
  },
  {
    id: "3eb05efdf63fcd2b",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/setup.ts#sessionNames < src/domain/setup.ts#<anonymous> in beginSetupSession",
    disposition: "deliberate",
    reason:
      "setup before bootstrap only: SETUP_TOKEN-gated, and refused once bootstrapped (SETUP-2, src/domain/setup.ts:275 and :545), when kopje_state holds at most MAX_SETUP_SESSIONS (8, setup.ts:51) sessions besides the Store's own names and the monthly transform counters the setup's Images check charges (src/domain/media.ts:237), one per month it ran",
  },
  {
    id: "498ac8adb066550d",
    scans: ["?: SCAN c", "local_accounts: SCAN l"],
    site: "src/domain/status-presenter.ts#statusRowBounds < src/domain/status-presenter.ts#plannedChunks < src/domain/status-presenter.ts#statusStream",
    disposition: "deliberate",
    reason:
      "c is remoteAttachmentSql's subquery over one account's attachment, at most MAX_REMOTE_FIELDS entries (src/domain/account-columns.ts); the local accounts are OAUTH_ADMIN_HEAP_SQL's bound of oauthAdmin's read (src/domain/admin-authority.ts), and local accounts are operator-sized (docs/threat-model.md, \"Deployment assumptions\")",
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
    id: "a7802aa0e24dce31",
    scans: ["push_deliveries: SCAN push_deliveries"],
    site: "src/domain/suspension.ts#tokensRound < src/domain/suspension.ts#<anonymous> in moderationRound < src/domain/job-attempts.ts#<anonymous> in isolated",
    disposition: "background",
    reason:
      'a job or round traversal (job-attempts.ts#<anonymous> in isolated); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "c46111791f6ddd31",
    scans: ["follows: SCAN fo USING COVERING INDEX follows_accepted"],
    site: "src/domain/tags.ts#tagHistory < src/domain/tags.ts#<anonymous> in presentTags < src/domain/tags.ts#presentTags < src/domain/search.ts#searchHashtags < src/domain/search.ts#<anonymous> in search",
    disposition: "deliberate",
    reason:
      "the rule has no viewer, so its follow probe asks for fo.account_id IS NULL, which follows.account_id (NOT NULL, migrations/0000_initial.sql:255) never holds: SQLite reads no follow for it, and the history admits public statuses only besides",
    witness: "test/other-request-plans.test.ts",
  },
  {
    id: "a85388cc8a507b53",
    scans: ["follows: SCAN fo USING COVERING INDEX follows_accepted"],
    site: "src/domain/tags.ts#tagHistory < src/domain/tags.ts#<anonymous> in presentTags < src/domain/tags.ts#presentTags < src/domain/tags.ts#presentTag < src/domain/tags.ts#<anonymous> in tagWrite",
    disposition: "deliberate",
    reason:
      "the rule has no viewer, so its follow probe asks for fo.account_id IS NULL, which follows.account_id (NOT NULL, migrations/0000_initial.sql:255) never holds: SQLite reads no follow for it, and the history admits public statuses only besides",
    witness: "test/other-request-plans.test.ts",
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
    id: "18359c3baf3a88b8",
    scans: ["trend_links: SCAN t"],
    site: "src/domain/trends.ts#roundLinks < src/domain/trends.ts#<anonymous> in trendsRound",
    disposition: "deliberate",
    reason: "trend_links holds at most 250 rows (trend_links_cap, migration 0071_link_trends)",
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
    scans: ["?: SCAN a", "?: SCAN ps"],
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
    id: "a6623e9966398a30",
    scans: ["trend_statuses: SCAN t USING COVERING INDEX trend_statuses_account"],
    site: "src/domain/trends.ts#adminStatusRows < src/domain/trends.ts#<anonymous>",
    disposition: "deliberate",
    reason:
      "the trend lists hold at most 250 rows each (trend_tags_cap, trend_statuses_cap, migration 0057_trends); each status and author is read by key",
  },
  {
    id: "5018c77751eeb712",
    scans: ["accounts: SCAN a", "local_accounts: SCAN l USING INDEX sqlite_autoindex_local_accounts_1"],
    site: "src/domain/unlock-accepts.ts#<anonymous> in unlockAcceptStep",
    disposition: "background",
    reason:
      'a job or round traversal (unlock-accepts.ts#<anonymous> in unlockAcceptStep); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
  {
    id: "ebcd829363705cba",
    scans: ["kopje_state: SCAN kopje_state"],
    site: "src/domain/web-state.ts#sweepPrefix < src/domain/web-state.ts#<anonymous> in sweepWebState < src/domain/web-state.ts#sweepWebState < src/domain/oauth.ts#<anonymous> in sweepOAuth",
    disposition: "background",
    reason:
      'a job or round traversal (oauth.ts#<anonymous> in sweepOAuth); each round is bounded by its batch (docs/engineering.md, "Ordering, rounds and fences")',
  },
];
