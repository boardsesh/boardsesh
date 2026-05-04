import { describe, expect, it, vi } from 'vite-plus/test';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// Avoid pulling server-only side effects in via `getDb` at module-load time.
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ getDb: vi.fn() }));
vi.mock('@boardsesh/db/queries', () => ({ populateDenormalizedColumns: vi.fn() }));
// table-select.ts imports schema via the `@/lib/*` alias; mock the bag of names
// it pulls in so the upsert helpers can hand them to the fake db without the
// real schema module having to load.
vi.mock('@/lib/db/schema', () => {
  const fakeTable = {} as Record<string, unknown>;
  return {
    boardAttempts: fakeTable,
    boardDifficultyGrades: fakeTable,
    boardProducts: fakeTable,
    boardSets: fakeTable,
    boardProductSizes: fakeTable,
    boardLayouts: fakeTable,
    boardHoles: fakeTable,
    boardPlacementRoles: fakeTable,
    boardLeds: fakeTable,
    boardPlacements: fakeTable,
    boardProductSizesLayoutsSets: fakeTable,
    boardClimbs: fakeTable,
    boardClimbStats: fakeTable,
    boardClimbHolds: fakeTable,
    boardClimbStatsHistory: fakeTable,
    boardBetaLinks: fakeTable,
    boardUsers: fakeTable,
    boardCircuits: fakeTable,
    boardCircuitsClimbs: fakeTable,
    boardWalls: fakeTable,
    boardTags: fakeTable,
    boardUserSyncs: fakeTable,
    boardSharedSyncs: fakeTable,
  };
});

const { expectArrayShape, PROCESSING_ORDER, upsertSharedTableData } = await import('../shared-sync');

type CapturedCall = {
  values: Array<Record<string, unknown>>;
  setKeys: string[];
  targetCols: number;
};

