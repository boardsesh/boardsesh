import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../db/client', () => ({ db: mockDb }));

vi.mock('../db/queries/util/table-select', () => ({
  UNIFIED_TABLES: {
    climbs: {
      uuid: 'climbs.uuid',
      layoutId: 'climbs.layoutId',
      boardType: 'climbs.boardType',
      setterUsername: 'climbs.setterUsername',
      name: 'climbs.name',
      description: 'climbs.description',
      frames: 'climbs.frames',
    },
    climbStats: {
      climbUuid: 'climbStats.climbUuid',
      boardType: 'climbStats.boardType',
      angle: 'climbStats.angle',
      ascensionistCount: 'climbStats.ascensionistCount',
      qualityAverage: 'climbStats.qualityAverage',
      difficultyAverage: 'climbStats.difficultyAverage',
      displayDifficulty: 'climbStats.displayDifficulty',
      benchmarkDifficulty: 'climbStats.benchmarkDifficulty',
    },
  },
}));

vi.mock('@boardsesh/db/queries', () => ({
  getGradeLabel: (id: number | null | undefined) => (id == null ? '?' : `V${id}`),
  getClimbStars: (_boardName: string | null | undefined, qualityAverage: number | string | null | undefined) => {
    const numericQualityAverage = Number(qualityAverage);
    return Number.isFinite(numericQualityAverage) ? Math.round(numericQualityAverage * 5) : 0;
  },
}));

import { hydrateClimbsByRefs } from '../graphql/resolvers/playlists/helpers/hydrate-climbs';

