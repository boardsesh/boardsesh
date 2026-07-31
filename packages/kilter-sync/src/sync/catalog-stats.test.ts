import { describe, it, expect } from 'vitest';

import { foldCatalogStat, foldCatalogStatOnce, shouldRelistFoldedCanonical } from './catalog-sync';
import type { KilterCatalogStat } from '../api/kilter-rest';
import type { StatAccum } from './catalog-sync';

const CANON = 'canon-uuid';
const MERGED = 'merged-uuid';

function stat(
  over: Partial<KilterCatalogStat> & { climbUuid: string; angle: number; ascentCount: number },
): KilterCatalogStat {
  return {
    currentDifficultyId: null,
    difficultyAverage: null,
    qualityAverage: null,
    faUsername: null,
    faAt: null,
    ...over,
  };
}

function fold(...rows: Array<{ stat: KilterCatalogStat; canonical: string }>): StatAccum {
  const map = new Map<string, StatAccum>();
  for (const r of rows) foldCatalogStat(map, r.stat, r.canonical);
  // single (canonical, angle) per test
  const values = [...map.values()];
  expect(values).toHaveLength(1);
  return values[0];
}

describe('foldCatalogStat — kilter catalog stat accumulation', () => {
  it('takes display fields from the canonical-own row and sums the count', () => {
    const accum = fold({
      stat: stat({
        climbUuid: CANON,
        angle: 40,
        ascentCount: 12,
        currentDifficultyId: 20,
        difficultyAverage: 20.4,
        qualityAverage: 4.2,
        faUsername: 'fa1',
      }),
      canonical: CANON,
    });
    expect(accum.kilterCount).toBe(12);
    expect(accum.displayDifficulty).toBe(20);
    expect(accum.difficultyAverage).toBe(20.4);
    expect(accum.qualityAverage).toBe(4.2);
    expect(accum.faUsername).toBe('fa1');
    expect(accum.hasOwnRowStats).toBe(true);
  });

  it('#4: a fingerprint-merged duplicate fills the grade when the canonical has no own row', () => {
    // Canonical is aurora-origin (never appears as its own Grips climb); only a
    // merged duplicate's stat row is seen.
    const accum = fold({
      stat: stat({
        climbUuid: MERGED,
        angle: 40,
        ascentCount: 5,
        currentDifficultyId: 18,
        difficultyAverage: 18.1,
        qualityAverage: 3.8,
        faUsername: 'famerge',
      }),
      canonical: CANON,
    });
    expect(accum.kilterCount).toBe(5);
    expect(accum.displayDifficulty).toBe(18); // grade contributed by the merge, not NULL
    expect(accum.qualityAverage).toBe(3.8);
    expect(accum.faUsername).toBe('famerge');
    expect(accum.hasOwnRowStats).toBe(false);
  });

  it('#4: canonical-own row overwrites a merged duplicate regardless of order, count still sums', () => {
    // merged first, then own
    const a = fold(
      {
        stat: stat({
          climbUuid: MERGED,
          angle: 40,
          ascentCount: 5,
          currentDifficultyId: 18,
          difficultyAverage: 18.1,
          qualityAverage: 3.8,
        }),
        canonical: CANON,
      },
      {
        stat: stat({
          climbUuid: CANON,
          angle: 40,
          ascentCount: 12,
          currentDifficultyId: 20,
          difficultyAverage: 20.4,
          qualityAverage: 4.2,
        }),
        canonical: CANON,
      },
    );
    expect(a.kilterCount).toBe(17);
    expect(a.displayDifficulty).toBe(20); // canonical wins
    expect(a.qualityAverage).toBe(4.2);
    expect(a.hasOwnRowStats).toBe(true);

    // own first, then merged — merged must NOT clobber the canonical's values
    const b = fold(
      {
        stat: stat({
          climbUuid: CANON,
          angle: 40,
          ascentCount: 12,
          currentDifficultyId: 20,
          difficultyAverage: 20.4,
          qualityAverage: 4.2,
        }),
        canonical: CANON,
      },
      {
        stat: stat({
          climbUuid: MERGED,
          angle: 40,
          ascentCount: 5,
          currentDifficultyId: 18,
          difficultyAverage: 18.1,
          qualityAverage: 3.8,
        }),
        canonical: CANON,
      },
    );
    expect(b.kilterCount).toBe(17);
    expect(b.displayDifficulty).toBe(20);
    expect(b.qualityAverage).toBe(4.2);
  });

  it('#4: multiple merged duplicates (no own row) — first non-null per field wins, counts all sum', () => {
    const accum = fold(
      {
        stat: stat({ climbUuid: 'm1', angle: 40, ascentCount: 3, currentDifficultyId: 17, qualityAverage: null }),
        canonical: CANON,
      },
      {
        stat: stat({ climbUuid: 'm2', angle: 40, ascentCount: 4, currentDifficultyId: 19, qualityAverage: 3.5 }),
        canonical: CANON,
      },
    );
    expect(accum.kilterCount).toBe(7);
    expect(accum.displayDifficulty).toBe(17); // first merged with a value wins
    expect(accum.qualityAverage).toBe(3.5); // m1 had null quality, m2 fills it
    expect(accum.hasOwnRowStats).toBe(false);
  });

  it('counts the same source climb stat only once across repeated Grips layouts', () => {
    const map = new Map<string, StatAccum>();
    const seen = new Set<string>();
    const first = foldCatalogStatOnce(
      map,
      seen,
      stat({ climbUuid: CANON, angle: 40, ascentCount: 12, currentDifficultyId: 20 }),
      CANON,
    );
    const second = foldCatalogStatOnce(
      map,
      seen,
      stat({ climbUuid: CANON, angle: 40, ascentCount: 12, currentDifficultyId: 20 }),
      CANON,
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    const [accum] = [...map.values()];
    expect(accum.kilterCount).toBe(12);
  });

  it('still sums distinct source UUIDs that resolve to the same canonical', () => {
    const map = new Map<string, StatAccum>();
    const seen = new Set<string>();
    foldCatalogStatOnce(map, seen, stat({ climbUuid: 'alias-a', angle: 40, ascentCount: 12 }), CANON);
    foldCatalogStatOnce(map, seen, stat({ climbUuid: 'alias-b', angle: 40, ascentCount: 5 }), CANON);

    const [accum] = [...map.values()];
    expect(accum.kilterCount).toBe(17);
  });

  it('#3: quality 0 or negative is stored as NULL (never a literal 0 rating)', () => {
    expect(
      fold({ stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, qualityAverage: 0 }), canonical: CANON })
        .qualityAverage,
    ).toBeNull();
    expect(
      fold({ stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, qualityAverage: null }), canonical: CANON })
        .qualityAverage,
    ).toBeNull();
    expect(
      fold({ stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, qualityAverage: 5 }), canonical: CANON })
        .qualityAverage,
    ).toBe(5);
  });

  it('#star-scale: Grips quality is stored verbatim (already 1-5) — NOT rescaled, regardless of era', () => {
    // A Grips 3.0 is a real 3-of-5; the fa_at era is irrelevant — it must stay
    // 3.0. (An earlier version wrongly pushed pre-cutover climbs 3.0 → 5.0.)
    expect(
      fold({
        stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 8, qualityAverage: 3.0, faAt: '2021-06-01 10:00:00' }),
        canonical: CANON,
      }).qualityAverage,
    ).toBe(3.0);
    expect(
      fold({
        stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 8, qualityAverage: 3.0, faAt: '2026-02-01 10:00:00' }),
        canonical: CANON,
      }).qualityAverage,
    ).toBe(3.0);
  });

  it('#star-scale: quality above 5 is rejected → null (ingest guard)', () => {
    expect(
      fold({
        stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, qualityAverage: 6.1, faAt: '2026-02-01 10:00:00' }),
        canonical: CANON,
      }).qualityAverage,
    ).toBeNull();
  });

  it('#star-scale: placeholder difficulty ≤ 1 is rejected → null (ingest guard)', () => {
    const accum = fold({
      stat: stat({
        climbUuid: CANON,
        angle: 40,
        ascentCount: 1,
        currentDifficultyId: 1,
        difficultyAverage: 1,
      }),
      canonical: CANON,
    });
    expect(accum.displayDifficulty).toBeNull();
    expect(accum.difficultyAverage).toBeNull();

    // A real grade id is kept.
    const real = fold({
      stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, currentDifficultyId: 12, difficultyAverage: 12.3 }),
      canonical: CANON,
    });
    expect(real.displayDifficulty).toBe(12);
    expect(real.difficultyAverage).toBe(12.3);

    // Mixed: a real display grade with a sentinel average — each field is
    // guarded independently.
    const mixed = fold({
      stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, currentDifficultyId: 12, difficultyAverage: 1 }),
      canonical: CANON,
    });
    expect(mixed.displayDifficulty).toBe(12);
    expect(mixed.difficultyAverage).toBeNull();
  });

  it('falls back to difficultyAverage when currentDifficultyId is null; separates by angle', () => {
    const accum = fold({
      stat: stat({ climbUuid: CANON, angle: 40, ascentCount: 1, currentDifficultyId: null, difficultyAverage: 15.7 }),
      canonical: CANON,
    });
    expect(accum.displayDifficulty).toBe(15.7);

    // distinct angles → distinct accumulators
    const map = new Map<string, StatAccum>();
    foldCatalogStat(map, stat({ climbUuid: CANON, angle: 40, ascentCount: 2 }), CANON);
    foldCatalogStat(map, stat({ climbUuid: CANON, angle: 30, ascentCount: 3 }), CANON);
    expect(map.size).toBe(2);
  });

  it('nulls fa_username/fa_at on the canonical-own-row branch for an impossible future date (issue #3536)', () => {
    const accum = fold({
      stat: stat({
        climbUuid: CANON,
        angle: 40,
        ascentCount: 1,
        faUsername: 'somebody',
        faAt: '2033-01-01T00:00:00.000Z',
      }),
      canonical: CANON,
    });
    expect(accum.faUsername).toBeNull();
    expect(accum.faAt).toBeNull();
  });

  it('nulls fa_username/fa_at on the merge-fill branch for a pre-2016 date (issue #3536)', () => {
    const accum = fold({
      stat: stat({
        climbUuid: MERGED,
        angle: 40,
        ascentCount: 1,
        faUsername: 'somebody',
        faAt: '2006-01-01T00:00:00.000Z',
      }),
      canonical: CANON,
    });
    expect(accum.faUsername).toBeNull();
    expect(accum.faAt).toBeNull();
  });

  it('preserves a valid fa_at verbatim on both branches (regression guard against over-nulling)', () => {
    const own = fold({
      stat: stat({
        climbUuid: CANON,
        angle: 40,
        ascentCount: 1,
        faUsername: 'goodfa',
        faAt: '2024-03-15T12:34:56.000Z',
      }),
      canonical: CANON,
    });
    expect(own.faUsername).toBe('goodfa');
    expect(own.faAt).toBe('2024-03-15T12:34:56.000Z');

    const merged = fold({
      stat: stat({
        climbUuid: MERGED,
        angle: 30,
        ascentCount: 1,
        faUsername: 'mergefa',
        faAt: '2023-01-01T00:00:00.000Z',
      }),
      canonical: CANON,
    });
    expect(merged.faUsername).toBe('mergefa');
    expect(merged.faAt).toBe('2023-01-01T00:00:00.000Z');
  });
});

describe('shouldRelistFoldedCanonical — re-list fold decision', () => {
  it('re-lists a synced (non-user) canonical that is currently unlisted', () => {
    expect(shouldRelistFoldedCanonical({ isListed: false, userId: null })).toBe(true);
    // is_listed can be stored as NULL (never-listed synced row) — still re-list.
    expect(shouldRelistFoldedCanonical({ isListed: null, userId: null })).toBe(true);
  });

  it('leaves an already-listed canonical untouched', () => {
    expect(shouldRelistFoldedCanonical({ isListed: true, userId: null })).toBe(false);
  });

  it('never re-lists a user-authored canonical, listed or not', () => {
    expect(shouldRelistFoldedCanonical({ isListed: false, userId: 'user-1' })).toBe(false);
    expect(shouldRelistFoldedCanonical({ isListed: true, userId: 'user-1' })).toBe(false);
  });

  it('is a no-op for a canonical created this run (no DB meta entry)', () => {
    // A canonical inserted earlier in the same run is absent from the existing
    // meta map — it was just inserted as listed, so there is nothing to re-list.
    expect(shouldRelistFoldedCanonical(undefined)).toBe(false);
  });
});
