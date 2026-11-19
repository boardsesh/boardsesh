import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const mockRevalidateTag = vi.fn();
vi.mock('next/cache', () => ({
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}));

const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    execute: (...args: unknown[]) => mockExecute(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  }),
}));

vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  USER_CLIMB_PERCENTILE_CACHE_TAG: 'user-climb-percentile',
}));

vi.mock('@boardsesh/db/schema', () => ({
  userClimbPercentiles: {},
}));

vi.mock('@boardsesh/db/queries', () => ({
  refreshUserClimbPercentiles: (database: { execute: (statement: unknown) => Promise<void> }) =>
    database.execute('refresh-percentiles'),
}));

const routeModule = await import('../route');

describe('GET /api/internal/profile-percentiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockResolvedValue([{ count: 3 }]);
    mockExecute.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 when the cron secret is missing or invalid', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');

    const response = await routeModule.GET(new Request('http://localhost/api/internal/profile-percentiles'));

    expect(response.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refreshes the snapshot and invalidates the shared percentile cache tag', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');

    const response = await routeModule.GET(
      new Request('http://localhost/api/internal/profile-percentiles', {
        headers: {
          authorization: 'Bearer test-secret',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith('user-climb-percentile', { expire: 0 });

    const body = await response.json();
    expect(body.refreshedUsers).toBe(3);
  });
});
