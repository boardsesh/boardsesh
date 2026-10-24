import { useMemo } from 'react';
import { logbookClimbAngleKey, useOptionalBoardActions, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { isTickOnCurrentHolds } from '@boardsesh/logbook';
import { tickTimeMs } from '@boardsesh/profile-stats';
import type { BoardName } from '@boardsesh/shared-schema';
import { deriveClimbProgress } from '../lib/climb-progress';
import { useClimbProgressEntries } from './use-climb-progress-entries';

/** Isolated personal leaf: indexed lookup, with holds filtering before derivation. */
export function useClimbProgress(
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  holdsRevisionNumber?: number | null,
) {
  const scopedEntries = useClimbProgressEntries(boardName, climbUuid, angle);
  return useMemo(
    () => deriveProgressOnCurrentHolds(scopedEntries, holdsRevisionNumber),
    [scopedEntries, holdsRevisionNumber],
  );
}

/** Board-provider fallback is used only outside a list scope, and only on its board. */
export function useBoardClimbProgress(
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  holdsRevisionNumber?: number | null,
) {
  const actions = useOptionalBoardActions();
  const logbook = useOptionalBoardLogbook();
  const entries =
    actions?.boardName === boardName && actions.isAuthenticated
      ? logbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle))
      : undefined;
  return useMemo(() => deriveProgressOnCurrentHolds(entries, holdsRevisionNumber), [entries, holdsRevisionNumber]);
}

function deriveProgressOnCurrentHolds(
  entries: readonly import('@boardsesh/board-react').LogbookEntry[] | undefined,
  holdsRevisionNumber?: number | null,
) {
  return deriveClimbProgress(
    entries?.filter((entry) => isTickOnCurrentHolds(entry.climb_revision, holdsRevisionNumber)),
    tickTimeMs,
  );
}
