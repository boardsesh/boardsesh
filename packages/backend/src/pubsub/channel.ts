import type { Logger } from 'winston';

/** Callback registered against a channel key (session id, user id, board id, ...). */
export type ChannelSubscriber<TEvent> = (event: TEvent) => void;

/** Minimal logger surface the channel needs — avoids depending on the full winston `Logger`. */
export type ChannelLogger = Pick<Logger, 'error'>;

export type PubSubChannelDeps<TEvent> = {
  /**
   * Human-readable domain name used in log messages, e.g. "queue", "session",
   * "new climb", "board presence". Must match the historical per-domain
   * wording exactly (see the six triplets this replaces) so log output/tests
   * that assert on log text stay unaffected.
   */
  label: string;
  /**
   * Called when the first local subscriber for a key registers. Omit (or have
   * it resolve without side effects) for a channel that never needs Redis
   * fan-out.
   */
  redisSubscribe?: (key: string) => Promise<void>;
  /** Called when the last local subscriber for a key unregisters. */
  redisUnsubscribe?: (key: string) => Promise<void>;
  /**
   * Called on every `publish()`, fire-and-forget. Errors are caught and
   * logged by the channel — they are never thrown back to the publisher.
   */
  redisPublish?: (key: string, event: TEvent) => Promise<void>;
  /**
   * Whether Redis is required (REDIS_URL was configured at startup). When
   * true, a failed first-subscribe Redis call is rethrown (fail-closed)
   * instead of silently falling back to local-only dispatch.
   */
  isRedisRequired: () => boolean;
  logger: ChannelLogger;
};

/**
 * Generic per-key pub/sub channel shared by every PubSub domain (queue,
 * session, notification, comment, new-climb, board-presence).
 *
 * Domain-specific behaviour (event buffering, APNs hooks, board-presence
 * Redis KV helpers, etc.) is layered outside this class, in `PubSub`'s
 * domain methods — this class only owns the generic subscribe/publish/fan-in
 * mechanics that used to be copy-pasted six times.
 */
export class PubSubChannel<TEvent> {
  private readonly subscribers = new Map<string, Set<ChannelSubscriber<TEvent>>>();

  constructor(private readonly deps: PubSubChannelDeps<TEvent>) {}

  /**
   * Subscribe to events for `key`. The first subscriber for a key triggers
   * the injected `redisSubscribe`; the returned unsubscribe function removes
   * the callback and, when it was the last subscriber for that key, calls
   * `redisUnsubscribe`.
   *
   * @throws If `isRedisRequired()` is true and the Redis subscribe call fails
   *   (fail-closed behavior, preserved from the pre-extraction implementation).
   */
  async subscribe(key: string, callback: ChannelSubscriber<TEvent>): Promise<() => void> {
    const isFirstSubscriber = !this.subscribers.has(key);

    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);

    // Subscribe to Redis if this is the first local subscriber for the key.
    // IMPORTANT: We must await this to ensure Redis subscription is active
    // before returning, otherwise events from other instances could be missed.
    if (isFirstSubscriber && this.deps.redisSubscribe) {
      try {
        await this.deps.redisSubscribe(key);
      } catch (error) {
        this.deps.logger.error(`[PubSub] Failed to subscribe to Redis ${this.deps.label} channel: ${String(error)}`);
        // Remove the subscriber since Redis subscription failed
        this.subscribers.get(key)?.delete(callback);
        if (this.subscribers.get(key)?.size === 0) {
          this.subscribers.delete(key);
        }
        if (this.deps.isRedisRequired()) {
          throw error;
        }
      }
    }

    return () => {
      this.subscribers.get(key)?.delete(callback);

      // Clean up empty sets and unsubscribe from Redis
      if (this.subscribers.get(key)?.size === 0) {
        this.subscribers.delete(key);

        if (this.deps.redisUnsubscribe) {
          this.deps.redisUnsubscribe(key).catch((error) => {
            this.deps.logger.error(
              `[PubSub] Failed to unsubscribe from Redis ${this.deps.label} channel: ${String(error)}`,
            );
          });
        }
      }
    };
  }

  /**
   * Publish an event for `key`. Dispatches to local subscribers first
   * (synchronous, per-callback error isolation), then fire-and-forget
   * publishes to Redis for other instances. Redis publish errors are logged,
   * never thrown — local dispatch already succeeded.
   */
  publish(key: string, event: TEvent): void {
    this.dispatchLocal(key, event);

    if (this.deps.redisPublish) {
      this.deps.redisPublish(key, event).catch((error) => {
        this.deps.logger.error(`[PubSub] Redis ${this.deps.label} publish failed:`, error);
      });
    }
  }

  /**
   * Dispatch an event to local subscribers only, without re-publishing to
   * Redis. Used by the Redis fan-in path: a message arriving from another
   * instance must reach this instance's local subscribers but must not be
   * echoed back out to Redis.
   */
  dispatchLocal(key: string, event: TEvent): void {
    const subscribers = this.subscribers.get(key);
    if (subscribers) {
      for (const callback of subscribers) {
        try {
          callback(event);
        } catch (error) {
          this.deps.logger.error(`Error in ${this.deps.label} subscriber:`, error);
        }
      }
    }
  }

  /** Count of local subscribers currently registered for `key`. */
  count(key: string): number {
    return this.subscribers.get(key)?.size ?? 0;
  }

  getRuntimeStats() {
    let subscribers = 0;
    for (const callbacks of this.subscribers.values()) subscribers += callbacks.size;
    return { channels: this.subscribers.size, subscribers };
  }
}
