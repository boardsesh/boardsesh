import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import {
  buildKilterStatsUpsert,
  kilterStatsConflictSet,
  kilterStatsConflictWhere,
  type KilterStatsUpsertRow,
} from './stats-upsert';

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment).sql.toLowerCase().replace(/\s+/g, ' ').trim();

function row(climbUuid: string): KilterStatsUpsertRow {
  return {
    climbUuid,
    angle: 40,
    displayDifficulty: 20,
    difficultyAverage: 20.4,
    qualityAverage: 4.2,
    faUsername: 'setter',
    faAt: '2024-01-01 00:00:00',
    upstreamAscensionistCount: 12,
  };
}

describe('Kilter stats upsert', () => {
  it('guards on every column the SET writes except upstream_synced_at', () => {
    for (const policy of ['raise-only', 'authoritative'] as const) {
      const set = kilterStatsConflictSet(policy);
      const guard = render(kilterStatsConflictWhere(set));
      const [storedTuple] = guard.split(' is distinct from ');
      for (const entry of set) {
        expect(storedTuple).toContain(`"board_climb_stats"."${entry.column.name}"`);
      }
      // Every SET column, including the ones the sync_seq trigger does not
      // watch (upstream_*, tick_graded_at, quality_normalized). Missing one
      // would leave a stale value, e.g. a tick marker Grips should have cleared.
      expect(set.map((entry) => entry.column.name).sort()).toEqual(
        [
          'ascensionist_count',
          'difficulty_average',
          'display_difficulty',
          'fa_at',
          'fa_username',
          'quality_average',
          'quality_normalized',
          'tick_graded_at',
          'upstream_ascensionist_count',
          'upstream_quality_average',
        ].sort(),
      );
      expect(storedTuple).not.toContain('upstream_synced_at');
    }
  });

  it('still restamps a missing stamp, or a day-old one where Boardsesh ticks count', () => {
    // The tick recompute's absorption rule reads this stamp
    // (kilter_synced_at < upstream_synced_at - 48h), so it must keep moving
    // wherever absorption can still lower boardsesh_ascensionist_count.
    const guard = render(kilterStatsConflictWhere(kilterStatsConflictSet('raise-only')));
    expect(guard).toContain('or "board_climb_stats"."upstream_synced_at" is null');
    expect(guard).toContain(
      `or ( "board_climb_stats"."upstream_synced_at" < excluded.upstream_synced_at - interval '24 hours' and coalesce("board_climb_stats"."boardsesh_ascensionist_count", 0) > 0 )`,
    );
  });

  it('raises the catalog count but lets the repair lower it', () => {
    const [raiseOnly] = kilterStatsConflictSet('raise-only');
    const [authoritative] = kilterStatsConflictSet('authoritative');
    expect(render(raiseOnly.value)).toBe(
      'greatest(coalesce("board_climb_stats"."upstream_ascensionist_count", 0), coalesce(excluded.upstream_ascensionist_count, 0))',
    );
    expect(render(authoritative.value)).toBe('excluded.upstream_ascensionist_count');
  });

  it('ships the shared grade rule (#4798)', () => {
    const byColumn = new Map(
      kilterStatsConflictSet('authoritative').map((entry) => [entry.column.name, render(entry.value)]),
    );
    expect(byColumn.get('display_difficulty')).toBe(
      'coalesce(excluded.display_difficulty, "board_climb_stats"."display_difficulty")',
    );
    expect(byColumn.get('tick_graded_at')).toBe(
      'case when excluded.display_difficulty is null then "board_climb_stats"."tick_graded_at" else null end',
    );
  });

  it('emits one statement text whatever the chunk size', () => {
    // Multi-row VALUES minted one pg_stat_statements entry per distinct row
    // count (852 for this writer). unnest arrays keep it at one.
    const options = { policy: 'raise-only' as const, syncedAt: '2026-09-26T00:00:00.000Z' };
    const one = dialect.sqlToQuery(buildKilterStatsUpsert([row('a')], options));
    const three = dialect.sqlToQuery(buildKilterStatsUpsert([row('a'), row('b'), row('c')], options));
    expect(three.sql).toBe(one.sql);
    // kilter, the stamp, then one array per unnest column.
    expect(three.params).toHaveLength(10);
    expect(three.params[2]).toEqual(['a', 'b', 'c']);
  });
});
