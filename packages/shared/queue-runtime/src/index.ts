// Transport-wiring helpers for the queue state machine. Pure TS — no React,
// no DOM, no React Native. The state machine itself lives in
// `@boardsesh/queue`; this package only handles the wire protocol and the
// orchestration patterns that web and mobile would otherwise duplicate.

export { mapSubscriptionEnvelopeToAction } from './subscription-adapter';
export type { SubscriptionWireEnvelope, MapEnvelopeOptions } from './subscription-adapter';

export { createSetCurrentClimbCoalescer } from './set-current-climb-coalescer';
export type {
  SetCurrentClimbArgs,
  SetCurrentClimbCoalescer,
  SetCurrentClimbCoalescerOptions,
} from './set-current-climb-coalescer';

export { createJoinSessionTracker } from './ensure-joined';
export type { JoinSessionTracker, JoinSessionTrackerOptions } from './ensure-joined';

export { deriveIsDriver, derivePreviewOnly, deriveSessionWallConnected, deriveIsWallWriter } from './driver-state';

export { applySessionRuntimeEvent, upsertRuntimeSessionUser } from './session-events';
export type {
  ApplySessionRuntimeEventOptions,
  RuntimeSessionEvent,
  RuntimeSessionState,
  RuntimeSessionUser,
} from './session-events';

export {
  createReleaseControlOptimisticPlan,
  createTakeControlOptimisticPlan,
  deriveTakeControlPlaylistSuggestionSource,
  shouldRollbackReleaseControlDriver,
  shouldRollbackTakeControlDriver,
  shouldRollbackTakeControlQueue,
  shouldSurfaceReleaseControlFailure,
} from './wall-control-optimistic';
export type { ReleaseControlOptimisticPlan, TakeControlOptimisticPlan } from './wall-control-optimistic';
