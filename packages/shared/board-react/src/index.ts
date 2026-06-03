// Shared React runtime for BoardProvider + logbook/tick/climb hooks.
// Platform-agnostic React: uses `useState`, `useEffect`, `createContext`,
// `@tanstack/react-query`. No DOM, no React Native, no `next/*`, no `expo-*`.
// Platform-specific behaviour (auth state, GraphQL transport, session-id
// source, side-effects, error UI) is supplied by `BoardAdapter` —
// each app mounts a `BoardAdapterProvider` once near the root.

export type { BoardAdapter, BoardErrorReason, ExecuteHttp, ExecuteWs } from './adapter';
export { BoardAdapterProvider, useBoardAdapter } from './adapter';

export {
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  logbookQueryKey,
} from './logbook-keys';
export type { LogbookEntry, LogbookSourceTick, TickStatus } from './logbook-keys';

export { buildOptimisticTickEntry, applySavedTickToLogbook, rollbackOptimisticTick } from './tick-helpers';
export type { SaveTickOptions } from './tick-helpers';

export { toSaveClimbInput, toSaveMoonBoardClimbInput, isDuplicateClimbError } from './climb-helpers';
export type {
  SaveClimbOptions,
  SaveClimbResponse,
  SaveMoonBoardClimbOptions,
  UpdateClimbResponse,
} from './climb-helpers';

export { useLogbook, useInvalidateLogbook } from './use-logbook';
export { useSaveTick } from './use-save-tick';
export { useUpdateTick, useDeleteTick } from './use-mutate-tick';
export { useSaveClimb, useSaveMoonBoardClimb, useUpdateClimb } from './use-save-climb';

export { BoardProvider, useBoardProvider, useOptionalBoardProvider, BoardContext } from './board-provider';
export type { BoardContextType } from './board-provider';
