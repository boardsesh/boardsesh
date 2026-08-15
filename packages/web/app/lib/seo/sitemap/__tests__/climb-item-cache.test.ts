import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbzRead: {} }));

const KILTER_CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 12,
  displayName: 'Kilter Original 12x12',
};

vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [KILTER_CONFIG],
}));

// Stands in for the whole read path, so the assertion is "how many scans reached
// the pool", which is the invariant the single-flight promise exists to protect.
const reads = vi.hoisted(() => ({ count: 0, gate: null as null | Promise<void> }));

vi.mock('@boardsesh/db/queries', () => ({
  withSerialPlan: async () => {
    reads.count += 1;
    if (reads.gate) await reads.gate;
    return [
      { uuid: 'abcdef1234567890abcdef1234567890', name: 'Test Climb', angle: 40, updatedAt: new Date('2026-05-04') },
    ];
  },
}));

const { buildTier2ClimbItems, resetTier2ItemCacheForTests } = await import('../climb-query');

afterEach(() => {
  resetTier2ItemCacheForTests();
  reads.count = 0;
  reads.gate = null;
});

describe('the tier-2 item cache', () => {
  it('scans once and serves the second caller from the TTL cache', async () => {
    const first = await buildTier2ClimbItems();
    const second = await buildTier2ClimbItems();

    expect(reads.count).toBe(1);
    expect(second).toBe(first);
    expect(first).toHaveLength(1);
  });

  it('collapses concurrent cold-start callers into one scan', async () => {
    // A crawl burst across N shard pages on a cold instance is N full scans
    // against a ten-connection pool without this — the #4461 failure.
    let release = () => {};
    reads.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = Promise.all([buildTier2ClimbItems(), buildTier2ClimbItems(), buildTier2ClimbItems()]);
    release();
    const [a, b, c] = await inFlight;

    expect(reads.count).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('rebuilds after the cache is dropped, so the seam is not a one-way door', async () => {
    await buildTier2ClimbItems();
    resetTier2ItemCacheForTests();
    await buildTier2ClimbItems();

    expect(reads.count).toBe(2);
  });

  it('does not cache a failed build', async () => {
    await buildTier2ClimbItems();
    resetTier2ItemCacheForTests();

    reads.gate = Promise.reject(new Error('pool exhausted'));
    await expect(buildTier2ClimbItems()).rejects.toThrow('pool exhausted');

    // The next caller must retry rather than inherit a poisoned in-flight promise.
    reads.gate = null;
    await expect(buildTier2ClimbItems()).resolves.toHaveLength(1);
    expect(reads.count).toBe(3);
  });
});
