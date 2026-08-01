import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const redisModuleMocks = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ options: Record<string, unknown>; redisUrl: string }>,
  evaluate: vi.fn().mockResolvedValue(1),
}));

vi.mock('server-only', () => ({}));
vi.mock('ioredis', () => ({
  default: class MockRedis {
    status = 'wait';

    constructor(redisUrl: string, options: Record<string, unknown>) {
      redisModuleMocks.constructorCalls.push({ options, redisUrl });
    }

    async connect(): Promise<void> {
      this.status = 'ready';
    }

    disconnect(): void {
      this.status = 'end';
    }

    eval(script: string, numberOfKeys: number, key: string, expireSeconds: string): Promise<unknown> {
      return redisModuleMocks.evaluate(script, numberOfKeys, key, expireSeconds);
    }

    on(_event: string, _listener: (error: Error) => void): this {
      return this;
    }
  },
}));

import { createWebRedisRateLimitEvaluator } from '../public-api-rate-limit-redis.server';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  redisModuleMocks.constructorCalls.length = 0;
  redisModuleMocks.evaluate.mockReset().mockResolvedValue(1);
});

describe('createWebRedisRateLimitEvaluator', () => {
  it('creates the client lazily with bounded commands and no retry or offline queue', async () => {
    const evaluate = createWebRedisRateLimitEvaluator({ redisUrl: 'rediss://redis.example.test:6380' });
    expect(redisModuleMocks.constructorCalls).toHaveLength(0);

    await expect(evaluate?.('script', 1, 'key', '60')).resolves.toBe(1);

    expect(redisModuleMocks.constructorCalls).toHaveLength(1);
    const construction = redisModuleMocks.constructorCalls[0];
    expect(construction?.redisUrl).toBe('rediss://redis.example.test:6380');
    expect(construction?.options).toMatchObject({
      commandTimeout: 300,
      connectTimeout: 300,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    const retryStrategy = construction?.options.retryStrategy;
    expect(typeof retryStrategy).toBe('function');
    if (typeof retryStrategy === 'function') expect(retryStrategy(1)).toBeNull();
  });

  it('opens a cooldown circuit and allows exactly one half-open probe', async () => {
    let currentTime = 0;
    let probeResolver: ((requestCount: number) => void) | undefined;
    const warnings: string[] = [];
    const failedClient = {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      evaluate: vi.fn().mockRejectedValue(new Error('command timed out')),
      onError: vi.fn(),
    };
    const probeClient = {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      evaluate: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            probeResolver = resolve;
          }),
      ),
      onError: vi.fn(),
    };
    const createClient = vi.fn().mockReturnValueOnce(failedClient).mockReturnValue(probeClient);
    const evaluate = createWebRedisRateLimitEvaluator({
      circuitCooldownMs: 30_000,
      createClient,
      now: () => currentTime,
      onWarning: (message) => warnings.push(message),
      redisUrl: 'redis://example.test:6379',
    });
    if (!evaluate) throw new Error('expected configured evaluator');

    await expect(evaluate('script', 1, 'key', '60')).rejects.toThrow('command timed out');
    expect(createClient).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);

    currentTime = 20_000;
    await expect(evaluate('script', 1, 'key', '60')).rejects.toThrow('circuit is open');
    expect(createClient).toHaveBeenCalledOnce();

    currentTime = 30_000;
    const probe = evaluate('script', 1, 'key', '60');
    await expect(evaluate('script', 1, 'key', '60')).rejects.toThrow('probe is in progress');
    await Promise.resolve();
    probeResolver?.(1);
    await expect(probe).resolves.toBe(1);

    probeClient.evaluate.mockResolvedValueOnce(2);
    await expect(evaluate('script', 1, 'key', '60')).resolves.toBe(2);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('keeps the circuit open after sibling failures and a late sibling success', async () => {
    let firstFailureRejecter: ((error: Error) => void) | undefined;
    let secondFailureRejecter: ((error: Error) => void) | undefined;
    let lateSuccessResolver: ((requestCount: number) => void) | undefined;
    const firstFailure = new Promise<number>((_resolve, reject) => {
      firstFailureRejecter = reject;
    });
    const secondFailure = new Promise<number>((_resolve, reject) => {
      secondFailureRejecter = reject;
    });
    const lateSuccess = new Promise<number>((resolve) => {
      lateSuccessResolver = resolve;
    });
    const warnings: string[] = [];
    const client = {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      evaluate: vi
        .fn()
        .mockReturnValueOnce(firstFailure)
        .mockReturnValueOnce(secondFailure)
        .mockReturnValueOnce(lateSuccess),
      onError: vi.fn(),
    };
    const createClient = vi.fn().mockReturnValue(client);
    const evaluate = createWebRedisRateLimitEvaluator({
      createClient,
      now: () => 0,
      onWarning: (message) => warnings.push(message),
      redisUrl: 'redis://example.test:6379',
    });
    if (!evaluate) throw new Error('expected configured evaluator');

    const firstRequest = evaluate('script', 1, 'key', '60');
    const secondRequest = evaluate('script', 1, 'key', '60');
    const lateSuccessfulRequest = evaluate('script', 1, 'key', '60');
    await Promise.resolve();

    const firstFailureAssertion = expect(firstRequest).rejects.toThrow('first command timed out');
    firstFailureRejecter?.(new Error('first command timed out'));
    await firstFailureAssertion;
    expect(warnings).toHaveLength(1);

    const secondFailureAssertion = expect(secondRequest).rejects.toThrow('second command timed out');
    secondFailureRejecter?.(new Error('second command timed out'));
    await secondFailureAssertion;
    expect(warnings).toHaveLength(1);

    lateSuccessResolver?.(1);
    await expect(lateSuccessfulRequest).resolves.toBe(1);
    await expect(evaluate('script', 1, 'key', '60')).rejects.toThrow('circuit is open');
    expect(createClient).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);
  });

  it('does not let a probe success overwrite a circuit reopened by an older request', async () => {
    let currentTime = 0;
    let openingFailureRejecter: ((error: Error) => void) | undefined;
    let staleFailureRejecter: ((error: Error) => void) | undefined;
    let probeSuccessResolver: ((requestCount: number) => void) | undefined;
    const openingFailure = new Promise<number>((_resolve, reject) => {
      openingFailureRejecter = reject;
    });
    const staleFailure = new Promise<number>((_resolve, reject) => {
      staleFailureRejecter = reject;
    });
    const probeSuccess = new Promise<number>((resolve) => {
      probeSuccessResolver = resolve;
    });
    const warnings: string[] = [];
    const closedStateClient = {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      evaluate: vi.fn().mockReturnValueOnce(openingFailure).mockReturnValueOnce(staleFailure),
      onError: vi.fn(),
    };
    const probeClient = {
      status: 'ready',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      evaluate: vi.fn().mockReturnValue(probeSuccess),
      onError: vi.fn(),
    };
    const evaluate = createWebRedisRateLimitEvaluator({
      createClient: vi.fn().mockReturnValueOnce(closedStateClient).mockReturnValue(probeClient),
      now: () => currentTime,
      onWarning: (message) => warnings.push(message),
      redisUrl: 'redis://example.test:6379',
    });
    if (!evaluate) throw new Error('expected configured evaluator');

    const openingRequest = evaluate('script', 1, 'key', '60');
    const staleRequest = evaluate('script', 1, 'key', '60');
    await Promise.resolve();
    const openingAssertion = expect(openingRequest).rejects.toThrow('opening failure');
    openingFailureRejecter?.(new Error('opening failure'));
    await openingAssertion;

    currentTime = 30_000;
    const probeRequest = evaluate('script', 1, 'key', '60');
    await Promise.resolve();

    const staleAssertion = expect(staleRequest).rejects.toThrow('stale failure');
    staleFailureRejecter?.(new Error('stale failure'));
    await staleAssertion;
    probeSuccessResolver?.(1);
    await expect(probeRequest).resolves.toBe(1);

    await expect(evaluate('script', 1, 'key', '60')).rejects.toThrow('circuit is open');
    expect(warnings).toHaveLength(2);
  });

  it('returns no evaluator when Redis is not configured', () => {
    expect(createWebRedisRateLimitEvaluator({ redisUrl: undefined })).toBeUndefined();
  });
});

describe('getWebRedisRateLimitEvaluator', () => {
  it('warns only once per process when a Vercel deployment has no REDIS_URL', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('REDIS_URL', '');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();

    const { getWebRedisRateLimitEvaluator } = await import('../public-api-rate-limit-redis.server');
    expect(getWebRedisRateLimitEvaluator()).toBeUndefined();
    expect(getWebRedisRateLimitEvaluator()).toBeUndefined();

    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('REDIS_URL is not configured'));
  });
});
