import { useCallback, useEffect } from 'react';
import { Portal } from 'react-native-paper';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useUnfollowBoard } from '../../lib/graphql/hooks';
import { FRIENDS_BOARDS_QUERY_KEY } from '../../lib/graphql/hooks/use-friends-boards';
import { clearSavedFriendBoard, useSavedFriendBoard } from '../../lib/boards/saved-friend-board-undo';
import { reportError } from '../../lib/error-reporting';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing } from '../../theme/tokens';
import { TabBarHideFollower } from '../navigation/TabBarHideFollower';
import { UndoSnackbar } from '../UndoSnackbar';

const UNDO_DURATION = 6000;

/**
 * "Saved to Your boards · Undo", after a climber picked a friend's board
 * (use-friend-board-action.ts). Portaled above the app chrome, because the
 * pick closed the boards modal it was made in. Undo unfollows the board: it
 * leaves Your boards and goes back to Friends' boards; the climber stays on it.
 */
export function SavedFriendBoardUndoSnackbar() {
  const { t } = useTranslation('boards');
  const bottomChrome = useBottomChromeMetrics();
  const saved = useSavedFriendBoard();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { mutateAsync: unfollowBoard } = useUnfollowBoard();
  // An Undo belongs to the account that saved the board.
  const { isAuthenticated } = useAuth();
  useEffect(() => {
    if (!isAuthenticated) clearSavedFriendBoard();
  }, [isAuthenticated]);

  const onUndo = useCallback(() => {
    if (!saved) return;
    clearSavedFriendBoard();
    unfollowBoard(saved.boardUuid)
      .then(() => queryClient.invalidateQueries({ queryKey: [FRIENDS_BOARDS_QUERY_KEY] }))
      .catch((error: unknown) => {
        reportError(error);
        showToast(t('mobile.friendBoards.undoError', { name: saved.boardName }), 'error');
      });
  }, [saved, unfollowBoard, queryClient, showToast, t]);

  return (
    <Portal>
      <TabBarHideFollower>
        <UndoSnackbar
          visible={saved !== null}
          nonce={saved?.nonce ?? 0}
          message={t('mobile.friendBoards.saved')}
          undoLabel={t('mobile.friendBoards.undo')}
          undoAccessibilityLabel={saved ? t('mobile.friendBoards.undoAria', { name: saved.boardName }) : undefined}
          onDismiss={clearSavedFriendBoard}
          onUndo={onUndo}
          duration={UNDO_DURATION}
          bottom={bottomChrome.floatingControlBottom + spacing[2]}
        />
      </TabBarHideFollower>
    </Portal>
  );
}
