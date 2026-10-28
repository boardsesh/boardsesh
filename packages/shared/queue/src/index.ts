// Pure queue state machine — no React, no DOM, works in any JS runtime.
// React-specific wrappers (useQueueReducer) and web-specific types
// (QueueContextType, QueueDataType, QueueActionsType) stay in the web app.

export { queueReducer, initialState, heldHistoryCount } from './reducer';

export { fnv1aHash, computeQueueStateHash, computeQueueStateHashOrdered } from './state-hash';

export type {
  QueueState,
  HeldHistoryLine,
  QueueAction,
  UnconfirmedQueueMove,
  QueueSearchParams,
  QueueClimbReadTarget,
  ClimbQueue,
  PlaylistSuggestionSource,
  PlaylistTrackContinuation,
  PlaylistTrackResume,
  PlaylistTrackPage,
  SetCurrentClimbOptions,
  SetCurrentClimbTrigger,
  AddToQueueSource,
  PeerId,
  UserName,
} from './types';

// Queue-local type definitions (wide enough for both web and shared-schema consumers)
export type { Climb, ClimbQueueItem, QueueItemUser, ClimbRegradePatch, ClimbAuthoredPatch } from './types';

export { MAX_SYNCED_QUEUE_ITEMS, clampQueueWindow, clampQueueAroundCurrent } from './limits';

// The Now slot (F3, #6666): the History / Now / Up next line in the flat queue
// and the one rule for putting a climb on the wall. Shared by the backend
// resolvers and the reducer. See docs/current-climb-outside-queue.md.
export {
  HISTORY_TRIM_AT,
  HISTORY_KEEP_COUNT,
  QUEUE_FULL,
  historyLine,
  upNextStart,
  historyOf,
  upNextOf,
  historyAndUpNextCount,
  isUpNextFull,
  isSameWallClimb,
  normaliseOrphanCurrent,
  placeOnWall,
  historyCopyRuleFor,
  capHistory,
  clampNowSlotPayload,
  lineAfterDelta,
  reorderAcrossLine,
  clampInsertPosition,
  normaliseHistoryCount,
  chooseQueueEvent,
} from './now-slot';
export type {
  NowSlotClimb,
  NowSlotQueueItem,
  NowSlotState,
  NowSlotResolvedState,
  CurrentClimbPlacement,
  NowSlotRewrite,
  NowSlotPlacement,
  HistoryCopyRule,
  CappedHistory,
  QueueLineDelta,
  ReorderAcrossLine,
  NowSlotRequest,
  NowSlotQueueEvent,
} from './now-slot';

export {
  insertQueueItemIdempotent,
  evaluateQueueEventSequence,
  stripPrivateClimbFields,
  PRIVATE_CLIMB_FIELDS,
} from './event-utils';
export type { QueueSequenceDecision } from './event-utils';

// "Play next" placement maths — where a climb lands when it jumps the line.
export { planPlayNext, playNextInsertPosition } from './play-next';
export type { PlayNextPlan, PlayNextTarget, QueueAddPlacement } from './play-next';

export {
  mergeUniquePlaylistClimbs,
  playlistSuggestionSourceMatches,
  getPlaylistSuggestedClimbs,
  pruneSuggestedQueueItemsAfterCurrent,
  getPlaylistPeekQueueItemUuid,
  isPlaylistPeekQueueItemUuid,
  getQueueBoardKey,
  createPlaylistSuggestionSource,
  reanchorPlaylistSuggestionSource,
  preparePlaylistClimbs,
  findPlaylistClimbIndex,
  appendPlaylistTrackPage,
  withPlaylistTrackClimbs,
  withPlaylistTrackResume,
  withPlaylistTrackPlace,
  samePlaylistTrackResume,
} from './playlist-suggestions';
export type { QueueBoardKeyTarget, PreparedPlaylistClimbs } from './playlist-suggestions';

// Cross-board queue decisions (board-model identity + the add/confirm call).
// The compatibility classifier is injected so this package stays dependency-free.
export { configKey, climbConfigKey, deriveAcceptedConfigs, decideAdd, isClimbOnReachableBoard } from './cross-board';
export type {
  QueueBoardIdentity,
  ClimbBoardIdentityLike,
  ClimbBoardCompatibility,
  AddDecision,
  DecideAddInput,
} from './cross-board';

export {
  createQueueSyncCoordinator,
  mapQueueEventToAction,
  generateClientId,
  generateCorrelationId,
  DEFAULT_PENDING_TTL_MS,
} from './sync-coordinator';
export type {
  SyncQueueEvent,
  MapEventContext,
  EventMappingResult,
  SyncCoordinator,
  SyncCoordinatorOptions,
  ScheduleCleanupFn,
} from './sync-coordinator';
