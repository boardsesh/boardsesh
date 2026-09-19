import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type Table } from 'drizzle-orm';

import type { KilterCatalogClimb, KilterCatalogStat } from '../api/kilter-rest';
import type { KilterReferencePull } from './reference-pull';

// The REST layer and the three side-effect passes are mocked so a whole
// syncKilterCatalog cycle can run against a fake database. vi.hoisted keeps the
// mock objects out of the factory closures (Vitest 4 + typechecked test files).
const restMocks = vi.hoisted(() => ({
  fetchLayoutClimbs: vi.fn(),
  fetchLayoutClimbStats: vi.fn(),
  fetchDeletedClimbUuids: vi.fn(),
}));
const deletionMocks = vi.hoisted(() => ({ reconcileDeletions: vi.fn() }));
const locationMocks = vi.hoisted(() => ({ syncKilterLocations: vi.fn() }));
const notificationMocks = vi.hoisted(() => ({ createSetterSyncNotifications: vi.fn() }));

vi.mock('../api/kilter-rest', () => restMocks);
vi.mock('./deletions', () => deletionMocks);
vi.mock('./locations-sync', () => locationMocks);
vi.mock('./notifications', () => notificationMocks);

const { syncKilterCatalog } = await import('./catalog-sync');

const SOURCE_LAYOUT_ID = 1;
const TARGET_LAYOUT_ID = 8;
// 'h4000p12' places only on the Homewall layout, so a climb Kilter tags
// Original decodes nowhere but layout 8 — the live mis-tagging.
const MISTAGGED_CONCAT = 'h4000p12';
const SOURCE_CONCAT = 'h10p12';

type Rows = Array<Record<string, unknown>>;
/** Canned select results per table, consumed in call order; an Error throws. */
type TableQueues = Record<string, Array<Rows | Error>>;

function catalogClimb(overrides: Partial<KilterCatalogClimb> = {}): KilterCatalogClimb {
  return {
    climbUuid: 'MISTAGGED',
    climbConcat: MISTAGGED_CONCAT,
    name: 'Put em up',
    description: '',
    edgeLeft: 0,
    edgeRight: 0,
    edgeBottom: 0,
    edgeTop: 0,
    frameCount: 1,
    framesPace: 0,
    userUuid: '26394',
    username: 'DynoClimb',
    productName: 'Kilter Board Original',
    productLayoutUuid: '27',
    allowMatch: true,
    isDraft: false,
    isListed: true,
    isDeleted: false,
    accumulatedHoldSetValue: 3,
    origin: 'NATIVE',
    createdAt: '2026-09-10T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    ...overrides,
  };
}

function referencePull(): KilterReferencePull {
  const layout = (productLayoutUuid: string, productName: string) => ({
    productLayoutUuid,
    productName,
    isListed: true,
    edgeLeft: 0,
    edgeRight: 0,
    edgeBottom: 0,
    edgeTop: 0,
  });
  return {
    products: [],
    productLayouts: [layout('27', 'Kilter Board Original'), layout('17', 'Kilter Board Homewall')],
    holds: [],
    difficultyGrades: [],
    gyms: [],
    walls: [],
  };
}

/**
 * Minimal drizzle shim: selects are answered from a per-table queue (so the
 * assertions don't depend on the exact order of unrelated queries), and inserts
 * and updates are recorded rather than run.
 */
function createFakeDb(queues: TableQueues) {
  const inserts: Array<{ table: string; values: Rows }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const pending: TableQueues = Object.fromEntries(Object.entries(queues).map(([table, rows]) => [table, [...rows]]));

  function nextRows(table: Table): Rows {
    const next = pending[getTableName(table)]?.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  }

  function selectStub(rows: Rows) {
    const stub = {
      from: () => stub,
      where: () => stub,
      innerJoin: () => stub,
      leftJoin: () => stub,
      groupBy: () => stub,
      orderBy: () => stub,
      limit: () => stub,
      then: (onFulfilled: (rows: Rows) => unknown) => Promise.resolve(rows).then(onFulfilled),
    };
    return stub;
  }

  const writer = {
    insert: (table: Table) => ({
      values: (values: Rows | Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values: Array.isArray(values) ? values : [values] });
        const written = {
          onConflictDoUpdate: () => Promise.resolve([]),
          onConflictDoNothing: () => Promise.resolve([]),
          returning: () => Promise.resolve([]),
          then: (onFulfilled: (rows: Rows) => unknown) => Promise.resolve([]).then(onFulfilled),
        };
        return written;
      },
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table: getTableName(table), values });
        const written = {
          where: () => written,
          returning: () => Promise.resolve([]),
          then: (onFulfilled: (rows: Rows) => unknown) => Promise.resolve([]).then(onFulfilled),
        };
        return written;
      },
    }),
    execute: () => Promise.resolve([]),
  };

  // Annotated rather than inferred: `transaction` hands the same object back to
  // its callback, and inferring that would be self-referential (TS7022).
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: Table) => selectStub(nextRows(table)) }),
    ...writer,
  };
  db.transaction = (callback: (tx: unknown) => Promise<unknown>) => callback(db);
  return { db: db as unknown as Parameters<typeof syncKilterCatalog>[0]['db'], inserts, updates };
}

