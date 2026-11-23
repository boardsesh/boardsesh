import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { sitemapShardRefreshes } from '@boardsesh/db/schema';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@boardsesh/db/queries/sitemap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries/sitemap')>()),
  runSetterSitemapQuery: mocks.query,
}));
vi.mock('../services/popular-board-configs', () => ({
  getPopularConfigs: async () => [
    {
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 20],
      climbCount: 10,
      boardCount: 1,
    },
  ],
}));

import { getStoredSetterSitemapSummary } from '@boardsesh/db/queries/sitemap';
import { db } from '../db/client';
import { refreshSetterSitemapSummary } from '../services/setter-sitemap-summary';

const CONTENT_CLOCK = new Date('2026-11-20T10:00:00.000Z');
const ROWS = [{ setter_username: 'alice', last_modified: CONTENT_CLOCK.toISOString() }];
const clearFixture = () => db.delete(sitemapShardRefreshes).where(eq(sitemapShardRefreshes.shardId, 'setters'));

beforeEach(async () => {
  await clearFixture();
  mocks.query.mockReset().mockResolvedValue(ROWS);
});
afterEach(clearFixture);

describe('persisted setters summary in PostgreSQL', () => {
  it('commits the exact validated count and content clock', async () => {
    const result = await refreshSetterSitemapSummary();
    const stored = await getStoredSetterSitemapSummary(db);
    expect(result).toMatchObject({ refreshed: true, itemCount: 1, skipped: null });
    expect(stored).toMatchObject({ itemCount: 1, lastModified: CONTENT_CLOCK });
    expect(stored?.computedAt.toISOString()).toBe(result.computedAt);
  });

  it('retains the previous persisted row after a failed scan or invalid result', async () => {
    await refreshSetterSitemapSummary();
    const previous = await getStoredSetterSitemapSummary(db);
    mocks.query.mockRejectedValueOnce(new Error('fixture scan failed'));
    await expect(refreshSetterSitemapSummary({ force: true })).rejects.toThrow('fixture scan failed');
    expect(await getStoredSetterSitemapSummary(db)).toEqual(previous);
    mocks.query.mockResolvedValueOnce([]);
    await expect(refreshSetterSitemapSummary({ force: true })).rejects.toThrow('empty or incomplete');
    expect(await getStoredSetterSitemapSummary(db)).toEqual(previous);
  });

  it('serializes competing writers and releases the transaction lock on completion', async () => {
    let scanStarted = () => {};
    let releaseScan = () => {};
    const started = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    mocks.query.mockImplementationOnce(async () => {
      scanStarted();
      await gate;
      return ROWS;
    });
    const first = refreshSetterSitemapSummary({ force: true });
    try {
      await started;
      expect(await refreshSetterSitemapSummary({ force: true })).toMatchObject({
        refreshed: false,
        skipped: 'locked',
        itemCount: null,
      });
      expect(mocks.query).toHaveBeenCalledTimes(1);
    } finally {
      releaseScan();
      await first;
    }
    await expect(refreshSetterSitemapSummary({ force: true })).resolves.toMatchObject({ refreshed: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
