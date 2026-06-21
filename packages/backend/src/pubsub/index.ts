import type {
  QueueEvent,
  SessionEvent,
  NotificationEvent,
  CommentEvent,
  NewClimbCreatedEvent,
  BoardPresenceEvent,
  BoardPresenceClimb,
} from '@boardsesh/shared-schema';
import { redisClientManager } from '../redis/client';
import { createRedisPubSubAdapter, type RedisPubSubAdapter } from './redis-adapter';
import { logger } from '../utils/logger';

type QueueSubscriber = (event: QueueEvent) => void;
type SessionSubscriber = (event: SessionEvent) => void;
type NotificationSubscriber = (event: NotificationEvent) => void;
type CommentSubscriber = (event: CommentEvent) => void;
type NewClimbSubscriber = (event: NewClimbCreatedEvent) => void;
type BoardPresenceSubscriber = (event: BoardPresenceEvent) => void;

// Board-presence durable history (Redis FIFO) configuration. The live
// "now on the wall" feed is ephemeral; this buffer backfills late joiners
// before the `boardNowPlaying` subscription takes over.
const BOARD_HISTORY_SIZE = 50; // Keep the last 50 climbs per board
const BOARD_HISTORY_TTL = 604_800; // 1 week
// Must track BOARD_HISTORY_TTL: the per-board seq counter and the history buffer
// expire together, so the seq never resets to 1 while history rows still exist
// (which would collide / mis-order the keyset cursor).
const BOARD_SEQ_TTL = 604_800; // 1 week
// Proof-of-presence window: how long after connecting (resolveBoardForSerial /
// resolveBoardForConfig) a user may report climbs to that board's feed. Long
// enough for a climbing session; a reconnect re-stamps it.
const BOARD_MEMBERSHIP_TTL = 43_200; // 12 hours

/** External hook called after every queue event publish. Fire-and-forget. */
type QueueEventHook = (sessionId: string, event: QueueEvent) => void;

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
 */
class PubSub {
  private queueSubscribers = new Map<string, Set<QueueSubscriber>>();
  private sessionSubscribers = new Map<string, Set<SessionSubscriber>>();
  private notificationSubscribers = new Map<string, Set<NotificationSubscriber>>();
  private commentSubscribers = new Map<string, Set<CommentSubscriber>>();
  private newClimbSubscribers = new Map<string, Set<NewClimbSubscriber>>();
  private boardPresenceSubscribers = new Map<string, Set<BoardPresenceSubscriber>>();
  // Local-only fallback for the per-board monotonic seq counter. In Redis
  // mode the authoritative counter is `board:${boardId}:seq` (INCR); this map
  // only ever serves single-instance deployments that have no Redis.
  private localBoardSeq = new Map<string, number>();
  // Local-only proof-of-presence: `${boardId}:${userId}` → expiry epoch ms.
  private localBoardMembership = new Map<string, number>();
  private localBoardMembershipCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private localBoardMembershipCleanupExpiry: number | null = null;
  private redisAdapter: RedisPubSubAdapter | null = null;
  private initialized = false;
  private redisRequired = false;
  private queueEventHook: QueueEventHook | null = null;

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
   * The hook is called fire-and-forget (not awaited, errors are caught internally).
   * Used to wire APNs Live Activity updates without coupling PubSub to the APNs service.
   *
   * **Publisher-side semantics (important for multi-instance deployments):**
   * The hook fires only on the instance that calls `publishQueueEvent`. It is
   * NOT invoked by `dispatchToLocalQueueSubscribers` when a Redis fan-out
   * message arrives from another instance — that path bypasses the hook
   * intentionally so a single event published in a 3-instance cluster does
   * not trigger 3 redundant APNs sends.
   *
   * Implication: every backend instance that receives queue mutations must
   * have APNs env vars configured, otherwise queue events that originate on
   * an unconfigured instance will skip the push (the hook still runs but
   * `sendLiveActivityUpdate` becomes a no-op when `configured === false`).
   * The startup log in `server.ts` warns when env vars are missing.
   */
  setQueueEventHook(hook: QueueEventHook): void {
    this.queueEventHook = hook;
  }

