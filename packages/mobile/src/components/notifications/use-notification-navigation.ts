import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { useMarkGroupAsRead } from '../../lib/graphql/hooks/use-notifications';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { defaultAngle } from '../../lib/boards/default-angle';

/**
 * What tapping a notification row does — the mobile translation of web's
 * `handleNotificationClick`. Marks the group read first (only when it is
 * unread, matching web), then routes by type.
 *
 * Two rows behave differently from web, for reasons that are structural rather
 * than choices:
 *
 * - `new_climbs_synced` has no mobile setter-profile route to open (the Climbs
 *   tab's `setters` screen is a filter picker, not a profile), so it falls
 *   through to the climb branch. That is safe: the resolver populates
 *   `climbUuid` + `boardType` for exactly this type.
 * - The climb branch needs an angle that `GroupedNotification` does not carry.
 *   Web resolves one server-side via `/api/internal/climb-redirect`, which has
 *   no mobile counterpart, so we take the user's active-board angle when it is
 *   the same board and the board's default angle otherwise.
 *
 * Every other type (`comment_*`, `vote_*`, a bare `proposal_*` with no climb)
 * marks read and stays put — the resolver never enriches those with a
 * `climbUuid`, so web's climb branch is dead for them too.
 */
export function useNotificationNavigation() {
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  // The two scalars this callback actually reads, rather than the board object:
  // any other field moving (name, layout, sets) must not churn the callback.
  const { data: activeBoard } = useActiveBoard();
  const activeBoardType = activeBoard?.boardType;
  const activeBoardAngle = activeBoard?.angle;
  // `mutate` only — the mutation RESULT object gets a new identity on every
  // state flip (idle → pending → success), which would churn this callback,
  // then the screen's `renderItem`, then every memoized row, on each tap.
  const { mutate: markGroupAsRead } = useMarkGroupAsRead();

  return useCallback(
    (notification: GroupedNotification) => {
      if (!notification.isRead) markGroupAsRead(notification);

      if (notification.type === 'new_follower' && notification.actors.length > 0) {
        router.push({ pathname: '/users/[userId]', params: { userId: notification.actors[0].id } });
        return;
      }

      if (notification.type === 'gym_claim_approved' && notification.entityId) {
        // entityId is the gym uuid; the edit route resolves the gym by uuid.
        router.push({ pathname: '/gyms/edit', params: { gymUuid: notification.entityId } });
        return;
      }

      const { climbUuid, boardType } = notification;
      if (!climbUuid || !boardType) return;

      const boardName = toBoardName(boardType);
      if (!boardName) return;

      const angle =
        activeBoardType === boardType && activeBoardAngle != null ? activeBoardAngle : defaultAngle(boardName);

      openClimbInPlayDrawer({ kind: 'ref', climbUuid, boardType, angle }, { openPlayDrawer, router });
    },
    // All scalars or stable singletons (expo-router's `useRouter` hands back the
    // module-level imperative api; `openPlayDrawer` is empty-dep in its
    // provider), which is what keeps the screen's `renderItem` — and so every
    // row's memo — from invalidating on unrelated renders.
    [activeBoardType, activeBoardAngle, markGroupAsRead, openPlayDrawer, router],
  );
}
