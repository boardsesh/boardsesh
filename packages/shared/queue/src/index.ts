// Pure queue state machine — no React, no DOM, works in any JS runtime.
// React-specific wrappers (useQueueReducer) and web-specific types
// (QueueContextType, QueueDataType, QueueActionsType) stay in the web app.

export { queueReducer, initialState } from './reducer';

export { fnv1aHash, computeQueueStateHash, computeQueueStateHashOrdered } from './state-hash';

export type {
  QueueState,
  QueueAction,
  QueueSearchParams,
  ClimbQueue,
  PlaylistSuggestionSource,
  SetCurrentClimbOptions,
  AddToQueueSource,
  PeerId,
  UserName,
} from './types';

// Queue-local type definitions (wide enough for both web and shared-schema consumers)
export type { Climb, ClimbQueueItem, QueueItemUser, ClimbRegradePatch } from './types';

export {
  insertQueueItemIdempotent,
  evaluateQueueEventSequence,
  stripPrivateClimbFields,
  PRIVATE_CLIMB_FIELDS,
} from './event-utils';
export type { QueueSequenceDecision } from './event-utils';

export {
  mergeUniquePlaylistClimbs,
  playlistSuggestionSourceMatches,
  getPlaylistSuggestedClimbs,
  pruneSuggestedQueueItemsAfterCurrent,
  insertQueueItemAfterCurrent,
  getPlaylistPeekQueueItemUuid,
  isPlaylistPeekQueueItemUuid,
  getQueueBoardKey,
  createPlaylistSuggestionSource,
} from './playlist-suggestions';
export type { QueueBoardKeyTarget } from './playlist-suggestions';

// Cross-board queue decisions (board-model identity + the add/confirm call).
// The compatibility classifier is injected so this package stays dependency-free.
export { configKey, climbConfigKey, deriveAcceptedConfigs, decideAdd } from './cross-board';
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
