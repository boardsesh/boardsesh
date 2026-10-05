import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  database: {},
  downloaded: vi.fn(async () => true),
  pull: vi.fn(
    async (_database: unknown, _queryClient: unknown, _fetch: unknown, _options: unknown): Promise<void> => {},
  ),
  report: vi.fn(),
  ready: true,
  enabled: true,
}));
vi.mock('../../../db/connection', () => ({ getDatabaseHandle: () => mocks.database }));
vi.mock('../../../db/schema-ready', () => ({ isSchemaReady: () => mocks.ready }));
vi.mock('../../offline-engine', () => ({ isOfflineEngineEnabled: () => mocks.enabled }));
vi.mock('../../../db/queries/board-download-status', () => ({ isBoardDownloadedLocally: mocks.downloaded }));
vi.mock('../../../offline/offline-sync-adapter', () => ({ pullSync: mocks.pull }));
vi.mock('../../graphql/client', () => ({ getOfflineSyncHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../error-reporting', () => ({ reportError: mocks.report }));
import { refreshPublishedSprayClimbs } from '../refresh-published-spray-climbs';

beforeEach(() => {
  mocks.downloaded.mockReset().mockResolvedValue(true);
  mocks.pull.mockReset().mockResolvedValue(undefined);
  mocks.report.mockClear();
  mocks.ready = true;
  mocks.enabled = true;
});

describe('published spray climb refresh', () => {
  it('awaits one downloaded scope pull before the visible list rereads local rows', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    let finishPull!: () => void;
    mocks.pull.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPull = resolve;
        }),
    );
    const refresh = refreshPublishedSprayClimbs(queryClient, 9001);
    await vi.waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    expect(mocks.downloaded).toHaveBeenCalledWith(mocks.database, { boardType: 'spray', layoutId: 9001, sizeId: 9001 });
    expect(mocks.pull.mock.calls[0]?.[3]).toEqual({ enabledBoards: ['spray:9001:9001'] });
    expect(invalidate).not.toHaveBeenCalled();
    finishPull();
    await refresh;
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey?.[0])).toEqual([
      'searchClimbs',
      'infiniteSearchClimbs',
      'searchClimbsCount',
      'climb',
    ]);
  });

  it('reports a failed mirror refresh without rejecting the already-published mutation', async () => {
    const failure = new Error('Delta unavailable');
    mocks.pull.mockRejectedValueOnce(failure);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await expect(refreshPublishedSprayClimbs(queryClient, 9001)).resolves.toBeUndefined();
    expect(mocks.report).toHaveBeenCalledWith(failure);
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
  });

  it.each(['not downloaded', 'schema unavailable', 'downloads disabled'])(
    'does not start a download when %s',
    async (condition) => {
      if (condition === 'not downloaded') mocks.downloaded.mockResolvedValue(false);
      if (condition === 'schema unavailable') mocks.ready = false;
      if (condition === 'downloads disabled') mocks.enabled = false;
      const queryClient = new QueryClient();
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await refreshPublishedSprayClimbs(queryClient, 9001);
      expect(mocks.pull).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['infiniteSearchClimbs'] });
    },
  );
});
