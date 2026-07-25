import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  type Client,
  createGraphQLClient,
  execute,
  subscribe,
  GraphQLOperationError,
} from '../../graphql-queue/graphql-client';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_TRANSIENT_RETRIES,
  // Imported from the shared package directly (not the web re-export) so the
  // many web tests that vi.mock('../../graphql-queue/graphql-client') don't
  // each need to add this export to their factory — @boardsesh/graphql-client
  // is never mocked in web tests.
  isNotSessionMemberError,
} from '@boardsesh/graphql-client';
import {
  JOIN_SESSION,
  LEAVE_SESSION,
  QUEUE_UPDATES,
  SESSION_UPDATES,
  EVENTS_REPLAY,
} from '@boardsesh/graphql/operations/queue-session';
import {
  applySessionRuntimeEvent,
  type QueueSyncGate,
  type RuntimeSessionEvent,
  type SessionConnectionDeps,
  type SessionConnectionFatalReason,
  type SessionConnectionSink,
} from '@boardsesh/queue-runtime';
import type { SubscriptionQueueEvent, SessionEvent, QueueEvent, EventsReplayResponse } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../../queue-control/types';
import { computeQueueStateHash, computeQueueStateHashOrdered } from '@/app/utils/hash';
import { removePreference } from '@/app/lib/user-preferences-db';
import { coerceSessionUser } from '../event-utils';
import {
  type Session,
  type ActiveSessionInfo,
  type PendingInitialQueue,
  toClimbQueueItemInput,
  ACTIVE_SESSION_KEY,
  DEBUG,
} from '../types';

/**
 * Web's implementation of the `SessionConnectionDeps` ports consumed by
 * `@boardsesh/queue-runtime`'s `createSessionConnectionController`
 * (Workstream W4). Extracted out of `use-session-lifecycle.ts` so that hook
 * stays a thin React binding — this module has the GraphQL-operation-shaped
 * closures the controller doesn't (and shouldn't) know about.
 */

/**
 * Transform QueueEvent (from eventsReplay) to SubscriptionQueueEvent format.
 */
