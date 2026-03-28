/**
 * SessionConnection encapsulates all WebSocket connection orchestration:
 * - graphql-ws client lifecycle (create, connect, dispose)
 * - Session join/leave mutations
 * - Queue and session subscription setup/teardown
 * - Reconnection with delta sync / full sync fallback
 * - Transient retry logic with exponential backoff
 *
 * This class replaces the inline connection logic in use-session-lifecycle.ts.
 * It emits events via callbacks rather than calling React setState directly,
 * making it independently testable and free from stale closure issues.
 */

import { createGraphQLClient, execute, subscribe, Client } from '../graphql-queue/graphql-client';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  BACKOFF_MULTIPLIER,
  MAX_TRANSIENT_RETRIES,
} from '../graphql-queue/retry-constants';
import {
  JOIN_SESSION,
  LEAVE_SESSION,
  QUEUE_UPDATES,
  SESSION_UPDATES,
  EVENTS_REPLAY,
  type SubscriptionQueueEvent,
  type SessionEvent,
} from '@boardsesh/shared-schema';
import { ConnectionStateMachine, type ConnectionFlags } from './connection-state-machine';
import { TransientJoinError } from './errors';
import { computeQueueStateHash } from '@/app/utils/hash';

const DEBUG = process.env.NODE_ENV === 'development';

/** Session data returned from joinSession mutation */
export interface SessionData {
  id: string;
  name: string | null;
  boardPath: string;
  users: Array<{
    id: string;
    username: string;
    isLeader: boolean;
    avatarUrl?: string;
  }>;
  queueState: {
    sequence: number;
    stateHash: string;
    queue: unknown[];
    currentClimbQueueItem: unknown;
  };
  isLeader: boolean;
  clientId: string;
  goal?: string | null;
  isPublic?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  isPermanent?: boolean;
  color?: string | null;
}

/** Initial queue data to seed a new session */
export interface InitialQueueData {
  sessionId: string;
  queue: Array<{ uuid: string }>;
  currentClimb: { uuid: string } | null;
  sessionName?: string;
}

/** Callbacks for the React layer to receive events */
export interface SessionConnectionCallbacks {
  onConnectionFlagsChange: (flags: ConnectionFlags) => void;
  onSessionJoined: (session: SessionData) => void;
  onSessionCleared: () => void;
  onQueueEvent: (event: SubscriptionQueueEvent) => void;
  onSessionEvent: (event: SessionEvent) => void;
  onError: (error: Error) => void;
  onClientCreated: (client: Client | null) => void;
  /** Called to read current queue state for hash verification during reconnect */
  getQueueState: () => { queue: Array<{ uuid: string }>, currentItemUuid: string | null };
  /** Called to read current sequence number for delta sync */
  getLastSequence: () => number | null;
  /** Called to convert queue items to GraphQL input format */
  toClimbQueueItemInput: (item: unknown) => unknown;
  /** Called to get current pending initial queue data */
  getPendingInitialQueue: () => InitialQueueData | null;
  /** Called after initial queue is consumed */
  clearPendingInitialQueue: () => void;
}

/** Configuration for creating a SessionConnection */
export interface SessionConnectionConfig {
  backendUrl: string;
  sessionId: string;
  boardPath: string;
  sessionName?: string;
  callbacks: SessionConnectionCallbacks;
}

// Minimum interval between resyncs to prevent spamming (e.g., rapid visibility changes)
const MIN_RESYNC_INTERVAL_MS = 5_000;
const DEFINITIVE_AUTH_PATTERNS = [
  'unauthorized',
  'forbidden',
  'authentication',
  'auth token',
  'invalid token',
  'permission denied',
];
const DEFINITIVE_SESSION_PATTERNS = [
  'session not found',
  'invalid session',
  'session expired',
  'session ended',
];
const TRANSIENT_PATTERNS = [
  'timeout',
  'timed out',
  'network',
  'fetch',
  'econn',
  'closed',
  'unavailable',
  'temporarily',
  'gateway',
  'too many requests',
];

type JoinErrorKind = 'auth' | 'session-invalid' | 'transient' | 'unknown';

type EventsReplayAliasedResponse = {
  events: SubscriptionQueueEvent[];
  currentSequence: number;
};

class JoinSessionError extends Error {
  constructor(
    public readonly kind: JoinErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'JoinSessionError';
  }
}

export class SessionConnection {
  private readonly config: SessionConnectionConfig;
  private readonly stateMachine = new ConnectionStateMachine();

