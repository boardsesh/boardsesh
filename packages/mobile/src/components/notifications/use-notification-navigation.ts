import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { toBoardName } from '@boardsesh/board-config';
import type { GroupedNotification, SocialEntityType } from '@boardsesh/shared-schema';
import { useMarkGroupAsRead } from '../../lib/graphql/hooks/use-notifications';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useClimbModerationEnabled } from '../../providers/feature-flags-provider';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { defaultAngle } from '../../lib/boards/default-angle';
import { notificationClimbRender } from './notification-climb-render';
import { notificationToClimb } from './notification-to-climb';

/** Opens the comment thread for an entity. Supplied by the screen, which hosts the sheet. */
export type OpenCommentThread = (entityType: SocialEntityType, entityId: string) => void;

/**
 * The types that hang off a comment thread. Tapping one opens the thread rather
 * than a climb — including `vote_on_comment`, whose `threadEntity*` the resolver
 * walks one hop to the entity the liked comment actually sits under.
 */
const THREAD_TYPES: ReadonlySet<GroupedNotification['type']> = new Set([
  'comment_reply',
  'comment_on_tick',
  'comment_on_climb',
  'vote_on_tick',
  'vote_on_comment',
]);

/**
 * What tapping a notification row does. Marks the group read first (only when it
 * is unread, matching web), then routes by type.
 *
 * Every type lands somewhere:
 *
 * - `new_follower` opens the follower's profile when there is one of them, and
 *   the follow-back list when there are more. A group only carries its first
 *   three actors, so the list screen re-fetches all of them by group key.
 * - `comment_*` and `vote_*` open the thread the row is about, via the
 *   `threadEntityType`/`threadEntityId` pair the resolver fills for exactly
 *   these types.
 * - `gym_claim_approved` opens the gym's edit screen.
 * - everything climb-bearing opens the climb.
 *
 * Two rows are deliberately coarser than they look:
 *
 * - `new_climbs_synced` has no mobile setter-profile route to open (the Climbs
 *   tab's `setters` screen is a filter picker, not a profile), so it falls
 *   through to the climb branch. That is safe: the resolver populates
 *   `climbUuid` + `boardType` for exactly this type.
 * - A `proposal_*` row carrying a `proposalUuid` opens the Moderation feed on
 *   that proposal rather than the climb — the report thread, its votes and the
 *   climb preview are all there, which is what the row is actually about. Web
 *   appends the uuid to the climb URL instead; mobile has a dedicated feed. The
 *   feed is ONE root-stack modal (`app/moderation.tsx`), so the same push works
 *   from the Home bell and from the You tab and there is no tab to pick. With
 *   the `climb-moderation-kill` flag off there is no feed to open, so those rows
 *   fall through to the plain climb, exactly as before.
 *
 * The climb page is reached by the flat `ref` route. It needs three coordinates
 * (layout, angle, size) and reads layout + angle from `board_climbs`; see the
 * ladder below for what fills the gaps. www had a server-side twin of this
 * resolution until W-20b (#4439) removed the web notification centre — mobile is
 * the only client now.
 */
export function useNotificationNavigation(openCommentThread: OpenCommentThread) {
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const moderationEnabled = useClimbModerationEnabled();
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

      if (notification.type === 'new_follower') {
        // One follower reads as "go see who this is"; several read as "let me
        // deal with all of them", which is the follow-back list.
        if (notification.actorCount === 1 && notification.actors.length > 0) {
          router.push({ pathname: '/users/[userId]', params: { userId: notification.actors[0].id } });
          return;
        }
        // The group key must ride along. `notificationActors` matches the
        // (type, entityType, entityId) triple exactly, and a follower
        // notification's entityId is the FOLLOWED user's id (follows.ts) — never
        // null — so omitting it matches no rows and the list comes back empty.
        router.push({
          pathname: '/users/connections',
          params: { mode: 'newFollowers', entityId: notification.entityId ?? '' },
        });
        return;
      }

      if (THREAD_TYPES.has(notification.type)) {
        const { threadEntityType, threadEntityId } = notification;
        if (threadEntityType && threadEntityId) {
          openCommentThread(threadEntityType, threadEntityId);
          return;
        }
        // No thread resolved — an OTA'd client briefly ahead of the backend
        // deploy. Fall through rather than return, so a row that still carries
        // a climb opens that instead of doing nothing.
      }

      if (notification.type === 'gym_claim_approved' && notification.entityId) {
        // entityId is the gym uuid; the edit route resolves the gym by uuid.
        router.push({ pathname: '/gyms/edit', params: { gymUuid: notification.entityId } });
        return;
      }

      const { climbUuid, boardType, climbLayoutId, climbAngle } = notification;

      // Every proposal row about a specific proposal lands in the feed, whatever
      // the outcome it announces (created, voted, approved, rejected, or one on
      // your own climb) — they all want the same screen.
      if (moderationEnabled && notification.type.startsWith('proposal_') && notification.proposalUuid) {
        router.push({
          // One root modal, whichever tab the bell was tapped in — it presents
          // above the tabs (and above the player) rather than inside a stack.
          pathname: '/moderation',
          // Omit the climb coordinates rather than passing empty strings: the
          // feed treats a blank uuid as "no climb to scroll to", and a bare
          // `proposal_vote` row genuinely carries none.
          params: {
            proposalUuid: notification.proposalUuid,
            ...(climbUuid ? { climbUuid } : {}),
            ...(boardType ? { boardType } : {}),
          },
        });
        return;
      }

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

      // The row carries the climb's frames, so open the drawer straight away
      // rather than routing through the climb page. That page is the `ref`
      // fallback for callers holding only a uuid: it re-fetches by uuid, shows a
      // spinner while it does, and ignores `preview` (see its docblock). Preview
      // rather than active because a notification tap is browsing — it should
      // not append to the reader's queue.
      const render = notificationClimbRender(notification);
      if (render) {
        const climb = notificationToClimb(notification, angle);
        if (climb) {
          openClimbInPlayDrawer(
            {
              kind: 'climb',
              climb,
              boardConfig: {
                boardName: render.boardConfig.boardName,
                layoutId: render.boardConfig.layoutId,
                sizeId: render.boardConfig.sizeId,
                setIds: render.boardConfig.setIds.join(','),
                angle,
              },
            },
            { openPlayDrawer, router },
            { preview: true },
          );
          return;
        }
      }

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
    // provider, and the screen memoizes `openCommentThread` with empty deps),
    // which is what keeps the screen's `renderItem` — and so every row's memo —
    // from invalidating on unrelated renders.
    [
      activeBoardType,
      activeBoardAngle,
      activeBoardLayoutId,
      activeBoardSizeId,
      activeBoardSetIds,
      moderationEnabled,
      markGroupAsRead,
      openCommentThread,
      openPlayDrawer,
      router,
    ],
  );
}
