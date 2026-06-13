// The single source of truth for the mobile user's **active board** — the one
// they picked from the boards tab, used by the BLE wrapper, the shared
// BoardProvider, the climb list, and the play drawer.
//
// Backed by AsyncStorage (`active-board-store`) so the choice survives a cold
// start. There is deliberately **no server-default fallback**: a user with no
// stored board has `null`, and the app routes them to the board picker rather
// than silently picking a board for them. Exposed through React Query so every
// reader updates reactively the instant the board switches.
//
// The queryFn returns `UserBoard | null`.

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getStoredActiveBoard, setStoredActiveBoard } from '../active-board-store';
import { getHttpClient } from './client';
import { GET_BOARD, type GetBoardQueryResponse } from './operations';

export const ACTIVE_BOARD_QUERY_KEY = ['activeBoard'] as const;

function hasNumericBoardId(board: UserBoard): boolean {
  return typeof (board as { id?: unknown }).id === 'number';
}

async function hydrateStoredActiveBoard(): Promise<UserBoard | null> {
  const storedBoard = await getStoredActiveBoard();
  if (!storedBoard) return null;
  if (hasNumericBoardId(storedBoard)) return storedBoard;

  try {
    const response = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, { boardUuid: storedBoard.uuid });
    if (response.board && hasNumericBoardId(response.board)) {
      await setStoredActiveBoard(response.board);
      return response.board;
    }
  } catch {
    // Keep the existing v2 selection available for board config consumers. It
    // just won't be used as a tick boardId until a network fetch hydrates it.
  }

  return storedBoard;
}

/**
 * Read the active board from storage. Returns `null` when the user hasn't
 * picked one yet — callers surface the board picker rather than defaulting.
 */
export function useActiveBoard() {
  return useQuery({
    queryKey: ACTIVE_BOARD_QUERY_KEY,
    queryFn: () => hydrateStoredActiveBoard(),
    // The stored board is authoritative until the user explicitly switches
    // (which calls setActiveBoard and updates the cache directly), so there's
    // no value in background refetching here.
    staleTime: Infinity,
  });
}

/**
 * Returns a setter that records the user's board choice: persisted to storage
 * (survives relaunch) and written straight into the `['activeBoard']` cache so
 * every reader re-renders with the new board immediately, no refetch.
 */
export function useSetActiveBoard() {
  const queryClient = useQueryClient();
  return useCallback(
    async (board: UserBoard) => {
      await setStoredActiveBoard(board);
      queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, board);
    },
    [queryClient],
  );
}
