import type {
  QueueEvent,
  SessionEvent,
  NotificationEvent,
  CommentEvent,
  NewClimbCreatedEvent,
  ClimbStatsEvent,
} from '@boardsesh/shared-schema';
import { redisClientManager } from '../redis/client';
import { createRedisPubSubAdapter, type RedisPubSubAdapter } from './redis-adapter';
import { logger } from '../utils/logger';

type QueueSubscriber = (event: QueueEvent) => void;
type SessionSubscriber = (event: SessionEvent) => void;
type NotificationSubscriber = (event: NotificationEvent) => void;
type CommentSubscriber = (event: CommentEvent) => void;
type NewClimbSubscriber = (event: NewClimbCreatedEvent) => void;
type ClimbStatsSubscriber = (event: ClimbStatsEvent) => void;

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
  private climbStatsSubscribers = new Map<string, Set<ClimbStatsSubscriber>>();
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

    this.redisAdapter.onClimbStatsMessage((channelKey, event) => {
      this.dispatchToLocalClimbStatsSubscribers(channelKey, event);
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

  /**
   * Subscribe to climb-stats events for a single (boardType, climbUuid, angle).
   * @param channelKey format: `${boardType}:${climbUuid}:${angle}`
   */
  async subscribeClimbStats(channelKey: string, callback: ClimbStatsSubscriber): Promise<() => void> {
    this.ensureRedisIfRequired();

    const isFirstSubscriber = !this.climbStatsSubscribers.has(channelKey);

    if (!this.climbStatsSubscribers.has(channelKey)) {
      this.climbStatsSubscribers.set(channelKey, new Set());
    }
    this.climbStatsSubscribers.get(channelKey)!.add(callback);

    if (isFirstSubscriber && this.redisAdapter) {
      try {
        await this.redisAdapter.subscribeClimbStatsChannel(channelKey);
      } catch (error) {
        logger.error(`[PubSub] Failed to subscribe to Redis climb-stats channel: ${String(error)}`);
        this.climbStatsSubscribers.get(channelKey)?.delete(callback);
        if (this.climbStatsSubscribers.get(channelKey)?.size === 0) {
          this.climbStatsSubscribers.delete(channelKey);
        }
        if (this.redisRequired) {
          throw error;
        }
      }
    }

    return () => {
      this.climbStatsSubscribers.get(channelKey)?.delete(callback);
      if (this.climbStatsSubscribers.get(channelKey)?.size === 0) {
        this.climbStatsSubscribers.delete(channelKey);
        if (this.redisAdapter) {
          this.redisAdapter.unsubscribeClimbStatsChannel(channelKey).catch((error) => {
            logger.error(`[PubSub] Failed to unsubscribe from Redis climb-stats channel: ${String(error)}`);
          });
        }
      }
    };
  }

  /**
   * Publish a climb-stats event after the debounced recompute finishes.
   * Dispatches locally first, then fans out via Redis to other instances.
   */
  publishClimbStatsEvent(channelKey: string, event: ClimbStatsEvent): void {
    this.dispatchToLocalClimbStatsSubscribers(channelKey, event);

    if (this.redisAdapter) {
      this.redisAdapter.publishClimbStatsEvent(channelKey, event).catch((error) => {
        logger.error('[PubSub] Redis climb-stats publish failed:', error);
      });
    }
  }

  private dispatchToLocalClimbStatsSubscribers(channelKey: string, event: ClimbStatsEvent): void {
    const subscribers = this.climbStatsSubscribers.get(channelKey);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          logger.error('Error in climb-stats subscriber:', error);
        }
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
