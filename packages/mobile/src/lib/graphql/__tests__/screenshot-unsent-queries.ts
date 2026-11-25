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
  // Only the explicit /bug-reports/[id] destination; capture flows never open a support conversation.
  'AppBugReport',
  'AppBugReportMessages',
  'AppWorkout', // Only explicit /w launch links; capture flows never open a partner workout.
  'BetaLinkPreview',
  'BoardClimbRecentSenders',
  'BoardHistory',
  'BoardHistoryPage',
  // Pinned wall feeds contain no Aurora imports; the grade hook stays disabled.
  // screenshot-fixture-drift.test.ts guards that evidence before allowing this exemption.
  'BoardPresenceClimbGrades',
  // The owner's invite link: only the Share sheet of a Followers or Invite-only board asks.
  'BoardShareLink',
  'BoardShareLinkPreview', // Only incoming invite links; screenshot flows do not open one.
  'BoardseshGrade',
  'BoardseshGradesForAngles',
  'BrowseProposals',
  'ClimbStatsHistory',
  'ConfirmSprayWallVisibility',
  'ContentAudience',
  // The add-a-board wizard's gym steps (#8151): behind add-board-wizard, which capture flows don't open.
  'ExistingWallCandidates',
  // The add-a-board wizard's Add your gym step (/boards/add/new-gym): no capture flow adds a gym.
  'FindSimilarGyms',
  'GetActivityFeed',
  'GetAngles',
  'GetBetaLinks',
  'GetBoardBySlug',
  // Report a problem: only the report review sheet asks, behind a report notification or a menu row.
  'GetBoardReports',
  'GetBoardsBySerialNumbers',
  'GetClimbLogs',
  'GetClimbLostHolds',
  'GetClimbProposals',
  'GetComments',
  // Screenshot mode skips the consent gate, so the region is never asked.
  'GetConsentRegion',
  'GetDeleteAccountInfo',
  'GetFollowers',
  'GetFollowing',
  'GetGroupedNotifications',
  'GetGym',
  // The gym page: only a pasted gym link asks by slug, and no capture flow opens the page.
  'GetGymBySlug',
  'GetGymMembers',
  'GetGymPendingClaim',
  // ConsentGate skips account privacy synchronization in screenshot mode.
  'GetMyAnalyticsConsent',
  'GetMyBoardSerialConfigs',
  'GetMyConnectedApps', // Only Settings › Connected apps; no capture flow opens it.
  'GetMyGyms',
  'GetMyRoles',
  'GetMySprayWallLifecycle',
  'GetMySprayWalls',
  'GetNearbySessions',
  'GetNotificationActors',
  'GetNotifications',
  // Only a real BLE scan sends observed identities; capture flows do not scan.
  'GetObservedBoardSerialMatches',
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
  // Spray-only detail; the recorded capture flows use catalogue boards.
  'GetSprayClimb',
  'GetSprayWallDraftRenderData',
  'GetSprayWallForLink',
  // Only saving hold removals asks; capture flows never save changes to a live wall.
  'GetSprayWallHoldUsageSummary',
  'GetSprayWallLedSetup',
  'GetSprayWallReports',
  // Recorded picker/summary boards are catalogue boards. Feed spray thumbnails use the climb renderer.
  'GetSprayWallThumbnail',
  'GetSprayWallTrainingConsent',
  'GetSprayWallWithVersions',
  'GetUserAscentCaptionMatches',
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
  'MyAppBugReports', // Only the user drawer's /bug-reports destination; no capture flow opens it.
  'PrivacyRelationship',
  'ProfilePrivacy',
  'ProposalReportReleaseContexts', // Only expanded report reasons for scoped admins.
  'QaPreviews',
  // Only explicit partner history links open this route; captures never visit it.
  'ResolvePartnerSessionHistory',
  'ResourceAccessRequests',
  'ResourcePrivacy',
  'SavedClimbDocuments',
  'SearchBoards',
  'SearchClimbsCount',
  'SearchGyms',
  // Town suggestions under a gym search field (/gyms, the add-a-board gym step): only sent
  // once 3+ characters are typed there, and no capture flow types into a gym search.
  'SearchPlaces',
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
