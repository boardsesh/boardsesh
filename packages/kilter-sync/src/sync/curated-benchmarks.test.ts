import { describe, expect, it, vi } from 'vitest';

import { parseCuratedClimbStats, type KilterCuratedStat } from '../api/kilter-rest';
import {
  aliasLookupKeys,
  applyCuratedBenchmarks,
  buildCuratedTargets,
  foldCuratedStats,
  planCuratedClears,
} from './curated-benchmarks';

function curatedStat(overrides: Partial<KilterCuratedStat> & { climbUuid: string }): KilterCuratedStat {
  return { angle: 40, currentDifficultyId: 20, officialKilterDifficulty: null, ...overrides };
}

describe('parseCuratedClimbStats', () => {
  it('reads climbStats and treats a missing official grade as null', () => {
    const body = {
      climbs: [{ climbUuid: 'ignored' }],
      climbStats: [
        { climbUuid: 'ABC', angle: 40, currentDifficultyId: 22, officialKilterDifficulty: 21 },
        { climbUuid: 'DEF', angle: 50, currentDifficultyId: 18 },
      ],
    };
    expect(parseCuratedClimbStats(body)).toEqual([
      { climbUuid: 'ABC', angle: 40, currentDifficultyId: 22, officialKilterDifficulty: 21 },
      { climbUuid: 'DEF', angle: 50, currentDifficultyId: 18, officialKilterDifficulty: null },
    ]);
  });

  it.each([[null], [[]], [{}], [{ climbStats: 'nope' }], [{ climbs: [] }]])(
    'throws on a body without a climbStats array: %j',
    (body) => {
      expect(() => parseCuratedClimbStats(body)).toThrow(/climbStats/);
    },
  );

  it('drops rows missing a uuid or a whole-number angle', () => {
    const body = {
      climbStats: [
        { climbUuid: '', angle: 40 },
        { angle: 40 },
        { climbUuid: 'ABC', angle: 'forty' },
        { climbUuid: 'ABC', angle: 40.5 },
        null,
        { climbUuid: 'KEEP', angle: 45 },
      ],
    };
    expect(parseCuratedClimbStats(body).map((row) => row.climbUuid)).toEqual(['KEEP']);
  });
});

describe('foldCuratedStats', () => {
  it('collapses repeats across uuid casing and keeps the official grade from any of them', () => {
    const rows = foldCuratedStats(
      [
        curatedStat({ climbUuid: 'ABC', officialKilterDifficulty: null }),
        curatedStat({ climbUuid: 'abc', officialKilterDifficulty: 21 }),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lowerUuid: 'abc', officialDifficulty: 21, upstreamDifficulty: 20 });
  });

  it('keeps each angle of a climb as its own row', () => {
    const rows = foldCuratedStats(
      [curatedStat({ climbUuid: 'ABC', angle: 40 }), curatedStat({ climbUuid: 'ABC', angle: 50 })],
      null,
    );
    expect(rows.map((row) => row.angle)).toEqual([40, 50]);
  });

  it('drops climbs Kilter has deleted, whatever the casing', () => {
    expect(foldCuratedStats([curatedStat({ climbUuid: 'ABC' })], new Set(['abc']))).toEqual([]);
  });

  it('treats a placeholder grade of 1 or less as no grade', () => {
    const [row] = foldCuratedStats(
      [curatedStat({ climbUuid: 'ABC', currentDifficultyId: 1, officialKilterDifficulty: 0 })],
      null,
    );
    expect(row).toMatchObject({ officialDifficulty: null, upstreamDifficulty: null });
  });
});

describe('aliasLookupKeys', () => {
  it('covers the received, upper and lower spellings once each', () => {
    const rows = foldCuratedStats([curatedStat({ climbUuid: 'aBc' })], null);
    expect(aliasLookupKeys(rows).sort()).toEqual(['ABC', 'aBc', 'abc']);
  });
});

describe('buildCuratedTargets', () => {
  it('merges two aliases of one climb into one target and counts climbs we do not carry', () => {
    const rows = foldCuratedStats(
      [
        curatedStat({ climbUuid: 'ALIAS-A', officialKilterDifficulty: null }),
        curatedStat({ climbUuid: 'ALIAS-B', officialKilterDifficulty: 23 }),
        curatedStat({ climbUuid: 'UP-BOARD-ONE' }),
        curatedStat({ climbUuid: 'UP-BOARD-ONE', angle: 50 }),
      ],
      null,
    );
    const canonicals = new Map([
      ['alias-a', 'CANON'],
      ['alias-b', 'CANON'],
    ]);
    const { targets, unresolvedClimbs } = buildCuratedTargets(rows, canonicals);
    expect(targets).toEqual([{ climbUuid: 'CANON', angle: 40, officialDifficulty: 23, upstreamDifficulty: 20 }]);
    expect(unresolvedClimbs).toBe(1);
  });
});

describe('planCuratedClears', () => {
  it('clears only the marked rows missing from the list, per angle', () => {
    const targets = [{ climbUuid: 'KEEP', angle: 40, officialDifficulty: 20, upstreamDifficulty: 20 }];
    const marked = [
      { climbUuid: 'KEEP', angle: 40 },
      { climbUuid: 'KEEP', angle: 50 },
      { climbUuid: 'GONE', angle: 40 },
    ];
    expect(planCuratedClears(marked, targets)).toEqual([
      { climbUuid: 'KEEP', angle: 50 },
      { climbUuid: 'GONE', angle: 40 },
    ]);
  });
});

describe('applyCuratedBenchmarks', () => {
  it('refuses an empty list without touching the database', async () => {
    const write = vi.fn();
    const log = vi.fn();
    const db = new Proxy(
      {},
      {
        get: () => {
          throw new Error('database touched');
        },
      },
    );

    const report = await applyCuratedBenchmarks({
      db: db as Parameters<typeof applyCuratedBenchmarks>[0]['db'],
      write,
      stats: [],
      deletedLowerUuids: null,
      log,
    });

    expect(report).toEqual({ listed: 0, resolved: 0, unresolvedClimbs: 0, marked: 0, cleared: 0, refused: true });
    expect(write).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REFUSING'));
  });
});
