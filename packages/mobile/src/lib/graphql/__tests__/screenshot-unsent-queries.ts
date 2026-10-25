/**
 * Queries no screen in the capture flows (`packages/mobile/.maestro`) sends, so
 * the pinned fixture set does not need to answer them.
 *
 * The drift test (`screenshot-fixture-drift.test.ts`) requires every query the
 * app can send to be recorded, to have a replay default, or to be listed here.
 * A new query fails that test until its author picks one, which is the point:
 * a query added to a captured screen otherwise breaks every replay capture and
 * nobody finds out until a simulator runs days later.
 *
 * Before adding a name, check that no captured screen mounts the hook that
 * sends it. A query behind a tap the flows never make, a sheet they never
 * open, or the play view's deferred sections belongs here. A query a captured
 * screen sends on mount does not: record it, or give it a replay default.
 *
 * The starting list is every query that was neither recorded nor missed by the
 * last full replay captures (Android run 37258958437, iOS run 37200023911).
 * Kept sorted; the drift test fails on an entry that became recorded or that
 * the app stopped sending.
 */
export const QUERIES_NO_CAPTURE_SENDS: readonly string[] = [
  'BetaLinkPreview',
  'BoardClimbRecentSenders',
  'BoardConnection',
  'BoardHistory',
  'BoardHistoryPage',
  'BoardPresenceStats',
  'BoardRecentClimbs',
  'BoardRecentHistory',
  // The owner's invite link: only the Share sheet of a Followers or Invite-only board asks.
  'BoardShareLink',
  'BoardShareLinkPreview', // Only incoming invite links; screenshot flows do not open one.
  'BoardseshGrade',
  'BoardseshGradesForAngles',
  'BrowseProposals',
  'ClimbStatsHistory',
  'ConfirmSprayWallVisibility',
  'ContentAudience',
  'GetActivityFeed',
  'GetAngles',
  'GetBetaLinks',
  'GetBoardBySlug',
  'GetBoardsBySerialNumbers',
  'GetClimbLogs',
  'GetClimbLostHolds',
  'GetClimbProposals',
  'GetComments',
  // Screenshot mode skips the consent gate, so the region is never asked.
  'GetConsentRegion',
  'GetCrewFeed',
  'GetDeleteAccountInfo',
  'GetFollowers',
  'GetFollowing',
  'GetFollowingClimbAscents',
  'GetGroupedNotifications',
  'GetGym',
  'GetGymMembers',
  // ConsentGate skips account privacy synchronization in screenshot mode.
  'GetMyAnalyticsConsent',
  'GetMyBoardSerialConfigs',
  'GetMyGyms',
  'GetMyRoles',
  'GetMySprayWallLifecycle',
  'GetMySprayWalls',
  'GetNearbySessions',
  'GetNotificationActors',
  'GetNotifications',
  'GetPlaylist',
  'GetPlaylistClimbs',
  // A playlist's or smart list's setter picker (#6651): only a tap inside its filter sheet asks.
  'GetPlaylistSetters',
  'GetPlaylistsForClimb',
  'GetPlaylistsForClimbs',
  'GetPopularBoardConfigs',
  // Home's Fresh beta shelf (#6289), off by default; captures shoot the default Home.
  'GetRecentBetaLinks',
  'GetSessionHealthExport',
  // F3 resync (#6666): only in now-slot mode. Screenshot mode runs no PostHog and pins no env value for queue-now-slot.
  'GetSessionQueueStateNowSlot',
  'GetSprayWallArchive',
  'GetSprayWallArt',
  'GetSprayWallByLayout',
  'GetSprayWallDraftRenderData',
  'GetSprayWallForLink',
  'GetSprayWallHoldUsage',
  'GetSprayWallLook',
  'GetSprayWallRenderData',
  'GetSprayWallReports',
  'GetSprayWallTrainingConsent',
  'GetSprayWallWithVersions',
  'GetUserAscentCaptionMatches',
  'GetUserAscentsFeed',
  'GetUserClimbs',
  'GetUserDataExport',
  'GetUserDataExportDownload',
  // The Logbook setter picker; no capture flow opens it.
  'GetUserLoggedSetters',
  // Scoped offline registration only; mobile library/picker use GetAllUserPlaylists.
  'GetUserPlaylists',
  'HoldHeatmap',
  'HoldOutlines',
  'IncomingFollowRequests',
  // Captures use a dev client: expo-updates is disabled, so no rollout lookup runs.
  'MobileReleaseStatus',
  'PrivacyRelationship',
  'ProfilePrivacy',
  'ProposalReportReleaseContexts', // Only expanded report reasons for scoped admins.
  'QaPreviews',
  // F3 server probe (#6666): runs only with queue-now-slot on. Screenshot mode runs no PostHog and pins no env value for it.
  'QueueStateFieldsProbe',
  'ResourceAccessRequests',
  'ResourcePrivacy',
  'SavedClimbDocuments',
  'SearchBoards',
  'SearchClimbsCount',
  'SearchGyms',
  'SearchUsers',
  'SimilarClimbs',
  'SprayDetection',
  'SprayWallImportProgress',
  'SyncClimbGrades',
  'SyncClimbGradesSnapshotSupplement',
  'SyncClimbStats',
  'SyncClimbStatsSnapshotSupplement',
  'SyncClimbs',
  'SyncClimbsSnapshotSupplement',
  'SyncSprayWalls',
  // Capture flows never open the nested board picker in the logbook edit sheet.
  'TickBoardOptions',
];
