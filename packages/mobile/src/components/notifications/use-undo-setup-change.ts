// Undo on the `board_setup_changed_by_climber` notice (docs/product/directory-reports.md,
// "Suggested setup"): a climber's suggestion changed the board for everyone at
// a gym nobody runs, and whoever got the notice (the board's creator, the gym's
// owner or admins) puts the old setup back.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { isBoardSetupAlreadyUndoneError, isBoardSetupChangedSinceError } from '@boardsesh/graphql/errors';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { useConfirm } from '../../providers/dialog-provider';
import { useUndoBoardSetupChange } from '../../lib/graphql/hooks/use-directory-reports';
import { useApplyChangedBoard } from '../../lib/boards/use-apply-changed-board';
import { fetchBoardByUuid } from '../../lib/graphql/hooks/fetch-board-by-uuid';
import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';
import { findCachedNotification } from '../../lib/graphql/notification-read-cache';
import { formatSetupSummary } from '../report-problem/setup-summary';
import { canUndoSetupChange, type UndoSetupChange } from './setup-change-notice';

/**
 * Returns the inbox's Undo: confirm, then put the old setup back, then write
 * the restored board where the app reads it (the active board included, so a
 * climber on it climbs the old setup again straight away). When someone else
 * put it back first, the board is read again and written the same way. Its
 * inputs change only with the language or the signed-in account, so the rows
 * it is handed to stay memoised.
 */
export function useUndoSetupChange(): UndoSetupChange {
  const { t } = useTranslation('notifications');
  const { t: tCommon } = useTranslation('common');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const undo = useUndoBoardSetupChange();
  const applyChangedBoard = useApplyChangedBoard();

  return useCallback(
    async (notification: GroupedNotification) => {
      const notice = notification.directoryNotice;
      const eventId = notice?.setupChangeEventId;
      if (!notice || !eventId || !canUndoSetupChange(notification)) return 'cancelled';
      const board = notice.boardName ?? null;
      const before =
        notice.setupBefore && notice.boardType ? formatSetupSummary(notice.boardType, notice.setupBefore) : null;
      const confirmed = await confirm({
        title: t('setupChange.undoTitle'),
        message:
          board && before ? t('setupChange.undoBody', { board, setup: before }) : t('setupChange.undoBodyGeneric'),
        confirmLabel: t('setupChange.undoConfirm'),
        cancelLabel: tCommon('actions.cancel'),
      });
      if (!confirmed) return 'cancelled';
      // The row may have moved on while the confirm was up (the inbox reloaded,
      // or an Undo elsewhere landed): undo only a change that is still live.
      const latest = findCachedNotification(queryClient, notification.uuid) ?? notification;
      if (!canUndoSetupChange(latest)) return 'cancelled';
      let restored;
      try {
        restored = await undo({ eventId, notification });
      } catch (error) {
        if (isBoardSetupChangedSinceError(error)) return 'changed_since';
        if (isBoardSetupAlreadyUndoneError(error)) {
          // The old setup is back, but this device's active board is a stored
          // copy that never re-reads on its own: read the board as it is now
          // and write it the way a successful undo does.
          const boardUuid = notice.boardUuid;
          if (boardUuid) {
            try {
              const current = await fetchBoardByUuid(boardUuid);
              if (current) await applyChangedBoard(current);
            } catch {
              // The row still reads as undone; the active board heals from the
              // server on the next foreground (use-active-board-self-heal).
            }
          }
          return 'already_undone';
        }
        if (extractGraphqlCode(error) === 'NOT_FOUND') return 'not_allowed';
        throw error;
      }
      try {
        await applyChangedBoard(restored);
      } catch {
        // The undo landed. A stored active board that failed to take it heals
        // from the server on the next foreground (use-active-board-self-heal).
      }
      return 'undone';
    },
    [t, tCommon, confirm, queryClient, undo, applyChangedBoard],
  );
}
