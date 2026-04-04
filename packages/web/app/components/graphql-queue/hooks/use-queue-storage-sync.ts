import { useEffect } from 'react';
import type { ClimbQueueItem } from '../../queue-control/types';
import type { BoardDetails } from '@/app/lib/types';

interface UseQueueStorageSyncParams {
  hasRestored: boolean;
  isPersistentSessionActive: boolean;
  sessionId: string | null;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  baseBoardPath: string;
  boardDetails: BoardDetails;
  isDisconnected: boolean;
  persistentSession: {
    setLocalQueueState: (
      queue: ClimbQueueItem[],
      currentItem: ClimbQueueItem | null,
      boardPath: string,
      boardDetails: BoardDetails,
    ) => void;
  };
}

/**
 * Persists queue changes to IndexedDB (via persistent session local queue)
 * when not in party mode, OR when in party mode but offline.
 * Gated by `hasRestored` to prevent overwriting valid data with empty initial
 * reducer state.
 */
export function useQueueStorageSync({
  hasRestored,
  isPersistentSessionActive,
  sessionId,
  queue,
  currentClimbQueueItem,
  baseBoardPath,
  boardDetails,
  isDisconnected,
  persistentSession,
}: UseQueueStorageSyncParams) {
  useEffect(() => {
    // Don't sync until initial restoration is complete
    if (!hasRestored) return;

    // When in party mode and online, don't sync locally (server is source of truth)
    if (isPersistentSessionActive && !isDisconnected) return;
    if (sessionId && !isPersistentSessionActive && !isDisconnected) return;

    // Sync queue state to persistent session for local storage
    persistentSession.setLocalQueueState(
      queue,
      currentClimbQueueItem,
      baseBoardPath,
      boardDetails,
    );
  }, [
    hasRestored,
    queue,
    currentClimbQueueItem,
    baseBoardPath,
    boardDetails,
    isPersistentSessionActive,
    sessionId,
    isDisconnected,
    persistentSession,
  ]);
}
