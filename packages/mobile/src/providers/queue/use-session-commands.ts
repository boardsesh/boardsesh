import { useCallback, useRef } from 'react';
import { buildSessionBoardPath } from '../../lib/boards/session-board-path';
import { execute } from '@boardsesh/graphql-client';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { LEAVE_SESSION } from '@boardsesh/graphql/operations/queue-session';
import type { ClimbQueueItem, PlaylistSuggestionSource, QueueAction, QueueState } from '@boardsesh/queue';
import type { SessionSummary, UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../../lib/graphql/client';
import { getStoredActiveBoard } from '../../lib/active-board-store';
import { getWsClient } from '../../lib/graphql/ws-client';
import {
  CREATE_SESSION,
  END_SESSION,
  type CreateSessionMutationResponse,
  type EndSessionMutationResponse,
} from '../../lib/graphql/operations';
import { getDeviceTimezone } from '../../lib/device-timezone';
import {
  clearStoredCreatedSessionId,
  clearStoredSessionId,
  setStoredCreatedSessionId,
  setStoredSessionId,
} from '../../lib/session-store';
import { clearStoredQueueSnapshot } from '../../lib/queue-snapshot-store';
import { track } from '../../lib/analytics';
import { reportError, reportHandledError } from '../../lib/error-reporting';
import { extractGraphqlMessage, isGraphqlRateLimitedError } from '../../lib/graphql/extract-error-message';
import type { ToastVariant } from '../../components/Toast';
import type { StartSessionConfig } from './queue-contexts';

type UseSessionCommandsParams = {
  showToast: (message: string, variant?: ToastVariant, duration?: number) => void;
  t: (key: string) => string;
  stateRef: React.RefObject<QueueState>;
  ensureJoined: (sessionIdToJoin: string) => Promise<unknown>;
  /** `mutations.setQueue` — the party-sync seed used by createSessionWithConfig. */
  setQueueMutation: (queue: ClimbQueueItem[], currentClimbQueueItem?: ClimbQueueItem | null) => Promise<void>;
  /**
   * Holds the id of a session whose local-queue seed threw. Set here on seed
   * failure and read by useSessionRealtime, which then refuses to let the empty
   * room's FullSync wipe the live queue and re-seeds instead (#3878). Cleared at
   * the clearSession teardown boundary.
   */
  seedFailedSessionIdRef: React.RefObject<string | null>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  sessionIdRef: React.RefObject<string | null>;
  dispatch: React.Dispatch<QueueAction>;
  setPlaylistSuggestionSourceState: React.Dispatch<React.SetStateAction<PlaylistSuggestionSource | null>>;
  /** Single-flight guard for resyncQueueFromServer — cleared at the clearSession teardown boundary. */
  resyncInFlightRef: React.RefObject<boolean>;
  resyncPendingRef: React.RefObject<boolean>;
  /** Raw active-board setter (useSetActiveBoard), NOT the ref-wrapped one. */
  setActiveBoard: (board: UserBoard) => Promise<void>;
  /** Shared with the session-realtime SessionEnded handler; owned by the provider. */
  locallyEndingSessionIdRef: React.RefObject<string | null>;
  suppressedRemoteEndSessionIdRef: React.RefObject<string | null>;
};

type SessionCommands = {
  createSessionWithConfig: (config?: StartSessionConfig) => Promise<string | null>;
  joinSession: (sessionId: string, opts: { boardPath: string; userBoard: UserBoard }) => Promise<void>;
  endSession: (options?: { notes?: string }) => Promise<SessionSummary | null>;
  clearSession: (options?: { notifyServer?: boolean }) => Promise<void>;
};

/**
 * The explicit session-lifecycle commands: create (Start button), join
 * (party mode), end, and clear (local teardown). `sessionCreationRef` is owned
 * internally (only createSessionWithConfig reads it); the leave-guard refs and
 * resync-flag refs are provider-owned shared state passed in.
 */
export function useSessionCommands({
  showToast,
  t,
  stateRef,
  ensureJoined,
  setQueueMutation,
  seedFailedSessionIdRef,
  setSessionId,
  sessionIdRef,
  dispatch,
  setPlaylistSuggestionSourceState,
  resyncInFlightRef,
  resyncPendingRef,
  setActiveBoard,
  locallyEndingSessionIdRef,
  suppressedRemoteEndSessionIdRef,
}: UseSessionCommandsParams): SessionCommands {
  // Single-flight + coalesce guard for concurrent Start taps. Only this callback
  // reads it, so it lives here rather than in the provider body.
  const sessionCreationRef = useRef<Promise<string | null> | null>(null);

  // Explicit session creation — the Start button (PreSessionView) and nothing
  // else. Sessions are never created lazily: the solo queue lives locally
  // (queue-snapshot-store) until the user starts or joins one, matching web.
  const createSessionWithConfig = useCallback(
    async (config?: StartSessionConfig): Promise<string | null> => {
      if (sessionIdRef.current) return sessionIdRef.current;
      if (sessionCreationRef.current) return sessionCreationRef.current;

      const createPromise = (async () => {
        const activeBoard = await getStoredActiveBoard();
        if (!activeBoard) {
          // The Start button is gated on the React Query copy of the active board;
          // if the stored board is somehow missing, fail loudly so the user knows
          // to pick a board instead of tapping into a silent no-op.
          showToast(t('mobile.queue.noBoardSelected'), 'error');
          return null;
        }

        const boardPath = buildSessionBoardPath(activeBoard);

        try {
          const response = await getHttpClient().request<CreateSessionMutationResponse>(CREATE_SESSION, {
            input: {
              boardPath,
              latitude: 0,
              longitude: 0,
              discoverable: config?.discoverable ?? false,
              ...(config?.name ? { name: config.name } : {}),
              ...(config?.goal ? { goal: config.goal } : {}),
              ...(config?.color ? { color: config.color } : {}),
              ...(config?.isPermanent ? { isPermanent: config.isPermanent } : {}),
            },
          });
          const newId = response.createSession.id;
          sessionIdRef.current = newId;
          await setStoredSessionId(newId);
          // Device provenance: this phone STARTED the party, as opposed to
          // joining one. The in-session exit UI leads with End here and with
          // Leave everywhere else, which is the whole point of #3502 — the
          // same climber's second phone has no way to know it's the second
          // phone from the roster alone (see session-store.ts for why).
          // Best-effort: a failed write only costs this device the End-first
          // emphasis, never the End action itself.
          try {
            await setStoredCreatedSessionId(newId);
          } catch (provenanceError) {
            if (__DEV__) console.warn('[queue] created-session provenance write failed', provenanceError);
          }
          // Seed the session with the locally-built queue BEFORE setSessionId
          // mounts the queueUpdates subscription — the subscription's FullSync
          // for an empty room would wipe the local queue via INITIAL_QUEUE_DATA.
          // SET_QUEUE is connection-scoped, so JOIN first (the subscription
          // effect's later eager ensureJoined hits the tracker cache).
          const { queue, currentClimbQueueItem } = stateRef.current;
          if (queue.length > 0 || currentClimbQueueItem) {
            try {
              await ensureJoined(newId);
              await setQueueMutation(queue, currentClimbQueueItem ?? undefined);
              // Queue ownership moved to the session — drop the local snapshot
              // so a stale copy can't resurrect after the session ends. Only on
              // a successful seed: if seeding failed, the snapshot is the sole
              // surviving copy and a relaunch can still recover the queue.
              await clearStoredQueueSnapshot();
            } catch (seedError) {
              // The seed never landed server-side, so the room is empty while
              // the local queue is the truth. Flag it BEFORE setSessionId mounts
              // the subscription: its empty-room FullSync would otherwise wipe
              // the live queue via INITIAL_QUEUE_DATA. useSessionRealtime reads
              // this ref, skips that FullSync, and re-seeds instead (#3878). The
              // local snapshot is untouched (clearStoredQueueSnapshot only runs
              // on success above), so a relaunch can still recover regardless.
              seedFailedSessionIdRef.current = newId;
              if (__DEV__) console.warn('[queue] session queue seed failed', seedError);
              reportHandledError(seedError, { tags: { source: 'startSessionSeed' } });
            }
          }
          setSessionId(newId);
          track(SHARED_EVENTS.SessionStarted, {
            boardName: activeBoard.boardType,
            hasGoal: !!config?.goal,
            isDiscoverable: config?.discoverable ?? false,
          });
          return newId;
        } catch (error) {
          if (isGraphqlRateLimitedError(error)) {
            showToast(t('mobile.queue.rateLimited'), 'error');
            return null;
          }
          // Production masks the GraphQL message to "Unexpected error", but the
          // graphql-request ClientError still carries the HTTP status — so error
          // reporting can distinguish network-down from a 4xx/5xx from a masked
          // server throw. Capture it with boardPath context; the backend captures
          // the unmasked cause for the same request (see createSession resolver).
          const httpStatus =
            error && typeof error === 'object' && 'response' in error
              ? ((error as { response?: { status?: number } }).response?.status ?? null)
              : null;
          reportError(error, {
            tags: { source: 'createSession' },
            extra: { boardPath, httpStatus, discoverable: config?.discoverable ?? false },
          });
          // Against a local backend (dev) errors aren't masked, so surface the
          // real server message to speed up diagnosis; shipped builds keep the
          // friendly fallback.
          const devMessage = __DEV__ ? extractGraphqlMessage(error) : null;
          showToast(devMessage ?? t('mobile.queue.sessionCreateError'), 'error');
          return null;
        } finally {
          sessionCreationRef.current = null;
        }
      })();

      sessionCreationRef.current = createPromise;
      return createPromise;
    },
    [ensureJoined, setQueueMutation, showToast, t],
  );

  const clearSession = useCallback(async (options?: { notifyServer?: boolean }) => {
    // When the user intentionally leaves a session (switching into another via
    // the join-confirm dialog), tell the backend so peers see them leave NOW —
    // the driver/presence release shouldn't wait on the 60s disconnect grace
    // timer. Best-effort and BEFORE we reset local state, so the WS registration
    // for the old session is still alive: a failed/timed-out leave degrades to
    // the prior disconnect-grace behavior. Default false keeps every other
    // caller (remote SessionEnded, endSession) unchanged. Mirrors web's
    // sendLeaveOnCleanup in use-session-lifecycle.ts.
    if (options?.notifyServer && sessionIdRef.current) {
      try {
        await execute(getWsClient(), { query: LEAVE_SESSION }, 5000);
      } catch (error) {
        if (__DEV__) console.warn('[queue] leaveSession on switch failed', error);
      }
    }
    // A resync fetch that never settles (hung connection) would leave the
    // single-flight guard stuck true; a mounted provider carries that across a
    // session switch and would block every future resync. Reset at the teardown
    // boundary so the next session always starts clean.
    resyncInFlightRef.current = false;
    // Same for the coalesced-rerun flag: a pending rerun belongs to the old
    // session and must not fire a fetch into the next one.
    resyncPendingRef.current = false;
    // Any pending seed-failure guard belongs to the session we're tearing down
    // (it's keyed by id, so a stale value can't match the next session anyway —
    // this just keeps the ref tidy).
    seedFailedSessionIdRef.current = null;
    sessionIdRef.current = null;
    setSessionId(null);
    dispatch({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });
    setPlaylistSuggestionSourceState(null);
    await clearStoredSessionId();
    // Provenance belongs to the session we're tearing down. It's keyed by
    // session id so a stale value could never match the next one anyway —
    // this just keeps the store tidy.
    await clearStoredCreatedSessionId();
  }, []);

  const endSession = useCallback(
    async (options?: { notes?: string }): Promise<SessionSummary | null> => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return null;

      // Trim the optional recap and send it only when there's something left — an
      // empty field must behave exactly like ending without a recap.
      const trimmedNotes = options?.notes?.trim() ?? '';

      try {
        locallyEndingSessionIdRef.current = currentSessionId;
        const response = await getHttpClient().request<EndSessionMutationResponse>(END_SESSION, {
          sessionId: currentSessionId,
          // Device IANA zone so the backend can export wall-clock local times
          // to platforms like Strava.
          timezone: getDeviceTimezone(),
          ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        });
        await clearSession();
        locallyEndingSessionIdRef.current = null;
        suppressedRemoteEndSessionIdRef.current = null;
        track(SHARED_EVENTS.SessionEnded, {
          sessionId: currentSessionId,
          // Seconds (not minutes) to match web's Session Ended property/unit
          // (session-lifecycle-tracking.ts) so both platforms land on one
          // PostHog dimension.
          durationSec:
            response.endSession?.durationMinutes != null ? Math.round(response.endSession.durationMinutes * 60) : null,
          // Counts only — never the recap text — so PostHog carries whether a
          // recap was written and its length without leaking user copy.
          hasNotes: trimmedNotes.length > 0,
          notesLength: trimmedNotes.length,
        });
        showToast(t('mobile.toast.sessionEnded'), 'success');
        return response.endSession;
      } catch {
        const remoteEndAlreadyApplied = suppressedRemoteEndSessionIdRef.current === currentSessionId;
        locallyEndingSessionIdRef.current = null;
        suppressedRemoteEndSessionIdRef.current = null;
        // A failed end still drops us out of the session locally, so tell the
        // server we left rather than leaving peers to discover it after the
        // 60s disconnect grace. This path is reached most often by a
        // participant who isn't the creator (the HTTP endSession branch
        // authorizes on createdByUserId alone), and until #3502 they were
        // silently ejected AND left as a ghost in everyone else's roster.
        // Best-effort with its own timeout; when the remote end already
        // applied, LEAVE_SESSION is a no-op server-side (no ctx.sessionId).
        await clearSession({ notifyServer: true });
        if (remoteEndAlreadyApplied) {
          showToast(t('mobile.toast.sessionEnded'), 'success');
        } else {
          // Production masks GraphQL errors to "Unexpected error", so we
          // genuinely cannot tell an authorization refusal from a dropped
          // network here. This message is true either way — and unlike the
          // old generic `actionFailed` it tells the climber what actually
          // happened to their session membership.
          showToast(t('mobile.queue.endSessionFailedLeft'), 'error');
        }
        return null;
      }
    },
    [clearSession, showToast, t],
  );

  const joinSession = useCallback(
    async (sessionToJoin: string, opts: { boardPath: string; userBoard: UserBoard }) => {
      // Idempotent against double-tap / re-entrant deep links.
      if (sessionIdRef.current === sessionToJoin) return;
      // Switch the active board to the session's board FIRST (and persist it) so
      // the session effect's JOIN_SESSION reads the correct boardPath and the
      // whole tree (BLE wrapper, BoardProvider, climb list, play drawer) renders
      // on the joined board. Unlike startSession (which reads the active board to
      // build the new session's path), joinSession writes it from the session.
      await setActiveBoard(opts.userBoard);
      sessionIdRef.current = sessionToJoin;
      setSessionId(sessionToJoin);
      await setStoredSessionId(sessionToJoin);
      // The session's FullSync replaces the local queue — drop the solo
      // snapshot so a stale copy can't resurrect on a later cold start.
      await clearStoredQueueSnapshot();
    },
    [setActiveBoard],
  );

  return { createSessionWithConfig, joinSession, endSession, clearSession };
}