function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'limit', 'offset'];
  for (const method of methods) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('hydrateClimbsByRefs', () => {
  it('returns [] without hitting the database when refs is empty', async () => {
    const result = await hydrateClimbsByRefs([]);
    expect(result).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('preserves caller order, not the order rows happen to come back from the DB', async () => {
    // DB returns rows in reverse order; helper should re-order them by refs.
    mockDb.select.mockReturnValueOnce(
      makeChain([
        {
          climbUuid: 'climb-2',
          layoutId: 2,
          boardType: 'tension',
          setter_username: 'b',
          name: 'Second',
          description: '',
          frames: '',
          statsAngle: 30,
          ascensionist_count: 5,
          difficulty_id: 15,
          quality_average: 2.0,
          difficulty_error: 0.1,
          benchmark_difficulty: null,
        },
        {
          climbUuid: 'climb-1',
          layoutId: 1,
          boardType: 'kilter',
          setter_username: 'a',
          name: 'First',
          description: '',
          frames: '',
          statsAngle: 40,
          ascensionist_count: 10,
          difficulty_id: 25,
          quality_average: 3.5,
          difficulty_error: 0.2,
          benchmark_difficulty: null,
        },
      ]),
    );

    const result = await hydrateClimbsByRefs([
      { climbUuid: 'climb-1', boardType: 'kilter' },
      { climbUuid: 'climb-2', boardType: 'tension' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].uuid).toBe('climb-1');
    expect(result[0].name).toBe('First');
    expect(result[1].uuid).toBe('climb-2');
    expect(result[1].name).toBe('Second');
  });

  it('keys lookups by both boardType and climbUuid so cross-board UUID collisions resolve correctly', async () => {
    // Both rows share a UUID but live on different boards. The helper must
    // dispatch each ref to the matching board's row.
    mockDb.select.mockReturnValueOnce(
      makeChain([
        {
          climbUuid: 'shared-uuid',
          layoutId: 1,
          boardType: 'kilter',
          setter_username: 'k',
          name: 'Kilter Twin',
          description: '',
          frames: '',
          statsAngle: 40,
          ascensionist_count: 10,
          difficulty_id: 20,
          quality_average: 3.0,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
        {
          climbUuid: 'shared-uuid',
          layoutId: 2,
          boardType: 'tension',
          setter_username: 't',
          name: 'Tension Twin',
          description: '',
          frames: '',
          statsAngle: 30,
          ascensionist_count: 5,
          difficulty_id: 18,
          quality_average: 2.5,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
      ]),
    );

    const result = await hydrateClimbsByRefs([
      { climbUuid: 'shared-uuid', boardType: 'tension' },
      { climbUuid: 'shared-uuid', boardType: 'kilter' },
    ]);

    expect(result[0].name).toBe('Tension Twin');
    expect(result[0].boardType).toBe('tension');
    expect(result[1].name).toBe('Kilter Twin');
    expect(result[1].boardType).toBe('kilter');
  });

  it('drops refs that have no matching climb row', async () => {
    // DB returned only one of the two refs. The missing ref is silently dropped.
    mockDb.select.mockReturnValueOnce(
      makeChain([
        {
          climbUuid: 'present',
          layoutId: 1,
          boardType: 'kilter',
          setter_username: 'a',
          name: 'Present',
          description: '',
          frames: '',
          statsAngle: 40,
          ascensionist_count: 1,
          difficulty_id: 10,
          quality_average: 1.0,
          difficulty_error: 0,
          benchmark_difficulty: null,
        },
      ]),
    );

    const result = await hydrateClimbsByRefs([
      { climbUuid: 'present', boardType: 'kilter' },
      { climbUuid: 'missing', boardType: 'kilter' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe('present');
  });

  describe('angle precedence', () => {
    const baseRow = {
      climbUuid: 'c1',
      layoutId: 1,
      boardType: 'kilter',
      setter_username: 's',
      name: 'C1',
      description: '',
      frames: '',
      ascensionist_count: 1,
      difficulty_id: 10,
      quality_average: 1.0,
      difficulty_error: 0,
      benchmark_difficulty: null,
    };

    it('falls back to the climb stats angle when no override is supplied', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: 35 }]));

      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }]);

      expect(result[0].angle).toBe(35);
    });

    it('falls back to the default angle (40) when stats has no angle row', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: null }]));

      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }]);

      expect(result[0].angle).toBe(40);
    });

    // The returned `angle` reflects the angle the stats row was actually joined
    // at (`statsAngle`), so it always agrees with the difficulty/quality shown.
    // The SQL joins at COALESCE(override-if-stats-exist, most-ascents), so when
    // an override is applied the joined statsAngle IS the override angle.
    it('returns the joined stats angle, which under an applied override is the override angle', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: 25 }]));

      const overrides = new Map<string, number | null>([['kilter:c1', 25]]);
      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }], {
        angleOverrides: overrides,
      });

      expect(result[0].angle).toBe(25);
    });

    // When the override angle has no stats row, the SQL EXISTS guard drops the
    // override and the join falls back to the most-ascended angle. The returned
    // angle follows that fallback (statsAngle) so grade and angle stay in sync,
    // rather than reporting an angle whose grade isn't shown.
    it('follows the joined fallback angle when the override angle has no stats', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: 35 }]));

      const overrides = new Map<string, number | null>([['kilter:c1', 25]]);
      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }], {
        angleOverrides: overrides,
      });

      expect(result[0].angle).toBe(35);
    });

    // Only when the climb has no stats row at all (nothing to join) does the
    // requested override angle survive as the reported angle.
    it('uses the override as a last resort when the climb has no stats row', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: null }]));

      const overrides = new Map<string, number | null>([['kilter:c1', 25]]);
      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }], {
        angleOverrides: overrides,
      });

      expect(result[0].angle).toBe(25);
    });

    it('treats a null override entry as "no override" and falls through to statsAngle', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: 35 }]));

      const overrides = new Map<string, number | null>([['kilter:c1', null]]);
      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }], {
        angleOverrides: overrides,
      });

      expect(result[0].angle).toBe(35);
    });

    it('treats a null override entry with a null statsAngle as default 40', async () => {
      mockDb.select.mockReturnValueOnce(makeChain([{ ...baseRow, statsAngle: null }]));

      const overrides = new Map<string, number | null>([['kilter:c1', null]]);
      const result = await hydrateClimbsByRefs([{ climbUuid: 'c1', boardType: 'kilter' }], {
        angleOverrides: overrides,
      });

      expect(result[0].angle).toBe(40);
    });
  });
});
