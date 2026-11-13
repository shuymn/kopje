import * as accountActions from "./domain/account-actions";
import * as invitations from "./domain/account-invitations";
import * as accounts from "./domain/accounts";
import * as activities from "./domain/activities";
import {
  ensureInstanceActorKey,
  featuredTagsOfActor,
  getCollection,
  getInstanceActorKey,
  getFetchSigner,
  getInstanceDomain,
  getLocalActor,
  getLocalKey,
  getNodeInfoUsage,
  listLocalKeys,
  listRewrapKeys,
  rewrapLocalKey,
} from "./domain/actors";
import {
  actOnAccount,
  actOnAdminAccount,
  getAdminAccount,
  listAdminAccounts,
  setAccountEmail,
  unsuspendAccount,
  unsuspendAdminAccount,
} from "./domain/admin-accounts";
import { oauthAdminStatus } from "./domain/admin-authority";
import * as adminDomainBlocks from "./domain/admin-domain-blocks";
import { adminMeasure } from "./domain/admin-measures";
import * as announcements from "./domain/announcements";
import { checkCredential, noteActivity } from "./domain/auth";
import * as blocks from "./domain/blocks";
import * as cardImages from "./domain/card-images";
import * as conversations from "./domain/conversations";
import * as deliveries from "./domain/deliveries";
import { directory } from "./domain/directory";
import * as endorsements from "./domain/endorsements";
import * as featuredTags from "./domain/featured-tags";
import * as federationReads from "./domain/federation-reads";
import { kvCas, kvDelete, kvGet, kvList, kvSet } from "./domain/fedify-kv";
import * as fieldLinks from "./domain/field-links";
import * as filters from "./domain/filters";
import * as inbox from "./domain/inbox";
import {
  instanceAdminSettings,
  instanceDocument,
  instanceInfo,
  instancePeers,
  instanceRules,
  instanceUsage,
  refreshDomainCount,
  searchPeers,
  setInstanceSettings,
} from "./domain/instance";
import * as instanceActivity from "./domain/instance-activity";
import * as instanceDomainBlocks from "./domain/instance-domain-blocks";
import * as interaction from "./domain/interaction";
import { retryParkedJobs } from "./domain/job-attempts";
import * as linkCards from "./domain/link-cards";
import * as lists from "./domain/lists";
import * as localEmojis from "./domain/local-emojis";
import * as localNotes from "./domain/local-notes";
import * as markers from "./domain/markers";
import * as media from "./domain/media";
import * as mediaRebuild from "./domain/media-rebuild";
import { moderationLog } from "./domain/moderation-log";
import * as notificationGroups from "./domain/notification-groups";
import * as notificationRequests from "./domain/notification-requests";
import * as notifications from "./domain/notifications";
import * as oauth from "./domain/oauth";
import * as polls from "./domain/polls";
import * as push from "./domain/push";
import * as quoteVerification from "./domain/quote-verification";
import * as quotes from "./domain/quotes";
import * as remoteCollections from "./domain/remote-collections";
import * as remoteMedia from "./domain/remote-media";
import { resolveSearch } from "./domain/remote-statuses";
import * as reports from "./domain/reports";
import * as scheduled from "./domain/scheduled-statuses";
import { search } from "./domain/search";
import * as setup from "./domain/setup";
import { saveSnapshot } from "./domain/snapshot";
import * as statusActions from "./domain/status-actions";
import * as statuses from "./domain/statuses";
import * as suggestions from "./domain/suggestions";
import { runModerationJobs, suspendAccount } from "./domain/suspension";
import * as tags from "./domain/tags";
import * as timelines from "./domain/timelines";
import * as trends from "./domain/trends";
import * as featuredPages from "./domain/web-pages/featured";
import * as followPages from "./domain/web-pages/follows";
import * as interactPages from "./domain/web-pages/interact";
import * as profilePages from "./domain/web-pages/profile";
import * as sitePages from "./domain/web-pages/site";
import * as statusPages from "./domain/web-pages/status";
import * as tagPages from "./domain/web-pages/tags";
import * as webSession from "./domain/web-session";
import type { OperationInput, StoreOperation } from "./platform/store-kernel";

