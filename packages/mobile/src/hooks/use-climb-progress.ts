import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { logbookClimbAngleKey, useOptionalBoardActions, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { isTickOnCurrentHolds } from '@boardsesh/logbook';
import { tickTimeMs } from '@boardsesh/profile-stats';
import type { BoardName } from '@boardsesh/shared-schema';
import { useClimbProgressStore } from '../lib/climb-progress-context';
import { climbProgressKey, NO_CLIMB_PROGRESS_ENTRIES } from '../lib/climb-progress-store';
import { deriveClimbProgress } from '../lib/climb-progress';

const noSubscription = () => () => {};

/** Isolated personal leaf: indexed lookup, with holds filtering before derivation. */
export function useClimbProgress(
  boardName: BoardName,
  climbUuid: string,
  angle: number,
  holdsRevisionNumber?: number | null,
) {
  const store = useClimbProgressStore();
  const key = climbProgressKey(boardName, climbUuid, angle);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(key, listener) ?? noSubscription(),
    [store, key],
  );
  const snapshot = useCallback(() => store?.getSnapshot(key) ?? NO_CLIMB_PROGRESS_ENTRIES, [store, key]);
  const scopedEntries = useSyncExternalStore(subscribe, snapshot, snapshot);
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
