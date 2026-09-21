import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useFollowBoard, useProfile } from '../graphql/hooks';
import { useBoardDownloads } from '../../offline/use-board-downloads';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useAuth } from '../../providers/auth-provider';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { getSetting, useSetting, offlineBoardKeyForBoard } from '../../settings';
import { reportError } from '../error-reporting';
import { boardOwnershipForViewer, decideAdoptFoundBoard, shouldFollowBoard } from './adopt-found-board-decision';

/**
 * Who is picking. Same degraded-never-blocked read as `/boards`: the profile when
 * it has loaded, else the id stored on the device, so a start with no signal can
 * still tell your own board from someone else's. `undefined` only when neither
 * has answered, which the decision treats as "unknown", never as "not yours".
 */
function useViewerId(): string | undefined {
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { userId: storedUserId } = useStoredUserId(isAuthenticated && !profile?.id);
  return profile?.id ?? storedUserId;
}

/**
 * Whether adopting `board` right now would follow it. Read by the bind before it
 * adopts, so the pick event can say whether the board landed in Your boards
 * without waiting for the adoption that runs after navigation. The same rule and
 * the same viewer as `useAdoptFoundBoard`, so the two agree.
 */
export function useWillFollowFoundBoard() {
  const viewerId = useViewerId();
  return useCallback(
    (board: UserBoard): boolean => shouldFollowBoard(boardOwnershipForViewer(board, viewerId)),
    [viewerId],
  );
}

/**
 * Adopt a board the user just picked from discovery (gym finder / Nearby): follow
 * it so it lands in My Boards, then — when offline downloads are available — offer
 * (or auto-run) the download per the user's "keep boards offline by default"
 * setting. Follow is fire-and-forget (idempotent server-side) so it never blocks
 * navigation; the offline confirm rides the root dialog, which survives the modal
 * dismiss that navigating away from the picker triggers.
 */
export function useAdoptFoundBoard() {
  const { showToast } = useToast();
  const { t } = useTranslation('boards');
  const viewerId = useViewerId();
  // The toast rides useFollowBoard's config-level onSuccess (it fires after this
  // screen unmounts on navigation); a per-call mutate callback would be dropped.
  const followBoard = useFollowBoard({
    onFollowed: (board) => showToast(t('mobile.discovery.followed', { name: board.name }), 'success'),
    onFollowError: (board, error) => {
      reportError(error);
      showToast(t('mobile.discovery.followError', { name: board.name }), 'error');
    },
  });
  const { enableBoardsOffline } = useBoardDownloads();
  const confirm = useConfirm();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const [autoOffline] = useSetting('autoOfflineBoards');

  return useCallback(
    async (board: UserBoard) => {
      const decision = decideAdoptFoundBoard({
        ...boardOwnershipForViewer(board, viewerId),
        offlineEnabled,
        autoOffline,
        alreadyEnabledOffline: getSetting('syncEnabledBoards').includes(offlineBoardKeyForBoard(board)),
      });

      if (decision.follow) {
        followBoard.mutate(board);
      }

      if (decision.offline === 'auto') {
        // The `autoOfflineBoards` setting acting on its own — NOT a tap. Kept
        // distinct from the confirmed branch below so discovery work (#4318) is
        // measured against deliberate opt-ins only.
        enableBoardsOffline(board, { trigger: 'adopt-auto', source: 'adopt' });
        return;
      }
      if (decision.offline === 'ask') {
        const confirmed = await confirm({
          title: t('mobile.offline.enableTitle', { name: board.name }),
          message: t('mobile.offline.enableMessage'),
          confirmLabel: t('mobile.offline.enableConfirm'),
          cancelLabel: t('mobile.manage.cancel'),
        });
        if (confirmed) enableBoardsOffline(board, { trigger: 'adopt-confirmed', source: 'adopt' });
      }
    },
    // followBoard.mutate is stable; depending on the whole `followBoard` object
    // (fresh each render) would churn this callback and every onSelect built on it.
    [followBoard.mutate, enableBoardsOffline, confirm, offlineEnabled, autoOffline, viewerId, t],
  );
}
