import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const database = vi.hoisted(() => ({ execute: vi.fn(), deadlines: [] as number[] }));

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => database,
  rowsFromResult: (queryResult: unknown) => queryResult,
}));
vi.mock('@/app/lib/db/read-deadline', () => ({
  withReadDeadline: async (_label: string, pending: PromiseLike<unknown>, timeoutMs: number) => {
    database.deadlines.push(timeoutMs);
    return await pending;
  },
}));

const routeModule = await import('../route');
const NO_STORE = 'private, no-store, max-age=0';

function request(authorization?: string): Request {
  return new Request('https://www.boardsesh.com/api/internal/pgbouncer-cutover-readiness', {
    headers: authorization ? { authorization } : undefined,
  });
}

beforeEach(() => {
  vi.stubEnv('PGBOUNCER_CUTOVER_SMOKE_TOKEN', 'test-probe-secret');
  database.execute.mockReset();
  database.deadlines = [];
  database.execute.mockResolvedValue([{ ready: 1 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/internal/pgbouncer-cutover-readiness', () => {
  it('rejects missing, wrong, same-length wrong, and unconfigured credentials before DB work', async () => {
    const rejected = [
      await routeModule.GET(request()),
      await routeModule.GET(request('Bearer wrong')),
      await routeModule.GET(request('Bearer test-probe-secrex')),
      await routeModule.GET(request('Bearer ')),
    ];
    vi.stubEnv('PGBOUNCER_CUTOVER_SMOKE_TOKEN', '');
    rejected.push(await routeModule.GET(request('Bearer test-probe-secret')));
    rejected.push(await routeModule.GET(request('Bearer ')));

    expect(rejected.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(rejected.every((response) => response.headers.get('cache-control') === NO_STORE)).toBe(true);
    expect(rejected.every((response) => response.headers.get('vary') === 'Authorization')).toBe(true);
    expect(database.execute).not.toHaveBeenCalled();
  });

  it('runs one primary query and returns an uncached success', async () => {
    const response = await routeModule.GET(request('Bearer test-probe-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(database.deadlines).toEqual([5_000]);
    expect(response.headers.get('cache-control')).toBe(NO_STORE);
    expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization');
  });

  it('returns an uncached 503 without driver details on failure or a wrong result', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    database.execute.mockRejectedValueOnce(new Error('password and host must stay private'));

    const failed = await routeModule.GET(request('Bearer test-probe-secret'));
    database.execute.mockResolvedValueOnce([{ ready: 0 }]);
    const wrongResult = await routeModule.GET(request('Bearer test-probe-secret'));

    expect(failed.status).toBe(503);
    expect(wrongResult.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false });
    for (const response of [failed, wrongResult]) {
      expect(response.headers.get('cache-control')).toBe(NO_STORE);
      expect(response.headers.get('cdn-cache-control')).toBe('no-store');
      expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Authorization');
    }
    expect(errorLog).toHaveBeenCalledWith('[pgbouncer-cutover-readiness] database probe failed');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('password');
  });
});
