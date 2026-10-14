import { useCallback, useEffect, useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards, useProfile } from '../lib/graphql/hooks';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { forgetDownloadAllTap, getSetting, offlineBoardKeyForBoard, takeDownloadAllTap, useSetting } from '../settings';
import { useBoardDownloads } from './use-board-downloads';

type MyBoardsOfflineState = {
  myBoards: UserBoard[];
  /** The boards in My Boards not yet opted into offline, read at call time. */
  missingOfflineBoards: () => UserBoard[];
};

function useMyBoardsOfflineState(): MyBoardsOfflineState {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const { data: profile } = useProfile();
  const { data: myBoardsConnection } = useMyBoards(undefined, { enabled: offlineEnabled && !!profile });
  // Memoised so the empty-while-loading fallback keeps a stable identity; the
  // effect below depends on this array and must not re-run every render.
  const myBoards = useMemo(() => myBoardsConnection?.boards ?? [], [myBoardsConnection]);
  const missingOfflineBoards = useCallback(() => {
    const enabled = new Set(getSetting('syncEnabledBoards'));
    return myBoards.filter((board) => !enabled.has(offlineBoardKeyForBoard(board)));
  }, [myBoards]);
  return { myBoards, missingOfflineBoards };
}

/**
 * The boards in My Boards not yet opted into offline, read at call time.
 *
 * The one source of truth for both the effect in `useKeepBoardsOffline` that
 * enables them and the Offline page's toast that says how many will download.
 * Reads `syncEnabledBoards` when CALLED, never a captured copy, so a board
 * enabled a moment ago is not counted again.
 *
 * Shares the `myBoards` query with every other reader, so calling it from a
 * page as well as from the settings layout costs no second request.
 */
export function useMissingOfflineBoards(): () => UserBoard[] {
  return useMyBoardsOfflineState().missingOfflineBoards;
}

/**
 * With "Keep boards offline" on, keep every board in My Boards downloaded.
 *
 * Mounted ONCE, in `app/settings/_layout.tsx`, which is up whenever any settings
 * page is open, in every scope. It used to live in the Settings index; now that
 * the switch sits on its own Offline page, the layout is the one place mounted
 * both for the page that flips it and for every page a climber moves on to,
 * without the effect running twice.
 *
 * Runs on mount and again once My Boards resolves, so flipping the switch before
 * the list loaded still downloads everything. It only enables boards not
 * already opted in, so once they are all in it does nothing: no repeated sync
 * kicks.
 *
 * A deliberate tap on the switch hands this effect its attribution (issue
 * #4316). Without the handoff every enable here would look automatic, since this
 * effect is also what runs on a plain visit with the setting already on, and
 * #4318's discovery work is measured against the deliberate half.
 *
 * The handoff is PERSISTED, not a ref. The tap can land before `useMyBoards`
 * resolves, and this effect bails while the list is empty, so a ref would drop
 * the attribution whenever the climber leaves Settings (or the app) in that
 * window, and the enable that eventually ran would be filed as automatic, which
 * is the one thing the split must not get wrong.
 */
export function useKeepBoardsOffline(): void {
  const offlineEnabled = useOfflineDownloadsEnabled();
  const [autoOfflineBoards] = useSetting('autoOfflineBoards');
  const { myBoards, missingOfflineBoards } = useMyBoardsOfflineState();
  const { enableBoardsOffline } = useBoardDownloads();

  useEffect(() => {
    if (!offlineEnabled || !autoOfflineBoards || myBoards.length === 0) return;
    const missing = missingOfflineBoards();
    if (missing.length === 0) {
      // A tap with nothing left to enable is fully handled here. Leaving the
      // flag armed would let the next automatic re-enable (a board followed
      // minutes later, say) inherit a `download-all` attribution for a tap
      // that had already been spent.
      forgetDownloadAllTap();
      return;
    }
    const fromTap = takeDownloadAllTap();
    enableBoardsOffline(missing, {
      trigger: fromTap ? 'download-all' : 'auto-download-all',
      source: 'more',
    });
  }, [offlineEnabled, autoOfflineBoards, myBoards, missingOfflineBoards, enableBoardsOffline]);
}