/** Catalogue tables every run reads before it reaches the interesting part. */
function baseQueues(overrides: TableQueues = {}): TableQueues {
  return {
    board_layouts: [
      [
        { id: SOURCE_LAYOUT_ID, productId: 1 },
        { id: TARGET_LAYOUT_ID, productId: 2 },
      ],
    ],
    board_products: [
      [
        { id: 1, name: 'Kilter Board Original' },
        { id: 2, name: 'Kilter Board Homewall' },
      ],
    ],
    board_layout_aliases: [
      [
        { layoutUuid: '27', layoutId: SOURCE_LAYOUT_ID },
        { layoutUuid: '17', layoutId: TARGET_LAYOUT_ID },
      ],
    ],
    board_climb_ingest_skips: [[]],
    // Preload order follows reference.productLayouts: layout 1, then layout 8.
    board_placements: [[{ holeId: 10, id: 100 }], [{ holeId: 4000, id: 900 }]],
    ...overrides,
  };
}

function runCatalog(db: Parameters<typeof syncKilterCatalog>[0]['db']) {
  return syncKilterCatalog({
    db,
    tokenProvider: () => Promise.resolve('access-token'),
    reference: referencePull(),
    // Scoped run: only Original is pulled, while the preload still resolves both
    // layouts so the reroute resolver can see Homewall.
    layoutUuids: ['27'],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  restMocks.fetchLayoutClimbStats.mockResolvedValue([] as KilterCatalogStat[]);
  restMocks.fetchDeletedClimbUuids.mockResolvedValue([]);
  locationMocks.syncKilterLocations.mockResolvedValue({});
  notificationMocks.createSetterSyncNotifications.mockResolvedValue(undefined);
  deletionMocks.reconcileDeletions.mockResolvedValue({});
});

void describe('reroute pass — a candidate that cannot be ingested', () => {
  it('declines a uuid that already lives on a third layout and keeps its original skip row', () => {
    restMocks.fetchLayoutClimbs.mockResolvedValue([catalogClimb()]);
    const { db, inserts } = createFakeDb(
      baseQueues({
        board_climbs: [
          [], // the source layout's own catalogue
          // …and the candidate, found on a layout that is neither source nor target.
          [{ uuid: 'MISTAGGED', layoutId: 99, fingerprint: null, isListed: true, userId: null, isDraft: false }],
          [], // fingerprint matches on the target layout
        ],
        board_climb_aliases: [[], []],
      }),
    );

    return runCatalog(db).then((summary) => {
      expect(summary.climbsRerouted).toBe(0);
      expect(summary.climbsUnmapped).toBe(1);
      expect(summary.skipsRecorded).toBe(1);
      // The skip row is the SOURCE layout's, exactly as if no reroute existed.
      const skipInsert = inserts.find((row) => row.table === 'board_climb_ingest_skips');
      expect(skipInsert?.values[0]).toMatchObject({
        climbUuid: 'MISTAGGED',
        reason: 'unplaceable_hole',
        layoutId: SOURCE_LAYOUT_ID,
      });
      // Nothing was written to the catalogue for it.
      expect(inserts.some((row) => row.table === 'board_climbs')).toBe(false);
    });
  });

  it('degrades to the backlog when the pass throws, without killing the rest of the cycle', () => {
    restMocks.fetchLayoutClimbs.mockResolvedValue([catalogClimb()]);
    const { db, inserts } = createFakeDb(
      baseQueues({
        board_climbs: [[], new Error('connection terminated')],
        board_climb_aliases: [[], []],
      }),
    );

    return runCatalog(db).then((summary) => {
      expect(summary.climbsRerouted).toBe(0);
      expect(summary.skipsRecorded).toBe(1);
      expect(inserts.find((row) => row.table === 'board_climb_ingest_skips')?.values[0]).toMatchObject({
        climbUuid: 'MISTAGGED',
        layoutId: SOURCE_LAYOUT_ID,
      });
      // The cycle carried on past the failed reroute.
      expect(locationMocks.syncKilterLocations).toHaveBeenCalledTimes(1);
    });
  });
});

void describe('a failed /delteduuids fetch', () => {
  it('disables both the identity re-list and deletion reconciliation', () => {
    restMocks.fetchDeletedClimbUuids.mockRejectedValue(new Error('502 from Kilter'));
    // A listed climb whose canonical we hold unlisted — the re-list candidate.
    restMocks.fetchLayoutClimbs.mockResolvedValue([catalogClimb({ climbUuid: 'climb-1', climbConcat: SOURCE_CONCAT })]);
    const { db, updates } = createFakeDb(
      baseQueues({
        board_climbs: [
          [
            {
              uuid: 'CLIMB-1',
              layoutId: SOURCE_LAYOUT_ID,
              fingerprint: 'fp',
              isListed: false,
              userId: null,
              isDraft: false,
            },
          ],
        ],
        board_climb_aliases: [[]],
      }),
    );

    return runCatalog(db).then((summary) => {
      // No re-list: without a deletion list we cannot tell a stale unlisting
      // from a climb Kilter deleted this very cycle.
      expect(summary.canonicalsRelisted).toBe(0);
      expect(updates.some((row) => row.table === 'board_climbs')).toBe(false);
      // Suppressed, not blocked-on-evidence.
      expect(summary.relistsBlockedByDeletionHistory).toBe(0);
      // And reconciliation never ran on a list we don't have.
      expect(deletionMocks.reconcileDeletions).not.toHaveBeenCalled();
    });
  });
});
