// The gym page's board rows: a tap climbs on the board, and the ⋯ is the shared
// board menu (`boardCardMenuEntries`), so a row offers exactly what a picker card
// offers for the same board. Staff get Remove from gym and Delete from the
// server's flags; a climber gets Remove from your boards on a board they saved.
// With the `directory-reports` flag on, a climber who can't fix a board gets
// Report a problem (Reported once theirs waits), and the creator and staff get
// See reports while a report waits on them (`useGymBoardReports` hosts both
// sheets in the page's route).
//
// The confirms and mutations are the picker's (`runMyBoardAction` in
// app/boards/index.tsx), with the same copy keys, so the two places that remove
// a board from a gym say the same thing.

import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { boardOriginFor, type UserBoard } from '@boardsesh/shared-schema';
import type { BoardCardMenu, DiscoveryBoardItem } from '../board-discovery/BoardDiscoveryCardView';
import {
  boardCardMenuAllows,
  boardCardReportAction,
  type BoardCardManageAction,
  type BoardCardMenuAction,
  type BoardCardMenuCapabilities,
  type BoardCardMenuItemState,
} from '../board-discovery/board-card-menu';
import type { ReportReviewAction } from '../report-problem/ReportReviewSheet';
import { useBoardCardMenuLabels } from '../board-discovery/use-board-card-menu-labels';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { isSystemBoardDeleteInsteadError } from '../../lib/graphql/extract-error-message';
import { useDeleteBoard, useDetachBoardFromGym, useLinkBoardToGym, useUnfollowBoard } from '../../lib/graphql/hooks';
import { GYM_BOARDS_QUERY_KEY } from '../../lib/graphql/query-keys';
import {
  getActiveBoardWriteGeneration,
  useActiveBoard,
  useClearActiveBoardIfCurrentGeneration,
  useSetActiveBoardIfCurrentGeneration,
} from '../../lib/graphql/use-active-board';
import { hapticSelection } from '../../lib/haptics';
import { useConfirm } from '../../providers/dialog-provider';
import { useDirectoryReportsEnabled } from '../../providers/feature-flags-provider';
import { useQueueActions } from '../../providers/queue-provider';
import { useToast } from '../../providers/toast-provider';
import { forgetOfflineBoard } from '../../settings';
import { useGymBoardReports } from './use-gym-board-reports';

/** The row's state as the menu read it, read again when a row runs. */
function itemMenuState(item: DiscoveryBoardItem): BoardCardMenuItemState {
  return {
    isPinned: false,
    offlineState: undefined,
    isViewerOwner: item.isViewerOwner,
    isImport: item.sprayImport != null,
    canEdit: item.canEdit,
    canDelete: item.canDelete,
    canRemoveFromGym: item.canRemoveFromGym,
    gymName: item.gymName,
    openReportCount: item.openReportCount,
    viewerHasOpenReport: item.viewerHasOpenReport,
  };
}

/** The same rule the menu drew the row with, read again when the row runs. */
function itemAllows(item: DiscoveryBoardItem, action: BoardCardManageAction): boolean {
  return boardCardMenuAllows(itemMenuState(item), action);
}

/** A board the review sheet showed, as the menu would read it. It need not be a row on the page. */
function boardMenuState(board: UserBoard, viewerId: string | undefined, gymName: string): BoardCardMenuItemState {
  return {
    isPinned: false,
    offlineState: undefined,
    isViewerOwner: viewerId === undefined ? undefined : board.ownerId === viewerId,
    isImport: board.sprayImport != null,
    canEdit: board.canEdit,
    canDelete: board.canDelete,
    canRemoveFromGym: board.canRemoveFromGym,
    gymName: board.gymName ?? gymName,
  };
}

export type GymBoardMenuOptions = {
  gymUuid: string;
  gymName: string;
  boards: readonly UserBoard[];
  viewerId: string | undefined;
  /**
   * Managing rows (edit, remove, delete, unfollow) need an account the page
   * resolved and a connection: every one of them is a network mutation. Report
   * a problem and See reports need the same, and the `directory-reports` flag.
   */
  canManage: boolean;
  returnTo: BoardReturnTo;
};

export type GymBoardMenu = {
  /** One object for every row, so a row re-renders only when its own item changes. */
  menu: BoardCardMenu;
  /** A tap on a row: climb on that board. */
  onPressBoard: (item: DiscoveryBoardItem) => void;
  /** The report and review sheets the rows open. Mount in the gym page's route. */
  sheets: ReactNode;
};

