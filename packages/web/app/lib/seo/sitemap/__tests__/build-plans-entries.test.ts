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

  it('lists the shop once cnc-packs is on', async () => {
    getServerFeatureFlagMock.mockResolvedValue(true);

    const items = await buildBuildPlansEntries();

    expect(items.map((item) => item.path)).toContain('/build-plans');
  });

  it('evaluates the flag for anonymous visitors', async () => {
    // Without `allowAnonymous` the flag resolves `no-distinct-id` for a crawler
    // — which has no person behind it — and the shard would stay empty however
    // the PostHog rollout is configured. That failure is invisible: the shard
    // still answers 200 with a valid empty urlset.
    getServerFeatureFlagMock.mockResolvedValue(true);

    await buildBuildPlansEntries();

    expect(getServerFeatureFlagMock).toHaveBeenCalledWith('cnc-packs', {
      distinctId: null,
      allowAnonymous: true,
    });
  });

  it('hands back a copy, so a caller that sorts it cannot rewrite the constant', async () => {
    getServerFeatureFlagMock.mockResolvedValue(true);

    const items = await buildBuildPlansEntries();
    items.length = 0;

    expect(BUILD_PLANS_ENTRIES.length).toBeGreaterThan(0);
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