function makeFakeDb(): { db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fake = {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => ({
        onConflictDoUpdate: (cfg: { target: unknown[]; set: Record<string, unknown> }) => {
          calls.push({
            values: rows,
            setKeys: Object.keys(cfg.set),
            targetCols: cfg.target.length,
          });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: fake as unknown as PgDatabase<PgQueryResultHKT, Record<string, unknown>>, calls };
}

describe('PROCESSING_ORDER (FK-safe)', () => {
  // Each child must appear after every one of its parents.
  // Parents derived from packages/db/src/schema/boards/unified.ts foreign keys.
  const children: Record<string, readonly string[]> = {
    product_sizes: ['products'],
    holes: ['products'],
    layouts: ['products'],
    placement_roles: ['products'],
    leds: ['product_sizes', 'holes'],
    product_sizes_layouts_sets: ['product_sizes', 'layouts', 'sets'],
  };

  it('places every parent before its child', () => {
    const indexOf = (table: string) => PROCESSING_ORDER.indexOf(table);
    for (const [child, parents] of Object.entries(children)) {
      const childIdx = indexOf(child);
      expect(childIdx, `${child} must be in PROCESSING_ORDER`).toBeGreaterThanOrEqual(0);
      for (const parent of parents) {
        const parentIdx = indexOf(parent);
        expect(parentIdx, `${parent} must be in PROCESSING_ORDER`).toBeGreaterThanOrEqual(0);
        expect(parentIdx, `${parent} must come before ${child}`).toBeLessThan(childIdx);
      }
    }
  });
});

describe('expectArrayShape', () => {
  it('passes when all required keys are present', () => {
    expect(() => expectArrayShape([{ a: 1, b: 2, c: 3 }], ['a', 'b'], 'X')).not.toThrow();
  });

  it('is a no-op on empty arrays', () => {
    expect(() => expectArrayShape([], ['a', 'b'], 'X')).not.toThrow();
  });

  it('throws when a required key is missing, listing the missing ones', () => {
    expect(() => expectArrayShape([{ a: 1 }], ['a', 'b', 'c'], 'X')).toThrow(/X .* \[b, c\]/);
  });
});

describe('upsertSharedTableData field mappings', () => {
  // These tests are the safety net for the snake_case → camelCase translations.
  // If a future refactor swaps `product_size_id` and `hole_id` in upsertLeds, this
  // suite should fail loudly.

  it('upsertLeds maps product_size_id and hole_id to the right columns', async () => {
    const { db, calls } = makeFakeDb();
    await upsertSharedTableData(db, 'tension', 'leds', [{ id: 1, product_size_id: 42, hole_id: 99, position: 7 }]);
    expect(calls).toHaveLength(1);
    const [row] = calls[0].values;
    expect(row).toMatchObject({
      boardType: 'tension',
      id: 1,
      productSizeId: 42,
      holeId: 99,
      position: 7,
    });
    expect(calls[0].setKeys).toEqual(['productSizeId', 'holeId', 'position']);
  });

  it('upsertHoles preserves nullable mirrored_hole_id and includes all schema columns', async () => {
    const { db, calls } = makeFakeDb();
    await upsertSharedTableData(db, 'kilter', 'holes', [
      { id: 1, product_id: 5, name: 'A1', x: 10, y: 20, mirrored_hole_id: 42, mirror_group: 1 },
      { id: 2, product_id: 5, name: 'A2', x: 30, y: 40, mirrored_hole_id: null, mirror_group: 0 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([
      { boardType: 'kilter', id: 1, productId: 5, name: 'A1', x: 10, y: 20, mirroredHoleId: 42, mirrorGroup: 1 },
      { boardType: 'kilter', id: 2, productId: 5, name: 'A2', x: 30, y: 40, mirroredHoleId: null, mirrorGroup: 0 },
    ]);
  });

  it('upsertProductSizesLayoutsSets maps product_size_id, layout_id, and set_id distinctly', async () => {
    const { db, calls } = makeFakeDb();
    await upsertSharedTableData(db, 'tension', 'product_sizes_layouts_sets', [
      { id: 1, product_size_id: 10, layout_id: 20, set_id: 30, image_filename: 'a.png', is_listed: true },
    ]);
    const [row] = calls[0].values;
    expect(row).toMatchObject({
      boardType: 'tension',
      id: 1,
      productSizeId: 10,
      layoutId: 20,
      setId: 30,
      imageFilename: 'a.png',
      isListed: true,
    });
  });

  it('chunks large inputs into batches of 100 (single multi-row INSERT per batch)', async () => {
    const { db, calls } = makeFakeDb();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      product_id: 5,
      name: `H${i + 1}`,
      x: 0,
      y: 0,
      mirrored_hole_id: null,
      mirror_group: 0,
    }));
    await upsertSharedTableData(db, 'kilter', 'holes', rows);
    expect(calls).toHaveLength(3);
    expect(calls[0].values).toHaveLength(100);
    expect(calls[1].values).toHaveLength(100);
    expect(calls[2].values).toHaveLength(50);
  });

  it('rejects an `holes` payload that looks like leds (missing keys)', async () => {
    const { db } = makeFakeDb();
    await expect(
      upsertSharedTableData(db, 'kilter', 'holes', [{ id: 1, product_size_id: 5, hole_id: 99, position: 1 }]),
    ).rejects.toThrow(/holes payload missing required key\(s\)/);
  });

  it('upsertProducts maps min_count_in_frame and max_count_in_frame correctly', async () => {
    const { db, calls } = makeFakeDb();
    await upsertSharedTableData(db, 'kilter', 'products', [
      { id: 1, name: 'KB', is_listed: true, password: null, min_count_in_frame: 1, max_count_in_frame: 12 },
    ]);
    const [row] = calls[0].values;
    expect(row).toMatchObject({
      boardType: 'kilter',
      id: 1,
      name: 'KB',
      isListed: true,
      password: null,
      minCountInFrame: 1,
      maxCountInFrame: 12,
    });
  });
});
