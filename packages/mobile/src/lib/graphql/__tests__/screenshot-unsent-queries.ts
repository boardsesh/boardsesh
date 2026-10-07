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
  'BoardseshGrade',
  'BoardseshGradesForAngles',
  'BrowseProposals',
  'ClimbStatsHistory',
  'ConfirmSprayWallVisibility',
  'GetActivityFeed',
  'GetAngles',
  'GetBetaLinks',
  'GetBoardBySlug',
  'GetBoardsBySerialNumbers',
  'GetClimbLogs',
  'GetClimbLostHolds',
  'GetClimbProposals',
  'GetClimbRevisions',
  'GetComments',
  'GetCrewFeed',
  'GetDeleteAccountInfo',
  'GetFollowers',
  'GetFollowing',
  'GetFollowingClimbAscents',
  'GetGroupedNotifications',
  'GetGym',
  'GetGymMembers',
  'GetMyBoardSerialConfigs',
  'GetMyGyms',
  'GetMyRoles',
  'GetMySprayWalls',
  'GetNearbySessions',
  'GetNotificationActors',
  'GetPlaylist',
  'GetPlaylistClimbs',
  'GetPlaylistsForClimb',
  'GetPlaylistsForClimbs',
  'GetPopularBoardConfigs',
  'GetSessionHealthExport',
  'GetSprayWall',
  'GetSprayWallArt',
  'GetSprayWallByLayout',
  'GetSprayWallDraftRenderData',
  'GetSprayWallForLink',
  'GetSprayWallLook',
  'GetSprayWallRenderData',
  'GetSprayWallReports',
  'GetSprayWallWithVersions',
  'GetUserAscentCaptionMatches',
  'GetUserAscentsFeed',
  'GetUserClimbs',
  'GetUserDataExport',
  'GetUserDataExportDownload',
  'HoldHeatmap',
  'HoldOutlines',
  'ProposeSprayWallReset',
  'QaPreviews',
  'SavedClimbDocuments',
  'SearchBoards',
  'SearchClimbsCount',
  'SearchGyms',
  'SearchUsers',
  'SimilarClimbs',
  'SprayDetection',
  'SyncClimbGrades',
  'SyncClimbStats',
  'SyncClimbs',
  'SyncSprayWalls',
];
