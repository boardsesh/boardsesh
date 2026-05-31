// Headless party-session client for end-to-end queue integration tests.
//
// These tests exercise the REAL renderer-agnostic client code — the same
// modules web and mobile ship — against a REAL backend (`startServer`), not a
// mocked transport. A `HeadlessParticipant` wires together, with zero mocks of
// the pieces under test:
//
//   - transport       @boardsesh/graphql-client  (createGraphQLClient / execute / subscribe)
//   - sync identity   @boardsesh/queue            (createQueueSyncCoordinator: clientId + correlationIds)
//   - event mapping   @boardsesh/queue-runtime    (mapSubscriptionEnvelopeToAction)
//   - local state     @boardsesh/queue            (queueReducer + evaluateQueueEventSequence + hash)
//   - mutations       @boardsesh/queue-react      (createQueueMutations — extracted in #2417)
//
// So a test driving this harness is, in effect, four phones in one party
// session talking to one backend. The harness mirrors the web event-processor's
// sequence gate (`use-event-processor.ts`) and the persistent-session context's
// clientId/correlationId echo-suppression — just headless, no React renderer.

import { expect } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import WS from 'ws';
import { createGraphQLClient, execute, subscribe, type ExtendedClient } from '@boardsesh/graphql-client';
import {
  queueReducer,
  initialState,
  computeQueueStateHash,
  createQueueSyncCoordinator,
  evaluateQueueEventSequence,
  type QueueState,
  type QueueAction,
  type ClimbQueueItem,
  type SyncCoordinator,
} from '@boardsesh/queue';
import { mapSubscriptionEnvelopeToAction } from '@boardsesh/queue-runtime';
import { createQueueMutations, type QueueMutationsActions } from '@boardsesh/queue-react/create-queue-mutations';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import {
  JOIN_SESSION,
  LEAVE_SESSION,
  QUEUE_UPDATES,
  SESSION_UPDATES,
  EVENTS_REPLAY,
  REORDER_QUEUE_ITEM,
} from '@boardsesh/graphql/operations/queue-session';
import { startServer } from '../../server';

// ---------------------------------------------------------------------------
// Wire types (mirror the GraphQL selection sets in queue-session operations)
// ---------------------------------------------------------------------------

export type SessionUserView = {
  id: string;
  username: string;
  isLeader: boolean;
  avatarUrl: string | null;
  userId: string | null;
  connectionState: string;
};

type ServerQueueStateView = {
  sequence: number;
  stateHash: string;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
};

// QUEUE_UPDATES / EVENTS_REPLAY events. Aliased fields (`addedItem`,
// `currentItem`, `mirroredUuid`) match what mapSubscriptionEnvelopeToAction
// accepts; the extra `sequence` / `stateHash` ride along for the gate.
type RawQueueEvent =
  | { __typename: 'FullSync'; sequence: number; state: ServerQueueStateView }
  | {
      __typename: 'QueueItemAdded';
      sequence: number;
      stateHash: string;
      addedItem: ClimbQueueItem;
      position: number | null;
    }
  | { __typename: 'QueueItemRemoved'; sequence: number; stateHash: string; uuid: string }
  | {
      __typename: 'QueueReordered';
      sequence: number;
      stateHash: string;
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      sequence: number;
      stateHash: string;
      currentItem: ClimbQueueItem | null;
      clientId: string | null;
      correlationId: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      sequence: number;
      stateHash: string;
      mirroredUuid: string | null;
      mirrored: boolean;
    };

type RawSessionEvent =
  | { __typename: 'UserJoined'; user: SessionUserView }
  | { __typename: 'UserLeft'; userId: string }
  | { __typename: 'UserPresenceChanged'; user: SessionUserView }
  | { __typename: 'LeaderChanged'; leaderId: string; leaderConnectionId: string | null }
  | { __typename: 'DriverChanged'; driverParticipantId: string | null; previousDriverParticipantId: string | null }
  | {
      __typename: 'WallConfirmedClimb';
      climbUuid: string;
      confirmedAt: string;
      confirmedByParticipantId: string;
      queueItemUuid: string | null;
    }
  | { __typename: 'SessionBoardSerialChanged'; lastConnectedBoardSerial: string | null }
  | { __typename: 'SessionBoardPathChanged'; boardPath: string; changedByParticipantId: string | null }
  | { __typename: 'SessionEnded'; reason: string; newPath: string | null }
  | { __typename: 'SessionStatsUpdated'; sessionId: string };

