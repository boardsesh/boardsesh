import { useState, useCallback, useEffect, useRef } from 'react';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { BoardDetails } from '@/app/lib/types';
import { getPreference } from '@/app/lib/user-preferences-db';
import type { ActiveSessionInfo } from '../types';
import { ACTIVE_SESSION_KEY, DEBUG } from '../types';

interface UseQueueStorageArgs {
  activeSession: ActiveSessionInfo | null;
  setActiveSession: (val: ActiveSessionInfo | null) => void;
}

export interface QueueStorageState {
  localQueue: LocalClimbQueueItem[];
  localCurrentClimbQueueItem: LocalClimbQueueItem | null;
  localBoardPath: string | null;
  localBoardDetails: BoardDetails | null;
  isLocalQueueLoaded: boolean;
}

export interface QueueStorageActions {
  setLocalQueueState: (
    queue: LocalClimbQueueItem[],
    currentItem: LocalClimbQueueItem | null,
    boardPath: string,
    boardDetails: BoardDetails,
  ) => void;
  clearLocalQueue: () => void;
}

export function useQueueStorage({ activeSession, setActiveSession }: UseQueueStorageArgs): QueueStorageState & QueueStorageActions {
  const [localQueue, setLocalQueue] = useState<LocalClimbQueueItem[]>([]);
  const [localCurrentClimbQueueItem, setLocalCurrentClimbQueueItem] = useState<LocalClimbQueueItem | null>(null);
  const [localBoardPath, setLocalBoardPath] = useState<string | null>(null);
  const [localBoardDetails, setLocalBoardDetails] = useState<BoardDetails | null>(null);
  const [isLocalQueueLoaded, setIsLocalQueueLoaded] = useState(false);

  // Ref for activeSession so callbacks have stable identity
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  // One-time cleanup: delete the old IndexedDB queue database if it exists
  useEffect(() => {
    if (typeof window !== 'undefined' && window.indexedDB) {
      window.indexedDB.deleteDatabase('boardsesh-queue');
    }
  }, []);

  // Auto-restore session state on mount (party session only — local queues are no longer persisted)
  useEffect(() => {
    async function restoreState() {
      // Try to restore party session
      try {
        const persisted = await getPreference<ActiveSessionInfo>(ACTIVE_SESSION_KEY);
        if (persisted && persisted.sessionId && persisted.boardPath && persisted.boardDetails) {
          if (DEBUG) console.log('[PersistentSession] Restoring persisted session:', persisted.sessionId);
          setActiveSession(persisted);
          setIsLocalQueueLoaded(true);
          return;
        }
      } catch (error) {
        console.error('[PersistentSession] Failed to restore persisted session:', error);
      }

      setIsLocalQueueLoaded(true);
    }

    restoreState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // Local queue management (in-memory only)
  const setLocalQueueState = useCallback(
    (
      newQueue: LocalClimbQueueItem[],
      newCurrentItem: LocalClimbQueueItem | null,
      boardPath: string,
      boardDetails: BoardDetails,
    ) => {
      // Don't store local queue if party mode is active
      if (activeSessionRef.current) return;

      setLocalQueue(newQueue);
      setLocalCurrentClimbQueueItem(newCurrentItem);
      setLocalBoardPath(boardPath);
      setLocalBoardDetails(boardDetails);
    },
    [],
  );

  const clearLocalQueue = useCallback(() => {
    if (DEBUG) console.log('[PersistentSession] Clearing local queue');
    setLocalQueue([]);
    setLocalCurrentClimbQueueItem(null);
    setLocalBoardPath(null);
    setLocalBoardDetails(null);
  }, []);

  return {
    localQueue,
    localCurrentClimbQueueItem,
    localBoardPath,
    localBoardDetails,
    isLocalQueueLoaded,
    setLocalQueueState,
    clearLocalQueue,
  };
}
