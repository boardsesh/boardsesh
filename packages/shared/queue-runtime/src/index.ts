// Transport-wiring helpers for the queue state machine. Pure TS — no React,
// no DOM, no React Native. The state machine itself lives in
// `@boardsesh/queue`; this package only handles the wire protocol and the
// orchestration patterns that web and mobile would otherwise duplicate.

export { mapSubscriptionEnvelopeToAction } from './subscription-adapter';
export type {
  SubscriptionWireEnvelope,
  MapEnvelopeOptions,
  SubscriptionEventMappingResult,
} from './subscription-adapter';

export { createSetCurrentClimbCoalescer } from './set-current-climb-coalescer';
export type {
  SetCurrentClimbArgs,
  SetCurrentClimbCoalescer,
  SetCurrentClimbCoalescerOptions,
} from './set-current-climb-coalescer';

export { createJoinSessionTracker } from './ensure-joined';
export type { JoinSessionTracker, JoinSessionTrackerOptions } from './ensure-joined';

export { createSessionConnectionController } from './session-connection';
export type {
  SessionConnectionClient,
  SessionConnectionController,
  SessionConnectionDeps,
  SessionConnectionFatalReason,
  SessionConnectionGate,
  SessionConnectionRecoveryEventKind,
  SessionConnectionReplayResult,
  SessionConnectionRetryPolicy,
  SessionConnectionSessionData,
  SessionConnectionSink,
  SessionConnectionTimerHandle,
} from './session-connection';

export {
  dedupeSessionUsers,
  countDistinctSessionUsers,
  countConnectedSessionPeers,
  countSessionPeers,
} from './session-roster';
export type { SessionSelfIdentity, SessionPeerCounts } from './session-roster';

export { applySessionRuntimeEvent, upsertRuntimeSessionUser } from './session-events';
export type {
  ApplySessionRuntimeEventOptions,
  RuntimeSessionEvent,
  RuntimeSessionState,
  RuntimeSessionUser,
} from './session-events';

export {
  createQueueSyncGate,
  hasContiguousReplayCoverage,
  RESYNC_LOOP_THRESHOLD,
  CORRUPTION_RESYNC_COOLDOWN_MS,
} from './sync-gate';
export type {
  QueueSyncGate,
  QueueSyncGateOptions,
  QueueSyncGateEvent,
  IncomingEventDecision,
  HashVerifyVerdict,
  HashVerifyResult,
  CorruptionVerdict,
  ReconnectStrategy,
  ReconnectStrategyInput,
} from './sync-gate';
