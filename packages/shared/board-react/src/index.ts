// @boardsesh/board-react — renderer-agnostic React for board data (logbook,
// ticks, climb create/update).
//
// React hooks shared by web and mobile. Pure React only: hooks over React
// Query, no react-dom, no next, no DOM globals, no MUI (web); no react-native
// host components, no Expo APIs (mobile). All platform I/O (GraphQL clients,
// auth state, draft storage, error reporting, cache invalidation) is injected
// via the per-hook `*Deps` seams. `react` and `@tanstack/react-query` are
// peerDependencies.

export {
  // types
  type TickStatus,
  type LogbookEntry,
  type LogbookSourceTick,
  type SaveTickOptions,
  type SaveClimbOptions,
  type SaveClimbResponse,
  type UpdateClimbResponse,
  // pure transforms
  toLogbookEntry,
  mergeLogbookEntries,
  accumulatedLogbookQueryKey,
  fetchLogbookQueryKeyPrefix,
  fetchLogbookQueryKey,
  logbookQueryKey,
  nextTempUuid,
  buildOptimisticTickEntry,
  applySavedTickToLogbook,
  rollbackOptimisticTick,
  toSaveClimbInput,
  isDuplicateClimbError,
} from './transforms';

export type { GraphQLRequestFn, LogbookDeps, SaveTickDeps, SaveClimbDeps, UpdateClimbDeps } from './types';

export { useLogbook, useInvalidateLogbook } from './use-logbook';
export { useSaveTick } from './use-save-tick';
export { useSaveClimb, useUpdateClimb } from './use-save-climb';