  private setupRedisMessageHandlers(): void {
    if (!this.redisAdapter) return;

    this.redisAdapter.onQueueMessage((sessionId, event) => {
      this.dispatchToLocalQueueSubscribers(sessionId, event);
    });

    this.redisAdapter.onSessionMessage((sessionId, event) => {
      this.dispatchToLocalSessionSubscribers(sessionId, event);
    });

    this.redisAdapter.onNotificationMessage((userId, event) => {
      this.dispatchToLocalNotificationSubscribers(userId, event);
    });

    this.redisAdapter.onCommentMessage((entityKey, event) => {
      this.dispatchToLocalCommentSubscribers(entityKey, event);
    });

    this.redisAdapter.onNewClimbMessage((channelKey, event) => {
      this.dispatchToLocalNewClimbSubscribers(channelKey, event);
    });

    this.redisAdapter.onBoardPresenceMessage((boardId, event) => {
      this.dispatchToLocalBoardPresenceSubscribers(boardId, event);
    });
  }

  /**
   * Subscribe to queue events for a session.
   * @returns Promise that resolves to an unsubscribe function
   * @throws If Redis is required but not connected, or if Redis subscription fails
   */
  async subscribeQueue(sessionId: string, callback: QueueSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.queueSubscribers.has(sessionId);

    if (!this.queueSubscribers.has(sessionId)) {
      this.queueSubscribers.set(sessionId, new Set());
    }
    this.queueSubscribers.get(sessionId)!.add(callback);

    // Subscribe to Redis channel if this is first local subscriber for session
    // IMPORTANT: We must await this to ensure Redis subscription is active
    // before returning, otherwise events from other instances could be missed
    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeQueueChannel(sessionId);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis queue channel: ${String(error)}`);
        // Remove the subscriber since Redis subscription failed
        this.queueSubscribers.get(sessionId)?.delete(callback);
        if (this.queueSubscribers.get(sessionId)?.size === 0) {
          this.queueSubscribers.delete(sessionId);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.queueSubscribers.get(sessionId)?.delete(callback);

      // Clean up empty sets and unsubscribe from Redis
      if (this.queueSubscribers.get(sessionId)?.size === 0) {
        this.queueSubscribers.delete(sessionId);

        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeQueueChannel(sessionId).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis queue channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Subscribe to session events (user joins/leaves, leader changes).
   * @returns Promise that resolves to an unsubscribe function
   * @throws If Redis is required but not connected, or if Redis subscription fails
   */
  async subscribeSession(sessionId: string, callback: SessionSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.sessionSubscribers.has(sessionId);

    if (!this.sessionSubscribers.has(sessionId)) {
      this.sessionSubscribers.set(sessionId, new Set());
    }
    this.sessionSubscribers.get(sessionId)!.add(callback);

    // Subscribe to Redis channel if this is first local subscriber for session
    // IMPORTANT: We must await this to ensure Redis subscription is active
    // before returning, otherwise events from other instances could be missed
    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeSessionChannel(sessionId);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis session channel: ${String(error)}`);
        // Remove the subscriber since Redis subscription failed
        this.sessionSubscribers.get(sessionId)?.delete(callback);
        if (this.sessionSubscribers.get(sessionId)?.size === 0) {
          this.sessionSubscribers.delete(sessionId);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.sessionSubscribers.get(sessionId)?.delete(callback);

      // Clean up empty sets and unsubscribe from Redis
      if (this.sessionSubscribers.get(sessionId)?.size === 0) {
        this.sessionSubscribers.delete(sessionId);

        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeSessionChannel(sessionId).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis session channel: ${String(error)}`);
          });
        }
      }
    };
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
   * Dispatches locally first, then publishes to Redis for other instances.
   * Also stores event in buffer for delta sync (Phase 2).
   *
   * Note: Redis publish errors are logged but not thrown to avoid blocking
   * the local dispatch. In Redis mode, events may not reach other instances
   * if Redis publish fails.
   */
  publishQueueEvent(sessionId: string, event: QueueEvent): void {
    // Always dispatch to local subscribers first (low latency)
    this.dispatchToLocalQueueSubscribers(sessionId, event);

    // Store event in buffer for delta sync (Phase 2)
    // Fire and forget - don't block on buffer storage
    this.storeEventInBuffer(sessionId, event).catch((error) => {
      logger.error(`[PubSub] Failed to buffer event for session ${sessionId}:`, error);
      // Non-fatal: clients will fall back to full sync if delta sync fails
    });

    // Also publish to Redis if available
    if (this.redisAdapter) {
      this.redisAdapter.publishQueueEvent(sessionId, event).catch((error) => {
        logger.error('[PubSub] Redis queue publish failed:', error);
        // Log but don't throw - local dispatch already succeeded
        // Health check will report Redis as unhealthy if connection is lost
      });
    }

    // Fire external hook (e.g. APNs Live Activity updates)
    if (this.queueEventHook) {
      try {
        this.queueEventHook(sessionId, event);
      } catch (error) {
        logger.error('[PubSub] Queue event hook error:', error);
      }
    }
  }

  /**
   * Publish a session event to all subscribers.
   * Dispatches locally first, then publishes to Redis for other instances.
   *
   * Note: Redis publish errors are logged but not thrown to avoid blocking
   * the local dispatch. In Redis mode, events may not reach other instances
   * if Redis publish fails.
   */
  publishSessionEvent(sessionId: string, event: SessionEvent): void {
    // Always dispatch to local subscribers first (low latency)
    this.dispatchToLocalSessionSubscribers(sessionId, event);

    // Also publish to Redis if available
    if (this.redisAdapter) {
      this.redisAdapter.publishSessionEvent(sessionId, event).catch((error) => {
        logger.error('[PubSub] Redis session publish failed:', error);
        // Log but don't throw - local dispatch already succeeded
        // Health check will report Redis as unhealthy if connection is lost
      });
    }
  }

  private dispatchToLocalQueueSubscribers(sessionId: string, event: QueueEvent): void {
    const subscribers = this.queueSubscribers.get(sessionId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in queue subscriber:', error);
        }
      }
    }
  }

  private dispatchToLocalSessionSubscribers(sessionId: string, event: SessionEvent): void {
    const subscribers = this.sessionSubscribers.get(sessionId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in session subscriber:', error);
        }
      }
    }
  }

  /**
   * Subscribe to notification events for a user.
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeNotifications(userId: string, callback: NotificationSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.notificationSubscribers.has(userId);

    if (!this.notificationSubscribers.has(userId)) {
      this.notificationSubscribers.set(userId, new Set());
    }
    this.notificationSubscribers.get(userId)!.add(callback);

    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeNotificationChannel(userId);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis notification channel: ${String(error)}`);
        this.notificationSubscribers.get(userId)?.delete(callback);
        if (this.notificationSubscribers.get(userId)?.size === 0) {
          this.notificationSubscribers.delete(userId);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.notificationSubscribers.get(userId)?.delete(callback);
      if (this.notificationSubscribers.get(userId)?.size === 0) {
        this.notificationSubscribers.delete(userId);
        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeNotificationChannel(userId).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis notification channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Publish a notification event to a user.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishNotificationEvent(userId: string, event: NotificationEvent): void {
    this.dispatchToLocalNotificationSubscribers(userId, event);

    if (this.redisAdapter) {
      this.redisAdapter.publishNotificationEvent(userId, event).catch((error) => {
        logger.error('[PubSub] Redis notification publish failed:', error);
      });
    }
  }

  private dispatchToLocalNotificationSubscribers(userId: string, event: NotificationEvent): void {
    const subscribers = this.notificationSubscribers.get(userId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in notification subscriber:', error);
        }
      }
    }
  }

  /**
   * Subscribe to comment events for an entity.
   * @param entityKey format: `${entityType}:${entityId}`
   * @returns Promise that resolves to an unsubscribe function
   */
  async subscribeComments(entityKey: string, callback: CommentSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.commentSubscribers.has(entityKey);

    if (!this.commentSubscribers.has(entityKey)) {
      this.commentSubscribers.set(entityKey, new Set());
    }
    this.commentSubscribers.get(entityKey)!.add(callback);

    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeCommentChannel(entityKey);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis comment channel: ${String(error)}`);
        this.commentSubscribers.get(entityKey)?.delete(callback);
        if (this.commentSubscribers.get(entityKey)?.size === 0) {
          this.commentSubscribers.delete(entityKey);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.commentSubscribers.get(entityKey)?.delete(callback);
      if (this.commentSubscribers.get(entityKey)?.size === 0) {
        this.commentSubscribers.delete(entityKey);
        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeCommentChannel(entityKey).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis comment channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Publish a comment event for an entity.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishCommentEvent(entityKey: string, event: CommentEvent): void {
    this.dispatchToLocalCommentSubscribers(entityKey, event);

    if (this.redisAdapter) {
      this.redisAdapter.publishCommentEvent(entityKey, event).catch((error) => {
        logger.error('[PubSub] Redis comment publish failed:', error);
      });
    }
  }

  private dispatchToLocalCommentSubscribers(entityKey: string, event: CommentEvent): void {
    const subscribers = this.commentSubscribers.get(entityKey);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in comment subscriber:', error);
        }
      }
    }
  }

  /**
   * Subscribe to new climb events for a board type + layout combination.
   * @param channelKey format: `${boardType}:${layoutId}`
   */
  async subscribeNewClimbs(channelKey: string, callback: NewClimbSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.newClimbSubscribers.has(channelKey);

    if (!this.newClimbSubscribers.has(channelKey)) {
      this.newClimbSubscribers.set(channelKey, new Set());
    }
    this.newClimbSubscribers.get(channelKey)!.add(callback);

    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeNewClimbChannel(channelKey);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis new climb channel: ${String(error)}`);
        this.newClimbSubscribers.get(channelKey)?.delete(callback);
        if (this.newClimbSubscribers.get(channelKey)?.size === 0) {
          this.newClimbSubscribers.delete(channelKey);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.newClimbSubscribers.get(channelKey)?.delete(callback);
      if (this.newClimbSubscribers.get(channelKey)?.size === 0) {
        this.newClimbSubscribers.delete(channelKey);
        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeNewClimbChannel(channelKey).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis new climb channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Publish a new climb event to subscribers.
   */
  publishNewClimbEvent(channelKey: string, event: NewClimbCreatedEvent): void {
    this.dispatchToLocalNewClimbSubscribers(channelKey, event);

    if (this.redisAdapter) {
      this.redisAdapter.publishNewClimbEvent(channelKey, event).catch((error) => {
        logger.error('[PubSub] Redis new climb publish failed:', error);
      });
    }
  }

  private dispatchToLocalNewClimbSubscribers(channelKey: string, event: NewClimbCreatedEvent): void {
    const subscribers = this.newClimbSubscribers.get(channelKey);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in new climb subscriber:', error);
        }
      }
    }
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

    const isFirstSubscriber = !this.boardPresenceSubscribers.has(boardId);

    if (!this.boardPresenceSubscribers.has(boardId)) {
      this.boardPresenceSubscribers.set(boardId, new Set());
    }
    this.boardPresenceSubscribers.get(boardId)!.add(callback);

    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeBoardPresenceChannel(boardId);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis board presence channel: ${String(error)}`);
        this.boardPresenceSubscribers.get(boardId)?.delete(callback);
        if (this.boardPresenceSubscribers.get(boardId)?.size === 0) {
          this.boardPresenceSubscribers.delete(boardId);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.boardPresenceSubscribers.get(boardId)?.delete(callback);
      if (this.boardPresenceSubscribers.get(boardId)?.size === 0) {
        this.boardPresenceSubscribers.delete(boardId);
        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeBoardPresenceChannel(boardId).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis board presence channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Publish a board-presence event to subscribers.
   * Dispatches locally first, then publishes to Redis for other instances.
   */
  publishBoardPresenceEvent(boardId: string, event: BoardPresenceEvent): void {
    this.dispatchToLocalBoardPresenceSubscribers(boardId, event);

    if (this.redisAdapter) {
      this.redisAdapter.publishBoardPresenceEvent(boardId, event).catch((error) => {
        logger.error('[PubSub] Redis board presence publish failed:', error);
      });
    }
  }

  private dispatchToLocalBoardPresenceSubscribers(boardId: string, event: BoardPresenceEvent): void {
    const subscribers = this.boardPresenceSubscribers.get(boardId);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in board presence subscriber:', error);
        }
      }
    }
  }

  /**
   * Atomically allocate the next monotonic sequence number for a board.
   * Redis `INCR` (cluster-safe across instances); falls back to an in-memory
   * counter in local-only mode. The key expires after a week of inactivity so
   * an idle board's counter doesn't leak in Redis — a new climb that day just
   * restarts at 1, which is fine because the history buffer expires together.
   */
  async nextBoardSeq(boardId: string): Promise<number> {
    if (this.redisAdapter && this.isRedisConnected()) {
      try {
        const { publisher } = redisClientManager.getClients();
        const key = `board:${boardId}:seq`;
        const next = await publisher.incr(key);
        await publisher.expire(key, BOARD_SEQ_TTL);
        return next;
      } catch (error) {
        if (this.redisRequired) {
          logger.error('[PubSub] Failed to allocate board seq from required Redis:', error);
          throw error;
        }
        logger.error('[PubSub] Failed to allocate board seq from Redis, falling back to local:', error);
      }
    }

    const next = (this.localBoardSeq.get(boardId) ?? 0) + 1;
    this.localBoardSeq.set(boardId, next);
    return next;
  }

  /**
   * Append a climb to a board's durable FIFO history (newest-first, capped at
   * 50, 1-week TTL). No-op without Redis — late joiners then just rely on the
   * live subscription.
   */
  async storeBoardClimb(boardId: string, climb: BoardPresenceClimb): Promise<void> {
    if (!this.redisAdapter || !this.isRedisConnected()) {
      return;
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const key = `board:${boardId}:history`;
      await publisher.lpush(key, JSON.stringify(climb));
      await publisher.ltrim(key, 0, BOARD_HISTORY_SIZE - 1);
      await publisher.expire(key, BOARD_HISTORY_TTL);
    } catch (error) {
      logger.error('[PubSub] Failed to store board climb in history:', error);
      // Non-fatal: the live event was already published.
    }
  }

  /**
   * Read a board's recent climbs, newest-first by seq (cap 50). Empty without
   * Redis.
   */
  async getRecentBoardClimbs(boardId: string): Promise<BoardPresenceClimb[]> {
    if (!this.redisAdapter || !this.isRedisConnected()) {
      return [];
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const key = `board:${boardId}:history`;
      const entries = await publisher.lrange(key, 0, -1);

      const climbs: BoardPresenceClimb[] = [];
      for (const json of entries) {
        try {
          climbs.push(JSON.parse(json) as BoardPresenceClimb);
        } catch (parseError) {
          logger.error('[PubSub] Failed to parse board history entry:', parseError);
        }
      }

      // The list is already newest-first (lpush), but sort by seq DESC so a
      // late, out-of-order write can't surface above a newer climb.
      climbs.sort((a, b) => b.seq - a.seq);
      return climbs.slice(0, BOARD_HISTORY_SIZE);
    } catch (error) {
      logger.error('[PubSub] Failed to read board history:', error);
      return [];
    }
  }

  /**
   * Record that a user is connected to a board (proof-of-presence), stamped on
   * resolveBoardForSerial / resolveBoardForConfig. `reportBoardClimb` requires
   * this so a logged-in user can't inject onto a board they never connected to.
   * TTL'd; a reconnect re-stamps. Best-effort without Redis (local map).
   */
  async stampBoardMembership(boardId: string, userId: string): Promise<void> {
    const key = `presence:board:${boardId}:user:${userId}`;
    if (this.redisAdapter && this.isRedisConnected()) {
      try {
        const { publisher } = redisClientManager.getClients();
        // Store the first-seen epoch-ms (NX preserves it across reconnects) so
        // the durable-history dwell gate can tell how long this member has been
        // on the board. A separate EXPIRE keeps the key alive while they're
        // active without resetting first-seen. EXISTS still answers presence.
        await publisher.set(key, String(Date.now()), 'EX', BOARD_MEMBERSHIP_TTL, 'NX');
        await publisher.expire(key, BOARD_MEMBERSHIP_TTL);
        return;
      } catch (error) {
        if (this.redisRequired) {
          logger.error('[PubSub] Failed to stamp board membership in required Redis:', error);
          throw error;
        }
        logger.error('[PubSub] Failed to stamp board membership, falling back to local:', error);
      }
    }
    this.setLocalBoardMembership(`${boardId}:${userId}`, Date.now() + BOARD_MEMBERSHIP_TTL * 1000);
  }

  /** True if the user has a live proof-of-presence stamp for the board. */
  async hasBoardMembership(boardId: string, userId: string): Promise<boolean> {
    const key = `presence:board:${boardId}:user:${userId}`;
    if (this.redisAdapter && this.isRedisConnected()) {
      try {
        const { publisher } = redisClientManager.getClients();
        return (await publisher.exists(key)) === 1;
      } catch (error) {
        if (this.redisRequired) {
          logger.error('[PubSub] Failed to check board membership in required Redis:', error);
          throw error;
        }
        logger.error('[PubSub] Failed to check board membership, falling back to local:', error);
      }
    }
    const localKey = `${boardId}:${userId}`;
    const expiry = this.localBoardMembership.get(localKey);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.localBoardMembership.delete(localKey);
      return false;
    }
    return true;
  }

  /**
   * First-seen epoch-ms for a member's presence on a board, or null when
   * unknown. Drives the durable-history dwell gate (persist only after ~60s on
   * the board). Redis-only: the single-instance local fallback returns null
   * (durable history degrades to off without Redis, like the live feed).
   * Fails closed on legacy '1' / non-plausible values so they can't bypass the
   * gate.
   */
  async getBoardMembershipFirstSeen(boardId: string, userId: string): Promise<number | null> {
    if (this.redisAdapter && this.isRedisConnected()) {
      try {
        const { publisher } = redisClientManager.getClients();
        const raw = await publisher.get(`presence:board:${boardId}:user:${userId}`);
        if (raw === null) return null;
        const firstSeen = Number(raw);
        if (!Number.isFinite(firstSeen) || firstSeen < 1_600_000_000_000) return null;
        return firstSeen;
      } catch (error) {
        if (this.redisRequired) {
          logger.error('[PubSub] Failed to read board membership first-seen in required Redis:', error);
          throw error;
        }
        logger.error('[PubSub] Failed to read board membership first-seen, treating as unknown:', error);
      }
    }
    return null;
  }

  /**
   * The board's current connection holder = the emitter id (a `userId`, or
   * `conn:{connectionId}` for an anonymous client) of the most recent confirmed
   * send. Set as a side-effect of reportBoardClimb; drives the "who's connected"
   * indicator. Redis-only (degrades to "no holder" without Redis, like the
   * durable feed). Returns the previous holder so the caller can detect a
   * hand-off and only broadcast on a real change.
   */
  async setBoardWriter(boardId: string, emitterId: string): Promise<string | null> {
    if (!this.redisAdapter || !this.isRedisConnected()) return null;
    try {
      const { publisher } = redisClientManager.getClients();
      const key = `board:${boardId}:writer`;
      // Atomic set-and-return-previous (`SET key val EX ttl GET`, Redis 6.2+) so
      // two concurrent reports can't both read the same previous holder and both
      // broadcast a hand-off — only the real change is detected. The writer key
      // only ever holds a string, so GET can't hit a WRONGTYPE.
      const previous = await publisher.set(key, emitterId, 'EX', BOARD_MEMBERSHIP_TTL, 'GET');
      return (previous as string | null) ?? null;
    } catch (error) {
      if (this.redisRequired) throw error;
      logger.error('[PubSub] Failed to set board writer:', error);
      return null;
    }
  }

  /**
   * Clear the board's holder only if `emitterId` still holds it (atomic
   * compare-and-delete), so a holder who was already booted can't wipe the new
   * one. Returns whether it was actually cleared.
   */
  async clearBoardWriterIf(boardId: string, emitterId: string): Promise<boolean> {
    if (!this.redisAdapter || !this.isRedisConnected()) return false;
    try {
      const { publisher } = redisClientManager.getClients();
      const cleared = await publisher.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        `board:${boardId}:writer`,
        emitterId,
      );
      return cleared === 1;
    } catch (error) {
      if (this.redisRequired) throw error;
      logger.error('[PubSub] Failed to clear board writer:', error);
      return false;
    }
  }

  /** The board's current connection holder emitter id, or null when free. */
  async getBoardWriter(boardId: string): Promise<string | null> {
    if (!this.redisAdapter || !this.isRedisConnected()) return null;
    try {
      const { publisher } = redisClientManager.getClients();
      return await publisher.get(`board:${boardId}:writer`);
    } catch (error) {
      if (this.redisRequired) throw error;
      logger.error('[PubSub] Failed to get board writer:', error);
      return null;
    }
  }

  /**
   * Remember which shared board_id a party session is on, written as a
   * side-effect of `reportBoardClimb` (the only moment a session is provably
   * tied to a board). The APNs Live Activity path needs this to resolve the
   * board's current holder for a given session — `QueueState` and the push-token
   * rows carry sessionId but not boardId.
   *
   * Redis-only and TTL'd to the same window as proof-of-presence so an idle
   * session's mapping doesn't leak; a fresh send re-stamps it. No-op without
   * Redis: the holder lookup then degrades to "unknown" and the APNs path omits
   * boardConnection (device falls back to its own App-Group state).
   */
  async setSessionBoard(sessionId: string, boardId: string): Promise<void> {
    if (!this.redisAdapter || !this.isRedisConnected()) return;
    try {
      const { publisher } = redisClientManager.getClients();
      await publisher.set(`session:${sessionId}:board`, boardId, 'EX', BOARD_MEMBERSHIP_TTL);
    } catch (error) {
      if (this.redisRequired) throw error;
      logger.error('[PubSub] Failed to set session board:', error);
    }
  }

  /** The shared board_id this session is on, or null when unknown. */
  async getSessionBoard(sessionId: string): Promise<string | null> {
    if (!this.redisAdapter || !this.isRedisConnected()) return null;
    try {
      const { publisher } = redisClientManager.getClients();
      return await publisher.get(`session:${sessionId}:board`);
    } catch (error) {
      if (this.redisRequired) throw error;
      logger.error('[PubSub] Failed to get session board:', error);
      return null;
    }
  }

  private setLocalBoardMembership(localKey: string, expiry: number): void {
    this.localBoardMembership.set(localKey, expiry);
    if (this.localBoardMembershipCleanupExpiry !== null && expiry >= this.localBoardMembershipCleanupExpiry) {
      return;
    }
    this.scheduleLocalBoardMembershipCleanup();
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  resetLocalBoardMembershipForTest(): void {
    this.clearLocalBoardMembershipCleanupTimer();
    this.localBoardMembership.clear();
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  setLocalBoardMembershipForTest(localKey: string, expiry: number): void {
    this.setLocalBoardMembership(localKey, expiry);
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  hasLocalBoardMembershipForTest(localKey: string): boolean {
    return this.localBoardMembership.has(localKey);
  }

  private scheduleLocalBoardMembershipCleanup(): void {
    this.clearLocalBoardMembershipCleanupTimer();

    if (this.localBoardMembership.size === 0) {
      return;
    }

    // Local-only mode is single-process and expected to stay small; keep the
    // scheduler simple unless proof-of-presence cardinality becomes material.
    let nextExpiry: number | null = null;
    for (const expiry of this.localBoardMembership.values()) {
      nextExpiry = nextExpiry === null ? expiry : Math.min(nextExpiry, expiry);
    }
    if (nextExpiry === null) return;

    this.localBoardMembershipCleanupExpiry = nextExpiry;
    const cleanupDelay = Math.max(0, nextExpiry - Date.now());
    const cleanupTimer = setTimeout(() => {
      this.localBoardMembershipCleanupTimer = null;
      this.localBoardMembershipCleanupExpiry = null;
      this.evictExpiredLocalBoardMemberships();
      this.scheduleLocalBoardMembershipCleanup();
    }, cleanupDelay);
    this.localBoardMembershipCleanupTimer = cleanupTimer;
    if (typeof cleanupTimer === 'object') {
      cleanupTimer.unref?.();
    }
  }

  private clearLocalBoardMembershipCleanupTimer(): void {
    if (this.localBoardMembershipCleanupTimer === null) {
      return;
    }
    clearTimeout(this.localBoardMembershipCleanupTimer);
    this.localBoardMembershipCleanupTimer = null;
    this.localBoardMembershipCleanupExpiry = null;
  }

  private evictExpiredLocalBoardMemberships(now = Date.now()): void {
    for (const [localKey, expiry] of this.localBoardMembership) {
      if (expiry <= now) {
        this.localBoardMembership.delete(localKey);
      }
    }
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
      queue: this.queueSubscribers.get(sessionId)?.size ?? 0,
      session: this.sessionSubscribers.get(sessionId)?.size ?? 0,
    };
  }
}

export const pubsub = new PubSub();
