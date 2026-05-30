// Pure queue state machine — no React, no DOM, works in any JS runtime.
// React-specific wrappers (useQueueReducer) and web-specific types
// (QueueContextType, QueueDataType, QueueActionsType) stay in the web app.

export { queueReducer, initialState } from './reducer';

export { fnv1aHash, computeQueueStateHash } from './state-hash';

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
export type { Climb, ClimbQueueItem, QueueItemUser } from './types';

export { insertQueueItemIdempotent, evaluateQueueEventSequence } from './event-utils';
export type { QueueSequenceDecision } from './event-utils';

export {
  mergeUniquePlaylistClimbs,
  playlistSuggestionSourceMatches,
  getPlaylistSuggestedClimbs,
  pruneSuggestedQueueItemsAfterCurrent,
  insertQueueItemAfterCurrent,
  getPlaylistPeekQueueItemUuid,
  isPlaylistPeekQueueItemUuid,
} from './playlist-suggestions';

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
