import { getPrivacyRevocationGeneration } from '../../lib/privacy/privacy-cache';
import { getCurrentUserStorageOwner } from '../../lib/user-storage-owner';
import { useEffect, useState, useCallback } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource, QueueAction, QueueState } from '@boardsesh/queue';
import {
  getStoredQueueSnapshot,
  setStoredQueueSnapshot,
  getQueueSnapshotGeneration,
} from '../../lib/queue-snapshot-store';
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
  authenticatedUserId?: string | null;
  identityReady?: boolean;
  privacyRevocationGeneration?: number;
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
 * Hydration completion is reactive and scoped to the viewer/privacy generation,
 * so a pending save resumes after revalidation without overwriting another owner.
 */
export function useQueuePersistence({
  authenticatedUserId,
  identityReady = true,
  privacyRevocationGeneration,
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
  const [verifiedOwner, setVerifiedOwner] = useState<{ userId: string; generation: number } | null>(null);
  useEffect(() => {
    if (identityReady) return;
    let cancelled = false;
    const generation = getPrivacyRevocationGeneration();
    void (async () => {
      // Keep native storage dependencies out of the queue's initial module graph.
      // This is an attested catalogue marker, never a decoded token identity.
      const [{ getDatabaseHandle }, { getAuthorizedCatalogViewerId }] = await Promise.all([
        import('../../db'),
        import('../../offline/catalog-access'),
      ]);
      if (cancelled || generation !== getPrivacyRevocationGeneration()) return;
      const database = getDatabaseHandle();
      const userId = database ? await getAuthorizedCatalogViewerId(database) : null;
      if (!cancelled && generation === getPrivacyRevocationGeneration()) {
        setVerifiedOwner(userId ? { userId, generation } : null);
      }
    })().catch(() => {
      /* An unavailable marker leaves the saved queue untouched. */
    });
    return () => {
      cancelled = true;
    };
  }, [identityReady, privacyRevocationGeneration]);
  const ownerUserId =
    authenticatedUserId ??
    (!identityReady && verifiedOwner?.generation === getPrivacyRevocationGeneration() ? verifiedOwner.userId : null);
  const ownerReady = identityReady || !!ownerUserId;
  const hydrationScope = JSON.stringify([
    ownerReady,
    ownerUserId,
    privacyRevocationGeneration ?? getPrivacyRevocationGeneration(),
  ]);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);

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
  useEffect(() => {
    if (!ownerReady) return;
    let cancelled = false;
    const generation = getPrivacyRevocationGeneration();
    const isCurrent = () => !cancelled && generation === getPrivacyRevocationGeneration();
    const owner = getCurrentUserStorageOwner() ?? (ownerUserId ? { userId: ownerUserId, authSessionId: '' } : null);
    const hydrateLocalSnapshot = async () => {
      const snapshotGeneration = getQueueSnapshotGeneration();
      const snapshot = await getStoredQueueSnapshot(owner);
      if (!isCurrent() || !snapshot || snapshotGeneration !== getQueueSnapshotGeneration()) return;
      // The user may have started acting — or a session may have appeared —
      // before the async load resolved; never clobber newer state.
      if (sessionIdRef.current !== null) return;
      if (stateRef.current.queue.length > 0 || stateRef.current.currentClimbQueueItem) return;
      restoreQueueSnapshot(snapshot);
    };
    void getStoredSessionId()
      .then(async (storedId) => {
        if (!isCurrent() || sessionIdRef.current !== null) return;
        if (__DEV__) {
          console.info(`[session] restored from store: ${storedId ?? '(none)'}`);
        }
        if (!storedId) {
          await hydrateLocalSnapshot();
          return;
        }
        // During a backend outage this call no longer hangs the cold start: the
        // interactive HTTP client is timed (20s) and, while the connectivity
        // store says we're offline, short-circuits with a
        // BackendUnavailableError. That error carries no `response`, so it
        // falls to the optimistic-restore branch below — the queue comes back
        // and the realtime join that follows is DEFERRED by
        // use-session-realtime.ts rather than retrying every 5s. A session
        // that turns out to be dead stays escapable via End Session (#4862).
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
          if (!isCurrent() || sessionIdRef.current !== null) return;
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
          if (!isCurrent()) return;
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
          if (isCurrent() && sessionIdRef.current === null) setSessionId(storedId);
        }
      })
      .finally(() => {
        if (isCurrent()) setHydratedScope(hydrationScope);
      });
    return () => {
      cancelled = true;
    };
  }, [restoreQueueSnapshot, ownerUserId, ownerReady, hydrationScope]);

  // Persist the SOLO queue across launches. Only while no session is active —
  // a session's queue is server-owned (the rejoin FullSync restores it) — and
  // only after the cold-start hydrate settles. Writing the empty state doubles
  // as the clear when the user empties the queue or a session teardown resets
  // it; the debounce coalesces mutation bursts (swipes, clear-queue removals).
  useEffect(() => {
    if (!ownerReady || hydratedScope !== hydrationScope || sessionId !== null || !activeBoardSettled) return undefined;
    const snapshotGeneration = getQueueSnapshotGeneration();
    const generation = getPrivacyRevocationGeneration();
    const owner = getCurrentUserStorageOwner() ?? (ownerUserId ? { userId: ownerUserId, authSessionId: '' } : null);
    const persistTimeout = setTimeout(() => {
      if (generation !== getPrivacyRevocationGeneration()) return;
      void setStoredQueueSnapshot(
        {
          queue,
          currentClimbQueueItem,
          playlistSuggestionSource,
        },
        owner,
        snapshotGeneration,
      );
    }, SOLO_QUEUE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(persistTimeout);
  }, [
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    sessionId,
    activeBoardSettled,
    ownerUserId,
    ownerReady,
    hydrationScope,
    hydratedScope,
  ]);
}
