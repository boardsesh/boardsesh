import { describe, expect, it, vi } from 'vite-plus/test';
import { RateLimitError } from '../memory';
import { buildRedisRateLimitKey, checkRedisRateLimit, REDIS_RATE_LIMIT_SCRIPT } from '../redis';

describe('checkRedisRateLimit', () => {
  it('uses the shared Lua script and a namespaced epoch-window key', async () => {
    const evaluate = vi.fn().mockResolvedValue(1);

    await checkRedisRateLimit({
      evaluate,
      identity: 'ip:203.0.113.4',
      maxRequests: 120,
      namespace: 'public-api:web:production',
      now: () => 125_000,
      operation: 'public-api-v1:get',
      windowMs: 60_000,
    });

    expect(evaluate).toHaveBeenCalledWith(
      REDIS_RATE_LIMIT_SCRIPT,
      1,
      'ratelimit:public-api:web:production:ip:203.0.113.4:public-api-v1:get:2',
      '60',
    );
  });

  it('preserves the existing un-namespaced backend key shape', () => {
    expect(buildRedisRateLimitKey('user-1', 'vote', 2)).toBe('ratelimit:user-1:vote:2');
  });

  it('allows the request at the limit and rejects the next one', async () => {
    const atLimit = vi.fn().mockResolvedValue(120);
    const overLimit = vi.fn().mockResolvedValue(121);
    const options = {
      identity: 'ip:203.0.113.4',
      maxRequests: 120,
      now: () => 125_000,
      operation: 'public-api-v1:get',
      windowMs: 60_000,
    };

    await expect(checkRedisRateLimit({ ...options, evaluate: atLimit })).resolves.toBeUndefined();
    await expect(checkRedisRateLimit({ ...options, evaluate: overLimit })).rejects.toMatchObject({
      retryAfterSeconds: 55,
    });
  });

  it('fails soft through the requested local fallback on a store failure', async () => {
    const storeError = new Error('connection timed out');
    const fallback = vi.fn();
    const onStoreError = vi.fn();

    await expect(
      checkRedisRateLimit({
        evaluate: vi.fn().mockRejectedValue(storeError),
        fallback,
        identity: 'user-1',
        maxRequests: 10,
        onStoreError,
        operation: 'vote',
        windowMs: 60_000,
      }),
    ).resolves.toBeUndefined();

    expect(onStoreError).toHaveBeenCalledWith(storeError);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('uses the fallback when no Redis evaluator is configured', async () => {
    const fallback = vi.fn();
    await checkRedisRateLimit({
      fallback,
      identity: 'user-1',
      maxRequests: 10,
      operation: 'vote',
      windowMs: 60_000,
    });

    expect(fallback).toHaveBeenCalledOnce();
  });

  it('never swallows RateLimitError as a transport failure', async () => {
    const fallback = vi.fn();
    const onStoreError = vi.fn();

    await expect(
      checkRedisRateLimit({
        evaluate: vi.fn().mockRejectedValue(new RateLimitError(12)),
        fallback,
        identity: 'user-1',
        maxRequests: 10,
        onStoreError,
        operation: 'vote',
        windowMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(fallback).not.toHaveBeenCalled();
    expect(onStoreError).not.toHaveBeenCalled();
  });
});