// The Store's RPC methods that run one domain operation and nothing else: each entry names the method and its
// operation, and the Store defines one method per entry (store.ts), typed by StoreRpc: the caller's build, then the
// operation's input (OperationInput: less the field the Store's clock fills), none for an operation that takes none.
// A method with logic of its own (streams, rescue RPCs, backups, gates, retries) is written in store.ts; a name in both
// places refuses to load (defineRpc). How a request talks to the Store, and when a call stays separate for its timing,
// is said in docs/engineering.md, "How a request talks to the Store".
export const STORE_RPC = {
  // The OAuth admin's state for GET /admin/health, which shows it to Access only.
  oauthAdmin: oauthAdminStatus,

  // POST /admin/accounts/email: the Access admin's repair of the OAuth admin's match (domain/admin-accounts.ts).
  setAccountEmail,

  // GET and POST /admin/invitations: the Access admin's account invitations (domain/account-invitations.ts).
  listInvitations: invitations.listInvitations,
  addInvitation: invitations.addInvitation,
  removeInvitation: invitations.removeInvitation,

  // GET and POST /admin/instance: the Access admin's public settings (domain/instance.ts).
  instanceAdminSettings,
  setInstanceSettings,

  // POST /admin/accounts/unsuspend: the Access admin's recovery of a suspended account (domain/admin-accounts.ts).
  unsuspendAccount,

  // GET /admin/reports/:id (domain/reports.ts).
  reportTargetPage: reports.reportTargetPage,

  // GET /admin/moderation-log (domain/moderation-log.ts).
  moderationLog,
  setupState: setup.getSetupState,

  // The /setup wizard (domain/setup.ts): each operation authorizes its setup session or admin itself.
  setupView: setup.setupView,
  beginSetupSession: setup.beginSetupSession,
  endSetupSession: setup.endSetupSession,
  confirmSetupDomain: setup.confirmSetupDomain,
  reserveAccess: setup.reserveAccess,
  checkpointAccess: setup.checkpointAccess,
  completeAccess: setup.completeAccess,
  failAccess: setup.failAccess,
  recordSetupImages: setup.recordSetupImages,
  sendSetupProbe: setup.sendSetupProbe,
  consumeSetupProbe: setup.consumeSetupProbe,
  recordCronRun: setup.recordCronRun,
  chargeSetupTransform: setup.chargeSetupTransform,
  bootstrapInstance: setup.bootstrapInstance,

  // The families of job rounds, each its own Store call and error boundary (jobsRound in jobs/queue.ts, RES-5). A
  // round of the inbound jobs and the quote stamp revocations (domain/inbox.ts), in one transaction.
  runInboundJobs: inbox.runInboundJobs,
  runDomainBlockCleanups: blocks.runDomainBlockCleanups,

  // A round of the jobs of answered notification requests and of notification removals
  // (domain/notification-requests.ts).
  runNotificationRequestJobs: notificationRequests.runNotificationRequestJobs,

  // A round of the local and remote moderation jobs (domain/suspension.ts), in one transaction.
  runModerationJobs,

  // POST /admin/jobs/retry (domain/job-attempts.ts, RES-5): failing jobs made fresh, a bounded number per call.
  retryParkedJobs,

  // Syncs of remote accounts' collections (domain/remote-collections.ts): claimed and applied by the Worker's job
  // rounds (federation/collections.ts).
  claimCollectionSync: remoteCollections.claimCollectionSync,
  completeCollectionRead: remoteCollections.completeCollectionRead,
  completePinFetches: remoteCollections.completePinFetches,

  // Verification of received quotes (domain/quotes.ts): the work read, applied and claimed by the Worker's job rounds
  // (federation/quotes.ts).
  quoteWork: quotes.quoteWork,
  completeQuote: quoteVerification.completeQuote,
  chargeQuote: quotes.chargeQuote,
  claimQuotes: quotes.claimQuotes,

  // Verification of local profile links (domain/field-links.ts): claimed, recorded and finished by the cron's round
  // (federation/field-links.ts).
  claimFieldLinks: fieldLinks.claimFieldLinks,
  recordFieldLink: fieldLinks.recordFieldLink,
  finishFieldLinks: fieldLinks.finishFieldLinks,

  // Status cards (domain/link-cards.ts): claimed and recorded by the cron's round (federation/link-cards.ts), whose
  // hops the domain policy admits as a write (webHopRefused).
  claimCards: linkCards.claimCards,
  recordCard: linkCards.recordCard,

  // Card images (domain/card-images.ts): claimed, admitted, started and recorded by the cron's round
  // (federation/card-images.ts).
  claimCardImages: cardImages.claimCardImages,
  admitCardImage: cardImages.admitCardImage,
  startCardImage: cardImages.startCardImage,
  recordCardImage: cardImages.recordCardImage,

  // Remote media (domain/remote-media.ts): claimed, admitted and recorded by the cron's round
  // (federation/remote-media.ts), each at the Store's own time, so every safety window (LATE_PUT_MS after a claim)
  // is measured from a Store-recorded time. The maintenance is the Store's own method (it reads the restore marker).
  confirmRemoteMediaDeleted: remoteMedia.confirmRemoteMediaDeleted,
  recordRemoteMediaValidation: remoteMedia.recordRemoteMediaValidation,
  remoteMediaOrphans: remoteMedia.remoteMediaOrphans,
  remoteMediaSwept: remoteMedia.remoteMediaSwept,
  claimRemoteMedia: remoteMedia.claimRemoteMedia,
  admitRemoteMedia: remoteMedia.admitRemoteMedia,
  recordRemoteMedia: remoteMedia.recordRemoteMedia,

  remoteKey: inbox.getRemoteKey,

  // The revision a search resolution reads before it fetches an actor's document, with that fetch's policy verdict
  // (federation/resolve.ts).
  actorRevision: inbox.getActorRevision,

  // The instance domain policy the Worker reads before a fetch (R38; inboxGate reads it before an inbound
  // request is verified): advisory, as the writes decide.
  fetchRefused: instanceDomainBlocks.fetchRefused,

  // The domain policy of each hop of the cron's web page rounds (link cards, profile link verification), admitted as a
  // write (NET-3).
  webHopRefused: instanceDomainBlocks.webHopRefused,
  inboxOwnerExists: inbox.inboxOwnerExists,

  // Federation: Fedify's KvStore, local actors and keys, collections, NodeInfo, and the rescue snapshots (their
  // rescue read is the Store's own method, rescueSnapshot).
  kvGet,
  kvSet,
  kvDelete,
  kvCas,
  kvList,
  instanceDomain: getInstanceDomain,
  localActor: getLocalActor,

  // The signer of a fetch no Store answer prepared (DATA-7, actors.ts fetchSignerOf), on its first fetch.
  fetchSigner: getFetchSigner,
  localKey: getLocalKey,
  instanceActorKey: getInstanceActorKey,
  ensureInstanceActorKey,
  localKeys: listLocalKeys,

  // The KEK rewrap (app/key-rewrap.ts), from /admin/keys/rewrap: a page of wrapped keys, and the compare-and-swap write
  // of one rewrapped key.
  rewrapKeys: listRewrapKeys,
  rewrapKey: rewrapLocalKey,
  collection: getCollection,
  featuredTagsCollection: featuredTagsOfActor,
  nodeInfoUsage: getNodeInfoUsage,

  // The federation GETs (domain/federation-reads.ts): one call a request, the setup check included.
  apSite: federationReads.apSite,
  apNodeInfo: federationReads.apNodeInfo,
  apQuoteAuthorization: federationReads.apQuoteAuthorization,
  apEmoji: federationReads.apEmoji,
  saveSnapshot,

  // OAuth and the account and instance API.
  registerApp: oauth.registerApp,

  // Protected operations take the request's credential and validate it in their own transaction (domain/auth.ts).
  // checkCredential() only validates.
  checkCredential,

  // After an authenticated request's response (mastodon/activity.ts): its account's active day.
  noteActivity,
  appOfCredential: oauth.appOfCredential,
  inspectToken: oauth.inspectToken,
  introspectToken: oauth.introspectToken,
  authorizeContext: oauth.authorizeContext,

  // An invited identity's first sign-in (domain/account-invitations.ts, AUTH-9).
  signInState: invitations.signInState,
  createInvitedAccount: invitations.createInvitedAccount,
  issueCode: oauth.issueCode,
  exchangeCode: oauth.exchangeCode,
  issueAppToken: oauth.issueAppToken,
  revokeToken: oauth.revokeToken,
  sweepOAuth: oauth.sweepOAuth,

  // The web UI: sessions of its own OAuth client, the user's authorizations, and the public pages.
  beginWebLogin: webSession.beginWebLogin,
  startWebSession: webSession.startWebSession,
  endWebSession: webSession.endWebSession,
  settingsView: webSession.settingsView,
  revokeAuthorization: webSession.revokeAuthorization,
  revokeOtherSessions: webSession.revokeOtherSessions,

  // The public pages (domain/web-pages/): one call a page, the site facts included.
  webSite: sitePages.webSite,
  webAbout: sitePages.webAbout,
  webDocument: sitePages.webDocument,
  webProfilePage: profilePages.webProfilePage,
  webFeaturedPage: featuredPages.webFeaturedPage,
  webFollowsPage: followPages.webFollowsPage,
  webTagPage: tagPages.webTagPage,
  webStatusPage: statusPages.webStatusPage,
  webInteractTarget: interactPages.webInteractTarget,
  embeddedStatus: statusPages.embeddedStatus,
  suspendAccount,
  instanceInfo,
  instanceUsage,
  refreshDomainCount,
  pruneActivity: instanceActivity.pruneActivity,
  instanceRules,

  // GET /api/v1/instance/{extended_description,privacy_policy,terms_of_service}: sanitized (domain/instance.ts).
  instanceDocument,

  // GET /api/v1/instance/domain_blocks (domain/instance-domain-blocks.ts).
  publicDomainBlocks: instanceDomainBlocks.publicDomainBlocks,
  instancePeers,
  searchPeers,
  getAccount: accounts.getAccount,
  lookupAccount: accounts.lookupAccount,
  verifyCredentials: accounts.verifyCredentials,
  userinfo: accounts.userinfo,
  updateCredentials: accountActions.updateCredentials,
  preferences: accounts.preferences,
  relationships: accounts.relationships,
  familiarFollowers: accounts.familiarFollowers,
  searchAccounts: accounts.searchAccounts,
  follow: accountActions.follow,
  unfollow: accountActions.unfollow,
  listFollowRequests: accounts.listFollowRequests,
  answerFollowRequest: accountActions.answerFollowRequest,
  listFollows: accounts.listFollows,

  // Accounts by id, private notes, endorsements and the removal of a follower (domain/accounts.ts,
  // domain/endorsements.ts, domain/blocks.ts).
  getAccounts: accounts.getAccounts,
  setNote: accounts.setNote,
  createReport: reports.createReport,

  // The Mastodon admin API's reports (domain/reports.ts, R37).
  adminReports: reports.listAdminReports,
  adminReport: reports.getAdminReport,
  updateAdminReport: reports.updateAdminReport,
  actOnReport: reports.actOnReport,

  // The Mastodon admin API's accounts (domain/admin-accounts.ts, R37).
  adminAccounts: listAdminAccounts,
  adminAccount: getAdminAccount,
  actOnAdminAccount,
  adminAccountAction: actOnAccount,
  unsuspendAdminAccount,

  // The Mastodon admin API's domain blocks, domain allows and metrics (domain/admin-domain-blocks.ts,
  // domain/admin-measures.ts).
  adminDomainBlocks: adminDomainBlocks.listAdminDomainBlocks,
  adminDomainBlock: adminDomainBlocks.getAdminDomainBlock,
  createAdminDomainBlock: adminDomainBlocks.createAdminDomainBlock,
  updateAdminDomainBlock: adminDomainBlocks.updateAdminDomainBlock,
  deleteAdminDomainBlock: adminDomainBlocks.deleteAdminDomainBlock,
  adminFederationGranted: adminDomainBlocks.federationGranted,
  adminDashboardGranted: adminDomainBlocks.dashboardGranted,
  adminMeasure,
  endorse: endorsements.endorse,
  unendorse: endorsements.unendorse,
  listEndorsements: endorsements.listEndorsements,
  accountEndorsements: endorsements.accountEndorsements,

  // The profile directory (domain/directory.ts).
  directory,

  // Follow suggestions and their dismissals (domain/suggestions.ts).
  suggestions: suggestions.suggestions,
  dismissSuggestion: suggestions.dismissSuggestion,
  removeFromFollowers: blocks.removeFromFollowers,

  // Blocks, mutes and domain blocks (domain/blocks.ts).
  block: blocks.block,
  unblock: blocks.unblock,
  mute: blocks.mute,
  unmute: blocks.unmute,
  listBlocks: blocks.listBlocks,
  listMutes: blocks.listMutes,
  listDomainBlocks: blocks.listDomainBlocks,
  blockDomain: blocks.blockDomain,
  unblockDomain: blocks.unblockDomain,
  previewDomainBlock: blocks.previewDomainBlock,

  // Filters (domain/filters.ts), v2 and the v1 layer over them.
  listFilters: filters.listFilters,
  getFilter: filters.getFilter,
  createFilter: filters.createFilter,
  updateFilter: filters.updateFilter,
  deleteFilter: filters.deleteFilter,
  listFilterKeywords: filters.listFilterKeywords,
  createFilterKeyword: filters.createFilterKeyword,
  getFilterKeyword: filters.getFilterKeyword,
  updateFilterKeyword: filters.updateFilterKeyword,
  deleteFilterKeyword: filters.deleteFilterKeyword,
  listFilterStatuses: filters.listFilterStatuses,
  createFilterStatus: filters.createFilterStatus,
  getFilterStatus: filters.getFilterStatus,
  deleteFilterStatus: filters.deleteFilterStatus,
  listFiltersV1: filters.listFiltersV1,
  getFilterV1: filters.getFilterV1,
  createFilterV1: filters.createFilterV1,
  updateFilterV1: filters.updateFilterV1,
  deleteFilterV1: filters.deleteFilterV1,

  // Lists (domain/lists.ts); their timeline is with the others.
  listLists: lists.listLists,
  getList: lists.getList,
  createList: lists.createList,
  updateList: lists.updateList,
  deleteList: lists.deleteList,
  listAccounts: lists.listAccounts,
  addListAccounts: lists.addListAccounts,
  removeListAccounts: lists.removeListAccounts,
  accountLists: lists.accountLists,

  // Conversations (domain/conversations.ts).
  listConversations: conversations.listConversations,
  markConversation: conversations.markConversation,
  deleteConversation: conversations.deleteConversation,

  // Timeline markers (domain/markers.ts).
  getMarkers: markers.getMarkers,
  saveMarkers: markers.saveMarkers,

  // Polls (domain/polls.ts).
  getPoll: polls.getPoll,
  vote: polls.vote,

  // The cron's round of polls (jobs/scheduled.ts): those that ended, and the Updates of counts that are due.
  pollRound: polls.pollRound,

  // Scheduled statuses (domain/scheduled-statuses.ts).
  postStatus: scheduled.postStatus,
  listScheduled: scheduled.listScheduled,
  getScheduled: scheduled.getScheduled,
  updateScheduled: scheduled.updateScheduled,
  deleteScheduled: scheduled.deleteScheduled,

  // Statuses, timelines and notifications.
  editStatus: statuses.editStatus,
  editTarget: statuses.editTarget,
  updateInteractionPolicy: statuses.updateInteractionPolicy,
  postTargets: statuses.postTargets,
  prepareRevoke: statuses.prepareRevoke,
  revokeQuote: statuses.revokeQuote,
  prepareDelete: statuses.prepareDelete,
  deleteStatus: statuses.deleteStatus,
  getStatus: statuses.getStatus,
  statusContext: statuses.statusContext,
  statusHistory: statuses.statusHistory,
  statusSource: statuses.statusSource,
  favourite: statuses.favourite,
  unfavourite: statuses.unfavourite,
  reblog: statuses.reblog,
  unreblog: statuses.unreblog,
  bookmark: statuses.bookmark,
  unbookmark: statuses.unbookmark,
  interactors: statuses.interactors,
  statusQuotes: statuses.statusQuotes,

  // Statuses by id, pins and conversation mutes (domain/statuses.ts, domain/status-actions.ts).
  getStatuses: statuses.getStatuses,
  pin: statusActions.pin,
  unpin: statusActions.unpin,
  muteConversation: statusActions.muteConversation,
  unmuteConversation: statusActions.unmuteConversation,
  homeTimeline: timelines.homeTimeline,
  listTimeline: timelines.listTimeline,
  publicTimeline: timelines.publicTimeline,
  tagTimeline: timelines.tagTimeline,
  linkTimeline: timelines.linkTimeline,

  // Hashtags (domain/tags.ts) and featured hashtags (domain/featured-tags.ts).
  tag: tags.getTag,
  followTag: tags.followTag,
  unfollowTag: tags.unfollowTag,
  featureTag: tags.featureTagOperation,
  unfeatureTag: tags.unfeatureTagOperation,
  followedTags: tags.followedTags,
  featuredTagSuggestions: tags.featuredTagSuggestions,
  listFeaturedTags: featuredTags.listFeaturedTags,
  createFeaturedTag: featuredTags.createFeaturedTag,
  deleteFeaturedTag: featuredTags.deleteFeaturedTag,
  accountFeaturedTags: featuredTags.accountFeaturedTags,
  accountStatuses: timelines.accountStatuses,
  bookmarksList: timelines.bookmarks,
  favouritesList: timelines.favourites,
  listNotifications: notifications.listNotifications,
  getNotification: notifications.getNotification,
  dismissNotification: notifications.dismissNotification,
  clearNotifications: notifications.clearNotifications,

  // Grouped notifications (API v2) and the unread counts.
  listGroupedNotifications: notificationGroups.listGroupedNotifications,
  getNotificationGroup: notificationGroups.getNotificationGroup,
  notificationGroupAccounts: notificationGroups.notificationGroupAccounts,
  dismissNotificationGroup: notificationGroups.dismissNotificationGroup,
  unreadNotificationCount: notificationGroups.unreadCount,
  unreadNotificationGroupCount: notificationGroups.unreadGroupCount,

  // The notification policy and notification requests.
  getNotificationPolicy: notificationRequests.getNotificationPolicy,
  updateNotificationPolicy: notificationRequests.updateNotificationPolicy,
  listNotificationRequests: notificationRequests.listNotificationRequests,
  getNotificationRequest: notificationRequests.getNotificationRequest,
  acceptNotificationRequest: notificationRequests.acceptNotificationRequest,
  dismissNotificationRequest: notificationRequests.dismissNotificationRequest,
  acceptNotificationRequests: notificationRequests.acceptNotificationRequests,
  dismissNotificationRequests: notificationRequests.dismissNotificationRequests,
  notificationRequestsMerged: notificationRequests.notificationRequestsMerged,

  // Web Push: the token's subscription, and the Worker's push rounds (jobs/push.ts).
  createPushSubscription: push.createPushSubscription,
  getPushSubscription: push.getPushSubscription,
  updatePushSubscription: push.updatePushSubscription,
  deletePushSubscription: push.deletePushSubscription,
  claimPushes: push.claimPushes,
  confirmPush: push.confirmPush,
  completePush: push.completePush,

  // Media.
  reserveMedia: media.reserveMedia,
  completeMedia: media.completeMedia,
  abandonMedia: media.abandonMedia,
  getMedia: media.getMedia,
  updateMedia: media.updateMedia,
  deleteMedia: media.deleteMedia,
  removeProfileImage: media.removeProfileImage,
  startTransforms: media.startTransforms,
  dueOrphans: media.dueOrphans,
  forgetOrphans: media.forgetOrphans,
  expiredMedia: media.expiredMedia,
  purgeMedia: media.purgeMedia,

  // The media rebuild (domain/media-rebuild.ts), from /admin/media/rebuild, its lease taken by the Store's own method
  // (mediaRebuildLease). Each runs at the Store's own time, never a
  // time the caller sends, so the lease and the fences that read it (store-admin.ts, store-flags.ts) share one clock.
  mediaRebuildCandidates: mediaRebuild.rebuildCandidates,
  mediaRebuildRowLive: mediaRebuild.rebuildRowLive,
  chargeMediaRebuild: mediaRebuild.chargeRebuild,
  recordMediaRebuild: mediaRebuild.recordRebuild,

  // Local custom emoji (domain/local-emojis.ts): the Access admin's writes from /admin/emojis, each at the Store's own
  // time, so the writer deadline is judged on one clock; the public list and the Emoji object.
  reserveEmoji: localEmojis.reserveEmoji,
  completeEmoji: localEmojis.completeEmoji,
  abandonEmoji: localEmojis.abandonEmoji,
  updateEmoji: localEmojis.updateEmoji,
  adminEmojis: localEmojis.adminEmojis,
  customEmojis: localEmojis.customEmojis,

  // Announcements (domain/announcements.ts): the signed-in user's list, dismissals and reactions; the Access admin's
  // writes from /admin/announcements, each at the Store's own time, and its list; the cron's round.
  listAnnouncements: announcements.listAnnouncements,
  dismissAnnouncement: announcements.dismissAnnouncement,
  reactToAnnouncement: announcements.reactToAnnouncement,
  unreactToAnnouncement: announcements.unreactToAnnouncement,
  createAnnouncement: announcements.createAnnouncement,
  updateAnnouncement: announcements.updateAnnouncement,
  publishAnnouncement: announcements.publishAnnouncement,
  unpublishAnnouncement: announcements.unpublishAnnouncement,
  deleteAnnouncement: announcements.deleteAnnouncement,
  adminAnnouncements: announcements.adminAnnouncements,
  announcementRound: announcements.announcementRound,

  // Trends (domain/trends.ts): the public lists, and the cron's round.
  trendingTags: trends.trendingTags,
  trendingStatuses: trends.trendingStatuses,
  trendingLinks: trends.trendingLinks,

  // The Access admin's lists and reviews from /admin/trends, each at the Store's own time.
  adminTrendTags: trends.adminTrendTags,
  adminTrendStatuses: trends.adminTrendStatuses,
  reviewTrendTag: trends.reviewTrendTag,
  reviewTrendStatus: trends.reviewTrendStatus,
  adminTrendLinks: trends.adminTrendLinks,
  adminTrendPublishers: trends.adminTrendPublishers,
  reviewTrendLink: trends.reviewTrendLink,
  reviewTrendPublisher: trends.reviewTrendPublisher,
  trendsRound: trends.trendsRound,

  // Search.
  search,

  // Search with resolve=true: stores what the Worker fetched, as inbound activities are stored.
  resolveSearch,

  // /authorize_interaction: the look-up stores what the Worker fetched as search resolution does and shows
  // it as an anonymous viewer would; the follow goes through the follow service.
  resolveInteraction: interaction.resolveInteraction,
  webFollow: interaction.webFollow,

  // Delivery: claims, confirmations and completions from the Worker's delivery round, the operator's view, and
  // the sweep.
  claimDeliveries: deliveries.claimDeliveries,
  confirmDelivery: deliveries.confirmDelivery,
  completeDelivery: deliveries.completeDelivery,
  deliveriesReport: deliveries.deliveriesReport,
  retryDeliveries: deliveries.retryDeliveries,
  sweepDeliveries: deliveries.sweepDeliveries,

  // Local objects over ActivityPub (VIS-4).
  localNote: localNotes.getLocalNote,
  legacyObject: activities.getLegacyObject,
  outbox: localNotes.getOutbox,
  featured: localNotes.getFeatured,
} satisfies Record<string, StoreOperation<never, unknown>>;

