import Redis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL;

// Minimum Redis version required by this backend. We use `SET key value EX ttl
// GET` in distributed-state/session-ops.ts (setSessionBoardSerialAndReturnPrevious),
// which needs the GET option on SET to atomically read the previous value. That
// option landed in Redis 6.2. On older Redis the GET keyword is silently
// ignored and the call returns OK, which would cause SessionBoardSerialChanged
// to never fire (the resolver decides whether to publish based on the previous
// value).
const MIN_REDIS_MAJOR = 6;
const MIN_REDIS_MINOR = 2;
const MAX_READY_HANDLER_PASSES = 100;

function parseRedisVersion(infoBlock: string): { major: number; minor: number; patch: number } | null {
  // `INFO server` returns lines like "redis_version:7.2.4\r\n". Parse the
  // first matching line; ignore patch beyond what we need.
  const match = infoBlock.match(/^redis_version:(\d+)\.(\d+)\.(\d+)/m);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

async function verifyRedisVersion(client: Redis): Promise<void> {
  const info = await client.info('server');
  const version = parseRedisVersion(info);
  if (!version) {
    logger.warn('[Redis] Could not parse redis_version from INFO output — proceeding without version check');
    return;
  }
  const ok = version.major > MIN_REDIS_MAJOR || (version.major === MIN_REDIS_MAJOR && version.minor >= MIN_REDIS_MINOR);
  const versionString = `${version.major}.${version.minor}.${version.patch}`;
  if (!ok) {
    throw new Error(
      `Redis ${versionString} is too old. Boardsesh requires Redis ${MIN_REDIS_MAJOR}.${MIN_REDIS_MINOR}+ for the SET ... GET ` +
        'option used by the board-serial mutation. Older Redis silently ignores the GET keyword, ' +
        'which would prevent SessionBoardSerialChanged events from firing.',
    );
  }
  logger.info(`[Redis] Server version ${versionString} (>= ${MIN_REDIS_MAJOR}.${MIN_REDIS_MINOR} required)`);
}

export type RedisClients = {
  publisher: Redis;
  subscriber: Redis;
  streamConsumer: Redis;
};

type RedisReadyHandler = (publisher: Redis) => void | Promise<void>;

export class RedisClientManager {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private streamConsumer: Redis | null = null;
  private isConnected = false;
  private connectionPromise: Promise<boolean> | null = null;
  private finishingConnection = false;
  private connectionLifecycleEpoch = 0;
  private cancelPendingConnection: (() => void) | null = null;
  private readonly readyHandlers = new Set<RedisReadyHandler>();

  /**
   * Run work that must be reconciled before the backend advertises a recovered
   * Redis connection. A handler registered while readiness reconciliation is in
   * flight joins that same barrier; handlers registered after Redis is already
   * ready run immediately. Failures are isolated so one best-effort
   * reconciliation cannot keep the entire backend disconnected.
   */
  onRedisReady(handler: RedisReadyHandler): () => void {
    this.readyHandlers.add(handler);
    if (this.isConnected && this.publisher) {
      void this.runReadyHandler(handler, this.publisher);
    }
    return () => {
      this.readyHandlers.delete(handler);
    };
  }

  private async runReadyHandler(handler: RedisReadyHandler, publisher: Redis): Promise<void> {
    try {
      await handler(publisher);
    } catch {
      logger.warn('[Redis] A recovery reconciliation handler failed; Redis remains available.');
    }
  }

  private async runReadyHandlersBeforeConnected(
    publisher: Redis,
    markConnectedIfCurrent: () => boolean,
  ): Promise<boolean> {
    const completedHandlers = new Set<RedisReadyHandler>();
    let handlerPasses = 0;
    while (handlerPasses <= MAX_READY_HANDLER_PASSES) {
      const pendingHandlers = Array.from(this.readyHandlers).filter((handler) => !completedHandlers.has(handler));
      if (pendingHandlers.length > 0) {
        if (handlerPasses === MAX_READY_HANDLER_PASSES) {
          logger.warn('[Redis] Recovery handlers kept registering more handlers; refusing to advertise readiness.');
          throw new Error(`Redis recovery handlers did not settle after ${MAX_READY_HANDLER_PASSES} passes`);
        }
        handlerPasses += 1;
        for (const handler of pendingHandlers) completedHandlers.add(handler);
        await Promise.all(pendingHandlers.map((handler) => this.runReadyHandler(handler, publisher)));
        continue;
      }

      // There is no await between the final handler-set check and publishing
      // isConnected=true. A concurrent registration therefore either joins the
      // loop above or observes connected state and takes onRedisReady's immediate
      // path; it cannot fall into the gap between the two contracts.
      return markConnectedIfCurrent();
    }

    throw new Error('Unreachable Redis readiness state');
  }

  /**
   * Connect to Redis. Returns true if connected, false if Redis is not configured.
   * Throws if connection fails (fail-closed behavior).
   */
  async connect(): Promise<boolean> {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    if (!REDIS_URL) {
      logger.info('[Redis] No REDIS_URL configured - Redis pub/sub is required for multi-instance mode');
      return false;
    }

    this.connectionPromise = this.doConnect();
    return this.connectionPromise;
  }

  private async doConnect(): Promise<boolean> {
    const lifecycleEpoch = this.connectionLifecycleEpoch;
    return new Promise((resolve, reject) => {
      let connectionSettled = false;
      const resolveConnection = (connected: boolean) => {
        if (connectionSettled) return;
        connectionSettled = true;
        if (this.cancelPendingConnection === cancelConnection) this.cancelPendingConnection = null;
        resolve(connected);
      };
      const rejectConnection = (error: Error) => {
        if (connectionSettled) return;
        connectionSettled = true;
        if (this.cancelPendingConnection === cancelConnection) this.cancelPendingConnection = null;
        reject(error);
      };
      const cancelConnection = () => resolveConnection(false);
      this.cancelPendingConnection = cancelConnection;
      logger.info('[Redis] Connecting to Redis...');

      // Create publisher connection
      this.publisher = new Redis(REDIS_URL!, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 10) {
            logger.error('[Redis] Max reconnection attempts reached');
            return null; // Stop retrying
          }
          const delay = Math.min(times * 1000, 5000);
          logger.info(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
          return delay;
        },
        lazyConnect: false,
      });

      // Create subscriber connection (required by ioredis - subscriber enters special mode)
      this.subscriber = new Redis(REDIS_URL!, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 10) {
            return null;
          }
          return Math.min(times * 1000, 5000);
        },
        lazyConnect: false,
      });

      // Create dedicated stream consumer connection for blocking XREADGROUP operations.
      // This prevents blocking reads from starving the shared publisher connection.
      this.streamConsumer = new Redis(REDIS_URL!, {
        maxRetriesPerRequest: null, // Blocking reads should not be limited by retries
        retryStrategy: (times) => {
          if (times > 10) {
            return null;
          }
          return Math.min(times * 1000, 5000);
        },
        lazyConnect: false,
      });

      let publisherReady = false;
      let subscriberReady = false;
      let streamConsumerReady = false;
      let readinessEpoch = 0;

      const checkAllReady = () => {
        if (this.connectionLifecycleEpoch !== lifecycleEpoch) return;
        if (!(publisherReady && subscriberReady && streamConsumerReady)) return;
        if (this.isConnected || this.finishingConnection) return;
        this.finishingConnection = true;
        const reconciliationEpoch = readinessEpoch;
        logger.info('[Redis] Connected successfully (3 connections: publisher, subscriber, streamConsumer)');
        // Verify server version before declaring ready. Fail-closed: an
        // older Redis silently breaks the board-serial event path, which we'd
        // rather catch at startup than in production.
        const publisher = this.publisher!;
        verifyRedisVersion(publisher)
          .then(() =>
            this.runReadyHandlersBeforeConnected(publisher, () => {
              if (
                this.connectionLifecycleEpoch !== lifecycleEpoch ||
                !publisherReady ||
                !subscriberReady ||
                !streamConsumerReady ||
                readinessEpoch !== reconciliationEpoch
              )
                return false;
              // Publish connected state and release the re-entrance guard in
              // the same synchronous callback as the final handler-set check.
              // A close/ready edge after this point can therefore start its
              // own readiness pass instead of being hidden by a stale guard.
              this.isConnected = true;
              this.finishingConnection = false;
              resolveConnection(true);
              return true;
            }),
          )
          .then((connected) => {
            if (connected) return;
            // A connection can close while an async recovery handler is
            // running. Do not advertise a stale ready state; the next `ready`
            // event will run version checks and reconciliation again.
            this.finishingConnection = false;
            checkAllReady();
          })
          .catch((err: Error) => {
            this.finishingConnection = false;
            logger.error(`[Redis] ${err.message}`);
            rejectConnection(err);
          });
      };

      this.publisher.on('ready', () => {
        publisherReady = true;
        readinessEpoch += 1;
        checkAllReady();
      });

      this.subscriber.on('ready', () => {
        subscriberReady = true;
        readinessEpoch += 1;
        checkAllReady();
      });

      this.streamConsumer.on('ready', () => {
        streamConsumerReady = true;
        readinessEpoch += 1;
        checkAllReady();
      });

      this.publisher.on('error', (err) => {
        logger.error('[Redis] Publisher error:', err.message);
        if (!this.isConnected) {
          rejectConnection(new Error(`Redis publisher connection failed: ${err.message}`));
        }
      });

      this.subscriber.on('error', (err) => {
        logger.error('[Redis] Subscriber error:', err.message);
        if (!this.isConnected) {
          rejectConnection(new Error(`Redis subscriber connection failed: ${err.message}`));
        }
      });

      this.streamConsumer.on('error', (err) => {
        logger.error('[Redis] Stream consumer error:', err.message);
        if (!this.isConnected) {
          rejectConnection(new Error(`Redis stream consumer connection failed: ${err.message}`));
        }
      });

      // Handle disconnection after initial connection
      this.publisher.on('close', () => {
        publisherReady = false;
        readinessEpoch += 1;
        if (this.isConnected) {
          logger.warn('[Redis] Publisher connection closed');
          this.isConnected = false;
        }
      });

      this.subscriber.on('close', () => {
        subscriberReady = false;
        readinessEpoch += 1;
        if (this.isConnected) {
          logger.warn('[Redis] Subscriber connection closed');
          this.isConnected = false;
        }
      });

      this.streamConsumer.on('close', () => {
        streamConsumerReady = false;
        readinessEpoch += 1;
        if (this.isConnected) {
          logger.warn('[Redis] Stream consumer connection closed');
          this.isConnected = false;
        }
      });

      // Handle reconnection
      this.publisher.on('reconnecting', () => {
        logger.info('[Redis] Publisher reconnecting...');
      });

      this.subscriber.on('reconnecting', () => {
        logger.info('[Redis] Subscriber reconnecting...');
      });

      this.streamConsumer.on('reconnecting', () => {
        logger.info('[Redis] Stream consumer reconnecting...');
      });
    });
  }

  /**
   * Get Redis clients. Throws if not connected.
   */
  getClients(): RedisClients {
    if (!this.publisher || !this.subscriber || !this.streamConsumer) {
      throw new Error('Redis not connected - call connect() first');
    }
    return {
      publisher: this.publisher,
      subscriber: this.subscriber,
      streamConsumer: this.streamConsumer,
    };
  }

  /**
   * Check if Redis is connected and available.
   */
  isRedisConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Check if Redis is configured (REDIS_URL is set).
   */
  isRedisConfigured(): boolean {
    return !!REDIS_URL;
  }

  /**
   * Gracefully disconnect from Redis.
   */
  async disconnect(): Promise<void> {
    logger.info('[Redis] Disconnecting...');

    // Invalidate any in-flight version check or readiness reconciliation before
    // awaiting ioredis. quit() emits close asynchronously in real deployments,
    // so relying on those events leaves a window where an old readiness pass
    // could publish isConnected=true after shutdown has already started.
    this.connectionLifecycleEpoch += 1;
    this.isConnected = false;
    this.finishingConnection = false;
    this.cancelPendingConnection?.();

    const disconnectPromises: Promise<void>[] = [];

    if (this.publisher) {
      disconnectPromises.push(
        this.publisher.quit().then(() => {
          logger.info('[Redis] Publisher disconnected');
        }),
      );
    }

    if (this.subscriber) {
      disconnectPromises.push(
        this.subscriber.quit().then(() => {
          logger.info('[Redis] Subscriber disconnected');
        }),
      );
    }

    if (this.streamConsumer) {
      disconnectPromises.push(
        this.streamConsumer.quit().then(() => {
          logger.info('[Redis] Stream consumer disconnected');
        }),
      );
    }

    await Promise.all(disconnectPromises);

    this.publisher = null;
    this.subscriber = null;
    this.streamConsumer = null;
    this.isConnected = false;
    this.finishingConnection = false;
    this.connectionPromise = null;
  }
}

export const redisClientManager = new RedisClientManager();
