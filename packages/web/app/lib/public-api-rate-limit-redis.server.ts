import 'server-only';

import Redis from 'ioredis';
import type { RedisRateLimitEvaluate } from '@boardsesh/rate-limit';

const DEFAULT_CONNECT_TIMEOUT_MS = 300;
const DEFAULT_COMMAND_TIMEOUT_MS = 300;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;

type RateLimitRedisClient = {
  readonly status: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  evaluate: RedisRateLimitEvaluate;
  onError: (listener: (error: Error) => void) => void;
};

type WebRedisRateLimitOptions = {
  circuitCooldownMs?: number;
  createClient?: (redisUrl: string) => RateLimitRedisClient;
  now?: () => number;
  onWarning?: (message: string) => void;
  redisUrl?: string;
};

function createDefaultRedisClient(redisUrl: string): RateLimitRedisClient {
  const client = new Redis(redisUrl, {
    commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS,
    connectTimeout: DEFAULT_CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });

  return {
    get status() {
      return client.status;
    },
    connect: async () => {
      await client.connect();
    },
    disconnect: () => client.disconnect(),
    evaluate: async (script, numberOfKeys, key, expireSeconds) => client.eval(script, numberOfKeys, key, expireSeconds),
    onError: (listener) => {
      client.on('error', listener);
    },
  };
}

/**
 * Build one lazy Redis evaluator with a short circuit breaker.
 *
 * Once the cooldown ends, exactly one request becomes the half-open probe;
 * concurrent requests stay on the local tier until that probe succeeds.
 */
export function createWebRedisRateLimitEvaluator({
  circuitCooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
  createClient = createDefaultRedisClient,
  now = Date.now,
  onWarning = console.warn,
  redisUrl,
}: WebRedisRateLimitOptions): RedisRateLimitEvaluate | undefined {
  if (!redisUrl) return undefined;

  let circuitState: 'closed' | 'half-open' | 'open' = 'closed';
  let circuitOpenUntil = 0;
  let client: RateLimitRedisClient | undefined;
  let connectPromise: Promise<void> | undefined;

  const closeClient = (): void => {
    client?.disconnect();
    client = undefined;
    connectPromise = undefined;
  };

  const openCircuit = (): void => {
    if (circuitState === 'open') return;
    circuitState = 'open';
    circuitOpenUntil = now() + circuitCooldownMs;
    closeClient();
    onWarning('[public-api-rate-limit] Redis unavailable; the bounded local tier remains active.');
  };

  const getClient = (): RateLimitRedisClient => {
    if (client) return client;
    client = createClient(redisUrl);
    // ioredis emits `error` even when the awaited command also rejects. Attach
    // a listener so the event cannot become an unhandled process error; the
    // command rejection below is what opens the circuit and emits one warning.
    client.onError(() => undefined);
    return client;
  };

  const ensureConnected = async (activeClient: RateLimitRedisClient): Promise<void> => {
    if (activeClient.status === 'ready') return;
    connectPromise ??= activeClient.connect().finally(() => {
      connectPromise = undefined;
    });
    await connectPromise;
  };

  return async (script, numberOfKeys, key, expireSeconds) => {
    const requestTime = now();
    let isHalfOpenProbe = false;
    if (circuitState === 'open') {
      if (requestTime < circuitOpenUntil) throw new Error('Redis rate-limit circuit is open');
      circuitState = 'half-open';
      isHalfOpenProbe = true;
    } else if (circuitState === 'half-open') {
      throw new Error('Redis rate-limit circuit probe is in progress');
    }

    try {
      const activeClient = getClient();
      await ensureConnected(activeClient);
      const result = await activeClient.evaluate(script, numberOfKeys, key, expireSeconds);
      // A normal request may have started while the circuit was closed, then
      // completed after a sibling failed and opened it. Only the one request
      // explicitly admitted as the half-open probe may close that circuit.
      if (isHalfOpenProbe && circuitState === 'half-open') circuitState = 'closed';
      return result;
    } catch (error) {
      openCircuit();
      throw error;
    }
  };
}

let singletonInitialized = false;
let singletonEvaluator: RedisRateLimitEvaluate | undefined;
let warnedAboutMissingVercelRedis = false;

export function getWebRedisRateLimitEvaluator(): RedisRateLimitEvaluate | undefined {
  if (singletonInitialized) return singletonEvaluator;
  singletonInitialized = true;

  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl && process.env.VERCEL === '1' && !warnedAboutMissingVercelRedis) {
    warnedAboutMissingVercelRedis = true;
    console.warn(
      '[public-api-rate-limit] REDIS_URL is not configured for the Vercel web deployment; only the bounded local tier is active.',
    );
  }

  singletonEvaluator = createWebRedisRateLimitEvaluator({ redisUrl });
  return singletonEvaluator;
}
