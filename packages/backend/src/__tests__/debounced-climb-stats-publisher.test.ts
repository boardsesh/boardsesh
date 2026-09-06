import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  queueClimbStatsRecompute,
  recomputeClimbStatsNow,
} from '../graphql/resolvers/ticks/debounced-climb-stats-publisher';
import { logger } from '../utils/logger';

const { recomputeClimbStatsMock, redisSetMock, redisGetMock, redisDelMock, canonicalState, publishStatsMock, dbMock } =
  vi.hoisted(() => {
    const canonicalState = { rows: [] as unknown[] };
    const selectChain = {
      from: vi.fn(() => selectChain),
      innerJoin: vi.fn(() => selectChain),
      where: vi.fn(() => selectChain),
      limit: vi.fn(async () => canonicalState.rows),
    };
    return {
      recomputeClimbStatsMock: vi.fn(),
      redisSetMock: vi.fn().mockResolvedValue('OK'),
      redisGetMock: vi.fn(),
      redisDelMock: vi.fn().mockResolvedValue(1),
      canonicalState,
      publishStatsMock: vi.fn(),
      dbMock: { select: vi.fn(() => selectChain) },
    };
  });

let mockRedisConnected = true;

vi.mock('../graphql/resolvers/ticks/recompute-climb-stats', () => ({
  recomputeClimbStats: recomputeClimbStatsMock,
}));

vi.mock('../db/client', () => ({ db: dbMock }));

vi.mock('../pubsub/index', () => ({
  pubsub: { publishClimbStatsEvent: publishStatsMock },
}));

vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return { ...actual, getGradeLabel: (difficulty: number) => `V${difficulty}` };
});

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
    canonicalState.rows = [
      {
        layoutId: 1,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        faUsername: 'setter',
        faAt: '2026-08-01T00:00:00.000Z',
        syncSeq: '90071992547409930',
      },
    ];
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
    expect(publishStatsMock).toHaveBeenCalledWith('kilter:1', {
      boardType: 'kilter',
      layoutId: 1,
      climbUuid: 'CLIMB-1',
      angle: 40,
      ascensionistCount: 12,
      qualityAverage: 3.5,
      difficultyAverage: 20.4,
      displayDifficulty: 20.6,
      difficulty: 'V21',
      faUsername: 'setter',
      faAt: '2026-08-01T00:00:00.000Z',
      syncSeq: '90071992547409930',
    });
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

  it('recomputes even when the Redis nonce does not match (idempotent fall-through)', async () => {
    // Nonce mismatch means another instance also queued this climb. Both
    // instances recompute — that's safe because recomputeClimbStats is
    // idempotent, and dropping the recompute outright (the previous
    // behavior) would be unsafe in the SET-failed-but-Redis-reachable
    // race window. See debounced-climb-stats-publisher.ts comment.
    redisGetMock.mockResolvedValue('different-nonce');

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
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

  it('logs [debouncedClimbStats] queued ... at queue time', async () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);

    expect(loggerSpy).toHaveBeenCalledWith(`[debouncedClimbStats] queued ${KEY}`);
    loggerSpy.mockRestore();
  });

  it('logs [debouncedClimbStats] firing ... when the timer fires', async () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    redisGetMock.mockImplementation(async () => redisSetMock.mock.calls[0]?.[1] ?? null);

    queueClimbStatsRecompute('kilter', 'CLIMB-1', 40);
    await vi.advanceTimersByTimeAsync(2100);

    expect(loggerSpy).toHaveBeenCalledWith(`[debouncedClimbStats] firing ${KEY}`);
    loggerSpy.mockRestore();
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

describe('recomputeClimbStatsNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recomputeClimbStatsMock.mockResolvedValue(undefined);
  });

  // The whole point of the inline path: it has to be DONE when the caller's
  // await resolves, because the tick mutation returns straight after and the
  // client's refetch reads board_climb_stats immediately (#4798).
  it('awaits the recompute for the given key before resolving', async () => {
    let recomputeSettled = false;
    recomputeClimbStatsMock.mockImplementation(async () => {
      await Promise.resolve();
      recomputeSettled = true;
    });

    await recomputeClimbStatsNow('kilter', 'CLIMB-1', 40);

    expect(recomputeClimbStatsMock).toHaveBeenCalledWith('kilter', 'CLIMB-1', 40);
    expect(recomputeSettled).toBe(true);
  });

  // A stats recompute must never fail the tick that triggered it, so the
  // rejection is swallowed and logged rather than propagated to the mutation.
  it('resolves and logs when the recompute rejects', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    recomputeClimbStatsMock.mockRejectedValue(new Error('DB write failed'));

    await expect(recomputeClimbStatsNow('kilter', 'CLIMB-1', 40)).resolves.toBeUndefined();

    expect(loggerSpy).toHaveBeenCalledWith(`[climbStatsNow] inline recompute failed for ${KEY}:`, expect.any(Error));
    loggerSpy.mockRestore();
  });
});