  private client: Client | null = null;
  private queueUnsubscribe: (() => void) | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private transientRetryCount = 0;
  private disposed = false;
  private suspended = false;
  private reconnectInProgress: Promise<void> | null = null;
  private lastResyncTimestamp = 0;

  // Mutable credentials that can be updated without reconnecting
  private authToken: string | null = null;
  private username: string | undefined = '';
  private avatarUrl: string | undefined;

  constructor(config: SessionConnectionConfig) {
    this.config = config;

    // Wire up state machine to emit flag changes
    this.stateMachine.onStateChange(() => {
      if (!this.disposed) {
        this.config.callbacks.onConnectionFlagsChange(this.stateMachine.flags);
      }
    });
  }

  /** Update auth credentials without triggering reconnect */
  updateCredentials(authToken: string | null, username: string | undefined, avatarUrl: string | undefined): void {
    this.authToken = authToken;
    this.username = username;
    this.avatarUrl = avatarUrl;
  }

  /** Get the current connection state flags */
  get flags(): ConnectionFlags {
    return this.stateMachine.flags;
  }

  /** Get the underlying graphql-ws client (for mutations) */
  get graphqlClient(): Client | null {
    return this.client;
  }

  /**
   * Start the connection. Creates the graphql-ws client, joins the session,
   * and sets up subscriptions.
   */
  async connect(): Promise<void> {
    if (this.disposed) return;
    if (this.suspended) return;

    // Prevent duplicate connections
    if (this.stateMachine.state === 'CONNECTING') {
      if (DEBUG) console.log('[SessionConnection] Connection already in progress, skipping');
      return;
    }

    this.clearRetryTimeout();
    this.stateMachine.transition('CONNECTING');

    try {
      this.ensureClient();
      const sessionData = await this.joinSession();

      if (this.disposed || this.suspended) {
        this.clearClient(false);
        return;
      }

      if (DEBUG) console.log('[SessionConnection] Joined session, clientId:', sessionData.clientId);

      this.transientRetryCount = 0;
      this.lastResyncTimestamp = Date.now();
      this.stateMachine.transition('CONNECTED');
      this.config.callbacks.onSessionJoined(sessionData);

      // Send initial queue state via FullSync
      if (sessionData.queueState) {
        this.config.callbacks.onQueueEvent({
          __typename: 'FullSync',
          sequence: sessionData.queueState.sequence,
          state: sessionData.queueState,
        } as SubscriptionQueueEvent);
      }

      this.setupSubscriptions();
    } catch (err) {
      if (this.disposed || this.suspended) return;

      console.error('[SessionConnection] Connection failed:', err);
      this.handleConnectionFailure(err, 'connect');
    }
  }

  /**
   * Handle WebSocket reconnection: rejoin session, delta sync or full sync.
   * Uses an async lock to prevent overlapping resync calls.
   */
  private handleReconnect(): Promise<void> {
    if (this.disposed || this.suspended || !this.client) return Promise.resolve();

    // If a reconnect is already in progress, return the existing promise
    // to prevent overlapping resync calls
    if (this.reconnectInProgress) {
      if (DEBUG) console.log('[SessionConnection] Reconnect already in progress, waiting for it to complete');
      return this.reconnectInProgress;
    }

    this.reconnectInProgress = this.doReconnect().finally(() => {
      this.reconnectInProgress = null;
    });
    return this.reconnectInProgress;
  }