type JoinSessionData = {
  joinSession: {
    id: string;
    clientId: string;
    participantId: string;
    isLeader: boolean;
    boardPath: string;
    driverParticipantId: string | null;
    lastConnectedBoardSerial: string | null;
    users: SessionUserView[];
    queueState: ServerQueueStateView;
  };
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export type TestBackend = {
  url: string;
  server: Awaited<ReturnType<typeof startServer>>;
  teardown: () => Promise<void>;
};

/**
 * Boot the real backend on an OS-assigned ephemeral port (PORT=0) — other
 * worktrees' dev servers squat fixed ports, so we never hardcode one.
 *
 * Redis is opt-in via `REDIS_URL`, which the backend reads at import time —
 * before this runs — so we can't flip it here. CI sets it process-wide, so the
 * Redis-backed EVENTS_REPLAY delta-sync runs there; locally (no Redis) the
 * client's resync falls back to a full re-query (see `triggerResync`), exactly
 * like the production client when the event buffer is unavailable. Either way
 * the suite is green and the gap-detect → resync behavior is covered. Postgres
 * (+ Redis when present) is already up via the backend's `global-setup.ts`.
 */
export async function startTestBackend(): Promise<TestBackend> {
  process.env.PORT = '0';
  const server = await startServer();
  // startServer() returns after calling httpServer.listen() but before the
  // 'listening' event; poll address() so we read the bound port only once set.
  await waitFor(() => server.httpServer.address() != null, { timeout: 5000, label: 'server listen' });

  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`test backend did not bind a TCP port (got ${String(address)})`);
  }

  return {
    url: `ws://localhost:${address.port}/graphql`,
    server,
    teardown: async () => {
      server.cleanupIntervals();
      await server.shutdownServices();
      server.wss.close();
      server.httpServer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A queue item shaped exactly like the GraphQL `ClimbQueueItemInput` accepts
 * (the same field set `integration.test.ts` uses). `uuid` is the queue-item id;
 * `climb.uuid` is the climb id — they differ so the same climb can be queued
 * twice. Both are real UUIDs: the backend validates the queue-item uuid on
 * `addQueueItem`, and the climb uuid on `confirmClimbOnWall`. `label` only sets
 * the display name. Read `.uuid` / `.climb.uuid` off the returned item to
 * assert on it across clients.
 */
export function makeClimb(label: string): ClimbQueueItem {
  return {
    uuid: uuidv4(),
    climb: {
      uuid: uuidv4(),
      setter_username: 'test-setter',
      name: `Test Climb ${label}`,
      description: 'A test climb',
      frames: 'p1145r15p1146r12',
      angle: 40,
      ascensionist_count: 10,
      difficulty: 'V5',
      quality_average: '4.5',
      stars: 4.5,
      difficulty_error: '0.5',
      mirrored: false,
      benchmark_difficulty: null,
    },
    addedBy: 'test-user',
    tickedBy: [],
    suggested: false,
  };
}

// Map a stored queue item back to the wire input, picking ONLY ClimbInput
// fields so the server's input coercion never rejects an unknown property.
function toQueueItemInput(item: ClimbQueueItem): ClimbQueueItemInput {
  return {
    uuid: item.uuid,
    climb: {
      uuid: item.climb.uuid,
      setter_username: item.climb.setter_username,
      name: item.climb.name,
      description: item.climb.description ?? null,
      frames: item.climb.frames,
      angle: item.climb.angle,
      ascensionist_count: item.climb.ascensionist_count,
      difficulty: item.climb.difficulty,
      quality_average: item.climb.quality_average,
      stars: item.climb.stars,
      difficulty_error: item.climb.difficulty_error,
      mirrored: item.climb.mirrored ?? false,
      benchmark_difficulty: item.climb.benchmark_difficulty ?? null,
    },
    addedBy: item.addedBy ?? null,
    tickedBy: (item.tickedBy ?? []).filter((id): id is string => id != null),
    suggested: item.suggested ?? false,
  };
}

// ---------------------------------------------------------------------------
// Async test util
// ---------------------------------------------------------------------------

export async function waitFor(
  predicate: () => boolean,
  { timeout = 5000, interval = 20, label = 'condition' }: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ---------------------------------------------------------------------------
// HeadlessParticipant
// ---------------------------------------------------------------------------

export class HeadlessParticipant {
  // Identity (resolved by the backend on join)
  clientId = '';
  participantId = '';
  isLeader = false;

  // Session-level view, fed by the SESSION_UPDATES subscription
  users: SessionUserView[] = [];
  driverParticipantId: string | null = null;
  boardSerial: string | null = null;
  boardPath: string;
  wallConfirmations: Array<{ climbUuid: string; queueItemUuid: string | null }> = [];
  boardPathChanges = 0;

  // Local queue state — driven by the real reducer
  private state: QueueState;
  private coordinator: SyncCoordinator;
  private lastSeq: number | null = null;
  lastServerHash: string | null = null;

  // Resilience instrumentation
  gapDetected = 0;
  private dropInbound = 0;

  readonly mutations: QueueMutationsActions<ClimbQueueItem>;

  private client: ExtendedClient;
  private unsubQueue?: () => void;
  private unsubSession?: () => void;

  constructor(
    private readonly url: string,
    readonly sessionId: string,
    readonly username: string,
    boardPath = '/kilter/1/2/3/40',
  ) {
    this.boardPath = boardPath;
    this.state = initialState<Record<string, unknown>>({});
    // Coordinator clientId is overwritten with the backend-assigned clientId on
    // join (echo suppression relies on eventClientId === myClientId).
    this.coordinator = createQueueSyncCoordinator({ dispatch: (action) => this.dispatch(action) });
    this.client = this.createClient();
    this.mutations = createQueueMutations<ClimbQueueItem>({
      getClient: () => this.client,
      getSessionId: () => this.sessionId,
      toQueueItemInput,
    });
  }

  private createClient(): ExtendedClient {
    return createGraphQLClient({
      url: this.url,
      connectionName: this.username,
      webSocketImpl: WS as unknown as typeof WebSocket,
      // Deterministic teardown: never auto-retry. Disconnect/reconnect in tests
      // is modeled explicitly via disconnect()/reconnect().
      shouldRetry: () => false,
    });
  }

  // --- lifecycle ----------------------------------------------------------

  /** Join the session on a single, persistent graphql-ws socket and wait until
   *  the first FullSync proves the subscription is live. */
  async join(): Promise<void> {
    await this.connectAndJoin();
  }

  /**
   * Open the subscriptions FIRST, then join — on the SAME socket. The shared
   * client is lazy: it closes the moment no operation is in flight, so a
   * join-then-subscribe ordering would close the joined socket and reopen an
   * unjoined one, and `queueUpdates`'s server-side `requireSessionMember` would
   * reject it. Subscribing first keeps the socket alive; `requireSessionMember`
   * retries until the join below lands on it (the same race the web client
   * relies on). The FullSync is gated on membership, so it arrives only after
   * the join resolves.
   */
  private async connectAndJoin(): Promise<void> {
    const fullSyncReady = this.openSubscriptions();
    const data = await execute<JoinSessionData>(this.client, {
      query: JOIN_SESSION,
      variables: {
        sessionId: this.sessionId,
        boardPath: this.boardPath,
        username: this.username,
        participantId: this.participantId || undefined,
      },
    });
    const joined = data.joinSession;
    this.clientId = joined.clientId;
    this.participantId = joined.participantId;
    this.isLeader = joined.isLeader;
    this.users = joined.users;
    this.driverParticipantId = joined.driverParticipantId;
    this.boardSerial = joined.lastConnectedBoardSerial;
    // Re-key the coordinator to the backend-assigned clientId (echo suppression
    // matches the server's CurrentClimbChanged.clientId against this).
    this.coordinator = createQueueSyncCoordinator({
      dispatch: (action) => this.dispatch(action),
      clientId: this.clientId,
    });
    await fullSyncReady;
  }

  private openSubscriptions(): Promise<void> {
    let sawFullSync = false;
    let subError: string | null = null;
    this.unsubQueue = subscribe<{ queueUpdates: RawQueueEvent }>(
      this.client,
      { query: QUEUE_UPDATES, variables: { sessionId: this.sessionId } },
      {
        next: (payload) => {
          if (payload.queueUpdates.__typename === 'FullSync') sawFullSync = true;
          this.handleQueueEvent(payload.queueUpdates);
        },
        error: (error) => {
          subError = error instanceof Error ? error.message : String(error);
        },
        complete: () => {},
      },
    );
    this.unsubSession = subscribe<{ sessionUpdates: RawSessionEvent }>(
      this.client,
      { query: SESSION_UPDATES, variables: { sessionId: this.sessionId } },
      { next: (payload) => this.handleSessionEvent(payload.sessionUpdates), error: () => {}, complete: () => {} },
    );
    return waitFor(() => sawFullSync, { label: `${this.username} FullSync`, timeout: 8000 }).catch(() => {
      throw new Error(
        `${this.username} never received FullSync${subError ? ` (subscription error: ${subError})` : ''}`,
      );
    });
  }

  /** Drop the socket without forgetting local state (simulates going offline). */
  async disconnect(): Promise<void> {
    this.unsubQueue?.();
    this.unsubSession?.();
    this.unsubQueue = undefined;
    this.unsubSession = undefined;
    await this.client.dispose();
  }

  /** Come back online on a fresh socket and rejoin as the same participant. The
   *  fresh subscription's FullSync resyncs missed state (a real reconnect). */
  async reconnect(): Promise<void> {
    this.client = this.createClient();
    await this.connectAndJoin();
  }

  async leave(): Promise<void> {
    await execute(this.client, { query: LEAVE_SESSION });
  }

  async dispose(): Promise<void> {
    this.unsubQueue?.();
    this.unsubSession?.();
    this.coordinator.dispose();
    await this.client.dispose();
  }

  // --- event processing (mirrors web's use-event-processor) ----------------

  private dispatch(action: QueueAction): void {
    this.state = queueReducer(this.state, action);
  }

  private handleQueueEvent(event: RawQueueEvent): void {
    if (event.__typename !== 'FullSync') {
      // Simulate a missed delta (test goes "offline" for one event).
      if (this.dropInbound > 0) {
        this.dropInbound -= 1;
        return;
      }
      const decision = evaluateQueueEventSequence(this.lastSeq, event.sequence);
      if (decision === 'ignore-stale') return;
      if (decision === 'gap') {
        this.gapDetected += 1;
        void this.triggerResync();
        return;
      }
    }

    const result = mapSubscriptionEnvelopeToAction<ClimbQueueItem>(event, { context: { myClientId: this.clientId } });
    if (result.kind === 'dispatch') this.dispatch(result.action);

    if (event.__typename === 'FullSync') {
      this.lastSeq = event.sequence;
      this.lastServerHash = event.state.stateHash;
    } else {
      this.lastSeq = event.sequence;
      this.lastServerHash = event.stateHash;
    }
  }

  private handleSessionEvent(event: RawSessionEvent): void {
    switch (event.__typename) {
      case 'UserJoined':
        if (!this.users.some((u) => u.id === event.user.id)) this.users = [...this.users, event.user];
        else this.users = this.users.map((u) => (u.id === event.user.id ? event.user : u));
        break;
      case 'UserPresenceChanged':
        this.users = this.users.map((u) => (u.id === event.user.id ? event.user : u));
        break;
      case 'UserLeft':
        this.users = this.users.filter((u) => u.id !== event.userId);
        break;
      case 'DriverChanged':
        this.driverParticipantId = event.driverParticipantId;
        break;
      case 'WallConfirmedClimb':
        this.wallConfirmations.push({ climbUuid: event.climbUuid, queueItemUuid: event.queueItemUuid });
        break;
      case 'SessionBoardSerialChanged':
        this.boardSerial = event.lastConnectedBoardSerial;
        break;
      case 'SessionBoardPathChanged':
        this.boardPath = event.boardPath;
        this.boardPathChanges += 1;
        break;
      default:
        break;
    }
  }

  /** Recover after a gap/reconnect. Prefer the delta-sync path (EVENTS_REPLAY,
   *  the web client's "Phase 2" optimization); fall back to a full re-query when
   *  the Redis-backed event buffer is unavailable — exactly the production
   *  client's behavior. CI (Redis on) drives the replay path; local (no Redis)
   *  drives the FullSync fallback. Both reconcile to the same converged state. */
  async triggerResync(): Promise<void> {
    try {
      const data = await execute<{ eventsReplay: { currentSequence: number; events: RawQueueEvent[] } }>(this.client, {
        query: EVENTS_REPLAY,
        variables: { sessionId: this.sessionId, sinceSequence: this.lastSeq ?? 0 },
      });
      for (const event of data.eventsReplay.events) {
        this.handleQueueEvent(event);
      }
    } catch {
      await this.resyncFromFullState();
    }
  }

  /** Force a full reconciliation to the server's authoritative state — the
   *  recovery the production hash-drift watchdog performs when a client's hash
   *  diverges from the server's at the same sequence (which delta-replay can't
   *  repair, since it only returns events AFTER the last-seen sequence). */
  async forceFullResync(): Promise<void> {
    await this.resyncFromFullState();
  }

  private async resyncFromFullState(): Promise<void> {
    const data = await execute<{ session: { queueState: ServerQueueStateView } }>(this.client, {
      query: RESYNC_QUERY,
      variables: { sessionId: this.sessionId },
    });
    const queueState = data.session.queueState;
    this.handleQueueEvent({ __typename: 'FullSync', sequence: queueState.sequence, state: queueState });
  }

  // --- helpers for tests --------------------------------------------------

  /** Faithful "user taps a climb" path: optimistic local update + correlation
   *  tracking, then the shared setCurrentClimb mutation. The server's echo
   *  (carrying the same correlationId) is suppressed by the reducer. */
  async navigateToClimb(item: ClimbQueueItem, shouldAddToQueue = true): Promise<void> {
    const correlationId = this.coordinator.generateCorrelationId();
    this.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue, isServerEvent: false, correlationId },
    });
    this.coordinator.trackPendingMutation(correlationId);
    await this.mutations.setCurrentClimb(item, shouldAddToQueue, correlationId);
  }

  /** Faithful "take the wall" path. `takeControl(climb)` broadcasts the climb
   *  with `clientId` = this connection, so the reducer suppresses our own echo —
   *  meaning the caller must set current optimistically, exactly like the app.
   *  The driver role lands for everyone (including us) via the DriverChanged
   *  session event. */
  async takeWall(item: ClimbQueueItem): Promise<void> {
    this.dispatch({
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: true, isServerEvent: false },
    });
    await this.mutations.takeControl(item);
  }

  /** Reorder a queue item. The shared `createQueueMutations` factory doesn't
   *  wrap reorder (web fires it from its drag handler), so this issues the raw
   *  mutation directly — the reducer still applies the resulting QueueReordered
   *  event like any other delta. */
  async reorder(uuid: string, oldIndex: number, newIndex: number): Promise<void> {
    await execute(this.client, { query: REORDER_QUEUE_ITEM, variables: { uuid, oldIndex, newIndex } });
  }

  /** Skip the next `n` inbound delta events (simulates a brief offline window
   *  that opens a sequence gap on the next event). */
  dropNextInboundEvents(n: number): void {
    this.dropInbound = n;
  }

  /** The highest queue sequence this participant has applied. */
  appliedSequence(): number | null {
    return this.lastSeq;
  }

  /** In-flight optimistic setCurrentClimb correlation IDs. Drops to 0 once the
   *  server echo matching a tracked id is suppressed by the reducer. */
  pendingUpdateCount(): number {
    return this.state.pendingCurrentClimbUpdates.length;
  }

  get queue(): ClimbQueueItem[] {
    return this.state.queue;
  }

  get currentUuid(): string | null {
    return this.state.currentClimbQueueItem?.uuid ?? null;
  }

  queueUuids(): string[] {
    return this.state.queue.map((item) => item.uuid);
  }

  /** Per-item mirrored flags, keyed by queue-item uuid (order-independent). */
  mirrorMap(): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const item of this.state.queue) map[item.uuid] = Boolean(item.climb.mirrored);
    if (this.state.currentClimbQueueItem) {
      map[this.state.currentClimbQueueItem.uuid] = Boolean(this.state.currentClimbQueueItem.climb.mirrored);
    }
    return map;
  }

  /** FNV hash of local state — computed with the SAME function the backend
   *  uses, so it equals the server's authoritative hash for identical state. */
  localHash(): string {
    return computeQueueStateHash(this.state.queue, this.currentUuid);
  }

  /** Authoritative server state, queried over this participant's own socket. */
  serverState(): Promise<ServerSessionView> {
    return queryServerState(this.client, this.sessionId);
  }
}

