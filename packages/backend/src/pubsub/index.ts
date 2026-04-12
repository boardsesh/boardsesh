import type { QueueEvent, SessionEvent, NotificationEvent, CommentEvent, NewClimbCreatedEvent } from '@boardsesh/shared-schema';
import { redisClientManager } from '../redis/client';
import { createRedisPubSubAdapter, type RedisPubSubAdapter } from './redis-adapter';

type QueueSubscriber = (event: QueueEvent) => void;
type SessionSubscriber = (event: SessionEvent) => void;
type NotificationSubscriber = (event: NotificationEvent) => void;
type CommentSubscriber = (event: CommentEvent) => void;
type NewClimbSubscriber = (event: NewClimbCreatedEvent) => void;

/** External hook called after every queue event publish. Fire-and-forget. */
type QueueEventHook = (sessionId: string, event: QueueEvent) => void;

// Event buffer configuration (Phase 2: Delta sync)
const EVENT_BUFFER_SIZE = 100; // Store last 100 events per session
const EVENT_BUFFER_TTL = 300;  // 5 minutes

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
  private queueSubscribers: Map<string, Set<QueueSubscriber>> = new Map();
  private sessionSubscribers: Map<string, Set<SessionSubscriber>> = new Map();
  private notificationSubscribers: Map<string, Set<NotificationSubscriber>> = new Map();
  private commentSubscribers: Map<string, Set<CommentSubscriber>> = new Map();
  private newClimbSubscribers: Map<string, Set<NewClimbSubscriber>> = new Map();
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

      console.log(`[PubSub] Redis mode enabled (instance: ${this.redisAdapter.getInstanceId()})`);
    } else {
      console.log('[PubSub] Local-only mode (single instance - no REDIS_URL configured)');
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
   * Register an external hook that fires after every queue event publish.
   * The hook is called fire-and-forget (not awaited, errors are caught internally).
   * Used to wire APNs Live Activity updates without coupling PubSub to the APNs service.
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
        console.error(`[PubSub] Failed to subscribe to Redis queue channel: ${error}`);
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
            console.error(`[PubSub] Failed to unsubscribe from Redis queue channel: ${error}`);
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
        console.error(`[PubSub] Failed to subscribe to Redis session channel: ${error}`);
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
            console.error(`[PubSub] Failed to unsubscribe from Redis session channel: ${error}`);
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
      console.error('[PubSub] Failed to store event in buffer:', error);
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
          console.error('[PubSub] Failed to parse buffered event:', parseError);
        }
      }

      // Sort by sequence (ascending) since buffer is newest-first
      events.sort((a, b) => a.sequence - b.sequence);

      return events;
    } catch (error) {
      console.error('[PubSub] Failed to retrieve events from buffer:', error);
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
      console.error(`[PubSub] Failed to buffer event for session ${sessionId}:`, error);
      // Non-fatal: clients will fall back to full sync if delta sync fails
    });

    // Also publish to Redis if available
    if (this.redisAdapter) {
      this.redisAdapter.publishQueueEvent(sessionId, event).catch((error) => {
        console.error('[PubSub] Redis queue publish failed:', error);
        // Log but don't throw - local dispatch already succeeded
        // Health check will report Redis as unhealthy if connection is lost
      });
    }

    // Fire external hook (e.g. APNs Live Activity updates)
    if (this.queueEventHook) {
      try {
        this.queueEventHook(sessionId, event);
      } catch (error) {
        console.error('[PubSub] Queue event hook error:', error);
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
        console.error('[PubSub] Redis session publish failed:', error);
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
          console.error('Error in queue subscriber:', error);
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
          console.error('Error in session subscriber:', error);
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
        console.error(`[PubSub] Failed to subscribe to Redis notification channel: ${error}`);
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
            console.error(`[PubSub] Failed to unsubscribe from Redis notification channel: ${error}`);
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
        console.error('[PubSub] Redis notification publish failed:', error);
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
          console.error('Error in notification subscriber:', error);
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
        console.error(`[PubSub] Failed to subscribe to Redis comment channel: ${error}`);
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
            console.error(`[PubSub] Failed to unsubscribe from Redis comment channel: ${error}`);
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
        console.error('[PubSub] Redis comment publish failed:', error);
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
          console.error('Error in comment subscriber:', error);
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
        console.error(`[PubSub] Failed to subscribe to Redis new climb channel: ${error}`);
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
            console.error(`[PubSub] Failed to unsubscribe from Redis new climb channel: ${error}`);
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
        console.error('[PubSub] Redis new climb publish failed:', error);
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
          console.error('Error in new climb subscriber:', error);
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
