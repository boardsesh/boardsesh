import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardName } from '@boardsesh/shared-schema';

/**
 * Proof that hole placements load one board at a time.
 *
 * Each board's holds live in their own `.cjs` shard, loaded by a literal
 * `require('./generated/hole-placements/<board>.cjs')`. We read Node's documented
 * `require.cache` to observe exactly which shard files have been *evaluated*, then
 * assert that asking for one board only ever loads that board's shard — never
 * every board at once (the Hermes freeze this change fixes). `require.cache` is a
 * stable public API, unlike Node's internal module loader.
 *
 * The loader caches shards in a module-level Map, so each test re-imports a fresh
 * copy of the loader module (`vi.resetModules()` + dynamic import) and clears the
 * shard entries from `require.cache` to observe the first, uncached require.
 */

/** Board names of every hole-placement shard currently present in `require.cache`. */
function cachedShardBoards(): string[] {
  return Object.keys(require.cache)
    .map((modulePath) => modulePath.replace(/\\/g, '/'))
    .filter((modulePath) => /\/generated\/hole-placements\/[^/]+\.cjs$/.test(modulePath))
    .map((modulePath) => modulePath.replace(/^.*\/hole-placements\//, '').replace(/\.cjs$/, ''))
    .sort();
}

function clearShardCache(): void {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('generated/hole-placements')) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete require.cache[key];
    }
  }
}

async function freshLoader() {
  vi.resetModules();
  clearShardCache();
  return import('../hole-placements');
}

describe('lazy per-board hole placements', () => {
  beforeEach(() => {
    clearShardCache();
  });

  it('loads only the requested board shard, not every board', async () => {
    const { getBoardHolePlacements } = await freshLoader();
    expect(cachedShardBoards()).toEqual([]);

    const result = getBoardHolePlacements('kilter');
    expect(Object.keys(result).length).toBeGreaterThan(0);

    // Exactly the active board's shard module evaluated; the other five did not.
    expect(cachedShardBoards()).toEqual(['kilter']);
  });

  it('returns an empty record for moonboard without loading any Aurora shard', async () => {
    const { getBoardHolePlacements } = await freshLoader();

    const result = getBoardHolePlacements('moonboard');
    expect(result).toEqual({});

    expect(cachedShardBoards()).toEqual([]);
  });

  it('loading one board never pulls in another', async () => {
    const { getBoardHolePlacements } = await freshLoader();

    getBoardHolePlacements('tension');
    expect(cachedShardBoards()).toEqual(['tension']);

    getBoardHolePlacements('decoy');
    expect(cachedShardBoards()).toEqual(['decoy', 'tension']);

    for (const untouched of ['kilter', 'touchstone', 'grasshopper', 'soill']) {
      expect(cachedShardBoards()).not.toContain(untouched);
    }
  });

  it('caches: a second call returns the same object without re-evaluating', async () => {
    const { getBoardHolePlacements } = await freshLoader();

    const first = getBoardHolePlacements('soill');
    expect(cachedShardBoards()).toEqual(['soill']);
    const second = getBoardHolePlacements('soill');

    expect(second).toBe(first);
    expect(cachedShardBoards()).toEqual(['soill']);
  });
});

