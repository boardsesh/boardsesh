// A tap on a friend's board, wherever it is drawn: the picker's Friends'
// boards shelf, the wizard's "Whose board?" and the picker's In range card for
// a private board heard over Bluetooth (in-range-request-card.ts). What it does
// follows the server's word on the viewer's access (`FriendBoard.viewerAccess`):
//
// - CAN_CLIMB: bind the board as a Your boards tap does, then save it (follow)
//   so it lands in Your boards. "Saved to Your boards · Undo" shows on the tab
//   the bind lands on (saved-friend-board-undo.ts), and "Download X?" is
//   offered as adoption would, without adoption's own follow.
// - CAN_REQUEST: "Ask {{name}} to climb here", a short sheet whose button asks
//   the owner (requestResourceAccess).
// - REQUESTED: the same sheet, waiting, with "Cancel request".
//
// The sheet's errors stay in the sheet: the boards modal is a native surface,
// and the toast overlay draws behind it. The sheet closes on the write itself;
// the access action then reads the list again rather than assuming Requested:
// the server answers an ask for a board the viewer can already open with a
// quiet yes and no request.

import { useCallback, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { FriendBoard } from '@boardsesh/shared-schema';
import {
  FriendBoardAccessSheet,
  type FriendBoardAccessError,
} from '../../components/board-discovery/FriendBoardAccessSheet';
import { useToast } from '../../providers/toast-provider';
import { useFollowBoard } from '../graphql/hooks';
import { FRIENDS_BOARDS_QUERY_KEY } from '../graphql/hooks/use-friends-boards';
import { useResourceAccessAction } from '../graphql/hooks/use-resource-privacy';
import { readGraphqlRateLimit } from '../graphql/extract-error-message';
import { useAdoptFoundBoard } from '../board-discovery/use-adopt-found-board';
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

/**
 * A rate limit that lifts in more than this is the daily cap on asks; a shorter
 * one is the per-minute limit every privacy write shares.
 */
const DAILY_CAP_RETRY_AFTER_SECONDS = 60 * 60;

/**
 * Pure: how a failed ask or cancel reads in the sheet. Only an ask can hit the
 * daily cap ("try again tomorrow"); any other limit, or one with no wait given,
 * reads as the neutral "wait a moment".
 */
export function friendBoardAccessError(
  error: unknown,
  offline: boolean,
  action: 'request' | 'cancel',
): FriendBoardAccessError {
  if (offline) return 'offline';
  const rateLimit = readGraphqlRateLimit(error);
  if (!rateLimit) return 'failed';
  const retryAfterSeconds = rateLimit.retryAfterSeconds ?? 0;
  return action === 'request' && retryAfterSeconds > DAILY_CAP_RETRY_AFTER_SECONDS ? 'daily_cap' : 'rate_limited';
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

  // `rethrow`, so a bind that failed is never followed by a save. No `onBound`:
  // adoption is off (it never follows a private board), so the bind can't say
  // whether the board was saved; the pick is reported once the save settles.
  const activate = useActivateBoard({
    returnTo,
    adopt: false,
    recognizesHeldBox: false,
    writeFailure: 'rethrow',
  });
  // Adoption's "Download X?" (or the auto-download setting) without its follow:
  // this hook saves the board itself, for Undo.
  const offerDownload = useAdoptFoundBoard({ follow: false });

  // Config-level callbacks: they run after the bind has closed the modal.
  const { mutateAsync: followBoard } = useFollowBoard({
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
      const reportPick = (followed: boolean) => {
        onBound?.(board, { pickSource: 'friends', section, position, followed }).catch(reportError);
      };
      activate(board, { pickSource: 'friends', section, position }).then(
        () => {
          void offerDownload(board);
          if (board.isFollowedByMe === true) {
            reportPick(false);
            return;
          }
          // `mutateAsync`, not `mutate`: the bind has closed the modal, and a
          // per-call callback dies with the screen. The failure is already
          // reported and toasted by the hook's own `onFollowError`.
          followBoard(board).then(
            () => reportPick(true),
            () => reportPick(false),
          );
        },
        () => showToast(t('mobile.boardSwitchError'), 'error'),
      );
    },
    [activate, followBoard, offerDownload, onBound, beforeClimb, section, showToast, t],
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
        // Resolves on the write: the action refreshes the friend lists without
        // holding the sheet open for it, and never sets Requested by hand.
        await runAccessAction({ action, kind: 'board', resourceId: target.preview.uuid });
        close();
      } catch (error: unknown) {
        const reason = friendBoardAccessError(error, getConnectivitySnapshot().effectiveOffline, action);
        if (reason === 'failed') reportError(error);
        setSheetError(reason);
      }
    },
    [target, runAccessAction, close],
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