type Registry = typeof STORE_RPC;

type RpcMethod<Op extends StoreOperation<never, unknown>> = [OperationInput<Op>] extends [undefined | void]
  ? (callerBuild: string) => Promise<ReturnType<Op["run"]>>
  : (callerBuild: string, input: OperationInput<Op>) => Promise<ReturnType<Op["run"]>>;

// The methods STORE_RPC defines on the Store (merged into its class, store.ts).
export type StoreRpc = { [K in keyof Registry]: RpcMethod<Registry[K]> };

// Defines one method on `prototype` for each entry of `registry`, named as the entry (the RPC name, which Durable
// Object RPC and stack traces show), that calls `run` with the object it is called on. Throws when a name is already
// a method of the prototype or of what it inherits, so a registry entry never shadows a hand-written method or is
// shadowed by one.
export function defineRpc<T extends object>(
  prototype: T,
  registry: Readonly<Record<string, StoreOperation<never, unknown>>>,
  run: (self: T, operation: StoreOperation<never, unknown>, callerBuild: string, input: unknown) => Promise<unknown>,
): void {
  for (const [name, operation] of Object.entries(registry)) {
    if (name in prototype) {
      throw new Error(`Store RPC ${name} is both a registry entry and a method`);
    }
    const method = {
      [name](this: T, callerBuild: string, input?: unknown) {
        return run(this, operation, callerBuild, input);
      },
    }[name];
    // As a class body defines a method: not enumerable.
    Object.defineProperty(prototype, name, { value: method, writable: true, configurable: true });
  }
}
