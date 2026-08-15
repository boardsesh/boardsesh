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
 * Three rows behave differently from web, for reasons that are structural rather
 * than choices:
 *
 * - `new_climbs_synced` has no mobile setter-profile route to open (the Climbs
 *   tab's `setters` screen is a filter picker, not a profile), so it falls
 *   through to the climb branch. That is safe: the resolver populates
 *   `climbUuid` + `boardType` for exactly this type.
 * - `proposalUuid` goes nowhere. Web appends it to the climb URL so the climb
 *   opens with that proposal surfaced; mobile has no proposal UI at all (no
 *   component, route, or drawer reads a proposal), so a `proposal_*` row opens
 *   the plain climb. Thread it through here the day a proposal surface lands.
 * - The climb page is reached by the flat `ref` route. It needs three
 *   coordinates (layout, angle, size) and reads layout + angle from
 *   `board_climbs`; see the ladder below for what fills the gaps. www had a
 *   server-side twin of this resolution until W-20b (#4439) removed the web
 *   notification centre — mobile is the only client now.
 *
 * Every other type (`comment_*`, `vote_*`, a bare `proposal_*` with no climb)
 * marks read and stays put — the resolver never enriches those with a
 * `climbUuid`, so web's climb branch is dead for them too.
 */
export function useNotificationNavigation() {
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  // The scalars this callback actually reads, rather than the board object, so
  // an unrelated field moving (name, followers, gym) can't churn the callback.
  const { data: activeBoard } = useActiveBoard();
  const activeBoardType = activeBoard?.boardType;
  const activeBoardAngle = activeBoard?.angle;
  const activeBoardLayoutId = activeBoard?.layoutId;
  const activeBoardSizeId = activeBoard?.sizeId;
  const activeBoardSetIds = activeBoard?.setIds;
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

      const { climbUuid, boardType, climbLayoutId, climbAngle } = notification;
      if (!climbUuid || !boardType) return;

      const boardName = toBoardName(boardType);
      if (!boardName) return;

      const sameBoard = activeBoardType === boardType;

      // Layout is the one coordinate that can't be guessed: the climb query
      // filters on it, so a wrong layout is a "climb not found" dead end rather
      // than a cosmetic miss. The resolver reads it off `board_climbs`, which
      // covers every climb-bearing type; the two fallbacks only carry an OTA'd
      // client that is briefly ahead of the backend deploy.
      const layoutId = climbLayoutId ?? (sameBoard ? activeBoardLayoutId : undefined) ?? null;

      // Size + sets come from the reader's own board only when the climb really
      // sits on that layout, so it draws on their wall instead of the layout's
      // biggest size. Otherwise leave them off and let the `ref` branch resolve
      // them from the layout.
      const onReadersLayout = sameBoard && layoutId != null && layoutId === activeBoardLayoutId;

      // Angle ladder: the setter's own angle when they fixed one (that's where
      // the climb's grade and stats live, and it's what web uses), then the
      // reader's board, then the board default.
      const angle = climbAngle ?? (sameBoard ? activeBoardAngle : undefined) ?? defaultAngle(boardName);

      openClimbInPlayDrawer(
        {
          kind: 'ref',
          climbUuid,
          boardType,
          layoutId,
          angle,
          sizeId: onReadersLayout ? activeBoardSizeId : undefined,
          setIds: onReadersLayout ? activeBoardSetIds : undefined,
        },
        { openPlayDrawer, router },
      );
    },
    // All scalars or stable singletons (expo-router's `useRouter` hands back the
    // module-level imperative api; `openPlayDrawer` is empty-dep in its
    // provider), which is what keeps the screen's `renderItem` — and so every
    // row's memo — from invalidating on unrelated renders.
    [
      activeBoardType,
      activeBoardAngle,
      activeBoardLayoutId,
      activeBoardSizeId,
      activeBoardSetIds,
      markGroupAsRead,
      openPlayDrawer,
      router,
    ],
  );
}
