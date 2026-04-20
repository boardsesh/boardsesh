import { useState, useEffect, Dispatch } from 'react';
import type { BoardConfig } from '@boardsesh/shared-schema';
import type { QueueAction, ClimbQueue, ClimbQueueItem } from '../../queue-control/types';
import { normalizeQueueItem } from '@/app/lib/board-config';

interface UseQueueRestorationParams {
  isPersistentSessionActive: boolean;
  sessionId: string | null;
  baseBoardPath: string;
  dispatch: Dispatch<QueueAction>;
  persistentSession: {
    hasConnected: boolean;
    queue: { climb: unknown; uuid: string }[];
    currentClimbQueueItem: { climb: unknown; uuid: string } | null;
    isLocalQueueLoaded: boolean;
    localBoardPath: string | null;
    localQueue: { climb: unknown; uuid: string }[];
    localCurrentClimbQueueItem: { climb: unknown; uuid: string } | null;
    clearLocalQueue: () => void;
    localBoardDetails: unknown;
  };
  /**
   * Fallback `BoardConfig` used by the ingress normalizer when restoring a
   * queue whose items predate multi-board support (no `boardConfig` stamped).
   */
  fallbackBoardConfig: BoardConfig | null;
}

/**
 * Handles initial queue restoration from persistent session (party mode)
 * or from in-memory local queue state (solo mode, SPA navigation).
 *
 * Returns `hasRestored` which gates storage sync to prevent overwriting
 * valid data with empty initial reducer state.
 */
export function useQueueRestoration({
  isPersistentSessionActive,
  sessionId,
  baseBoardPath,
  dispatch,
  persistentSession,
  fallbackBoardConfig,
}: UseQueueRestorationParams) {
  // Guard to prevent syncing empty initial state before restoration completes.
  // Uses useState (not useRef) so the sync effect only sees hasRestored=true
  // in the render where state.queue already contains the restored data.
  const [hasRestored, setHasRestored] = useState(false);

  // Initialize queue state from persistent session when remounting
  useEffect(() => {
    if (isPersistentSessionActive && persistentSession.hasConnected) {
      if (persistentSession.queue.length > 0 || persistentSession.currentClimbQueueItem) {
        const normalizedQueue = (persistentSession.queue as unknown as ClimbQueueItem[]).map((item) =>
          normalizeQueueItem(item, fallbackBoardConfig),
        );
        const normalizedCurrent = persistentSession.currentClimbQueueItem
          ? normalizeQueueItem(persistentSession.currentClimbQueueItem as unknown as ClimbQueueItem, fallbackBoardConfig)
          : null;
        dispatch({
          type: 'INITIAL_QUEUE_DATA',
          payload: {
            queue: normalizedQueue,
            currentClimbQueueItem: normalizedCurrent,
          },
        });
      }
      setHasRestored(true);
    }
    // Only run on mount and when session becomes active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPersistentSessionActive, persistentSession.hasConnected]);

  // Initialize queue state from in-memory local queue (SPA navigation, non-party mode)
  useEffect(() => {
    if (isPersistentSessionActive || sessionId) return;

    if (
      persistentSession.isLocalQueueLoaded &&
      persistentSession.localBoardPath === baseBoardPath &&
      (persistentSession.localQueue.length > 0 || persistentSession.localCurrentClimbQueueItem)
    ) {
      const normalizedQueue = (persistentSession.localQueue as unknown as ClimbQueueItem[]).map((item) =>
        normalizeQueueItem(item, fallbackBoardConfig),
      );
      const normalizedCurrent = persistentSession.localCurrentClimbQueueItem
        ? normalizeQueueItem(
            persistentSession.localCurrentClimbQueueItem as unknown as ClimbQueueItem,
            fallbackBoardConfig,
          )
        : null;
      dispatch({
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: normalizedQueue as unknown as ClimbQueue,
          currentClimbQueueItem: normalizedCurrent,
        },
      });
      setHasRestored(true);
      return;
    }

    // Local queue is loaded but empty or for a different board
    setHasRestored(true);
    // Only run on mount and when isLocalQueueLoaded changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistentSession.isLocalQueueLoaded]);

  // Clear local queue if navigating to a different board configuration
  useEffect(() => {
    if (persistentSession.localBoardPath && persistentSession.localBoardPath !== baseBoardPath) {
      persistentSession.clearLocalQueue();
    }
  }, [baseBoardPath, persistentSession]);
}
