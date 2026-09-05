import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  executeTransaction: vi.fn(),
  transaction: vi.fn(),
  getDb: vi.fn(),
  countGymsWithActivity: vi.fn(),
  rebuildGymActivityStats: vi.fn(),
  reportHandledError: vi.fn(),
}));

vi.mock('@/app/lib/db/db', () => ({ getDb: mocks.getDb }));
vi.mock('@boardsesh/db/queries', () => ({
  GYM_ACTIVITY_REFRESH_LOCK_KEY: 0x67796d61,
  countGymsWithActivity: mocks.countGymsWithActivity,
  rebuildGymActivityStats: mocks.rebuildGymActivityStats,
}));
vi.mock('@/app/lib/observability/request-logger', () => ({ createRequestLogger: () => ({}) }));
vi.mock('@/app/lib/observability/report-error', () => ({ reportHandledError: mocks.reportHandledError }));

const { GET } = await import('../route');
const transactionDb = { execute: mocks.executeTransaction };
const initialTime = new Date('2026-09-05T06:30:00.000Z');

function request(query = '', token: string | null = 'test-secret') {
  return new Request(`http://localhost/api/internal/refresh-gym-activity-stats${query}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  vi.stubEnv('CRON_SECRET', 'test-secret');
  mocks.getDb.mockReturnValue({ execute: mocks.execute, transaction: mocks.transaction });
  mocks.execute.mockResolvedValue([{ gym_count: 100 }]);
  mocks.countGymsWithActivity.mockImplementation(async () => {
    vi.setSystemTime(initialTime.getTime() + 40);
    return 90;
  });
  mocks.executeTransaction.mockResolvedValue([{ locked: true }]);
  mocks.transaction.mockImplementation(async (callback: (tx: typeof transactionDb) => Promise<unknown>) => {
    vi.setSystemTime(initialTime.getTime() + 100);
    return callback(transactionDb);
  });
  mocks.rebuildGymActivityStats.mockResolvedValue(90);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('GET /api/internal/refresh-gym-activity-stats', () => {
  it.each([null, 'wrong-secret'])('rejects token %s before accessing the database', async (token) => {
    const response = await GET(request('', token));

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('fails closed when the cron secret is missing', async () => {
    vi.stubEnv('CRON_SECRET', '');

    expect((await GET(request())).status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each(['', '?force=1'])('refuses an empty rebuild even with query %s', async (query) => {
    mocks.countGymsWithActivity.mockResolvedValue(0);

    const response = await GET(request(query));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ skipped: 'empty', gymCount: 0, previousGymCount: 100 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rebuildGymActivityStats).not.toHaveBeenCalled();
  });

  it.each(['', '?force=true'])('refuses a shrink over 50% with query %s', async (query) => {
    mocks.countGymsWithActivity.mockResolvedValue(49);

    const response = await GET(request(query));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ skipped: 'shrank', forced: false });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rebuildGymActivityStats).not.toHaveBeenCalled();
  });

  it('allows exactly a 50% shrink', async () => {
    mocks.countGymsWithActivity.mockResolvedValue(50);
    mocks.rebuildGymActivityStats.mockResolvedValue(50);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ gymCount: 50, skipped: null });
    expect(mocks.rebuildGymActivityStats).toHaveBeenCalledWith(transactionDb);
  });

  it('allows the initial population of an empty table', async () => {
    mocks.execute.mockResolvedValue([{ gym_count: 0 }]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ previousGymCount: 0, skipped: null });
    expect(mocks.rebuildGymActivityStats).toHaveBeenCalledWith(transactionDb);
  });

  it('allows an explicitly forced shrink', async () => {
    mocks.countGymsWithActivity.mockResolvedValue(1);
    mocks.rebuildGymActivityStats.mockResolvedValue(1);

    const response = await GET(request('?force=1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ gymCount: 1, skipped: null, forced: true });
    expect(mocks.rebuildGymActivityStats).toHaveBeenCalledWith(transactionDb);
  });

  it.each(['', '?force=1'])('never rebuilds without the advisory lock with query %s', async (query) => {
    mocks.executeTransaction.mockResolvedValue([{ locked: false }]);

    const response = await GET(request(query));

    expect(await response.json()).toMatchObject({ skipped: 'locked', scanDurationMs: 40 });
    expect(mocks.rebuildGymActivityStats).not.toHaveBeenCalled();
  });

  it('reports the actual written count and only the count-phase duration', async () => {
    mocks.rebuildGymActivityStats.mockResolvedValue(89);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      gymCount: 89,
      previousGymCount: 100,
      skipped: null,
      scanDurationMs: 40,
      forced: false,
    });
  });

  it.each(['count', 'lock', 'rebuild'] as const)(
    'reports a %s failure without exposing database details',
    async (phase) => {
      const failure = new Error('private database details');
      const operation = {
        count: mocks.countGymsWithActivity,
        lock: mocks.executeTransaction,
        rebuild: mocks.rebuildGymActivityStats,
      }[phase];
      operation.mockRejectedValue(failure);

      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Gym activity stats refresh failed' });
      expect(mocks.reportHandledError).toHaveBeenCalledWith(failure, expect.any(Object));
      if (phase !== 'rebuild') expect(mocks.rebuildGymActivityStats).not.toHaveBeenCalled();
    },
  );
});