// ---------------------------------------------------------------------------
// Authoritative server state (for client↔server parity assertions)
// ---------------------------------------------------------------------------

const SESSION_QUERY = `
  query Session($sessionId: ID!) {
    session(sessionId: $sessionId) {
      id
      driverParticipantId
      lastConnectedBoardSerial
      users { id username isLeader avatarUrl userId connectionState }
      queueState {
        sequence
        stateHash
        queue { uuid climb { uuid mirrored } }
        currentClimbQueueItem { uuid }
      }
    }
  }
`;

// Full queue-item fields, for the FullSync resync fallback (re-hydrates the
// reducer with complete climb data, not just uuids).
const RESYNC_QUEUE_ITEM_FIELDS = `
  uuid
  climb {
    uuid setter_username name frames angle ascensionist_count difficulty
    quality_average stars difficulty_error mirrored benchmark_difficulty
  }
  addedBy
  tickedBy
  suggested
`;

const RESYNC_QUERY = `
  query ResyncSession($sessionId: ID!) {
    session(sessionId: $sessionId) {
      queueState {
        sequence
        stateHash
        queue { ${RESYNC_QUEUE_ITEM_FIELDS} }
        currentClimbQueueItem { ${RESYNC_QUEUE_ITEM_FIELDS} }
      }
    }
  }
`;

