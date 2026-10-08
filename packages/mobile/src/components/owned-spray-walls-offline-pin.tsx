import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { isSigningOut, offlineBoardScopeForBoard } from '@boardsesh/offline-sync';
import { useOfflineDatabase } from '../db/use-offline-database';
import { useAuth } from '../providers/auth-provider';
import { useOfflineDownloadsEnabled } from '../providers/feature-flags-provider';
import { useStoredUserId } from '../hooks/use-current-user-id';
import { useIsOffline } from '../hooks/use-is-offline';
import { fetchAllMyBoards } from '../lib/graphql/hooks';
import { reportHandledError } from '../lib/error-reporting';
import { useBoardDownloads } from '../offline/use-board-downloads';
import { planOwnedSprayWallPins } from '../offline/owned-spray-wall-pins';
import { removeOfflineBoard } from '../offline/remove-offline-board';
import { getOwnedSprayWallPins, getSetting, setOwnedSprayWallPins, useSetting } from '../settings';

/**
 * The whole roster, every page, for the pin. `myBoards` pages at 20 and puts
 * boards never opened last, so a fresh wall on a busy account can sit past the
 * first page; `fetchAllMyBoards` walks to the end (one request of up to 50
 * boards for nearly everyone). Under the `myBoards` prefix on purpose: every
 * `invalidateQueries(['myBoards'])` (a publish, a follow, an edit) refetches it
 * while this component observes it, which is how a new wall gets pinned. Its
 * data is a plain array, and nothing reads the prefix as a connection: the
 * roster readers use the exact `myBoardsQueryKey()`.
 */
export const OWNED_SPRAY_WALL_PIN_ROSTER_QUERY_KEY = ['myBoards', 'ownedSprayWallPins'] as const;

/** The roster changes when the climber changes it, and each change invalidates it. */
const ROSTER_STALE_TIME_MS = 10 * 60 * 1000;

/**
 * Keeps the climber's own spray walls available offline (owner decision,
 * 2026-10): photo, holds and climbs, with no switch to remember. The rules are
 * `planOwnedSprayWallPins`; this only runs them against the full roster and acts
 * through the paths that already exist: `enableBoardsOffline`, which the
 * "Available offline" switch drives, and `removeOfflineBoard`, which Storage's
 * Remove drives.
 *
 * Mounted once at the root beside `OfflineSyncBridge`. Renders nothing. Idle
 * while signed out, while offline (a cached roster is no evidence that
 * ownership changed), where offline downloads are off (Expo web, through the
 * `.web.tsx` twin and the flag), in screenshot captures (their requests are
 * replayed from a recording), and while a sign-out is wiping: the account's
 * roster is still cached then, and pinning into the wipe would re-enable its
 * walls and rewrite the record the sign-out is about to clear.
 *
 * The effect re-runs on every settings write (`useSetting` re-renders all its
 * readers), not only on `syncEnabledBoards`; the plan is a pass over the roster
 * and a no-op once the record is current, so that costs nothing.
 */
export function OwnedSprayWallsOfflinePin(): null {
  const { isAuthenticated } = useAuth();
  const downloadsEnabled = useOfflineDownloadsEnabled();
  const isOffline = useIsOffline();
  const active = isAuthenticated && downloadsEnabled && !isOffline && process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1';
  const { userId } = useStoredUserId(active);
  const { data: boards } = useQuery({
    queryKey: OWNED_SPRAY_WALL_PIN_ROSTER_QUERY_KEY,
    queryFn: fetchAllMyBoards,
    enabled: active,
    staleTime: ROSTER_STALE_TIME_MS,
  });
  const [enabledScopeKeys] = useSetting('syncEnabledBoards');
  const { enableBoardsOffline } = useBoardDownloads();
  const db = useOfflineDatabase();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!active || !userId || !boards || isSigningOut()) return;
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
