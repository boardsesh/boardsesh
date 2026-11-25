// A tap on a friend's board, wherever it is drawn: the picker's Friends'
// boards shelf and the wizard's "Whose board?". What it does follows the
// server's word on the viewer's access (`FriendBoard.viewerAccess`):
//
// - CAN_CLIMB: bind the board as a Your boards tap does, then save it (follow)
//   so it lands in Your boards. "Saved to Your boards · Undo" shows on the tab
//   the bind lands on (saved-friend-board-undo.ts).
// - CAN_REQUEST: "Ask {{name}} to climb here", a short sheet whose button asks
//   the owner (requestResourceAccess).
// - REQUESTED: the same sheet, waiting, with "Cancel request".
//
// The sheet's errors stay in the sheet: the boards modal is a native surface,
// and the toast overlay draws behind it. After an ask or a cancel the list is
// read again rather than assumed: the server answers an ask for a board the
// viewer can already open with a quiet yes and no request.

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FriendBoard, UserBoard } from '@boardsesh/shared-schema';
import {
  FriendBoardAccessSheet,
  type FriendBoardAccessError,
} from '../../components/board-discovery/FriendBoardAccessSheet';
import { useToast } from '../../providers/toast-provider';
import { useFollowBoard } from '../graphql/hooks';
import { FRIENDS_BOARDS_QUERY_KEY } from '../graphql/hooks/use-friends-boards';
import { useResourceAccessAction } from '../graphql/hooks/use-resource-privacy';
import { isGraphqlRateLimitedError } from '../graphql/extract-error-message';
import { getConnectivitySnapshot } from '../connectivity/connectivity-store';
import { reportError } from '../error-reporting';
import { announceSavedFriendBoard } from './saved-friend-board-undo';
import { friendBoardOwnerName } from './friend-boards';
import type { BoardReturnTo } from './board-return-to';
import { useActivateBoard, type ActivateBoardOptions, type BoardPickSection } from './use-activate-board';

/** What a tap on a friend's board leads to. */
export type FriendBoardTap = 'climb' | 'ask' | 'waiting' | 'unavailable';

/** Pure: the branch for one row. A CAN_CLIMB row the server sent without its board can't be climbed. */
export function friendBoardTap(friendBoard: FriendBoard): FriendBoardTap {
  switch (friendBoard.viewerAccess) {
    case 'CAN_CLIMB':
      return friendBoard.board ? 'climb' : 'unavailable';
    case 'CAN_REQUEST':
      return 'ask';
    case 'REQUESTED':
      return 'waiting';
  }
}

/** Pure: how a failed ask or cancel reads in the sheet. */
export function friendBoardAccessError(error: unknown, offline: boolean): FriendBoardAccessError {
  if (offline) return 'offline';
  return isGraphqlRateLimitedError(error) ? 'rate_limited' : 'failed';
}

export type FriendBoardActionOptions = {
  returnTo: BoardReturnTo;
  /** The section the rows are drawn in, for the pick event. */
  section: Extract<BoardPickSection, 'friends_boards' | 'friend_step'>;
  /** The picker's pick event, when the rows are in the picker. */
  onBound?: ActivateBoardOptions['onBound'];
  /**
   * Runs just before a climbable board is bound: the picker stops its scan,
   * the wizard step marks the flow finished.
   */
  beforeClimb?: () => void;
};

export function useFriendBoardAction({ returnTo, section, onBound, beforeClimb }: FriendBoardActionOptions): {
  onPress: (friendBoard: FriendBoard, position: number) => void;
  sheet: ReactElement | null;
} {
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<FriendBoard | null>(null);
  const [sheetError, setSheetError] = useState<FriendBoardAccessError | null>(null);

  // The bind says the board was followed when this hook is about to follow it:
  // adoption is off (it never follows a private board), so it can't say so itself.
  const reportBound = useMemo<ActivateBoardOptions['onBound']>(
    () =>
      onBound
        ? (board: UserBoard, bound) => onBound(board, { ...bound, followed: board.isFollowedByMe !== true })
        : undefined,
    [onBound],
  );
  // `rethrow`, so a bind that failed is never followed by a save.
  const activate = useActivateBoard({
    returnTo,
    adopt: false,
    onBound: reportBound,
    recognizesHeldBox: false,
    writeFailure: 'rethrow',
  });

  // Config-level callbacks: they run after the bind has closed the modal.
  const { mutate: followBoard } = useFollowBoard({
    onFollowed: (board) => {
      announceSavedFriendBoard(board);
      void queryClient.invalidateQueries({ queryKey: [FRIENDS_BOARDS_QUERY_KEY] });
    },
    onFollowError: (board, error) => {
      reportError(error);
      showToast(t('mobile.discovery.followError', { name: board.name }), 'error');
    },
  });

  const { mutateAsync: runAccessAction, isPending } = useResourceAccessAction();

  const onPress = useCallback(
    (friendBoard: FriendBoard, position: number) => {
      const tap = friendBoardTap(friendBoard);
      if (tap === 'unavailable') {
        showToast(t('mobile.boardSwitchError'), 'error');
        return;
      }
      if (tap === 'ask' || tap === 'waiting') {
        setSheetError(null);
        setTarget(friendBoard);
        return;
      }
      const board = friendBoard.board;
      if (!board) return;
      beforeClimb?.();
      activate(board, { pickSource: 'friends', section, position }).then(
        () => {
          if (board.isFollowedByMe !== true) followBoard(board);
        },
        () => showToast(t('mobile.boardSwitchError'), 'error'),
      );
    },
    [activate, followBoard, beforeClimb, section, showToast, t],
  );

  const close = useCallback(() => {
    setTarget(null);
    setSheetError(null);
  }, []);

  const runOnTarget = useCallback(
    async (action: 'request' | 'cancel') => {
      if (!target) return;
      setSheetError(null);
      try {
        await runAccessAction({ action, kind: 'board', resourceId: target.preview.uuid });
        // The privacy write already refreshes every screen; the list is read
        // again either way, never set to Requested by hand.
        void queryClient.invalidateQueries({ queryKey: [FRIENDS_BOARDS_QUERY_KEY] });
        close();
      } catch (error: unknown) {
        const reason = friendBoardAccessError(error, getConnectivitySnapshot().effectiveOffline);
        if (reason === 'failed') reportError(error);
        setSheetError(reason);
      }
    },
    [target, runAccessAction, queryClient, close],
  );
  const ask = useCallback(() => void runOnTarget('request'), [runOnTarget]);
  const cancelRequest = useCallback(() => void runOnTarget('cancel'), [runOnTarget]);

  const sheet = target ? (
    <FriendBoardAccessSheet
      ownerName={friendBoardOwnerName(target.owner, t('mobile.friendBoards.ownerFallback'))}
      waiting={target.viewerAccess === 'REQUESTED'}
      pending={isPending}
      error={sheetError}
      onAsk={ask}
      onCancelRequest={cancelRequest}
      onDismiss={close}
    />
  ) : null;

  return { onPress, sheet };
}
