// Undo on the `board_setup_changed_by_climber` notice (docs/product/directory-reports.md,
// "Suggested setup"): a climber's suggestion changed the board for everyone at
// a gym nobody runs, and the board's creator puts the old setup back.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isBoardSetupChangedSinceError } from '@boardsesh/graphql/errors';
import type { GroupedNotification } from '@boardsesh/shared-schema';
import { useConfirm } from '../../providers/dialog-provider';
import { useUndoBoardSetupChange } from '../../lib/graphql/hooks/use-directory-reports';
import { useApplyChangedBoard } from '../../lib/boards/use-apply-changed-board';
import { formatSetupSummary } from '../report-problem/setup-summary';
import { canUndoSetupChange, type UndoSetupChange } from './setup-change-notice';

/**
 * Returns the inbox's Undo: confirm, then put the old setup back, then write
 * the restored board where the app reads it (the active board included, so a
 * climber on it climbs the old setup again straight away). Its inputs change
 * only with the language or the signed-in account, so the rows it is handed to
 * stay memoised.
 */
export function useUndoSetupChange(): UndoSetupChange {
  const { t } = useTranslation('notifications');
  const { t: tCommon } = useTranslation('common');
  const confirm = useConfirm();
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
      let restored;
      try {
        restored = await undo({ eventId, notification });
      } catch (error) {
        if (isBoardSetupChangedSinceError(error)) return 'changed_since';
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
    [t, tCommon, confirm, undo, applyChangedBoard],
  );
}
