import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const { getServerFeatureFlagMock } = vi.hoisted(() => ({ getServerFeatureFlagMock: vi.fn() }));
vi.mock('@/app/lib/feature-flags/server-feature-flag', () => ({
  getServerFeatureFlag: getServerFeatureFlagMock,
}));

const { BUILD_PLANS_ENTRIES, buildBuildPlansEntries } = await import('../build-plans-entries');

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildBuildPlansEntries', () => {
  it('lists nothing while cnc-packs is off', async () => {
    getServerFeatureFlagMock.mockResolvedValue(false);

    await expect(buildBuildPlansEntries()).resolves.toEqual([]);
  });

  it('keeps the shard empty even when access is enabled', async () => {
    getServerFeatureFlagMock.mockResolvedValue(true);
    await expect(buildBuildPlansEntries()).resolves.toEqual([]);
    expect(getServerFeatureFlagMock).not.toHaveBeenCalled();
  });

  it('returns a fresh empty list', async () => {
    expect(await buildBuildPlansEntries()).not.toBe(BUILD_PLANS_ENTRIES);
  });

  it('lists no path without a page behind it', () => {
    // The failure this exists for: `/build-plans/licence` is planned, its page
    // is not written yet, and adding the URL here before the route would ask
    // Google to crawl a 404 the moment the flag flips.
    for (const item of BUILD_PLANS_ENTRIES) {
      const routeDirectory = join(APP_ROOT, item.path.replace(/^\//, ''));
      expect(existsSync(join(routeDirectory, 'page.tsx')), `${item.path} has no page.tsx`).toBe(true);
    }
  });

  it('stamps a real edit date rather than the current time', () => {
    // `new Date()` here would claim every page changed on every crawl and
    // destroy the freshness signal — the same rule `static-entries.ts` follows.
    for (const item of BUILD_PLANS_ENTRIES) {
      expect(item.lastModified).toBeInstanceOf(Date);
      expect(item.lastModified!.getTime()).toBeLessThan(Date.now());
    }
  });
});
