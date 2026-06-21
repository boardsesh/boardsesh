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
import { InteractionManager } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getStoredActiveBoard, setStoredActiveBoard, clearStoredActiveBoard } from '../active-board-store';

export const ACTIVE_BOARD_QUERY_KEY = ['activeBoard'] as const;
const DEFERRED_ACTIVE_BOARD_PUBLISH_TIMEOUT_MS = 450;

function runAfterInteractionsWithTimeout(callback: () => void, timeoutMs = DEFERRED_ACTIVE_BOARD_PUBLISH_TIMEOUT_MS) {
  let settled = false;
  const publish = () => {
    if (settled) return;
    settled = true;
    callback();
  };

  const interactionHandle = InteractionManager.runAfterInteractions(publish);
  const timeout = setTimeout(publish, timeoutMs);

  return () => {
    settled = true;
    interactionHandle.cancel();
    clearTimeout(timeout);
  };
}

/**
 * Read the active board from storage. Returns `null` when the user hasn't
 * picked one yet — callers surface the board picker rather than defaulting.
 */
export function useActiveBoard() {
  return useQuery({
    queryKey: ACTIVE_BOARD_QUERY_KEY,
    queryFn: () => getStoredActiveBoard(),
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

/**
 * Persist the active board without publishing it into React Query yet.
 * Used by Android board-picker activation so the modal dismissal can finish
 * before active-board subscribers mount heavier board-backed surfaces.
 */
export function usePersistActiveBoard() {
  return useCallback(async (board: UserBoard) => {
    await setStoredActiveBoard(board);
  }, []);
}

/**
 * Publish a previously-persisted active board into the React Query cache.
 * Kept separate from persistence for Android modal-transition ordering.
 */
function usePublishActiveBoard() {
  const queryClient = useQueryClient();
  return useCallback(
    (board: UserBoard) => {
      queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, board);
    },
    [queryClient],
  );
}

export type DeferredActiveBoardPublishOptions = {
  onPublished?: () => void;
  timeoutMs?: number;
};

/**
 * Publish after the native interaction queue settles, with a timeout fallback.
 * The fallback is important: a leaked interaction handle must not leave the
 * app forever showing the pre-selection screen after a successful board write.
 */
export function usePublishActiveBoardAfterInteractions() {
  const publishActiveBoard = usePublishActiveBoard();
  return useCallback(
    (board: UserBoard, options?: DeferredActiveBoardPublishOptions) => {
      return runAfterInteractionsWithTimeout(() => {
        publishActiveBoard(board);
        options?.onPublished?.();
      }, options?.timeoutMs);
    },
    [publishActiveBoard],
  );
}

/**
 * Returns a clearer that drops the active board: removed from storage and the
 * `['activeBoard']` cache set to `null`. Used when the active board is deleted
 * or unfollowed — the app's contract is "no active board → route to the picker"
 * (see this module's header), so we never auto-pick a replacement.
 */
export function useClearActiveBoard() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await clearStoredActiveBoard();
    queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, null);
  }, [queryClient]);
}
