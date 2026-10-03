import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { SprayWallImportProgress, UserBoard } from '@boardsesh/shared-schema';
import { GET_SPRAY_IMPORT_PROGRESS } from '@boardsesh/graphql/operations/spray-detection';
import { getHttpClient } from '../graphql/client';
import { useIsOffline } from '../../hooks/use-is-offline';

export const SPRAY_IMPORT_PROGRESS_QUERY_KEY = ['sprayImportProgress'] as const;

/** One small status read for the displayed boards, never a poll in each row. */
export function useSprayImportProgress(boards: UserBoard[]) {
  const focused = useIsFocused();
  const offline = useIsOffline();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  const wallUuids = useMemo(
    () =>
      boards
        .filter((board) => board.boardType === 'spray' && board.canEdit)
        .map((board) => board.uuid)
        .sort(),
    [boards],
  );
  const query = useQuery({
    queryKey: [...SPRAY_IMPORT_PROGRESS_QUERY_KEY, wallUuids],
    enabled: focused && foreground && !offline && wallUuids.length > 0,
    queryFn: async () => {
      const response = await getHttpClient().request<{ sprayWallImportProgress: SprayWallImportProgress[] }>(
        GET_SPRAY_IMPORT_PROGRESS,
        { wallUuids },
      );
      return response.sprayWallImportProgress;
    },
    staleTime: 0,
    refetchInterval: (current) => {
      const imports = current.state.data ?? boards.flatMap((board) => (board.sprayImport ? [board.sprayImport] : []));
      return focused &&
        foreground &&
        !offline &&
        imports.some((progress) => progress.stage === 'queued' || progress.stage === 'running')
        ? 5000
        : false;
    },
    refetchIntervalInBackground: false,
  });
  const mergedBoards = useMemo(() => {
    if (!query.data) return boards;
    const imports = new Map(query.data.map((progress) => [progress.wallUuid, progress]));
    const requested = new Set(wallUuids);
    return boards.map((board) => {
      if (!requested.has(board.uuid)) return board;
      const sprayImport = imports.get(board.uuid) ?? null;
      return board.sprayImport === sprayImport ? board : { ...board, sprayImport };
    });
  }, [boards, query.data, wallUuids]);
  return { boards: mergedBoards, stale: offline || query.isError };
}
