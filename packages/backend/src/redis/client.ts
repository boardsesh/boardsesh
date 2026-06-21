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

class RedisClientManager {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private streamConsumer: Redis | null = null;
  private isConnected = false;
  private connectionPromise: Promise<boolean> | null = null;

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
    return new Promise((resolve, reject) => {
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

      const checkAllReady = () => {
        if (!(publisherReady && subscriberReady && streamConsumerReady)) return;
        logger.info('[Redis] Connected successfully (3 connections: publisher, subscriber, streamConsumer)');
        // Verify server version before declaring ready. Fail-closed: an
        // older Redis silently breaks the board-serial event path, which we'd
        // rather catch at startup than in production.
        verifyRedisVersion(this.publisher!)
          .then(() => {
            this.isConnected = true;
            resolve(true);
          })
          .catch((err: Error) => {
            logger.error(`[Redis] ${err.message}`);
            reject(err);
          });
      };

      this.publisher.on('ready', () => {
        publisherReady = true;
        checkAllReady();
      });

      this.subscriber.on('ready', () => {
        subscriberReady = true;
        checkAllReady();
      });

      this.streamConsumer.on('ready', () => {
        streamConsumerReady = true;
        checkAllReady();
      });

      this.publisher.on('error', (err) => {
        logger.error('[Redis] Publisher error:', err.message);
        if (!this.isConnected) {
          reject(new Error(`Redis publisher connection failed: ${err.message}`));
        }
      });

      this.subscriber.on('error', (err) => {
        logger.error('[Redis] Subscriber error:', err.message);
        if (!this.isConnected) {
          reject(new Error(`Redis subscriber connection failed: ${err.message}`));
        }
      });

      this.streamConsumer.on('error', (err) => {
        logger.error('[Redis] Stream consumer error:', err.message);
        if (!this.isConnected) {
          reject(new Error(`Redis stream consumer connection failed: ${err.message}`));
        }
      });

      // Handle disconnection after initial connection
      this.publisher.on('close', () => {
        if (this.isConnected) {
          logger.warn('[Redis] Publisher connection closed');
          this.isConnected = false;
        }
      });

      this.subscriber.on('close', () => {
        if (this.isConnected) {
          logger.warn('[Redis] Subscriber connection closed');
          this.isConnected = false;
        }
      });

      this.streamConsumer.on('close', () => {
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
    this.connectionPromise = null;
  }
}

export const redisClientManager = new RedisClientManager();
