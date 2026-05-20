import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { queueClimbStatsRecompute } from '../graphql/resolvers/ticks/debounced-climb-stats-publisher';
import { logger } from '../utils/logger';

const { recomputeClimbStatsMock, redisSetMock, redisGetMock, redisDelMock } = vi.hoisted(() => ({
  recomputeClimbStatsMock: vi.fn(),
  redisSetMock: vi.fn().mockResolvedValue('OK'),
  redisGetMock: vi.fn(),
  redisDelMock: vi.fn().mockResolvedValue(1),
}));

let mockRedisConnected = true;

vi.mock('../graphql/resolvers/ticks/recompute-climb-stats', () => ({
  recomputeClimbStats: recomputeClimbStatsMock,
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: () => mockRedisConnected,
    getClients: () => ({
      publisher: {
        set: redisSetMock,
        get: redisGetMock,
        del: redisDelMock,
      },
    }),
  },
}));

const KEY = 'kilter|CLIMB-1|40';
const REDIS_KEY = `boardsesh:debounce:climb-stats:${KEY}`;

describe('queueClimbStatsRecompute', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockRedisConnected = true;
    recomputeClimbStatsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the recompute after the debounce delay', async () => {
    redisGetMock.mockImplementation(async () => redisSetMock.mock.calls[0]?.[1] ?? null);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);

    expect(recomputeClimbStatsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
  });

  it('resets the timer when called multiple times for the same climb+angle', async () => {
    redisGetMock.mockImplementation(async () => {
      const calls = redisSetMock.mock.calls;
      return calls[calls.length - 1]?.[1] ?? null;
    });

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(1000);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(1000);

    expect(recomputeClimbStatsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps separate timers for different climbs', async () => {
    // Per-key nonce lookup — each call writes its own nonce under its own key.
    redisGetMock.mockImplementation(async (key: string) => {
      const matching = redisSetMock.mock.calls.filter((call) => call[0] === key);
      return matching[matching.length - 1]?.[1] ?? null;
    });

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    queueClimbStatsRecompute('tension', 'CLIMB-2', 35);

    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledTimes(2);
    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('tension', 'CLIMB-2', 35);
  });

  it('skips both recompute and publish when the Redis nonce does not match', async () => {
    // Multi-instance dedup gate: the instance whose nonce is currently in
    // Redis owns the recompute *and* the publish. The previous design ran
    // the recompute unconditionally on the basis that it's idempotent at
    // the DB level — but the *publish* isn't, so 3 instances each pushing
    // the same event produced visible UI flicker. With the gate moved
    // upstream, only the winning instance runs both.
    redisGetMock.mockResolvedValue('different-nonce');

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).not.toHaveBeenCalled();
    // We don't own the key, so we don't DEL it.
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('writes the nonce to Redis with SET PX on each call', () => {
    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);

    expect(redisSetMock).toHaveBeenCalledWith(REDIS_KEY, expect.any(String), 'PX', 2500);
  });

  it('cleans up the Redis key after a successful recompute', async () => {
    redisGetMock.mockImplementation(async () => redisSetMock.mock.calls[0]?.[1] ?? null);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(redisDelMock).toHaveBeenCalledWith(REDIS_KEY);
  });

  it('falls back to local-only debounce when Redis is not connected', async () => {
    mockRedisConnected = false;

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
  });

  it('runs the recompute anyway when Redis SET fails (fail-open)', async () => {
    // SET fails fire-and-forget — GET will then see no matching nonce and
    // the timer falls through to recompute. The earlier setFailed-flag
    // approach raced because SET could reject AFTER the timer fired; the
    // current design sidesteps that entirely by never depending on SET's
    // outcome to decide whether to recompute.
    redisSetMock.mockRejectedValue(new Error('Redis SET timed out'));

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
  });

  it('runs the recompute anyway when Redis GET fails (fail-open)', async () => {
    redisGetMock.mockRejectedValue(new Error('Redis connection lost'));

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
  });

  it('logs an error when the recompute throws', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    recomputeClimbStatsMock.mockRejectedValue(new Error('DB write failed'));
    redisGetMock.mockImplementation(async () => redisSetMock.mock.calls[0]?.[1] ?? null);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to recompute stats for ${KEY}`),
      expect.any(Error),
    );
    loggerSpy.mockRestore();
  });
});
