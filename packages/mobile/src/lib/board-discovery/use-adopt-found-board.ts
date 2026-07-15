import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useFollowBoard } from '../graphql/hooks';
import { useBoardDownloads } from '../../offline/use-board-downloads';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';
import { getSetting, useSetting, offlineBoardKeyForBoard } from '../../settings';
import { decideAdoptFoundBoard } from './adopt-found-board-decision';

/**
 * Adopt a board the user just picked from discovery (gym finder / Nearby): follow
 * it so it lands in My Boards, then — when offline downloads are available — offer
 * (or auto-run) the download per the user's "keep boards offline by default"
 * setting. Follow is fire-and-forget (idempotent server-side) so it never blocks
 * navigation; the offline confirm rides the root dialog, which survives the modal
 * dismiss that navigating away from the picker triggers.
 */
export function useAdoptFoundBoard() {
  const followBoard = useFollowBoard();
  const { enableBoardsOffline } = useBoardDownloads();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const [autoOffline] = useSetting('autoOfflineBoards');
  const { t } = useTranslation('boards');

  return useCallback(
    async (board: UserBoard) => {
      const decision = decideAdoptFoundBoard({
        isOwned: board.isOwned,
        isFollowedByMe: board.isFollowedByMe,
        offlineEnabled,
        autoOffline,
        alreadyEnabledOffline: getSetting('syncEnabledBoards').includes(offlineBoardKeyForBoard(board)),
      });

      if (decision.follow) {
        followBoard.mutate(board.uuid, {
          onSuccess: () => showToast(t('mobile.discovery.followed', { name: board.name }), 'success'),
        });
      }

      if (decision.offline === 'auto') {
        enableBoardsOffline(board);
        return;
      }
      if (decision.offline === 'ask') {
        const confirmed = await confirm({
          title: t('mobile.offline.enableTitle', { name: board.name }),
          message: t('mobile.offline.enableMessage'),
          confirmLabel: t('mobile.offline.enableConfirm'),
          cancelLabel: t('mobile.manage.cancel'),
        });
        if (confirmed) enableBoardsOffline(board);
      }
    },
    [followBoard, enableBoardsOffline, confirm, showToast, offlineEnabled, autoOffline, t],
  );
}