describe('HOLE_PLACEMENTS backwards-compatible proxy', () => {
  it('enumerates every board key like the old eager record', async () => {
    const { HOLE_PLACEMENTS } = await import('../hole-placements');
    const keys = Object.keys(HOLE_PLACEMENTS) as BoardName[];
    expect(keys).toEqual(['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard']);
  });

  it('resolves the same data via the proxy as via getBoardHolePlacements', async () => {
    const { HOLE_PLACEMENTS, getBoardHolePlacements } = await import('../hole-placements');
    expect(HOLE_PLACEMENTS.kilter['1-1']).toBeDefined();
    expect(HOLE_PLACEMENTS.kilter['1-1']).toEqual(getBoardHolePlacements('kilter')['1-1']);
  });

  it('supports Object.entries iteration used by Node-side consumers', async () => {
    const { HOLE_PLACEMENTS } = await import('../hole-placements');
    const entries = Object.entries(HOLE_PLACEMENTS);
    expect(entries.length).toBe(7);
    const kilterEntry = entries.find(([board]) => board === 'kilter');
    expect(kilterEntry).toBeDefined();
    expect(Object.keys(kilterEntry![1]).length).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown board key', async () => {
    const { HOLE_PLACEMENTS } = await import('../hole-placements');
    expect((HOLE_PLACEMENTS as Record<string, unknown>).notaboard).toBeUndefined();
  });

  it('keeps the get/has/getOwnPropertyDescriptor traps consistent', async () => {
    const { HOLE_PLACEMENTS } = await import('../hole-placements');

    // Unknown key: all three traps agree it does not exist.
    expect('notaboard' in HOLE_PLACEMENTS).toBe(false);
    expect((HOLE_PLACEMENTS as Record<string, unknown>).notaboard).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(HOLE_PLACEMENTS, 'notaboard')).toBeUndefined();

    // Known key: present, enumerable, and its descriptor value matches the data.
    expect('kilter' in HOLE_PLACEMENTS).toBe(true);
    const descriptor = Object.getOwnPropertyDescriptor(HOLE_PLACEMENTS, 'kilter');
    expect(descriptor).toBeDefined();
    expect(descriptor).toMatchObject({ enumerable: true, configurable: true });
    const descriptorValue = descriptor!.value as Record<string, unknown>;
    expect(descriptorValue['1-1']).toBeDefined();
  });

  it('structuredClone walks the proxy without tripping a descriptor invariant', async () => {
    const { HOLE_PLACEMENTS } = await import('../hole-placements');
    // structuredClone reads own keys + descriptors; a phantom descriptor for an
    // unknown key would throw. A successful clone of one board proves the traps
    // are internally consistent.
    const cloned = structuredClone({ kilter: HOLE_PLACEMENTS.kilter });
    expect(cloned.kilter['1-1']).toBeDefined();
  });
});

describe('Node ESM shard resolution (the getBuiltinModule/createRequire branch)', () => {
  // Vitest always exposes a global `require`, so the loader's `hasGlobalRequire`
  // branch is the one it exercises. These tests cover the *other* branch — the
  // one every bare Node ESM consumer (tsx scripts, backend, aurora-sync, the db
  // `tsx --test` runner) takes — by driving the exact resolution mechanism it
  // uses: `process.getBuiltinModule('node:module').createRequire(import.meta.url)`
  // anchored at this module, requiring a shard by the same relative path.
  it('process.getBuiltinModule resolves node:module.createRequire', () => {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    expect(typeof getBuiltinModule).toBe('function');
    const moduleBuiltin = getBuiltinModule!('node:module') as { createRequire: unknown };
    expect(typeof moduleBuiltin.createRequire).toBe('function');
  });

  it('createRequire(import.meta.url) loads a shard by its relative path', () => {
    const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule!;
    const { createRequire } = getBuiltinModule('node:module') as {
      createRequire: (path: string | URL) => (path: string) => unknown;
    };
    const nodeRequire = createRequire(import.meta.url);
    // The test file sits in src/__tests__/, the shards in src/generated/...; the
    // loader lives at src/hole-placements.ts and uses './generated/...'. From here
    // the same shard is one level up.
    const kilter = nodeRequire('../generated/hole-placements/kilter.cjs') as Record<string, unknown>;
    expect(kilter['1-1']).toBeDefined();
  });
});

describe('getHolePlacements public API stays synchronous and per-board', () => {
  it('returns holds for a known board/layout/set', async () => {
    const { getHolePlacements } = await import('../product-sizes');
    const holds = getHolePlacements('kilter', 1, 1);
    expect(Array.isArray(holds)).toBe(true);
    expect(holds.length).toBeGreaterThan(0);
    // HoldTuple shape: [placementId, mirroredId|null, x, y]
    expect(holds[0]).toHaveLength(4);
  });

  it('returns an empty array for an unknown layout/set', async () => {
    const { getHolePlacements } = await import('../product-sizes');
    expect(getHolePlacements('kilter', 99999, 99999)).toEqual([]);
  });
});