export function useGymBoardMenu({
  gymUuid,
  gymName,
  boards,
  viewerId,
  canManage,
  returnTo,
}: GymBoardMenuOptions): GymBoardMenu {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const labels = useBoardCardMenuLabels();
  const { data: activeBoard } = useActiveBoard();
  const clearActiveBoard = useClearActiveBoardIfCurrentGeneration();
  const setActiveBoardIfCurrentGeneration = useSetActiveBoardIfCurrentGeneration();
  const { clearSession } = useQueueActions();
  // `mutateAsync` is bound once per observer; the mutation objects are not.
  const deleteBoardAsync = useDeleteBoard().mutateAsync;
  const unfollowBoardAsync = useUnfollowBoard().mutateAsync;
  const linkBoardToGymAsync = useLinkBoardToGym().mutateAsync;
  const detachBoardFromGymAsync = useDetachBoardFromGym().mutateAsync;
  // The same bind every picker uses: write the board, then return to the tab.
  const activateBoard = useActivateBoard({ returnTo });

  const boardsByUuid = useMemo(() => new Map(boards.map((board) => [board.uuid, board])), [boards]);
  // A board being removed, deleted or unfollowed can't also be climbed on or acted on twice.
  const inFlight = useRef(new Set<string>());
  const activeUuid = activeBoard?.uuid;

  const onPressBoard = useCallback(
    (item: DiscoveryBoardItem) => {
      const board = boardsByUuid.get(item.key);
      if (!board || inFlight.current.has(item.key)) return;
      void activateBoard(board);
    },
    [boardsByUuid, activateBoard],
  );

  const removeFromGym = useCallback(
    async (board: UserBoard) => {
      const origin = boardOriginFor(board, viewerId);
      const confirmed = await confirm({
        title: t('gymBoards.removeTitle', { board: board.name, gym: gymName }),
        message:
          origin === 'own'
            ? t('gymBoards.removeBodyOwn', { gym: gymName })
            : origin === 'synced'
              ? t('gymBoards.removeBodySynced', { gym: gymName })
              : origin === 'climber'
                ? t('gymBoards.removeBodyOther', { name: board.ownerDisplayName ?? '', gym: gymName })
                : t('gymBoards.removeBodyOtherHidden', { gym: gymName }),
        confirmLabel: t('gymBoards.removeConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
      });
      if (!confirmed) return;
      const wasActive = activeUuid === board.uuid;
      const generation = getActiveBoardWriteGeneration();
      try {
        // The creator unlinks their own board; anyone else is staff, whose
        // removal also keeps the creator from linking it straight back.
        if (origin === 'own') await linkBoardToGymAsync({ boardUuid: board.uuid, gymUuid: null });
        else await detachBoardFromGymAsync({ boardUuid: board.uuid, gymUuid });
        showToast(t('gymBoards.removed', { gym: gymName }), 'success');
      } catch (error) {
        showToast(
          isSystemBoardDeleteInsteadError(error) ? t('gymBoards.removeSyncedError') : t('gymBoards.removeFailed'),
          'error',
        );
        return;
      }
      // The active board is a stored copy no invalidation reaches; without this
      // the play drawer keeps naming the gym the board just left.
      if (wasActive) {
        try {
          await setActiveBoardIfCurrentGeneration(generation, {
            ...board,
            gymId: null,
            gymUuid: null,
            gymName: null,
            gymIsListed: null,
            canRemoveFromGym: false,
          });
        } catch (error) {
          console.warn('Could not refresh the active board after removing it from its gym', error);
        }
      }
    },
    [
      viewerId,
      confirm,
      t,
      gymName,
      gymUuid,
      activeUuid,
      linkBoardToGymAsync,
      detachBoardFromGymAsync,
      showToast,
      setActiveBoardIfCurrentGeneration,
    ],
  );

  const deleteBoard = useCallback(
    async (board: UserBoard) => {
      const origin = boardOriginFor(board, viewerId);
      const isSprayWall = board.boardType === 'spray';
      const confirmed = await confirm({
        title: isSprayWall ? t('mobile.manage.deleteWallTitle') : t('gymBoards.deleteTitle', { board: board.name }),
        message: isSprayWall
          ? t('mobile.manage.deleteWallMessage', { name: board.name })
          : origin === 'own'
            ? t('gymBoards.deleteBodyOwn')
            : origin === 'synced'
              ? t('gymBoards.deleteBodySynced')
              : origin === 'climber'
                ? t('gymBoards.deleteBodyOther', { name: board.ownerDisplayName ?? '' })
                : t('gymBoards.deleteBodyOtherHidden'),
        confirmLabel: t('mobile.manage.deleteConfirm'),
        cancelLabel: t('mobile.manage.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      const wasActive = activeUuid === board.uuid;
      const generation = getActiveBoardWriteGeneration();
      try {
        await deleteBoardAsync(board.uuid);
        // A card for a board the backend dropped must never reach setActiveBoard.
        forgetOfflineBoard(board.uuid);
        if (wasActive && generation === getActiveBoardWriteGeneration()) {
          await clearSession({ notifyServer: true });
          await clearActiveBoard(generation);
        }
        // `deleteBoard` refreshes the climber's own lists; this list is the gym's.
        void queryClient.invalidateQueries({ queryKey: GYM_BOARDS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ['gym', gymUuid] });
        void queryClient.invalidateQueries({ queryKey: ['gymBySlug'] });
        showToast(t('mobile.manage.deleteSuccess', { name: board.name }), 'success');
      } catch {
        showToast(t('mobile.manage.deleteError'), 'error');
      }
    },
    [
      viewerId,
      confirm,
      t,
      activeUuid,
      deleteBoardAsync,
      clearSession,
      clearActiveBoard,
      queryClient,
      gymUuid,
      showToast,
    ],
  );

  const unfollow = useCallback(
    async (board: UserBoard) => {
      const wasActive = activeUuid === board.uuid;
      // One tap, except on the board the climber is on, where it also clears
      // the selection out from under a live session.
      if (wasActive) {
        const confirmed = await confirm({
          title: t('mobile.manage.unfollowTitle'),
          message: t('mobile.manage.unfollowMessage', { name: board.name }),
          confirmLabel: t('mobile.manage.unfollowConfirm'),
          cancelLabel: t('mobile.manage.cancel'),
        });
        if (!confirmed) return;
      }
      const generation = getActiveBoardWriteGeneration();
      try {
        await unfollowBoardAsync(board.uuid);
        forgetOfflineBoard(board.uuid);
        if (wasActive && generation === getActiveBoardWriteGeneration()) {
          await clearSession({ notifyServer: true });
          await clearActiveBoard(generation);
        }
        // The row's follow state comes from the gym's list.
        void queryClient.invalidateQueries({ queryKey: GYM_BOARDS_QUERY_KEY });
      } catch {
        showToast(t('mobile.manage.unfollowError'), 'error');
      }
    },
    [activeUuid, confirm, t, unfollowBoardAsync, clearSession, clearActiveBoard, queryClient, showToast],
  );

  /** Runs a managing row on a board the caller already checked the row against. */
  const runOnBoard = useCallback(
    async (board: UserBoard, action: BoardCardManageAction) => {
      if (inFlight.current.has(board.uuid)) return;
      if (action === 'edit') {
        hapticSelection();
        router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
        return;
      }
      inFlight.current.add(board.uuid);
      try {
        if (action === 'remove_from_gym') await removeFromGym(board);
        else if (action === 'delete') await deleteBoard(board);
        else await unfollow(board);
      } finally {
        inFlight.current.delete(board.uuid);
      }
    },
    [router, removeFromGym, deleteBoard, unfollow],
  );

  const runManageAction = useCallback(
    async (item: DiscoveryBoardItem, action: BoardCardManageAction) => {
      const board = boardsByUuid.get(item.key);
      if (!board || !itemAllows(item, action)) return;
      await runOnBoard(board, action);
    },
    [boardsByUuid, runOnBoard],
  );

  // The review sheet's board actions, the same as the picker's: Fix opens the
  // edit route (whose save tells the climbers who flagged it), Remove and
  // Delete run this page's confirms on the board the sheet showed.
  const onReviewAction = useCallback(
    (action: ReportReviewAction, board: UserBoard) => {
      if (action === 'fix') {
        hapticSelection();
        router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid, fromReport: '1' } });
        return;
      }
      if (!canManage) return;
      const manageAction = action === 'remove' ? 'remove_from_gym' : 'delete';
      if (!boardCardMenuAllows(boardMenuState(board, viewerId, gymName), manageAction)) return;
      void runOnBoard(board, manageAction);
    },
    [router, canManage, viewerId, gymName, runOnBoard],
  );

  const directoryReportsEnabled = useDirectoryReportsEnabled();
  const canReport = directoryReportsEnabled && canManage;
  const { openReport, openReview, sheets } = useGymBoardReports({ boards, viewerId, onReviewAction });

  const onAction = useCallback(
    (item: DiscoveryBoardItem, action: BoardCardMenuAction) => {
      switch (action) {
        case 'climb_here':
          onPressBoard(item);
          return;
        case 'edit':
        case 'remove_from_gym':
        case 'delete':
        case 'unfollow':
          if (!canManage) return;
          void runManageAction(item, action);
          return;
        case 'report':
        case 'review_reports': {
          if (!canReport) return;
          const board = boardsByUuid.get(item.key);
          // Only the row the board offers now: a menu drawn before the report
          // went in, or before the viewer became staff, runs nothing.
          if (!board || boardCardReportAction(itemMenuState(item)) !== action) return;
          if (action === 'report') openReport(board);
          else openReview(board);
          return;
        }
        case 'reported':
          // A disabled row: it only says the climber's report is in.
          return;
        case 'pin':
        case 'unpin':
        case 'download':
        case 'details':
          // These belong to the climber's own list and the picker; the page
          // turns them off in its capabilities.
          return;
      }
    },
    [onPressBoard, canManage, runManageAction, canReport, boardsByUuid, openReport, openReview],
  );

  const capabilities = useMemo<BoardCardMenuCapabilities>(
    () => ({ canPin: false, canDownload: false, canOpenDetails: false, canManage, canReport }),
    [canManage, canReport],
  );
  const menu = useMemo<BoardCardMenu>(() => ({ capabilities, labels, onAction }), [capabilities, labels, onAction]);
  return { menu, onPressBoard, sheets };
}