  private async doReconnect(): Promise<void> {
    const { callbacks } = this.config;

    // Transition to RECONNECTING if not already (e.g., when called from triggerResync while CONNECTED)
    if (
      !this.disposed &&
      this.stateMachine.state !== 'RECONNECTING' &&
      this.stateMachine.state !== 'FAILED'
    ) {
      this.stateMachine.transition('RECONNECTING');
    }

    try {
      if (DEBUG) console.log('[SessionConnection] Reconnecting...');

      const lastSeq = callbacks.getLastSequence();
      const sessionData = await this.joinSession();

      if (this.disposed || this.suspended) return;

      this.lastResyncTimestamp = Date.now();

      // Calculate sequence gap
      const currentSeq = sessionData.queueState.sequence;
      const gap = lastSeq !== null ? currentSeq - lastSeq : 0;

      if (DEBUG) console.log(`[SessionConnection] Reconnected. Last seq: ${lastSeq}, Current seq: ${currentSeq}, Gap: ${gap}`);

      if (gap > 0 && gap <= 100 && lastSeq !== null) {
        await this.attemptDeltaSync(lastSeq, sessionData);
      } else if (gap > 100) {
        if (DEBUG) console.log(`[SessionConnection] Gap too large (${gap}), using full sync`);
        this.applyFullSync(sessionData);
      } else if (lastSeq === null) {
        if (DEBUG) console.log('[SessionConnection] First connection, applying initial state');
        this.applyFullSync(sessionData);
      } else if (gap === 0) {
        this.verifyHashAndSync(sessionData);
      } else if (gap < 0) {
        // Client is ahead of server (e.g., subscription delivered events during joinSession)
        if (DEBUG) console.log(`[SessionConnection] Client ahead of server (gap=${gap}), verifying hash`);
        this.verifyHashAndSync(sessionData);
      }

      callbacks.onSessionJoined(sessionData);

      // Re-establish subscriptions if they were lost (e.g., due to subscription error)
      if (!this.queueUnsubscribe || !this.sessionUnsubscribe) {
        if (DEBUG) console.log('[SessionConnection] Re-establishing lost subscriptions');
        this.setupSubscriptions();
      }

      if (DEBUG) console.log('[SessionConnection] Reconnection complete, clientId:', sessionData.clientId);
      this.transientRetryCount = 0;
      this.stateMachine.transition('CONNECTED');
    } catch (err) {
      if (this.disposed || this.suspended) return;
      console.error('[SessionConnection] Reconnect failed:', err);
      this.handleConnectionFailure(err, 'reconnect');
    }
  }

  /**
   * Trigger a manual resync (e.g. from corruption detection or visibility change).
   * Throttled to prevent excessive resyncs from rapid triggers.
   * @param force - Bypass throttle (e.g., for corruption detection)
   */
  triggerResync(force = false): void {
    if (this.disposed || this.suspended || !this.client) return;
    if (this.stateMachine.state !== 'CONNECTED' && this.stateMachine.state !== 'RECONNECTING') return;

    // Throttle non-forced resyncs to prevent spamming (e.g., rapid tab switches)
    if (!force) {
      const timeSinceLastResync = Date.now() - this.lastResyncTimestamp;
      if (timeSinceLastResync < MIN_RESYNC_INTERVAL_MS) {
        if (DEBUG) console.log(`[SessionConnection] Resync throttled (${Math.round(timeSinceLastResync / 1000)}s since last)`);
        return;
      }
    }

    if (DEBUG) console.log(`[SessionConnection] Manual resync triggered (force=${force})`);
    this.handleReconnect();
  }

