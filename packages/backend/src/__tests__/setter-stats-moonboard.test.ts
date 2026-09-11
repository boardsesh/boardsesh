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
//
// It also covers #5404: the query used to INNER JOIN board_climb_stats at the
// requested angle, so a setter vanished from the picker unless one of their
// climbs carried a stats row at exactly the board's tilt. The suite now asserts
// the aggregate is angle-blind on every board, and that the is_listed / is_draft
// / required_set_ids guards that the dropped join was implicitly providing are
// enforced on their own.

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

type SeedClimbOptions = {
  boardType: string;
  uuid: string;
  name: string;
  setter: string;
  /** Raw SQL for compatible_size_ids — 'NULL' for MoonBoard, which never populates it. */
  sizeIdsSql: string;
  /** Raw SQL for required_set_ids. Defaults to set 1, the sets every test board is fitted with. */
  requiredSetIdsSql?: string;
  isListed?: boolean;
  isDraft?: boolean;
};

async function seedClimb({
  boardType,
  uuid,
  name,
  setter,
  sizeIdsSql,
  requiredSetIdsSql = 'ARRAY[1]::integer[]',
  isListed = true,
  isDraft = false,
}: SeedClimbOptions) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, compatible_size_ids, required_set_ids)
    VALUES (${uuid}, ${boardType}, 1, ${setter}, ${name}, '', 'p1r1', ${isListed}, ${isDraft}, ${sql.raw(sizeIdsSql)}, ${sql.raw(requiredSetIdsSql)})
  `);
}

async function seedStats(boardType: string, uuid: string, angle: number, displayDifficulty: number, ascents: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, ${displayDifficulty}, ${displayDifficulty}, 3.0, ${ascents}, 0)
  `);
}

const SEEDED_UUIDS = [
  'moon-setter-climb-1',
  'moon-setter-climb-2',
  'moon-unlisted-climb',
  'moon-draft-climb',
  'kilter-sized-setter-climb',
  'kilter-other-size-setter-climb',
  'kilter-other-set-climb',
  'woods-angle-20-climb',
  'woods-angle-70-climb',
];

