import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useActiveBoard } from '../../lib/graphql/use-active-board';

/** Browsing the selected board must not activate it again or change the session. */
export function useSessionBoardNavigation() {
  const router = useRouter();
  const boardQuery = useActiveBoard();
  const activeBoard = boardQuery.data;
  const hasNoBoard = boardQuery.isSuccess && activeBoard === null;

  const browseClimbs = useCallback(() => {
    if (activeBoard) router.navigate('/(tabs)/climbs');
  }, [activeBoard, router]);

  const openBoardSwitcher = useCallback(() => {
    if (!activeBoard && !hasNoBoard) return;
    router.push({
      pathname: '/boards',
      params: { returnTo: activeBoard ? '/(tabs)/record' : '/(tabs)/climbs' },
    });
  }, [activeBoard, hasNoBoard, router]);

  const { refetch } = boardQuery;
  const retryBoard = useCallback(() => {
    void refetch();
  }, [refetch]);

  return { boardQuery, hasNoBoard, browseClimbs, openBoardSwitcher, retryBoard };
}
