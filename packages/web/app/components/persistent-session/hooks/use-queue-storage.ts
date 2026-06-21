import { useState, useCallback, useEffect, useRef } from 'react';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import type { BoardDetails } from '@/app/lib/types';
import { getPreference, removePreference } from '@/app/lib/user-preferences-db';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_SESSION_SUMMARY, type GetSessionSummaryResponse } from '@boardsesh/graphql/operations/sessions';
import { getClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { type ActiveSessionInfo, ACTIVE_SESSION_KEY, DEBUG } from '../types';

type UseQueueStorageArgs = {
  activeSession: ActiveSessionInfo | null;
  setActiveSession: (val: ActiveSessionInfo) => void;
  /** Called when a restored session was already auto-finished by the backend */
  onSessionAutoFinished?: (summary: SessionSummary, boardType: string | null) => void;
  wsAuthToken?: string | null;
  isAuthLoading?: boolean;
};

export type QueueStorageState = {
  localQueue: LocalClimbQueueItem[];
  localCurrentClimbQueueItem: LocalClimbQueueItem | null;
  localBoardPath: string | null;
  localBoardDetails: BoardDetails | null;
  isLocalQueueLoaded: boolean;
};

export type QueueStorageActions = {
  setLocalQueueState: (
    queue: LocalClimbQueueItem[],
    currentItem: LocalClimbQueueItem | null,
    boardPath: string,
    boardDetails: BoardDetails,
  ) => void;
  clearLocalQueue: () => void;
};

export function useQueueStorage({
  activeSession,
  setActiveSession,
  onSessionAutoFinished = () => {},
  wsAuthToken = null,
  isAuthLoading = false,
}: UseQueueStorageArgs): QueueStorageState & QueueStorageActions {
  const [localQueue, setLocalQueue] = useState<LocalClimbQueueItem[]>([]);
  const [localCurrentClimbQueueItem, setLocalCurrentClimbQueueItem] = useState<LocalClimbQueueItem | null>(null);
  const [localBoardPath, setLocalBoardPath] = useState<string | null>(null);
  const [localBoardDetails, setLocalBoardDetails] = useState<BoardDetails | null>(null);
  const [isLocalQueueLoaded, setIsLocalQueueLoaded] = useState(false);
  // Flips true only after we ran the auto-finished pre-flight with a real
  // token (or determined there was no persisted session at all). The no-token
  // branch deliberately leaves this false so a later non-null `wsAuthToken`
  // re-fires the effect and gets its chance at the pre-flight.
  const hasRunPreflightRef = useRef(false);
  // Flips true the first time we successfully read the persisted session and
  // committed it to `activeSession`. Prevents double-activation on the
  // re-fire after `wsAuthToken` arrives.
  const hasActivatedRef = useRef(false);

  // Ref for activeSession so callbacks have stable identity
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;

  // One-time cleanup: delete the old IndexedDB queue database if it exists
  useEffect(() => {
    if (typeof window !== 'undefined' && window.indexedDB) {
      window.indexedDB.deleteDatabase('boardsesh-queue');
    }
  }, []);

  // Restore party session once auth has resolved.
  //
  // The pre-flight auto-finished check needs a real bearer token —
  // `fetchAutoFinishedSummary` short-circuits on `!authToken`. Two valid
  // post-`isAuthLoading=false` states matter here:
  //   - authenticated (or sign-in arrived later): wsAuthToken is a string;
  //     run the pre-flight, surface the summary if the backend ended the
  //     session, then mark the pre-flight done.
  //   - anonymous or auth-fetch error: wsAuthToken stays null; restore the
  //     UI optimistically so the queue isn't blocked, but DO NOT mark the
  //     pre-flight done — a later non-null wsAuthToken (e.g. user signs in
  //     after the page loads) re-fires this effect and gets a real chance.
  //
  // The diagnostic log on the no-token branch is unconditional so a
  // silent fall-through (e.g. token fetch repeatedly fails) is visible.
  useEffect(() => {
    if (isAuthLoading) return;
    if (hasRunPreflightRef.current) return;

    async function restoreState() {
      try {
        const persisted = await getPreference<ActiveSessionInfo>(ACTIVE_SESSION_KEY);
        if (persisted && persisted.sessionId && persisted.boardPath && persisted.boardDetails) {
          // Cookie wins over stale IndexedDB — skip activation and let BoardSessionBridge activate the cookie's session. Leave IndexedDB intact so an unvalidated cookie (e.g. legacy ?session= migration) can't wipe a recoverable entry.
          const cookieSessionId = getClimbSessionCookie();
          if (cookieSessionId && cookieSessionId !== persisted.sessionId) {
            if (DEBUG)
              console.info('[PersistentSession] Cookie session differs from persisted; skipping restore.', {
                cookieSessionId,
                persistedSessionId: persisted.sessionId,
              });
            hasRunPreflightRef.current = true;
            setIsLocalQueueLoaded(true);
            return;
          }

          if (DEBUG) console.info('[PersistentSession] Restoring persisted session:', persisted.sessionId);

          if (!wsAuthToken) {
            console.info(
              '[PersistentSession] No auth token after auth resolved; restoring optimistically. Will retry the auto-finished pre-flight if a token arrives.',
            );
            if (!hasActivatedRef.current) {
              hasActivatedRef.current = true;
              setActiveSession(persisted);
            }
            setIsLocalQueueLoaded(true);
            return;
          }

          const autoFinished = await fetchAutoFinishedSummary(persisted, wsAuthToken);
          hasRunPreflightRef.current = true;
          if (autoFinished) {
            if (DEBUG) console.info('[PersistentSession] Session was auto-finished, showing summary');
            await removePreference(ACTIVE_SESSION_KEY);
            onSessionAutoFinished(autoFinished.summary, autoFinished.boardType);
            setIsLocalQueueLoaded(true);
            return;
          }

          if (!hasActivatedRef.current) {
            hasActivatedRef.current = true;
            setActiveSession(persisted);
          }
          setIsLocalQueueLoaded(true);
          return;
        }
      } catch (error) {
        console.error('[PersistentSession] Failed to restore persisted session:', error);
      }

      // No persisted session, or read failed — nothing the token would change.
      hasRunPreflightRef.current = true;
      setIsLocalQueueLoaded(true);
    }

    void restoreState();
  }, [isAuthLoading, wsAuthToken, onSessionAutoFinished, setActiveSession]);

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
    if (DEBUG) console.info('[PersistentSession] Clearing local queue');
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

// Null summary is ambiguous (fresh session with no ticks vs. missing) so we treat it as "still active".
export async function fetchAutoFinishedSummary(
  persisted: ActiveSessionInfo,
  authToken: string | null,
): Promise<{ summary: SessionSummary; boardType: string | null } | null> {
  if (!authToken) return null;
  try {
    const httpClient = createGraphQLHttpClient(authToken);
    const response = await httpClient.request<GetSessionSummaryResponse>(GET_SESSION_SUMMARY, {
      sessionId: persisted.sessionId,
    });
    const summary = response?.sessionSummary ?? null;
    if (summary?.endedAt) {
      return { summary, boardType: persisted.parsedParams?.board_name ?? null };
    }
    return null;
  } catch (error) {
    if (DEBUG) console.warn('[PersistentSession] Auto-finished pre-check failed, falling through:', error);
    return null;
  }
}
