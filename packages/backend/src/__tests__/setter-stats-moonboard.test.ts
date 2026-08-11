import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { climbQueries } from '../graphql/resolvers/climbs/queries';

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column (e.g.
// quality_normalized) which that DDL omits, so a builder insert fails. Naming
// only the columns the test DDL declares is the genuine raw-SQL exception.

// Integration test (real DB) for #4008: getSetterStats size-scoped every board
// with an unguarded `size_id = ANY(compatible_size_ids)`, which MoonBoard
// climbs never populate (single fixed size), so `1 = ANY(NULL)` dropped every
// MoonBoard row. Both callers (backend resolver, web REST route) additionally
// short-circuited `boardName === 'moonboard'` to `[]`. This test locks in both
// fixes: the resolver no longer short-circuits, and the predicate is gated by
// isSizeScopedBoard rather than deleted outright (so size filtering still
// works for Aurora boards like Kilter).

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-setter-stats',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

async function seedClimb(boardType: string, uuid: string, name: string, setter: string, sizeIdsSql: string) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, compatible_size_ids)
    VALUES (${uuid}, ${boardType}, 1, ${setter}, ${name}, '', 'p1r1', true, ${sql.raw(sizeIdsSql)})
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number, displayDifficulty: number, ascents: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, ${displayDifficulty}, ${displayDifficulty}, 3.0, ${ascents}, 0)
  `);
}

describe('setterStats — size filter skips MoonBoard, still applies to Aurora boards (real DB)', () => {
  beforeAll(async () => {
    // MoonBoard climbs: compatible_size_ids stays NULL, as in production —
    // populate-denormalized-columns skips the size-edges step for moonboard.
    await seedClimb('moonboard', 'moon-setter-climb-1', 'Moon one', 'moon-setter', 'NULL');
    await seedStats('moonboard', 'moon-setter-climb-1', 40, 20, 50);
    await seedClimb('moonboard', 'moon-setter-climb-2', 'Moon two', 'moon-setter', 'NULL');
    await seedStats('moonboard', 'moon-setter-climb-2', 40, 22, 30);

    // Kilter climbs: one compatible with size 10, one only with size 99 — the
    // size filter must still apply to size-scoped boards.
    await seedClimb(
      'kilter',
      'kilter-sized-setter-climb',
      'Fits size 10',
      'kilter-sized-setter',
      'ARRAY[10]::integer[]',
    );
    await seedStats('kilter', 'kilter-sized-setter-climb', 40, 18, 100);
    await seedClimb(
      'kilter',
      'kilter-other-size-setter-climb',
      'Fits size 99 only',
      'kilter-other-size-setter',
      'ARRAY[99]::integer[]',
    );
    await seedStats('kilter', 'kilter-other-size-setter-climb', 40, 19, 80);
  });

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM board_climb_stats WHERE climb_uuid IN (
        'moon-setter-climb-1', 'moon-setter-climb-2', 'kilter-sized-setter-climb', 'kilter-other-size-setter-climb'
      )
    `);
    await db.execute(sql`
      DELETE FROM board_climbs WHERE uuid IN (
        'moon-setter-climb-1', 'moon-setter-climb-2', 'kilter-sized-setter-climb', 'kilter-other-size-setter-climb'
      )
    `);
  });

  it('returns MoonBoard setters with correct counts for the fixed board size, sizeId 1', async () => {
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    expect(result).toEqual([{ setterUsername: 'moon-setter', climbCount: 2 }]);
  });

  it('still size-filters Kilter, excluding a setter whose only climb fits a different size', async () => {
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    expect(result).toEqual([{ setterUsername: 'kilter-sized-setter', climbCount: 1 }]);
  });

  it('filters MoonBoard setters by a search substring', async () => {
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: 40, search: 'moon' } },
      makeCtx(),
    );

    expect(result).toEqual([{ setterUsername: 'moon-setter', climbCount: 2 }]);

    const noMatch = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: 40, search: 'nobody-sets-this' } },
      makeCtx(),
    );

    expect(noMatch).toEqual([]);
  });
});