  /**
   * Suspend active networking without disposing the whole SessionConnection instance.
   * Used for long inactive-tab periods.
   */
  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.clearRetryTimeout();
    this.clearSubscriptions();
    this.clearClient(false);
    this.stateMachine.transition('IDLE');
  }

  /**
   * Resume networking after a prior suspend().
   */
  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    void this.connect();
  }

  /**
   * Execute a GraphQL mutation on the connected client.
   */
  async executeMutation<TData = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<TData> {
    if (!this.client) throw new Error('Not connected to session');
    return execute<TData>(this.client, { query, variables });
  }

  /**
   * Disconnect and clean up all resources.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.suspended = false;

    if (DEBUG) console.log('[SessionConnection] Disposing');

    this.clearRetryTimeout();
    this.clearSubscriptions();
    this.clearClient(true);

    this.stateMachine.reset();
    this.stateMachine.dispose();
  }

  // ── Private helpers ──────────────────────────────────────────────

  private ensureClient(): void {
    if (this.client || this.disposed || this.suspended) return;

    const { backendUrl, callbacks } = this.config;
    const newClient = createGraphQLClient({
      url: backendUrl,
      authToken: this.authToken,
      onReconnect: () => this.handleReconnect(),
      onConnectionStateChange: (connected, isReconnect) => {
        if (this.disposed || this.suspended) return;
        if (connected && isReconnect) {
          // On reconnection, don't transition to CONNECTED yet.
          // handleReconnect will do it after resync completes.
          return;
        }
        if (!connected && this.stateMachine.state === 'CONNECTED') {
          this.stateMachine.transition('RECONNECTING');
        }
      },
    });

    this.client = newClient;
    callbacks.onClientCreated(newClient);
  }

  private normalizeError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }

  private classifyJoinError(err: unknown): JoinErrorKind {
    const message = this.normalizeError(err).message.toLowerCase();

    if (DEFINITIVE_AUTH_PATTERNS.some((pattern) => message.includes(pattern))) {
      return 'auth';
    }
    if (DEFINITIVE_SESSION_PATTERNS.some((pattern) => message.includes(pattern))) {
      return 'session-invalid';
    }
    if (TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern))) {
      return 'transient';
    }
    if (err instanceof TransientJoinError) {
      return 'transient';
    }
    return 'unknown';
  }

  private handleConnectionFailure(err: unknown, mode: 'connect' | 'reconnect'): void {
    const error = this.normalizeError(err);
    const wrappedError = err instanceof JoinSessionError
      ? err
      : new JoinSessionError(this.classifyJoinError(err), error.message, err);

    this.config.callbacks.onError(wrappedError);

    const isDefinitive =
      wrappedError.kind === 'auth' || wrappedError.kind === 'session-invalid';
    if (isDefinitive) {
      this.transientRetryCount = 0;
      this.stateMachine.transition('FAILED');
      this.config.callbacks.onSessionCleared();
      this.clearClient(false);
      return;
    }

    this.transientRetryCount++;
    if (this.transientRetryCount > MAX_TRANSIENT_RETRIES) {
      console.warn(`[SessionConnection] Exhausted ${MAX_TRANSIENT_RETRIES} transient retries`);
      this.transientRetryCount = 0;
      this.stateMachine.transition('FAILED');
      this.config.callbacks.onSessionCleared();
      this.clearClient(false);
      return;
    }

    if (mode === 'connect') {
      this.stateMachine.transition('IDLE');
      this.clearClient(false);
    } else {
      this.stateMachine.transition('RECONNECTING');
    }

    this.scheduleRetry(mode);
  }

  private clearRetryTimeout(): void {
    if (!this.retryTimeout) return;
    clearTimeout(this.retryTimeout);
    this.retryTimeout = null;
  }

  private clearSubscriptions(): void {
    this.queueUnsubscribe?.();
    this.queueUnsubscribe = null;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
  }

  private clearClient(sendLeave: boolean): void {
    const clientToCleanup = this.client;
    this.client = null;
    this.config.callbacks.onClientCreated(null);

    if (!clientToCleanup) return;

    Promise.resolve().then(() => {
      if (sendLeave) {
        execute(clientToCleanup, { query: LEAVE_SESSION }).catch(() => {});
      }
      clientToCleanup.dispose();
    });
  }

  private async joinSession(): Promise<SessionData> {
    if (!this.client) {
      throw new JoinSessionError('transient', 'Cannot join session without an active websocket client');
    }

    if (DEBUG) console.log('[SessionConnection] Calling joinSession mutation...');

    try {
      const { sessionId, boardPath, sessionName, callbacks } = this.config;

      const initialQueueData = callbacks.getPendingInitialQueue();
      const isForThisSession = initialQueueData?.sessionId === sessionId;
      const queueData = isForThisSession ? initialQueueData : null;

      if (DEBUG && queueData) {
        console.log('[SessionConnection] Sending initial queue with', queueData.queue.length, 'items');
      }

      const effectiveSessionName = sessionName || queueData?.sessionName;
      const variables: Record<string, unknown> = {
        sessionId,
        boardPath,
        username: this.username,
        avatarUrl: this.avatarUrl,
      };

      if (queueData) {
        variables.initialQueue = queueData.queue.map(callbacks.toClimbQueueItemInput);
        variables.initialCurrentClimb = queueData.currentClimb
          ? callbacks.toClimbQueueItemInput(queueData.currentClimb)
          : null;
      }

      if (effectiveSessionName) {
        variables.sessionName = effectiveSessionName;
      }

      const response = await execute<{ joinSession: SessionData }>(this.client, {
        query: JOIN_SESSION,
        variables,
      });

      const joinedSession = response?.joinSession;
      if (!joinedSession) {
        throw new TransientJoinError('JoinSession returned no session payload');
      }

      // Clear pending queue only after confirmed successful join payload
      if (queueData) {
        callbacks.clearPendingInitialQueue();
      }

      return joinedSession;
    } catch (err) {
      console.error('[SessionConnection] JoinSession failed:', err);
      const error = this.normalizeError(err);
      throw new JoinSessionError(this.classifyJoinError(err), error.message, err);
    }
  }

  private setupSubscriptions(): void {
    if (!this.client || this.disposed) return;

    const { sessionId, callbacks } = this.config;

    // Subscribe to queue updates
    this.queueUnsubscribe = subscribe<{ queueUpdates: SubscriptionQueueEvent }>(
      this.client,
      { query: QUEUE_UPDATES, variables: { sessionId } },
      {
        next: (data) => {
          if (data.queueUpdates) {
            callbacks.onQueueEvent(data.queueUpdates);
          }
        },
        error: (err) => {
          console.error('[SessionConnection] Queue subscription error:', err);
          this.queueUnsubscribe = null;
          if (!this.disposed) {
            callbacks.onError(this.normalizeError(err));
            this.handleReconnect();
          }
        },
        complete: () => {
          if (DEBUG) console.log('[SessionConnection] Queue subscription completed');
          this.queueUnsubscribe = null;
        },
      },
    );

    // Subscribe to session updates
    this.sessionUnsubscribe = subscribe<{ sessionUpdates: SessionEvent }>(
      this.client,
      { query: SESSION_UPDATES, variables: { sessionId } },
      {
        next: (data) => {
          if (data.sessionUpdates) {
            callbacks.onSessionEvent(data.sessionUpdates);
          }
        },
        error: (err) => {
          console.error('[SessionConnection] Session subscription error:', err);
          this.sessionUnsubscribe = null;
          if (!this.disposed) {
            callbacks.onError(this.normalizeError(err));
            this.handleReconnect();
          }
        },
        complete: () => {
          if (DEBUG) console.log('[SessionConnection] Session subscription completed');
          this.sessionUnsubscribe = null;
        },
      },
    );
  }

  private async attemptDeltaSync(lastSeq: number, sessionData: SessionData): Promise<void> {
    if (!this.client) return;

    const { sessionId, callbacks } = this.config;

    try {
      if (DEBUG) console.log(`[SessionConnection] Attempting delta sync for missed events...`);

      const response = await execute<{ eventsReplay: EventsReplayAliasedResponse }>(this.client, {
        query: EVENTS_REPLAY,
        variables: { sessionId, sinceSequence: lastSeq },
      });

      const replay = response?.eventsReplay;
      if (!replay) {
        throw new Error('eventsReplay payload missing');
      }

      if (replay.events.length > 0) {
        if (DEBUG) console.log(`[SessionConnection] Replaying ${replay.events.length} events`);
        replay.events.forEach(event => {
          callbacks.onQueueEvent(event);
        });
        if (DEBUG) console.log('[SessionConnection] Delta sync completed successfully');
      } else {
        // Gap > 0 but no events returned — server may have purged old events.
        if (DEBUG) console.log('[SessionConnection] No events to replay despite gap > 0, falling back to full sync');
        this.applyFullSync(sessionData);
      }
    } catch (err) {
      console.warn('[SessionConnection] Delta sync failed, falling back to full sync:', err);
      this.applyFullSync(sessionData);
    }
  }

  private applyFullSync(sessionData: SessionData): void {
    if (sessionData.queueState) {
      this.config.callbacks.onQueueEvent({
        __typename: 'FullSync',
        sequence: sessionData.queueState.sequence,
        state: sessionData.queueState,
      } as SubscriptionQueueEvent);
    }
  }

  private verifyHashAndSync(sessionData: SessionData): void {
    const { queue, currentItemUuid } = this.config.callbacks.getQueueState();
    const localHash = computeQueueStateHash(queue, currentItemUuid);

    if (localHash !== sessionData.queueState.stateHash) {
      if (DEBUG) console.log('[SessionConnection] Hash mismatch on reconnect despite gap=0, applying full sync');
      this.applyFullSync(sessionData);
    } else {
      if (DEBUG) console.log('[SessionConnection] No missed events, already in sync');
    }
  }

  private scheduleRetry(mode: 'connect' | 'reconnect'): void {
    this.clearRetryTimeout();

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, this.transientRetryCount - 1),
      MAX_RETRY_DELAY_MS,
    );

    if (DEBUG) {
      console.log(
        `[SessionConnection] Transient retry ${this.transientRetryCount}/${MAX_TRANSIENT_RETRIES} in ${delay}ms`,
      );
    }

    this.retryTimeout = setTimeout(() => {
      if (this.disposed || this.suspended) return;
      if (mode === 'connect') {
        void this.connect();
      } else {
        void this.handleReconnect();
      }
    }, delay);
  }
}
