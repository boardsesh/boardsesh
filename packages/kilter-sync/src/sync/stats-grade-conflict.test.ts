import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { kilterStatsGradeConflictSet } from './stats-grade-conflict';

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment).sql.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The grade rule both Kilter Grips writers ship on ON CONFLICT — the catalog
 * sync and the stats repair import this one builder, so these assertions cover
 * both. The behaviour they pin (#4798) is that tick_graded_at survives exactly
 * as long as the grade it describes.
 */
describe('kilterStatsGradeConflictSet', () => {
  it('keeps the stored grade when Grips supplies none', () => {
    expect(render(kilterStatsGradeConflictSet().displayDifficulty)).toBe(
      'coalesce(excluded.display_difficulty, "board_climb_stats"."display_difficulty")',
    );
    expect(render(kilterStatsGradeConflictSet().difficultyAverage)).toBe(
      'coalesce(excluded.difficulty_average, "board_climb_stats"."difficulty_average")',
    );
  });

  it('keeps the tick-derived marker on an incoming NULL and clears it on a real grade', () => {
    // Branch for branch against the COALESCE above: an incoming NULL keeps the
    // stored grade, so the marker describing it must stay; a real incoming
    // grade replaces it, so the marker must go.
    expect(render(kilterStatsGradeConflictSet().tickGradedAt)).toBe(
      'case when excluded.display_difficulty is null then "board_climb_stats"."tick_graded_at" else null end',
    );
  });

  it('never decides provenance by comparing timestamps', () => {
    // The bug this replaced: both writers stamp upstream_synced_at on EVERY
    // pass, so `tick_graded_at > upstream_synced_at` went false after the first
    // gradeless pass and froze a grade Boardsesh owned — unable to be refreshed
    // by a later tick or cleared by a delete.
    const rendered = Object.values(kilterStatsGradeConflictSet()).map(render).join(' ');
    expect(rendered).not.toContain('upstream_synced_at');
  });

  it('keys the marker off the same column the grade is keyed off', () => {
    // A drift guard: if the grade ever stops being decided by
    // excluded.display_difficulty, the marker CASE has to move with it.
    const { displayDifficulty, tickGradedAt } = kilterStatsGradeConflictSet();
    expect(render(displayDifficulty)).toContain('excluded.display_difficulty');
    expect(render(tickGradedAt)).toContain('excluded.display_difficulty');
  });
});
