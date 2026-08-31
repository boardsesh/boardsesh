import type {
  QueueEvent,
  SessionEvent,
  NotificationEvent,
  CommentEvent,
  NewClimbCreatedEvent,
  BoardPresenceEvent,
  BoardPresenceClimb,
  BoardLayersSnapshot,
  BoardQueuePreview,
  ClimbStatsEvent,
} from '@boardsesh/shared-schema';
import { redisClientManager } from '../redis/client';
import { createRedisPubSubAdapter, type RedisPubSubAdapter } from './redis-adapter';
import { PubSubChannel, type ChannelSubscriber } from './channel';
import {
  BoardPresenceStore,
  type BoardSeqAllocator,
  type BoardReportGate,
  type CommitBoardClimbInput,
  type CommitBoardClimbResult,
  type CommitBoardLayersResult,
  type BoardLayersStaleResult,
  type BoardWriterTakeResult,
} from './board-presence-store';
import { logger } from '../utils/logger';

// Board-presence gate/commit types live with their implementation in
// board-presence-store.ts; re-exported here so consumers keep importing them
// from the pubsub entry point.
export type {
  BoardReportGate,
  CommitBoardClimbInput,
  CommitBoardClimbResult,
  CommitBoardLayersResult,
  BoardWriterTakeResult,
} from './board-presence-store';

type QueueSubscriber = ChannelSubscriber<QueueEvent>;
type SessionSubscriber = ChannelSubscriber<SessionEvent>;
type NotificationSubscriber = ChannelSubscriber<NotificationEvent>;
type CommentSubscriber = ChannelSubscriber<CommentEvent>;
type NewClimbSubscriber = ChannelSubscriber<NewClimbCreatedEvent>;
type BoardPresenceSubscriber = ChannelSubscriber<BoardPresenceEvent>;
type BoardQueuePreviewSubscriber = ChannelSubscriber<BoardQueuePreview>;
type ClimbStatsSubscriber = ChannelSubscriber<ClimbStatsEvent>;

/** External hook called after every queue event publish. Fire-and-forget. */
export type QueueEventHook = (sessionId: string, event: QueueEvent) => void;

// Event buffer configuration (Phase 2: Delta sync)
const EVENT_BUFFER_SIZE = 100; // Store last 100 events per session
const EVENT_BUFFER_TTL = 300; // 5 minutes

/**
 * Hybrid PubSub that supports both local-only and Redis-backed modes.
 *
 * In Redis mode (multi-instance):
 * - Events are published to Redis channels
 * - Events from other instances are received and dispatched to local subscribers
 * - Local dispatch happens first for low latency
 *
 * In local-only mode (single instance, no Redis):
 * - Events are only dispatched to local subscribers
 * - Used when REDIS_URL is not configured
 *
 * The eight domains below (queue, session, notification, comment, new-climb,
 * climb-stats, board-presence, board-queue) all share the exact same subscribe/publish/fan-in mechanics
 * — that generic behavior lives in `PubSubChannel` (./channel.ts). Each
 * `redisSubscribe`/`redisUnsubscribe`/`redisPublish` closure below resolves to
 * a no-op when `redisAdapter` is null (local-only mode or not-yet-initialized),
 * which is intentional: it reproduces the old `if (this.redisAdapter) { ... }`
 * guards without the channel needing to know about `redisAdapter` at all.
 * Domain-specific quirks (queue's replay buffer + APNs hook; board-presence's
 * Redis KV helpers) are NOT part of the generic channel — they're layered on
 * top in this class, documented at their call sites below.
 */
