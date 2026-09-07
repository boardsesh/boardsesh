// Shared React runtime for BoardProvider + logbook/tick/climb hooks.
// Platform-agnostic React: uses `useState`, `useEffect`, `createContext`,
// `@tanstack/react-query`. No DOM, no React Native, no `next/*`, no `expo-*`.
// Platform-specific behaviour (auth state, GraphQL transport, session-id
// source, side-effects, error UI) is supplied by `BoardAdapter` —
// each app mounts a `BoardAdapterProvider` once near the root.

export type {
  BoardAdapter,
  BoardErrorReason,
  ExecuteHttp,
  ExecuteWs,
  ClimbStatsSubscriptionHandlers,
  OfflineMutationDelivery,
} from './adapter';
export { BoardAdapterProvider, useBoardAdapter } from './adapter';

export {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  fetchedLogbookClimbUuidsQueryKey,
  logbookQueryKey,
  logbookClimbAngleKey,
} from './logbook-keys';
export type { LogbookEntry, LogbookSourceTick, TickStatus } from './logbook-keys';

export { buildOptimisticTickEntry, applySavedTickToLogbook, rollbackOptimisticTick } from './tick-helpers';
export type { SaveTickOptions } from './tick-helpers';

export { toSaveClimbInput, isDuplicateClimbError } from './climb-helpers';
export type { SaveClimbOptions, SaveClimbResponse, UpdateClimbResponse } from './climb-helpers';

export { useLogbook, useInvalidateLogbook } from './use-logbook';
export { useSaveTick } from './use-save-tick';
export { useEffectiveClimbStats } from './use-effective-climb-stats';
export type { EffectiveClimbStats, EffectiveClimbStatsBase } from './use-effective-climb-stats';
export {
  applyCanonicalClimbStats,
  getClimbStatsSnapshot,
  beginOptimisticAscent,
  acknowledgeOptimisticAscent,
  rejectOptimisticAscent,
  markOptimisticAscentQueued,
  retireAcknowledgedOptimisticAscents,
  settleOfflineTickAscent,
  setClimbStatsAuthEpoch,
} from './climb-stats-store';
export type {
  ClimbStatsKey,
  ClimbStatsSnapshot,
  CanonicalClimbStats,
  SettledOfflineTickAscent,
} from './climb-stats-store';
export { useUpdateTick, useDeleteTick } from './use-mutate-tick';
export { useSaveClimb, useUpdateClimb } from './use-save-climb';

export {
  BoardProvider,
  useBoardProvider,
  useOptionalBoardProvider,
  useBoardActions,
  useOptionalBoardActions,
  useBoardLogbook,
  useOptionalBoardLogbook,
  BoardContext,
} from './board-provider';
export type { BoardContextType, BoardActionsContextType, BoardLogbookContextType } from './board-provider';
