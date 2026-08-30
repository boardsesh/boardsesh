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
import {
  captureActiveBoardStorageNamespace,
  getStoredActiveBoard,
  setStoredActiveBoard,
  clearStoredActiveBoard,
  type ActiveBoardStorageNamespace,
} from '../active-board-store';
import { getCurrentUserStorageOwner, type UserStorageOwner } from '../user-storage-owner';

export const ACTIVE_BOARD_QUERY_KEY = ['activeBoard'] as const;

// Active-board writes can overlap even on one JS thread because persistence is
// async. Record each write *intent* synchronously, before its first await, and
// serialize the storage operations in intent order. That gives us two useful
// guarantees:
//
// 1. a stale self-heal fetch can see that the user has already started picking
//    another board even before React Query has rendered that new selection;
// 2. if an older storage write is already in progress, the newer user choice is
//    queued behind it and therefore remains the final persisted value.
let activeBoardWriteGeneration = 0;
let activeBoardWriteQueue: Promise<void> = Promise.resolve();
let activeBoardWriteNamespace: ActiveBoardStorageNamespace | null = null;

type ActiveBoardStorageWrite = () => Promise<void>;

export function getActiveBoardWriteGeneration(): number {
  syncActiveBoardWriteNamespace();
  return activeBoardWriteGeneration;
}

function syncActiveBoardWriteNamespace(): ActiveBoardStorageNamespace {
  const namespace = captureActiveBoardStorageNamespace();
  if (activeBoardWriteNamespace !== null && namespace !== activeBoardWriteNamespace) {
    // A conditional self-heal that began in the previous mode is stale even if
    // no explicit board write happened during the switch.
    activeBoardWriteGeneration += 1;
  }
  activeBoardWriteNamespace = namespace;
  return namespace;
}

function beginActiveBoardWrite(): { generation: number; namespace: ActiveBoardStorageNamespace } {
  const namespace = syncActiveBoardWriteNamespace();
  activeBoardWriteGeneration += 1;
  return { generation: activeBoardWriteGeneration, namespace };
}

function enqueueActiveBoardWrite(
  generation: number,
  writeStorage: ActiveBoardStorageWrite,
  commitCache: () => void,
): Promise<boolean> {
  const operation = activeBoardWriteQueue.then(async () => {
    // Always execute queued storage operations in intent order. In particular,
    // auth cleanup may target the previous user's scoped key and must not be
    // skipped merely because the next user already selected a board.
    await writeStorage();

    // A newer intent may have arrived while AsyncStorage was in flight. Its
    // write is queued next, so do not briefly roll the React Query cache back.
    if (generation !== activeBoardWriteGeneration) return false;
    commitCache();
    return true;
  });

  // A failed write must not poison the queue for every later board selection.
  activeBoardWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function enqueueCurrentGenerationWrite(
  expectedGeneration: number,
  writeStorage: (namespace: ActiveBoardStorageNamespace) => Promise<void>,
  commitCache: () => void,
): Promise<boolean> {
  const namespace = syncActiveBoardWriteNamespace();
  if (expectedGeneration !== activeBoardWriteGeneration) return Promise.resolve(false);

  // Claim the write synchronously. A user choice that starts after this point
  // receives a newer generation and is queued after the heal, so it still wins.
  const { generation } = beginActiveBoardWrite();
  return enqueueActiveBoardWrite(generation, () => writeStorage(namespace), commitCache);
}

/**
 * Auth transitions clear persisted board state outside React hooks. Route that
 * clear through the same queue so an older selection cannot finish afterward
 * and repopulate storage for the signed-out/next user.
 */
export async function clearStoredActiveBoardCoordinated(owner?: UserStorageOwner | null): Promise<void> {
  const { generation, namespace } = beginActiveBoardWrite();
  await enqueueActiveBoardWrite(
    generation,
    () => clearStoredActiveBoard(owner, namespace),
    () => {},
  );
}

/** Test-only reset; callers must invoke it only after pending writes settle. */
export function resetActiveBoardWriteCoordinatorForTests(): void {
  activeBoardWriteGeneration = 0;
  activeBoardWriteQueue = Promise.resolve();
  activeBoardWriteNamespace = null;
}

/**
 * Read the active board from storage. Returns `null` when the user hasn't
 * picked one yet — callers surface the board picker rather than defaulting.
 */
export function useActiveBoard() {
  const namespace = captureActiveBoardStorageNamespace();
  return useQuery({
    queryKey: ACTIVE_BOARD_QUERY_KEY,
    queryFn: () => getStoredActiveBoard(undefined, namespace),
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
      const { generation, namespace } = beginActiveBoardWrite();
      const owner = getCurrentUserStorageOwner();
      await enqueueActiveBoardWrite(
        generation,
        () => setStoredActiveBoard(board, owner, namespace),
        () => queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, board),
      );
    },
    [queryClient],
  );
}

/**
 * Conditional setter used by tombstone self-healing. The generation is
 * captured before the network request; this refuses to write if any explicit
 * selection/clear started while that request was in flight.
 */
export function useSetActiveBoardIfCurrentGeneration() {
  const queryClient = useQueryClient();
  return useCallback(
    (expectedGeneration: number, board: UserBoard): Promise<boolean> => {
      const owner = getCurrentUserStorageOwner();
      return enqueueCurrentGenerationWrite(
        expectedGeneration,
        (namespace) => setStoredActiveBoard(board, owner, namespace),
        () => queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, board),
      );
    },
    [queryClient],
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
    const { generation, namespace } = beginActiveBoardWrite();
    const owner = getCurrentUserStorageOwner();
    await enqueueActiveBoardWrite(
      generation,
      () => clearStoredActiveBoard(owner, namespace),
      () => queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, null),
    );
  }, [queryClient]);
}

/** Conditional counterpart to `useClearActiveBoard` for stale-board healing. */
export function useClearActiveBoardIfCurrentGeneration() {
  const queryClient = useQueryClient();
  return useCallback(
    (expectedGeneration: number): Promise<boolean> => {
      const owner = getCurrentUserStorageOwner();
      return enqueueCurrentGenerationWrite(
        expectedGeneration,
        (namespace) => clearStoredActiveBoard(owner, namespace),
        () => queryClient.setQueryData<UserBoard | null>(ACTIVE_BOARD_QUERY_KEY, null),
      );
    },
    [queryClient],
  );
}
