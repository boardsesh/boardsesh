import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ stored: vi.fn(), request: vi.fn(), report: vi.fn() }));
vi.mock('@boardsesh/db/queries/sitemap', () => ({
  getStoredSetterSitemapSummary: mocks.stored,
  SETTER_SUMMARY_MAX_AGE_MS: 6 * 60 * 60 * 1000,
}));
vi.mock('@/app/lib/db/db', () => ({ dbz: {} }));
vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'https://backend.boardsesh.test/graphql' }));
vi.mock('@/app/lib/observability/report-error', () => ({ reportHandledError: mocks.report }));
vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    request = mocks.request;
  },
}));

import { refreshSetterSummaryIfStale, resetSetterSummaryRefreshForTests } from '../setter-summary-refresh';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const REFRESHED = {
  refreshSetterSitemapSummary: {
    refreshed: true,
    itemCount: 40,
    lastModified: '2026-11-20T12:00:00.000Z',
    computedAt: NOW.toISOString(),
    skipped: null,
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', 'test-only-cron-secret');
  vi.clearAllMocks();
  resetSetterSummaryRefreshForTests();
  mocks.stored.mockResolvedValue(null);
  mocks.request.mockResolvedValue(REFRESHED);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('deferred setters summary recovery', () => {
  it('does not call the backend for a fresh stored row', async () => {
    mocks.stored.mockResolvedValue({ computedAt: NOW });
    await refreshSetterSummaryIfStale();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([null, { computedAt: new Date('2026-11-23T06:00:00.000Z') }])(
    'asks the backend to populate a missing or six-hour-old summary',
    async (stored) => {
      mocks.stored.mockResolvedValue(stored);
      await refreshSetterSummaryIfStale();
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(mocks.request.mock.calls[0][0]).not.toContain('force: true');
      expect(mocks.report).not.toHaveBeenCalled();
    },
  );

  it('shares one in-flight refresh across concurrent crawls', async () => {
    let finish = () => {};
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(REFRESHED);
        }),
    );
    const first = refreshSetterSummaryIfStale();
    await Promise.resolve();
    const second = refreshSetterSummaryIfStale();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
  });

  it('reports failures and waits sixty seconds before retrying', async () => {
    mocks.request.mockRejectedValueOnce(new Error('backend unavailable'));
    await refreshSetterSummaryIfStale();
    await refreshSetterSummaryIfStale();
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await refreshSetterSummaryIfStale();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('accepts another backend writer holding the refresh lock', async () => {
    mocks.request.mockResolvedValue({
      refreshSetterSitemapSummary: {
        refreshed: false,
        itemCount: null,
        lastModified: null,
        computedAt: null,
        skipped: 'locked',
      },
    });
    await refreshSetterSummaryIfStale();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('reports a malformed success instead of treating it as a populated cache', async () => {
    mocks.request.mockResolvedValue({
      refreshSetterSitemapSummary: {
        refreshed: true,
        itemCount: null,
        lastModified: null,
        computedAt: null,
        skipped: null,
      },
    });
    await refreshSetterSummaryIfStale();
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });

  it('does not send an unauthenticated refresh when the cron secret is missing', async () => {
    vi.stubEnv('CRON_SECRET', '');
    await refreshSetterSummaryIfStale();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });
});
