import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useActiveBoard } from '../graphql/use-active-board';
import type { BoardReturnTo } from './board-return-to';

/**
 * The actions behind `BoardSummaryCard`: browse the board you're on, or change
 * it. Session and Home both show the card; `returnTo` is the tab the board
 * picker comes back to after a change.
 *
 * Browsing the selected board must not activate it again or change the session.
 */
export function useBoardShortcutNavigation(returnTo: BoardReturnTo, returnAfterFirstPick = false) {
  const router = useRouter();
  const boardQuery = useActiveBoard();
  const activeBoard = boardQuery.data;
  const hasNoBoard = boardQuery.isSuccess && activeBoard === null;

  const browseClimbs = useCallback(() => {
    // Keep loading/error states on the card; browsing requires a restored board.
    if (activeBoard) router.navigate('/(tabs)/climbs');
  }, [activeBoard, router]);

  const openBoardSwitcher = useCallback(() => {
    if (!activeBoard && !hasNoBoard) return;
    // A first pick still lands on Climbs: there is nothing to come back to yet.
    router.push({
      pathname: '/boards',
      params: { returnTo: activeBoard || returnAfterFirstPick ? returnTo : '/(tabs)/climbs' },
    });
  }, [activeBoard, hasNoBoard, returnTo, returnAfterFirstPick, router]);

  const { refetch } = boardQuery;
  const retryBoard = useCallback(() => {
    void refetch();
  }, [refetch]);

  return { boardQuery, hasNoBoard, browseClimbs, openBoardSwitcher, retryBoard };
}