class PubSub {
  // No `redisPublish` here: queue publishes don't go through `channel.publish()`.
  // `publishQueueEvent` issues the Redis publish explicitly so the replay-buffer
  // LPUSH can be ordered before the fan-out PUBLISH on the wire (see its docstring).
  private readonly queueChannel = new PubSubChannel<QueueEvent>({
    label: 'queue',
    redisSubscribe: (sessionId) => this.redisAdapter?.subscribeQueueChannel(sessionId) ?? Promise.resolve(),
    redisUnsubscribe: (sessionId) => this.redisAdapter?.unsubscribeQueueChannel(sessionId) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly sessionChannel = new PubSubChannel<SessionEvent>({
    label: 'session',
    redisSubscribe: (sessionId) => this.redisAdapter?.subscribeSessionChannel(sessionId) ?? Promise.resolve(),
    redisUnsubscribe: (sessionId) => this.redisAdapter?.unsubscribeSessionChannel(sessionId) ?? Promise.resolve(),
    redisPublish: (sessionId, event) => this.redisAdapter?.publishSessionEvent(sessionId, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly notificationChannel = new PubSubChannel<NotificationEvent>({
    label: 'notification',
    redisSubscribe: (userId) => this.redisAdapter?.subscribeNotificationChannel(userId) ?? Promise.resolve(),
    redisUnsubscribe: (userId) => this.redisAdapter?.unsubscribeNotificationChannel(userId) ?? Promise.resolve(),
    redisPublish: (userId, event) => this.redisAdapter?.publishNotificationEvent(userId, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly commentChannel = new PubSubChannel<CommentEvent>({
    label: 'comment',
    redisSubscribe: (entityKey) => this.redisAdapter?.subscribeCommentChannel(entityKey) ?? Promise.resolve(),
    redisUnsubscribe: (entityKey) => this.redisAdapter?.unsubscribeCommentChannel(entityKey) ?? Promise.resolve(),
    redisPublish: (entityKey, event) => this.redisAdapter?.publishCommentEvent(entityKey, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly newClimbChannel = new PubSubChannel<NewClimbCreatedEvent>({
    label: 'new climb',
    redisSubscribe: (channelKey) => this.redisAdapter?.subscribeNewClimbChannel(channelKey) ?? Promise.resolve(),
    redisUnsubscribe: (channelKey) => this.redisAdapter?.unsubscribeNewClimbChannel(channelKey) ?? Promise.resolve(),
    redisPublish: (channelKey, event) =>
      this.redisAdapter?.publishNewClimbEvent(channelKey, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly climbStatsChannel = new PubSubChannel<ClimbStatsEvent>({
    label: 'climb stats',
    redisSubscribe: (channelKey) => this.redisAdapter?.subscribeClimbStatsChannel(channelKey) ?? Promise.resolve(),
    redisUnsubscribe: (channelKey) => this.redisAdapter?.unsubscribeClimbStatsChannel(channelKey) ?? Promise.resolve(),
    redisPublish: (channelKey, event) =>
      this.redisAdapter?.publishClimbStatsEvent(channelKey, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private readonly boardPresenceChannel = new PubSubChannel<BoardPresenceEvent>({
    label: 'board presence',
    redisSubscribe: (boardId) => this.redisAdapter?.subscribeBoardPresenceChannel(boardId) ?? Promise.resolve(),
    redisUnsubscribe: (boardId) => this.redisAdapter?.unsubscribeBoardPresenceChannel(boardId) ?? Promise.resolve(),
    redisPublish: (boardId, event) => this.redisAdapter?.publishBoardPresenceEvent(boardId, event) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  // Redacted "Up next" previews for public gym displays. Keyed on the shared
  // board_id like board presence; each event is a full snapshot (latest wins).
  private readonly boardQueueChannel = new PubSubChannel<BoardQueuePreview>({
    label: 'board queue',
    redisSubscribe: (boardId) => this.redisAdapter?.subscribeBoardQueueChannel(boardId) ?? Promise.resolve(),
    redisUnsubscribe: (boardId) => this.redisAdapter?.unsubscribeBoardQueueChannel(boardId) ?? Promise.resolve(),
    redisPublish: (boardId, preview) =>
      this.redisAdapter?.publishBoardQueuePreview(boardId, preview) ?? Promise.resolve(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  // Board-presence Redis KV helpers (seq counter, durable history, proof-of-
  // presence, writer holder, session→board) live outside the generic channel
  // — see board-presence-store.ts for why.
  private readonly boardPresenceStore = new BoardPresenceStore({
    isRedisAvailable: () => this.isRedisConnected(),
    isRedisRequired: () => this.redisRequired,
    logger,
  });
  private redisAdapter: RedisPubSubAdapter | null = null;
  private initialized = false;
  private redisRequired = false;
  private queueEventHooks: QueueEventHook[] = [];

  /**
   * Initialize the PubSub system.
   * Connects to Redis if configured.
   *
   * @throws If Redis is configured but connection fails (fail-closed behavior)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.redisRequired = redisClientManager.isRedisConfigured();

    if (this.redisRequired) {
      // Fail-closed: require Redis connection when configured
      const connected = await redisClientManager.connect();

      if (!connected) {
        throw new Error('Redis is configured but connection failed');
      }

      const { publisher, subscriber } = redisClientManager.getClients();
      this.redisAdapter = createRedisPubSubAdapter(publisher, subscriber);
      this.setupRedisMessageHandlers();

      logger.info(`[PubSub] Redis mode enabled (instance: ${this.redisAdapter.getInstanceId()})`);
    } else {
      logger.info('[PubSub] Local-only mode (single instance - no REDIS_URL configured)');
    }

    this.initialized = true;
  }

  /**
   * Check if Redis is connected and available.
   */
  isRedisConnected(): boolean {
    return this.redisAdapter !== null && redisClientManager.isRedisConnected();
  }

  /**
   * Check if Redis is required (REDIS_URL was configured at startup).
   */
  isRedisRequired(): boolean {
    return this.redisRequired;
  }

  /**
   * Get the unique ID assigned to this backend instance, or null when
   * running in local-only mode. Used to tag logs and correlate cross-instance
   * events.
   */
  getInstanceId(): string | null {
    return this.redisAdapter?.getInstanceId() ?? null;
  }

  /**
   * Register an external hook that fires after every queue event publish.
   * Multiple hooks may be registered (APNs Live Activity updates, the
   * board-queue-preview producer, ...); they fire in registration order.
   * Each hook is called fire-and-forget (not awaited, errors are caught
   * internally and isolated per hook). Returns an unregister function —
   * mirrors the `subscribe*` unsubscribe contract.
   *
   * **Publisher-side semantics (important for multi-instance deployments):**
   * Hooks fire only on the instance that calls `publishQueueEvent`. They are
   * NOT invoked by the Redis fan-in path (`queueChannel.dispatchLocal`) when a
   * Redis fan-out message arrives from another instance — that path bypasses
   * the hooks intentionally so a single event published in a 3-instance
   * cluster does not trigger 3 redundant APNs sends (or 3 redundant
   * board-queue-preview publishes — the preview channel itself Redis-fans-out).
   *
   * Implication: every backend instance that receives queue mutations must
   * have APNs env vars configured, otherwise queue events that originate on
   * an unconfigured instance will skip the push (the hook still runs but
   * `sendLiveActivityUpdate` becomes a no-op when `configured === false`).
   * The startup log in `server.ts` warns when env vars are missing.
   */
  addQueueEventHook(hook: QueueEventHook): () => void {
    this.queueEventHooks.push(hook);
    return () => {
      const index = this.queueEventHooks.indexOf(hook);
      if (index !== -1) {
        this.queueEventHooks.splice(index, 1);
      }
    };
  }

  private setupRedisMessageHandlers(): void {
    if (!this.redisAdapter) return;

    this.redisAdapter.onQueueMessage((sessionId, event) => {
      this.queueChannel.dispatchLocal(sessionId, event);
    });

    this.redisAdapter.onSessionMessage((sessionId, event) => {
      this.sessionChannel.dispatchLocal(sessionId, event);
    });

    this.redisAdapter.onNotificationMessage((userId, event) => {
      this.notificationChannel.dispatchLocal(userId, event);
    });

    this.redisAdapter.onCommentMessage((entityKey, event) => {
      this.commentChannel.dispatchLocal(entityKey, event);
    });

    this.redisAdapter.onNewClimbMessage((channelKey, event) => {
      this.newClimbChannel.dispatchLocal(channelKey, event);
    });

    this.redisAdapter.onClimbStatsMessage((channelKey, event) => {
      this.climbStatsChannel.dispatchLocal(channelKey, event);
    });

    this.redisAdapter.onBoardPresenceMessage((boardId, event) => {
      this.boardPresenceChannel.dispatchLocal(boardId, event);
    });

    this.redisAdapter.onBoardQueueMessage((boardId, preview) => {
      this.boardQueueChannel.dispatchLocal(boardId, preview);
    });
  }

  /**
   * Subscribe to queue events for a session.
   * @returns Promise that resolves to an unsubscribe function
   * @throws If Redis is required but not connected, or if Redis subscription fails
   */
  async subscribeQueue(sessionId: string, callback: QueueSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.queueChannel.subscribe(sessionId, callback);
  }

  /**
   * Subscribe to session events (user joins/leaves, leader changes).
   * @returns Promise that resolves to an unsubscribe function
   * @throws If Redis is required but not connected, or if Redis subscription fails
   */
  async subscribeSession(sessionId: string, callback: SessionSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.sessionChannel.subscribe(sessionId, callback);
  }

  /**
   * Store a queue event in the event buffer for delta sync (Phase 2).
   * Events are stored in a Redis list with a TTL.
   */
  private async storeEventInBuffer(sessionId: string, event: QueueEvent): Promise<void> {
    if (!this.redisAdapter) {
      // No Redis - skip event buffering (will fallback to full sync)
      return;
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const bufferKey = `session:${sessionId}:events`;
      const eventJson = JSON.stringify(event);

      // Add to front of list (newest events first)
      await publisher.lpush(bufferKey, eventJson);
      // Trim to keep only last N events
      await publisher.ltrim(bufferKey, 0, EVENT_BUFFER_SIZE - 1);
      // Set TTL (5 minutes)
      await publisher.expire(bufferKey, EVENT_BUFFER_TTL);
    } catch (error) {
      logger.error('[PubSub] Failed to store event in buffer:', error);
      // Don't throw - event buffering is optional (will fallback to full sync)
    }
  }

  /**
   * Retrieve events since a given sequence number (Phase 2).
   * Used for delta sync on reconnection.
   * Returns events in ascending sequence order.
   *
   * Defensively drops any `PlaybackStateChanged` entries found in the buffer.
   * `publishQueueEvent` no longer writes them (see `storeEventInBuffer` call
   * site below), but during a mixed-version rollout an old instance may still
   * have buffered one within the 5-minute TTL — its reused, non-monotonic
   * sequence would otherwise break the client's replay-contiguity check.
   */
  async getEventsSince(sessionId: string, sinceSequence: number): Promise<QueueEvent[]> {
    if (!this.redisAdapter) {
      throw new Error('Event buffer requires Redis');
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const bufferKey = `session:${sessionId}:events`;

      // Get all events from buffer (newest first due to lpush)
      const eventJsons = await publisher.lrange(bufferKey, 0, -1);

      // Parse and filter events
      const events: QueueEvent[] = [];
      for (const json of eventJsons) {
        try {
          const event = JSON.parse(json) as QueueEvent;
          if (event.__typename === 'PlaybackStateChanged') {
            continue;
          }
          if (event.sequence > sinceSequence) {
            events.push(event);
          }
        } catch (parseError) {
          logger.error('[PubSub] Failed to parse buffered event:', parseError);
        }
      }

      // Sort by sequence (ascending) since buffer is newest-first
      events.sort((a, b) => a.sequence - b.sequence);

      return events;
    } catch (error) {
      logger.error('[PubSub] Failed to retrieve events from buffer:', error);
      throw error;
    }
  }

  /**
   * Publish a queue event to all subscribers of a session.
   * Dispatches locally first, then stores the event in the delta-sync buffer,
   * then publishes to Redis for other instances, then fires the registered
   * queue-event hooks (APNs, board-queue preview) — the buffer and hooks are
   * queue-only quirks layered on top of the generic channel, not part of
   * `PubSubChannel` itself.
   *
   * `PlaybackStateChanged` events are excluded from buffering: they reuse the
   * room's current sequence number (rather than incrementing it) and can fire
   * up to 3600/min, so buffering them would both evict real queue events from
   * the 100-entry buffer within seconds and hand replaying clients
   * non-monotonic/duplicate sequences. See `publishPlaybackState` in
   * `graphql/resolvers/queue/mutations.ts`.
   *
   * Note: Redis publish errors are logged but not thrown to avoid blocking
   * the local dispatch. In Redis mode, events may not reach other instances
   * if Redis publish fails.
   */
  publishQueueEvent(sessionId: string, event: QueueEvent): void {
    // Always dispatch to local subscribers first (low latency). Deliberately
    // NOT `queueChannel.publish()`: the queue domain must interleave the
    // replay-buffer write between local dispatch and the Redis publish (see
    // ordering contract below), so the Redis publish is issued explicitly.
    this.queueChannel.dispatchLocal(sessionId, event);

    // Store event in buffer for delta sync (Phase 2), except playback events
    // (see docstring above). Fire and forget - don't block on buffer storage.
    // Ordering contract: the buffer LPUSH must be written (hit the wire)
    // before the fan-out PUBLISH below, so a remote instance can never
    // dispatch an event that a reconnecting client's `getEventsSince` replay
    // can't yet see. Both commands go through the same Redis connection, so
    // call order here fixes wire order.
    if (event.__typename !== 'PlaybackStateChanged') {
      this.storeEventInBuffer(sessionId, event).catch((error) => {
        logger.error(`[PubSub] Failed to buffer event for session ${sessionId}:`, error);
        // Non-fatal: clients will fall back to full sync if delta sync fails
      });
    }

    // Also publish to Redis if available
    if (this.redisAdapter) {
      this.redisAdapter.publishQueueEvent(sessionId, event).catch((error) => {
        logger.error('[PubSub] Redis queue publish failed:', error);
        // Log but don't throw - local dispatch already succeeded
        // Health check will report Redis as unhealthy if connection is lost
      });
    }

    // Fire external hooks (APNs Live Activity updates, board-queue-preview
    // producer, ...). Errors are isolated per hook so one failing hook can't
    // starve the others.
    for (const hook of this.queueEventHooks) {
      try {
        hook(sessionId, event);
      } catch (error) {
        logger.error('[PubSub] Queue event hook error:', error);
      }
    }
  }

  /**
   * Publish a session event to all subscribers.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishSessionEvent(sessionId: string, event: SessionEvent): void {
    this.sessionChannel.publish(sessionId, event);
  }

  /**
   * Subscribe to notification events for a user.
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeNotifications(userId: string, callback: NotificationSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.notificationChannel.subscribe(userId, callback);
  }

  /**
   * Publish a notification event to a user.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishNotificationEvent(userId: string, event: NotificationEvent): void {
    this.notificationChannel.publish(userId, event);
  }

  /**
   * Subscribe to comment events for an entity.
   * @param entityKey format: `${entityType}:${entityId}`
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeComments(entityKey: string, callback: CommentSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.commentChannel.subscribe(entityKey, callback);
  }

  /**
   * Publish a comment event for an entity.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishCommentEvent(entityKey: string, event: CommentEvent): void {
    this.commentChannel.publish(entityKey, event);
  }

  /**
   * Subscribe to new climb events for a board type + layout combination.
   * @param channelKey format: `${boardType}:${layoutId}`
   */
  async subscribeNewClimbs(channelKey: string, callback: NewClimbSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.newClimbChannel.subscribe(channelKey, callback);
  }

  /**
   * Publish a new climb event to subscribers.
   */
  publishNewClimbEvent(channelKey: string, event: NewClimbCreatedEvent): void {
    this.newClimbChannel.publish(channelKey, event);
  }

  // ============================================
  // Board presence ("now on the wall")
  //
  // Keyed on the shared board_id (userBoards.id, resolved from the BLE
  // serial). Membership-free: anyone who has connected to the board can watch
  // its live feed. Mirrors the new-climb domain exactly, plus a per-board
  // monotonic seq and a durable Redis FIFO for late-joiner backfill.
  // ============================================

  /**
   * Subscribe to board-presence events for a shared board.
   * @param boardId stringified userBoards.id
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeBoardPresence(boardId: string, callback: BoardPresenceSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.boardPresenceChannel.subscribe(boardId, callback);
  }

  /**
   * Publish a board-presence event to subscribers.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishBoardPresenceEvent(boardId: string, event: BoardPresenceEvent): void {
    this.boardPresenceChannel.publish(boardId, event);
  }

  /**
   * Subscribe to redacted board-queue previews for a shared board (gym-kiosk
   * "Up next"). Same keying and mechanics as board presence.
   * @param boardId stringified userBoards.id
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeBoardQueuePreview(boardId: string, callback: BoardQueuePreviewSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.boardQueueChannel.subscribe(boardId, callback);
  }

  /**
   * Publish a redacted board-queue preview snapshot to subscribers.
   * Dispatches locally first, then publishes to Redis for other instances.
   * Callers must have applied the privacy gates BEFORE publishing (anon-
   * readable board + isPublic session) — the channel itself is gate-free.
   */
  publishBoardQueuePreview(boardId: string, preview: BoardQueuePreview): void {
    this.boardQueueChannel.publish(boardId, preview);
  }

  /** Subscribe once per board layout; events route to exact climb/angle keys. */
  async subscribeClimbStats(channelKey: string, callback: ClimbStatsSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();
    return this.climbStatsChannel.subscribe(channelKey, callback);
  }

  /** Publish a complete canonical stats row locally and across Redis. */
  publishClimbStatsEvent(channelKey: string, event: ClimbStatsEvent): void {
    this.climbStatsChannel.publish(channelKey, event);
  }

  // The methods below delegate to `boardPresenceStore` (board-presence-store.ts)
  // — Redis KV bookkeeping for the board-presence domain (seq counter, durable
  // history, proof-of-presence, writer holder, session→board) that sits
  // alongside but outside the generic pub/sub channel above. See that file
  // for the full rationale on each method; signatures and behavior here are
  // unchanged from before the extraction.

  /** Inject the legacy durable seq-floor lookup used by isolated tests. */
  setBoardSeqFloorProvider(provider: (boardId: number) => Promise<number>): void {
    this.boardPresenceStore.setBoardSeqFloorProvider(provider);
  }

  /** Install/remove PostgreSQL's authoritative board-sequence allocator. */
  setBoardSeqAllocator(provider: BoardSeqAllocator | null): void {
    this.boardPresenceStore.setBoardSeqAllocator(provider);
  }

  /** Atomically allocate the next monotonic sequence number for a board. */
  async nextBoardSeq(boardId: string, allocatorOverride?: BoardSeqAllocator): Promise<number> {
    return this.boardPresenceStore.nextBoardSeq(boardId, allocatorOverride);
  }

  /** Atomically allocate a board seq guaranteed past `floor`; null without Redis. Public for unit tests. */
  async allocateBoardSeqAtLeast(boardId: string, floor: number): Promise<number | null> {
    return this.boardPresenceStore.allocateBoardSeqAtLeast(boardId, floor);
  }

  /** Read a board's recent climbs, newest-first by seq (cap 50). Empty without Redis. */
  async getRecentBoardClimbs(boardId: string): Promise<BoardPresenceClimb[]> {
    return this.boardPresenceStore.getRecentBoardClimbs(boardId);
  }

  /** Read the latest confirmed, sanitized QuantumBoard roster. */
  async getBoardLayers(boardId: string): Promise<BoardLayersSnapshot | null> {
    return this.boardPresenceStore.getBoardLayers(boardId);
  }

  /** Atomically commit a Quantum roster, public holder, and private connection claim. */
  async commitBoardLayers(
    boardId: string,
    snapshot: BoardLayersSnapshot,
    emitterId: string,
    claimToken: string,
  ): Promise<CommitBoardLayersResult> {
    return this.boardPresenceStore.commitBoardLayers(boardId, snapshot, emitterId, claimToken);
  }

  /** Stale a roster only if it still belongs to the cleared writer emitter. */
  async markBoardLayersStaleIfOwned(
    boardId: string,
    ownerToken: string,
    snapshot: BoardLayersSnapshot,
  ): Promise<BoardLayersStaleResult | null> {
    return this.boardPresenceStore.markBoardLayersStaleIfOwned(boardId, ownerToken, snapshot);
  }

  /** Record that a user is connected to a board (proof-of-presence). TTL'd; a reconnect re-stamps. */
  async stampBoardMembership(boardId: string, userId: string): Promise<void> {
    return this.boardPresenceStore.stampBoardMembership(boardId, userId);
  }

  /** True if the user has a live proof-of-presence stamp for the board. */
  async hasBoardMembership(boardId: string, userId: string): Promise<boolean> {
    return this.boardPresenceStore.hasBoardMembership(boardId, userId);
  }

  /** One-pipeline Stage-A read for reportBoardClimb: membership, first-seen, lastReport, writer. */
  async getBoardReportGate(boardId: string, emitterId: string): Promise<BoardReportGate> {
    return this.boardPresenceStore.getBoardReportGate(boardId, emitterId);
  }

  /** One-pipeline commit of an accepted reportBoardClimb send (history, writer take, dedup, session→board). */
  async commitBoardClimb(input: CommitBoardClimbInput): Promise<CommitBoardClimbResult> {
    return this.boardPresenceStore.commitBoardClimb(input);
  }

  /** Claim the holder slot after a multi-layer controller roster is confirmed. */
  async takeBoardWriter(boardId: string, emitterId: string): Promise<BoardWriterTakeResult> {
    return this.boardPresenceStore.takeBoardWriter(boardId, emitterId);
  }

  /** Clear the board's holder only if `emitterId` still holds it (atomic compare-and-delete). */
  async clearBoardWriterIf(boardId: string, emitterId: string, layerClaimToken?: string): Promise<boolean> {
    return this.boardPresenceStore.clearBoardWriterIf(boardId, emitterId, layerClaimToken);
  }

  /** The board's current connection holder emitter id, or null when free. */
  async getBoardWriter(boardId: string): Promise<string | null> {
    return this.boardPresenceStore.getBoardWriter(boardId);
  }

  /** The shared board_id this session is on, or null when unknown (written by commitBoardClimb). */
  async getSessionBoard(sessionId: string): Promise<string | null> {
    return this.boardPresenceStore.getSessionBoard(sessionId);
  }

  /** The party session bound to this board, or null when unknown (reverse of getSessionBoard, same writer). */
  async getBoardSession(boardId: string): Promise<string | null> {
    return this.boardPresenceStore.getBoardSession(boardId);
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  resetLocalBoardMembershipForTest(): void {
    this.boardPresenceStore.resetLocalBoardMembershipForTest();
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  setLocalBoardMembershipForTest(localKey: string, expiry: number): void {
    this.boardPresenceStore.setLocalBoardMembershipForTest(localKey, expiry);
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  hasLocalBoardMembershipForTest(localKey: string): boolean {
    return this.boardPresenceStore.hasLocalBoardMembershipForTest(localKey);
  }

  /**
   * Ensure Redis is connected if it's required.
   * @throws If Redis is required but not connected
   */
  private ensureRedisIfRequired(): void {
    if (this.redisRequired && !this.isRedisConnected()) {
      throw new Error('Redis is required but not connected');
    }
  }

  /**
   * Get count of subscribers for debugging
   */
  getSubscriberCounts(sessionId: string): { queue: number; session: number } {
    return {
      queue: this.queueChannel.count(sessionId),
      session: this.sessionChannel.count(sessionId),
    };
  }

  /**
   * Count of local board-queue-preview subscribers for a board. Debug/test
   * aid — the subscription-leak regression test asserts this returns to 0
   * after a disconnect that lands during the seed computation.
   */
  getBoardQueuePreviewSubscriberCount(boardId: string): number {
    return this.boardQueueChannel.count(boardId);
  }

  /** @internal Subscription cleanup coverage. */
  getClimbStatsSubscriberCount(channelKey: string): number {
    return this.climbStatsChannel.count(channelKey);
  }
}

export const pubsub = new PubSub();
