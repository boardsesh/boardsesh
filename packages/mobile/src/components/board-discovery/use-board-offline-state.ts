// "Is this board on my phone?", as a per-board lookup a carousel can call.
//
// Derived from the syncEnabledBoards setting plus the downloaded checkpoints,
// NOT from useSyncStatus(): a card only needs "on my phone / on the way / not
// yet", and useSyncStatus republishes on every progress frame, which would
// re-render every stacked carousel on every tick. The screens that DO want live
// progress (My Boards) subscribe once at screen level and pass primitives down.

import { useCallback } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineBoardKeyForBoard, useSetting } from '../../settings';
import { useDownloadedScopeKeys } from '../../offline/use-downloaded-scope-keys';
import { boardDownloadState, type BoardDownloadState } from './board-offline-state';

export type BoardOfflineStateLookup = (board: UserBoard) => BoardDownloadState;

/**
 * A stable `(board) => BoardDownloadState` for the boards a climber owns or
 * follows. Only those carry a download state — a popular config has no `uuid`,
 * so it could never appear in the offline picker even though its data would
 * download.
 */
export function useBoardOfflineState(): BoardOfflineStateLookup {
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();

  return useCallback(
    (board: UserBoard): BoardDownloadState => {
      const scopeKey = offlineBoardKeyForBoard(board);
      return boardDownloadState({
        scopeKey,
        enabled: enabledScopeKeys.includes(scopeKey),
        isBootstrapDone: false,
        downloaded: (downloadedScopeKeys ?? []).includes(scopeKey),
        isSyncing: false,
        currentTable: null,
      });
    },
    [enabledScopeKeys, downloadedScopeKeys],
  );
}