export type ServerSessionView = {
  driverParticipantId: string | null;
  lastConnectedBoardSerial: string | null;
  users: SessionUserView[];
  queueState: {
    sequence: number;
    stateHash: string;
    queue: Array<{ uuid: string; climb: { uuid: string; mirrored: boolean | null } }>;
    currentClimbQueueItem: { uuid: string } | null;
  };
};

export async function queryServerState(client: ExtendedClient, sessionId: string): Promise<ServerSessionView> {
  const data = await execute<{ session: ServerSessionView }>(client, {
    query: SESSION_QUERY,
    variables: { sessionId },
  });
  return data.session;
}

// ---------------------------------------------------------------------------
// Convergence helpers
// ---------------------------------------------------------------------------

/**
 * Wait until every participant has converged on the server's authoritative
 * state. Requires BOTH that each client's locally-computed hash equals the
 * server's hash (proves the same uuid set + current climb) AND that each client
 * has applied up to the server's sequence (catches reorder/mirror deltas, which
 * leave the uuid set — and thus the hash — unchanged). The two together also
 * ride out the brief window where a client is mid-resync after a sequence gap.
 * Returns the authoritative server view once everyone is caught up.
 */
export async function waitForConvergence(
  participants: HeadlessParticipant[],
  { timeout = 5000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<ServerSessionView> {
  const start = Date.now();
  for (;;) {
    const server = await participants[0].serverState();
    const targetSeq = server.queueState.sequence;
    const targetHash = server.queueState.stateHash;
    const converged = participants.every(
      (p) => (p.appliedSequence() ?? -1) >= targetSeq && p.localHash() === targetHash,
    );
    if (converged) return server;
    if (Date.now() - start > timeout) {
      const dump = participants.map((p) => `${p.username}@seq${p.appliedSequence()}/${p.localHash()}`).join(', ');
      throw new Error(`convergence timed out; server seq=${targetSeq}/${targetHash}, clients: ${dump}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Assert all participants agree on queue order, current climb, and mirror
 *  flags (the order/mirror-sensitive checks the hash can't make). */
export function expectConverged(participants: HeadlessParticipant[]): void {
  const [first, ...rest] = participants;
  for (const other of rest) {
    expect(other.queueUuids(), `${other.username} queue order vs ${first.username}`).toEqual(first.queueUuids());
    expect(other.currentUuid, `${other.username} current vs ${first.username}`).toEqual(first.currentUuid);
    expect(other.mirrorMap(), `${other.username} mirror flags vs ${first.username}`).toEqual(first.mirrorMap());
  }
}

/** Assert each participant's locally-computed hash matches the server's
 *  authoritative hash (and the hash carried on its last applied event). */
export function expectHashParity(participants: HeadlessParticipant[], server: ServerSessionView): void {
  for (const participant of participants) {
    expect(participant.localHash(), `${participant.username} local hash vs server`).toBe(server.queueState.stateHash);
    if (participant.lastServerHash !== null) {
      expect(participant.lastServerHash, `${participant.username} last-event hash vs local`).toBe(
        participant.localHash(),
      );
    }
  }
}

/** Wait for convergence, then assert both invariants in one call. */
export async function assertConverged(participants: HeadlessParticipant[], opts?: { timeout?: number }): Promise<void> {
  const server = await waitForConvergence(participants, opts);
  expectConverged(participants);
  expectHashParity(participants, server);
}