export function transformToSubscriptionEvent(event: QueueEvent | SubscriptionQueueEvent): SubscriptionQueueEvent {
  switch (event.__typename) {
    case 'QueueItemAdded': {
      const addedItem = 'addedItem' in event ? event.addedItem : event.item;
      return {
        __typename: 'QueueItemAdded',
        sequence: event.sequence,
        stateHash: event.stateHash,
        addedItem,
        position: event.position,
      };
    }
    case 'CurrentClimbChanged': {
      const currentItem = 'currentItem' in event ? event.currentItem : event.item;
      return {
        __typename: 'CurrentClimbChanged',
        sequence: event.sequence,
        stateHash: event.stateHash,
        currentItem,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    }
    case 'ClimbMirrored': {
      // Wire shape exposes `uuid`; aliased subscription shape uses `mirroredUuid`. Read both.
      const climbMirroredCandidate = event as { uuid?: string | null; mirroredUuid?: string | null };
      const mirroredUuid = climbMirroredCandidate.mirroredUuid ?? climbMirroredCandidate.uuid ?? null;
      return {
        __typename: 'ClimbMirrored',
        sequence: event.sequence,
        stateHash: event.stateHash,
        mirroredUuid,
        mirrored: event.mirrored,
      };
    }
    default:
      return event as SubscriptionQueueEvent;
  }
}

type WebRuntimeSessionUser = Parameters<typeof coerceSessionUser>[0];

function toWebSessionRuntimeEvent(event: SessionEvent): RuntimeSessionEvent<WebRuntimeSessionUser> | null {
  switch (event.__typename) {
    case 'SessionRosterSnapshot':
      // Full authoritative roster seeded on subscribe. `applySessionRuntimeEvent`
      // applies it as a REPLACE and coerces each user via `coerceSessionUser`.
      return {
        __typename: 'SessionRosterSnapshot',
        users: (event.users ?? []) as unknown as WebRuntimeSessionUser[],
        boardPath: event.boardPath ?? null,
      };
    case 'UserJoined':
    case 'UserPresenceChanged':
      return { __typename: event.__typename, user: event.user as unknown as WebRuntimeSessionUser };
    case 'UserLeft':
      return { __typename: 'UserLeft', userId: event.userId };
    case 'LeaderChanged':
      return {
        __typename: 'LeaderChanged',
        leaderId: event.leaderId,
        leaderConnectionId: event.leaderConnectionId ?? null,
      };
    case 'WallDisconnected':
      return {
        __typename: 'WallDisconnected',
        disconnectedByParticipantId: event.disconnectedByParticipantId ?? null,
      };
    case 'SessionBoardSerialChanged':
      return {
        __typename: 'SessionBoardSerialChanged',
        lastConnectedBoardSerial: event.lastConnectedBoardSerial ?? null,
      };
    case 'SessionBoardPathChanged':
      return {
        __typename: 'SessionBoardPathChanged',
        boardPath: event.boardPath,
        changedByParticipantId: event.changedByParticipantId ?? null,
      };
    case 'SessionEnded':
      return { __typename: 'SessionEnded', reason: event.reason ?? null, newPath: event.newPath ?? null };
    default:
      return null;
  }
}

/**
 * Apply a single `SessionEvent` (excluding `SessionStatsUpdated`, which is
 * dispatched through the React Query cache rather than the session reducer)
 * to a `Session`. Pure so the rules can be unit-tested without standing up
 * the WebSocket subscription pipeline.
 *
 * Returns `null` when `prev` is `null` (no session to mutate). For
 * `SessionEnded` we leave the previous state in place — clearing happens via
 * IndexedDB removal and the next lifecycle tick, not the reducer.
 */
export function applySessionEvent(prev: Session | null, event: SessionEvent): Session | null {
  const runtimeEvent = toWebSessionRuntimeEvent(event);
  return runtimeEvent ? applySessionRuntimeEvent(prev, runtimeEvent, { coerceUser: coerceSessionUser }) : prev;
}

export type WebSessionConnectionRefs = {
  wsAuthTokenRef: MutableRefObject<string | null>;
  usernameRef: MutableRefObject<string | undefined>;
  avatarUrlRef: MutableRefObject<string | undefined>;
  queueRef: MutableRefObject<LocalClimbQueueItem[]>;
  currentClimbQueueItemRef: MutableRefObject<LocalClimbQueueItem | null>;
};

export type CreateWebSessionConnectionDepsArgs = {
  activeSession: ActiveSessionInfo;
  backendUrl: string;
  syncGate: QueueSyncGate;
  refs: WebSessionConnectionRefs;
  pendingInitialQueueRef: MutableRefObject<PendingInitialQueue | null>;
  handleQueueEvent: (event: SubscriptionQueueEvent) => void;
  handleSessionEvent: (event: SessionEvent) => void;
  setActiveSession: Dispatch<SetStateAction<ActiveSessionInfo | null>>;
  setClient: Dispatch<SetStateAction<Client | null>>;
  setSession: Dispatch<SetStateAction<Session | null>>;
  setIsConnecting: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<Error | null>>;
  setHasConnected: Dispatch<SetStateAction<boolean>>;
};

/**
 * Build the `SessionConnectionDeps` for one connection attempt (one
 * `useSessionLifecycle` connection-effect run — a fresh set of closures per
 * `activeSession`/auth change, matching the original hook's per-effect
 * `sessionId`/`boardPath` capture). Cites original line numbers (from the
 * pre-W4 `use-session-lifecycle.ts`) throughout so the port-to-behaviour
 * mapping is auditable.
 */
export function createWebSessionConnectionDeps({
  activeSession,
  backendUrl,
  syncGate,
  refs,
  pendingInitialQueueRef,
  handleQueueEvent,
  handleSessionEvent,
  setActiveSession,
  setClient,
  setSession,
  setIsConnecting,
  setError,
  setHasConnected,
}: CreateWebSessionConnectionDepsArgs): SessionConnectionDeps<Client, Session, SubscriptionQueueEvent, SessionEvent> {
  const { wsAuthTokenRef, usernameRef, avatarUrlRef, queueRef, currentClimbQueueItemRef } = refs;
  const { sessionId, boardPath } = activeSession;

  return {
    sessionId,

    createClient: (onReconnect) =>
      createGraphQLClient({
        url: backendUrl,
        authToken: wsAuthTokenRef.current,
        onReconnect,
        connectionName: 'session',
      }),

    // Mirrors the original `joinSession` local function
    // (`use-session-lifecycle.ts:434-490`, pre-W4).
    join: async (clientToUse) => {
      if (DEBUG) console.info('[PersistentSession] Calling joinSession mutation...');
      try {
        const initialQueueData =
          pendingInitialQueueRef.current?.sessionId === sessionId ? pendingInitialQueueRef.current : null;

        if (DEBUG && initialQueueData) {
          console.info('[PersistentSession] Sending initial queue with', initialQueueData.queue.length, 'items');
        }

        const sessionName = activeSession.sessionName || initialQueueData?.sessionName;
        const variables = {
          sessionId,
          boardPath,
          username: usernameRef.current,
          avatarUrl: avatarUrlRef.current,
          ...(initialQueueData && {
            initialQueue: initialQueueData.queue.map(toClimbQueueItemInput),
            initialCurrentClimb: initialQueueData.currentClimb
              ? toClimbQueueItemInput(initialQueueData.currentClimb)
              : null,
          }),
          ...(sessionName && { sessionName }),
        };

        const response = await execute<{ joinSession: Session }>(clientToUse, { query: JOIN_SESSION, variables });
        const joinedSession = response?.joinSession;
        if (!joinedSession) {
          console.error('[PersistentSession] JoinSession returned no session payload');
          return null;
        }

        if (initialQueueData) {
          pendingInitialQueueRef.current = null;
        }
        return joinedSession;
      } catch (err) {
        // The server refuses to resurrect an ended session (#2696). Drop the
        // stored session immediately instead of burning several backoff
        // retries on a dead session. Returning `null` still routes through
        // the controller's ordinary transient-retry path (matching the
        // original: this same `setActiveSession(null)` pre-empted the
        // scheduled retry via a React re-render before it ever fired) — see
        // the controller's `onFatal` doc comment for the genuinely-fatal
        // call sites.
        //
        // Post-stop safety: this branch has destructive side effects
        // (removePreference + setActiveSession(null)) and no isStopped
        // signal from the controller. That's sound because of the
        // controller's teardown discipline: `stop()` disposes the client,
        // and a disposed graphql-ws client's pending `execute` rejects with
        // a generic transport error — never a `GraphQLOperationError`
        // carrying SESSION_ENDED — so a join still in flight at teardown
        // can't reach this branch. One residual window remains: a
        // SESSION_ENDED rejection that settled just before stop() runs its
        // catch continuation a microtask later and still lands here (the
        // pre-controller hook had the equivalent hole via mountedRef; the
        // consequence is a lost activation on a pathological A→B switch
        // timed to A's server-side end). If that ever matters, or if the
        // controller ever stops without disposing, thread an isStopped
        // check through these deps instead
        // of relying on this reasoning.
        if (err instanceof GraphQLOperationError && err.extensions?.code === 'SESSION_ENDED') {
          if (DEBUG) console.info('[PersistentSession] Session has ended; clearing stored session');
          removePreference(ACTIVE_SESSION_KEY).catch(() => {});
          setActiveSession(null);
          return null;
        }
        console.error('[PersistentSession] JoinSession failed:', err);
        return null;
      }
    },

    leave: async (clientToUse) => {
      await execute(clientToUse, { query: LEAVE_SESSION }, 5000);
    },

    replayEvents: async (clientToUse, sinceSequence) => {
      const response = await execute<{ eventsReplay: EventsReplayResponse }>(clientToUse, {
        query: EVENTS_REPLAY,
        variables: { sessionId, sinceSequence },
      });
      const replay = response?.eventsReplay;
      if (!replay) return null;
      return { events: replay.events.map(transformToSubscriptionEvent), currentSequence: replay.currentSequence };
    },

    subscribeQueue: (clientToUse, sink: SessionConnectionSink<SubscriptionQueueEvent>) =>
      subscribe<{ queueUpdates: SubscriptionQueueEvent }>(
        clientToUse,
        { query: QUEUE_UPDATES, variables: { sessionId } },
        {
          next: (data) => {
            if (data.queueUpdates) sink.next(data.queueUpdates);
          },
          error: (err) => sink.error(err),
          complete: () => sink.complete(),
        },
      ),

    subscribeSession: (clientToUse, sink: SessionConnectionSink<SessionEvent>) =>
      subscribe<{ sessionUpdates: SessionEvent }>(
        clientToUse,
        { query: SESSION_UPDATES, variables: { sessionId } },
        {
          next: (data) => {
            if (data.sessionUpdates) sink.next(data.sessionUpdates);
          },
          error: (err) => sink.error(err),
          complete: () => sink.complete(),
        },
      ),

    gate: syncGate,

    getLocalStateHash: () => computeQueueStateHash(queueRef.current, currentClimbQueueItemRef.current?.uuid || null),

    // Order-sensitive (v2) local hash — paired with the server's
    // `queueState.stateHashOrdered` so `decideReconnectStrategy` can full-sync
    // and re-order on a pure reorder drift the v1 comparison can't see.
    getLocalStateHashOrdered: () =>
      computeQueueStateHashOrdered(queueRef.current, currentClimbQueueItemRef.current?.uuid || null),

    applyFullSync: (sessionData) => {
      if (sessionData.queueState) {
        handleQueueEvent({
          __typename: 'FullSync',
          sequence: sessionData.queueState.sequence,
          state: sessionData.queueState,
        });
      }
    },

    onConnectStart: () => {
      if (DEBUG) console.info('[PersistentSession] Connecting to session:', sessionId);
      setIsConnecting(true);
      setError(null);
    },

    // Fires on the initial join AND every successful rejoin. Bundling
    // `client` here (rather than surfacing it the moment it's created,
    // before join) is safe: `useQueueMutations` already gates every
    // mutation on `session` being non-null, so nothing downstream can act on
    // a client without a session anyway.
    onSessionData: (clientToUse, sessionData) => {
      if (DEBUG) console.info('[PersistentSession] Session ready, clientId:', sessionData.clientId);
      setClient(clientToUse);
      setSession(sessionData);
      setHasConnected(true);
      setIsConnecting(false);
    },

    onQueueEvent: (event) => handleQueueEvent(event),

    // Session-event application (roster via `applySessionEvent`) stays
    // here, not in the controller — the controller only knows about an
    // opaque `TSessionEvent`, never `SessionEvent`'s `__typename` union.
    onSessionEvent: (event) => {
      // SessionStatsUpdated is dispatched through React Query in
      // `handleSessionEvent` — it doesn't touch session state, so the
      // reducer call skips it.
      if (event.__typename !== 'SessionStatsUpdated') {
        // SessionEnded carries the side effect of clearing the persisted
        // session id; `applySessionEvent` is pure so the IndexedDB removal
        // lives here at the call site.
        if (event.__typename === 'SessionEnded') {
          if (DEBUG) console.info('[PersistentSession] Session ended:', event.reason);
          removePreference(ACTIVE_SESSION_KEY).catch(() => {});
        }
        setSession((prev) => applySessionEvent(prev, event));
      }
      handleSessionEvent(event);
    },

    onError: (err) => {
      // The queue subscription was denied because we're not a member of this
      // session (NOT_SESSION_MEMBER). Post-#3695 an authenticated member is
      // re-authorized instantly on reconnect, so reaching here means the
      // session is genuinely gone for us — force-clear it now instead of
      // burning MAX_TRANSIENT_RETRIES subscription-recovery strikes before
      // `onFatal` does the same. Mirrors the SESSION_ENDED join-path branch.
      // (#2385 follow-up.) setActiveSession(null) pre-empts the controller's
      // scheduled retry via the React re-render, exactly like SESSION_ENDED.
      if (isNotSessionMemberError(err)) {
        if (DEBUG) console.info('[PersistentSession] Not a session member; clearing stored session');
        removePreference(ACTIVE_SESSION_KEY).catch(() => {});
        setActiveSession(null);
        return;
      }
      console.error('[PersistentSession] Connection error:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsConnecting(false);
    },

    onFatal: (reason: SessionConnectionFatalReason) => {
      console.warn(`[PersistentSession] Fatal connection failure (${reason}), clearing session`);
      removePreference(ACTIVE_SESSION_KEY).catch(() => {});
      setActiveSession(null);
    },

    // Observability for the recovery paths the controller handles itself —
    // reproduces the pre-W4 hook's exact console calls
    // (`use-session-lifecycle.ts:580`, `:703`, and the B3
    // `rejoinedQueueState` guard's message).
    onRecoveryEvent: (kind, recoveryError) => {
      if (kind === 'delta-sync-fallback') {
        console.warn('[PersistentSession] Delta sync failed, falling back to full sync:', recoveryError);
      } else if (kind === 'rejoin-missing-queue-state') {
        console.error('[PersistentSession] JoinSession returned no queue snapshot; skipping reconnect sync');
      } else {
        console.error('[PersistentSession] Session subscription error:', recoveryError);
      }
    },

    retryPolicy: {
      initialRetryDelayMs: INITIAL_RETRY_DELAY_MS,
      maxRetryDelayMs: MAX_RETRY_DELAY_MS,
      backoffMultiplier: BACKOFF_MULTIPLIER,
      maxTransientRetries: MAX_TRANSIENT_RETRIES,
    },
  };
}
