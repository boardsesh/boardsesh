import { useEffect, useRef, useCallback } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource, QueueAction, QueueState } from '@boardsesh/queue';
import { getStoredQueueSnapshot, setStoredQueueSnapshot } from '../../lib/queue-snapshot-store';
import { getStoredSessionId, clearStoredSessionId } from '../../lib/session-store';
import { getHttpClient } from '../../lib/graphql/client';
import { SESSION_STATUS, type SessionStatusQueryResponse } from '../../lib/graphql/operations';
import { reportError } from '../../lib/error-reporting';

/**
 * How long the solo snapshot save waits before writing, coalescing mutation
 * bursts (swipes, clear-queue removals) into one write.
 *
 * Exported so a test that has to outlast it derives its wait from this number
 * rather than hardcoding one that can silently drift below it.
 */
export const SOLO_QUEUE_SAVE_DEBOUNCE_MS = 500;

type UseQueuePersistenceParams = {
  dispatch: React.Dispatch<QueueAction>;
  sessionIdRef: React.RefObject<string | null>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Read inside the async cold-start closure to compare against the latest queue state. */
  stateRef: React.RefObject<QueueState>;
  /** Reactive session id — gates + re-runs the solo persist effect exactly like the original. */
  sessionId: string | null;
  /** Reactive queue/current climb — the solo persist effect's dependency array. */
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  /**
   * The board-masked source (see QueueProvider): a source stamped with another
   * board reads as null here, so the next debounced save drops it from the
   * snapshot on its own. No schema change and no key bump — `capSuggestionSource`
   * has always persisted `boardKey`, it was simply never read back.
   */
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  setPlaylistSuggestionSourceState: React.Dispatch<React.SetStateAction<PlaylistSuggestionSource | null>>;
  /**
   * False while the active-board query is still loading. Gates the save so a
   * write can't race the board read and persist a null source for the wrong
   * reason — every source masks out against an unresolved board.
   */
  activeBoardSettled: boolean;
};

/**
 * Owns the solo-queue persistence lifecycle: cold-start restore (explicit
 * session first, then the local snapshot) and the debounced solo snapshot save.
 * `snapshotHydratedRef` is shared internally by both effects — set after the
 * cold-start hydrate settles, read as the save gate — so the initial empty
 * state can never clobber a stored snapshot.
 */
export function useQueuePersistence({
  dispatch,
  sessionIdRef,
  setSessionId,
  stateRef,
  sessionId,
  queue,
  currentClimbQueueItem,
  playlistSuggestionSource,
  setPlaylistSuggestionSourceState,
  activeBoardSettled,
}: UseQueuePersistenceParams): void {
  const restoreQueueSnapshot = useCallback(
    (snapshot: {
      queue: ClimbQueueItem[];
      currentClimbQueueItem: ClimbQueueItem | null;
      playlistSuggestionSource: PlaylistSuggestionSource | null;
    }) => {
      dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: snapshot.queue, currentClimbQueueItem: snapshot.currentClimbQueueItem },
      });
      dispatch({ type: 'SET_PLAYLIST_SUGGESTION_SOURCE', payload: snapshot.playlistSuggestionSource });
      setPlaylistSuggestionSourceState(snapshot.playlistSuggestionSource);
    },
    [],
  );

  // Cold-start restore, explicit-session first: a stored session id (persisted
  // only on explicit start/join) is verified and rejoined; otherwise the local
  // solo queue snapshot hydrates the reducer. The gate flag below keeps the
  // save effect from clobbering a stored snapshot with the initial empty state.
  const snapshotHydratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const hydrateLocalSnapshot = async () => {
      const snapshot = await getStoredQueueSnapshot();
      if (cancelled || !snapshot) return;
      // The user may have started acting — or a session may have appeared —
      // before the async load resolved; never clobber newer state.
      if (sessionIdRef.current !== null) return;
      if (stateRef.current.queue.length > 0 || stateRef.current.currentClimbQueueItem) return;
      restoreQueueSnapshot(snapshot);
    };
    void getStoredSessionId()
      .then(async (storedId) => {
        if (__DEV__) {
          console.info(`[session] restored from store: ${storedId ?? '(none)'}`);
        }
        if (!storedId) {
          await hydrateLocalSnapshot();
          return;
        }
        try {
          // Verify the stored session is still alive before rejoining. Without
          // this, JOIN_SESSION recreates a server-ended room as an empty zombie
          // and we land in InSessionView with no peers (#2683). sessionStatus
          // reads the durable session row, NOT the presence-gated `session`
          // query — that one returns null for any empty session, so it can't
          // tell an ended session apart from a dormant-but-active solo session.
          // null means the session row no longer exists; anything but 'active'
          // means drop the stored id.
          const { sessionStatus } = await getHttpClient().request<SessionStatusQueryResponse>(SESSION_STATUS, {
            sessionId: storedId,
          });
          if (cancelled) return;
          if (sessionStatus !== 'active') {
            if (__DEV__) {
              console.info(`[session] stored session ${storedId} ended/missing; clearing`);
            }
            await clearStoredSessionId();
            await hydrateLocalSnapshot();
            return;
          }
          setSessionId(storedId);
        } catch (err) {
          // graphql-request's ClientError always carries `response`; a genuine
          // network failure (fetch reject) doesn't — same structural check as
          // createSessionWithConfig's error handling above.
          const isServerResponse = !!err && typeof err === 'object' && 'response' in err;
          if (isServerResponse) {
            // The backend answered but the query failed (version skew — an
            // older backend without sessionStatus — or a masked 500). Don't
            // restore: a zombie session would put the whole app "in session".
            // Don't clear either: the id may verify fine once backend/app
            // versions align, so the next launch retries.
            reportError(err, { tags: { source: 'sessionRestore' } });
            await hydrateLocalSnapshot();
            return;
          }
          // Offline cold start: can't verify the session status, so restore
          // optimistically so the queue still comes back. A genuinely-dead
          // session stays escapable via End Session.
          if (__DEV__) {
            console.warn('[session] status check failed; restoring optimistically', err);
          }
          if (!cancelled) setSessionId(storedId);
        }
      })
      .finally(() => {
        if (!cancelled) snapshotHydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [restoreQueueSnapshot]);

  // Persist the SOLO queue across launches. Only while no session is active —
  // a session's queue is server-owned (the rejoin FullSync restores it) — and
  // only after the cold-start hydrate settles. Writing the empty state doubles
  // as the clear when the user empties the queue or a session teardown resets
  // it; the debounce coalesces mutation bursts (swipes, clear-queue removals).
  useEffect(() => {
    if (!snapshotHydratedRef.current || sessionId !== null || !activeBoardSettled) return undefined;
    const persistTimeout = setTimeout(() => {
      void setStoredQueueSnapshot({
        queue,
        currentClimbQueueItem,
        playlistSuggestionSource,
      });
    }, SOLO_QUEUE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(persistTimeout);
  }, [queue, currentClimbQueueItem, playlistSuggestionSource, sessionId, activeBoardSettled]);
}