describe('setterStats — size filter skips MoonBoard, still applies to Aurora boards (real DB)', () => {
  beforeAll(async () => {
    // MoonBoard climbs: compatible_size_ids stays NULL, as in production —
    // populate-denormalized-columns skips the size-edges step for moonboard.
    await seedClimb({
      boardType: 'moonboard',
      uuid: 'moon-setter-climb-1',
      name: 'Moon one',
      setter: 'moon-setter',
      sizeIdsSql: 'NULL',
    });
    await seedStats('moonboard', 'moon-setter-climb-1', 40, 20, 50);
    await seedClimb({
      boardType: 'moonboard',
      uuid: 'moon-setter-climb-2',
      name: 'Moon two',
      setter: 'moon-setter',
      sizeIdsSql: 'NULL',
    });
    await seedStats('moonboard', 'moon-setter-climb-2', 40, 22, 30);

    // MoonBoard skips the size predicate entirely, so is_listed / is_draft are the
    // only things keeping these two out of the picker (#5404). Both carry stats
    // rows, so they'd have leaked under the old angle join too.
    await seedClimb({
      boardType: 'moonboard',
      uuid: 'moon-unlisted-climb',
      name: 'Moon unlisted',
      setter: 'moon-unlisted-setter',
      sizeIdsSql: 'NULL',
      isListed: false,
    });
    await seedStats('moonboard', 'moon-unlisted-climb', 40, 20, 5);
    await seedClimb({
      boardType: 'moonboard',
      uuid: 'moon-draft-climb',
      name: 'Moon draft',
      setter: 'moon-draft-setter',
      sizeIdsSql: 'NULL',
      isDraft: true,
    });

    // Kilter climbs: one compatible with size 10, one only with size 99 — the
    // size filter must still apply to size-scoped boards.
    await seedClimb({
      boardType: 'kilter',
      uuid: 'kilter-sized-setter-climb',
      name: 'Fits size 10',
      setter: 'kilter-sized-setter',
      sizeIdsSql: 'ARRAY[10]::integer[]',
    });
    await seedStats('kilter', 'kilter-sized-setter-climb', 40, 18, 100);
    await seedClimb({
      boardType: 'kilter',
      uuid: 'kilter-other-size-setter-climb',
      name: 'Fits size 99 only',
      setter: 'kilter-other-size-setter',
      sizeIdsSql: 'ARRAY[99]::integer[]',
    });
    await seedStats('kilter', 'kilter-other-size-setter-climb', 40, 19, 80);
    // Needs a set the board isn't fitted with — the climb list drops it, so the
    // picker must not offer its setter either.
    await seedClimb({
      boardType: 'kilter',
      uuid: 'kilter-other-set-climb',
      name: 'Needs set 99',
      setter: 'kilter-other-set-setter',
      sizeIdsSql: 'ARRAY[10]::integer[]',
      requiredSetIdsSql: 'ARRAY[99]::integer[]',
    });
    await seedStats('kilter', 'kilter-other-set-climb', 40, 19, 70);

    // Woods, the board that surfaced #5404: each climb carries exactly one stats
    // row, at the angle it was set at. Neither of these is at 25°.
    await seedClimb({
      boardType: 'woods',
      uuid: 'woods-angle-20-climb',
      name: 'Woods at twenty',
      setter: 'woods-setter',
      sizeIdsSql: 'ARRAY[1]::integer[]',
    });
    await seedStats('woods', 'woods-angle-20-climb', 20, 16, 3);
    await seedClimb({
      boardType: 'woods',
      uuid: 'woods-angle-70-climb',
      name: 'Woods at seventy',
      setter: 'woods-setter',
      sizeIdsSql: 'ARRAY[1]::integer[]',
    });
    await seedStats('woods', 'woods-angle-70-climb', 70, 24, 1);
  });

  afterAll(async () => {
    const seededUuidList = sql.join(
      SEEDED_UUIDS.map((uuid) => sql`${uuid}`),
      sql`, `,
    );
    await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid IN (${seededUuidList})`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid IN (${seededUuidList})`);
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

  it('excludes a setter whose only climb needs a set the board is not fitted with', async () => {
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    expect(result.map((setter) => setter.setterUsername)).not.toContain('kilter-other-set-setter');
  });

  it('offers unlisted climbs and drafts to nobody, now that the stats join no longer hides them', async () => {
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } },
      makeCtx(),
    );

    const setterNames = result.map((setter) => setter.setterUsername);
    expect(setterNames).not.toContain('moon-unlisted-setter');
    expect(setterNames).not.toContain('moon-draft-setter');
  });

  it('returns a Woods setter at an angle none of their climbs was set at (#5404)', async () => {
    // The reporter's case: both climbs sit at 20° and 70°, the board is at 25°.
    // The old angle-scoped inner join returned nothing here.
    const result = await climbQueries.setterStats(
      null,
      { input: { boardName: 'woods', layoutId: 1, sizeId: 1, setIds: '1', angle: 25 } },
      makeCtx(),
    );

    expect(result).toEqual([{ setterUsername: 'woods-setter', climbCount: 2 }]);
  });

  it('returns the same setters at every angle, including a negative tilt (#5404)', async () => {
    // Mobile's setter filter sends the live board angle. Aurora boards support
    // negative tilt, and the angle must change nothing about who is offered.
    const atFortyDegrees = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 } },
      makeCtx(),
    );
    const atNegativeFive = await climbQueries.setterStats(
      null,
      { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: -5 } },
      makeCtx(),
    );

    expect(atNegativeFive).toEqual(atFortyDegrees);
    expect(atNegativeFive).toEqual([{ setterUsername: 'moon-setter', climbCount: 2 }]);
  });

  it('rejects angle -91 (outside the -90..90 board-tilt range)', async () => {
    await expect(
      climbQueries.setterStats(
        null,
        { input: { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', angle: -91 } },
        makeCtx(),
      ),
    ).rejects.toThrow();
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
