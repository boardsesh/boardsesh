import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { offlineBoardScopeForBoard } from '@boardsesh/offline-sync';
import { useOfflineDatabase } from '../db/use-offline-database';
import { useAuth } from '../providers/auth-provider';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { useIsOffline } from '../hooks/use-is-offline';
import { useMyBoards } from '../lib/graphql/hooks';
import { reportHandledError } from '../lib/error-reporting';
import { useBoardDownloads } from '../offline/use-board-downloads';
import { planOwnedSprayWallPins } from '../offline/owned-spray-wall-pins';
import { removeOfflineBoard } from '../offline/remove-offline-board';
import { getOwnedSprayWallPins, getSetting, setOwnedSprayWallPins, useSetting } from '../settings';

/**
 * Keeps the climber's own spray walls available offline (owner decision,
 * 2026-10): photo, holds and climbs, with no switch to remember. The rules are
 * `planOwnedSprayWallPins`; this only runs them against the live `myBoards`
 * roster (the same query the drawer host keeps warm, so no extra request) and
 * acts through the paths that already exist: `enableBoardsOffline`, which the
 * "Available offline" switch drives, and `removeOfflineBoard`, which Storage's
 * Remove drives.
 *
 * Publishing a wall (its first holds, or a later edit) invalidates `myBoards`,
 * so a new wall is pinned as soon as the refetch names it.
 *
 * Mounted once at the root beside `OfflineSyncBridge`. Renders nothing. Idle
 * while signed out, while offline (a roster from the persisted cache is no
 * evidence that ownership changed), and where offline downloads are off (Expo
 * web, through the `.web.tsx` twin and the flag).
 */
export function OwnedSprayWallsOfflinePin(): null {
  const { isAuthenticated } = useAuth();
  const downloadsEnabled = useOfflineDownloadsEnabled();
  const isOffline = useIsOffline();
  const active = isAuthenticated && downloadsEnabled && !isOffline;
  const { userId } = useStoredUserId(active);
  const { data: myBoardsConnection } = useMyBoards(undefined, { enabled: active });
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const { enableBoardsOffline } = useBoardDownloads();
  const db = useOfflineDatabase();
  const queryClient = useQueryClient();
  const boards = myBoardsConnection?.boards;

  useEffect(() => {
    if (!active || !userId || !boards) return;
    const plan = planOwnedSprayWallPins<UserBoard>({
      boards,
      viewerUserId: userId,
      ledger: getOwnedSprayWallPins(),
      enabledScopeKeys: new Set(getSetting('syncEnabledBoards')),
    });
    // The ledger first: writing the setting re-runs this effect, and it must
    // then find nothing left to do.
    if (plan.ledger) setOwnedSprayWallPins(plan.ledger);
    if (plan.pin.length > 0) enableBoardsOffline(plan.pin, { trigger: 'owned-wall', source: 'owned_wall' });
    for (const board of plan.unpin) {
      void removeOfflineBoard({ db, queryClient, scope: offlineBoardScopeForBoard(board) }).catch((error: unknown) =>
        reportHandledError(error, { tags: { source: 'offline-sync', op: 'owned-wall-unpin' } }),
      );
    }
  }, [active, userId, boards, enabledScopeKeys, enableBoardsOffline, db, queryClient]);

  return null;
}
