import { describe, it, expect, beforeEach } from 'vitest';
import type { SetterStatsInput } from '@boardsesh/shared-schema';
import { runMigrations, ensureMutationQueueTable } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getSetterStatsLocal } from '../get-setter-stats-local';

// A minimal, well-formed input; individual tests override the pieces they exercise.
function makeInput(overrides: Partial<SetterStatsInput> = {}): SetterStatsInput {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 5,
    setIds: '',
    angle: 40,
    ...overrides,
  };
}

type ClimbFixture = {
  uuid: string;
  boardType?: string;
  layoutId?: number;
  isListed?: number;
  isDraft?: number;
  /** Nullable on purpose: rows pulled before migration v5 added the column have
   *  no value, and the query must read that as visible. */
  isHidden?: number | null;
  compatibleSizeIds?: number[] | null;
  requiredSetIds?: number[] | null;
  setterUsername?: string | null;
  /** The climb's own set angle; NULL (the default) when none was recorded. */
  angle?: number | null;
};

async function insertClimb(db: TestSqliteDb, fixture: ClimbFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, is_hidden,
       compatible_size_ids, required_set_ids, setter_username, angle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.uuid,
      fixture.boardType ?? 'kilter',
      fixture.layoutId ?? 1,
      `Climb ${fixture.uuid}`,
      fixture.isListed ?? 1,
      fixture.isDraft ?? 0,
      fixture.isHidden === undefined ? 0 : fixture.isHidden,
      fixture.compatibleSizeIds === undefined
        ? '[5]'
        : fixture.compatibleSizeIds === null
          ? null
          : JSON.stringify(fixture.compatibleSizeIds),
      fixture.requiredSetIds === undefined
        ? null
        : fixture.requiredSetIds === null
          ? null
          : JSON.stringify(fixture.requiredSetIds),
      fixture.setterUsername ?? 'setter',
      fixture.angle ?? null,
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ],
  );
}

// Presence is all the setter query reads from a stats row, so the numbers are
// placeholders.
async function insertStats(db: TestSqliteDb, boardType: string, climbUuid: string, angle: number): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, benchmark_difficulty, ascensionist_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [boardType, climbUuid, angle, 16, 16, 3, 0, 1, '2026-01-01T00:00:00Z'],
  );
}

describe('getSetterStatsLocal', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
  });

  it('counts moonboard climbs with no compatible_size_ids (size predicate skipped)', async () => {
    await insertClimb(db, { uuid: 'c1', boardType: 'moonboard', compatibleSizeIds: null, setterUsername: 'moonMax' });
    await insertClimb(db, { uuid: 'c2', boardType: 'moonboard', compatibleSizeIds: null, setterUsername: 'moonMax' });

    const result = await getSetterStatsLocal(db, makeInput({ boardName: 'moonboard', sizeId: 1 }));

    expect(result).toEqual([{ setterUsername: 'moonMax', climbCount: 2 }]);
  });

  it('excludes an unlisted climb and a draft climb, each from their own setter', async () => {
    await insertClimb(db, {
      uuid: 'c1',
      boardType: 'moonboard',
      compatibleSizeIds: null,
      isListed: 0,
      setterUsername: 'unlistedSetter',
    });
    await insertClimb(db, {
      uuid: 'c2',
      boardType: 'moonboard',
      compatibleSizeIds: null,
      isDraft: 1,
      setterUsername: 'draftSetter',
    });

    const result = await getSetterStatsLocal(db, makeInput({ boardName: 'moonboard', sizeId: 1 }));

    expect(result).toEqual([]);
  });

  it('excludes a setter whose only climb does not fit the queried size (Kilter)', async () => {
    await insertClimb(db, { uuid: 'c1', compatibleSizeIds: [99], setterUsername: 'wrongSize' });

    const result = await getSetterStatsLocal(db, makeInput({ sizeId: 10 }));

    expect(result).toEqual([]);
  });

  it('excludes a setter whose only climb needs a set the board is not fitted with', async () => {
    await insertClimb(db, { uuid: 'c1', requiredSetIds: [99], setterUsername: 'wrongSet' });

    const result = await getSetterStatsLocal(db, makeInput({ setIds: '1,2,3' }));

    expect(result).toEqual([]);
  });

  it('is angle-blind on Kilter: the same setter counts the same regardless of the queried angle', async () => {
    // Set at 20° and 70° with stats only there — which on Woods would restrict
    // both away at 45°. Kilter climbs are not angle-bound, so the restriction
    // never applies, opted in or not.
    await insertClimb(db, { uuid: 'c1', setterUsername: 'kilterSetter', angle: 20 });
    await insertStats(db, 'kilter', 'c1', 20);
    await insertClimb(db, { uuid: 'c2', setterUsername: 'kilterSetter', angle: 70 });
    await insertStats(db, 'kilter', 'c2', 70);

    const atTwenty = await getSetterStatsLocal(db, makeInput({ angle: 20 }));
    const atFortyFive = await getSetterStatsLocal(db, makeInput({ angle: 45 }));
    const optedIn = await getSetterStatsLocal(db, makeInput({ angle: 45, crossAngleStats: true }));

    expect(atTwenty).toEqual([{ setterUsername: 'kilterSetter', climbCount: 2 }]);
    expect(atFortyFive).toEqual(atTwenty);
    expect(optedIn).toEqual(atTwenty);
  });

  it('is angle-blind on Kilter for climbs with no set angle recorded, too', async () => {
    await insertClimb(db, { uuid: 'c1', setterUsername: 'unangledSetter' });
    await insertClimb(db, { uuid: 'c2', setterUsername: 'unangledSetter' });

    const atTwenty = await getSetterStatsLocal(db, makeInput({ angle: 20 }));
    const atSeventy = await getSetterStatsLocal(db, makeInput({ angle: 70 }));

    expect(atTwenty).toEqual([{ setterUsername: 'unangledSetter', climbCount: 2 }]);
    expect(atSeventy).toEqual(atTwenty);
  });

  it('excludes a community-hidden climb; a NULL is_hidden (pre-v5 row) counts as visible', async () => {
    await insertClimb(db, { uuid: 'c1', isHidden: 1, setterUsername: 'hiddenSetter' });
    await insertClimb(db, { uuid: 'c2', isHidden: null, setterUsername: 'legacySetter' });

    const result = await getSetterStatsLocal(db, makeInput());

    expect(result).toEqual([{ setterUsername: 'legacySetter', climbCount: 1 }]);
  });

  it('narrows by a case-insensitive substring search; no match returns an empty list', async () => {
    await insertClimb(db, { uuid: 'c1', setterUsername: 'MoonWalker' });
    await insertClimb(db, { uuid: 'c2', setterUsername: 'otherSetter' });

    const matched = await getSetterStatsLocal(db, makeInput({ search: 'moon' }));
    const unmatched = await getSetterStatsLocal(db, makeInput({ search: 'nobody' }));

    expect(matched).toEqual([{ setterUsername: 'MoonWalker', climbCount: 1 }]);
    expect(unmatched).toEqual([]);
  });

  it('treats `%`/`_` in the search term as SQL wildcards, matching the server ILIKE unescaped', async () => {
    await insertClimb(db, { uuid: 'c1', setterUsername: 'axb' });
    await insertClimb(db, { uuid: 'c2', setterUsername: 'a_b' });

    // '_' is a single-character wildcard in both SQLite LIKE and Postgres ILIKE,
    // so an unescaped search term must match both rows, not just the literal one.
    const result = await getSetterStatsLocal(db, makeInput({ search: 'a_b' }));

    expect(result).toEqual([
      { setterUsername: 'a_b', climbCount: 1 },
      { setterUsername: 'axb', climbCount: 1 },
    ]);
  });

  it('orders by climb count descending, then setter username ascending', async () => {
    await insertClimb(db, { uuid: 'c1', setterUsername: 'zzz' });
    await insertClimb(db, { uuid: 'c2', setterUsername: 'zzz' });
    await insertClimb(db, { uuid: 'c3', setterUsername: 'aaa' });
    await insertClimb(db, { uuid: 'c4', setterUsername: 'aaa' });
    await insertClimb(db, { uuid: 'c5', setterUsername: 'bbb' });

    const result = await getSetterStatsLocal(db, makeInput());

    expect(result).toEqual([
      { setterUsername: 'aaa', climbCount: 2 },
      { setterUsername: 'zzz', climbCount: 2 },
      { setterUsername: 'bbb', climbCount: 1 },
    ]);
  });
});

// Issue #5642: on Woods the list keeps only the climbs for the browsed angle
// unless the search opts in, so the picker has to count the same climbs or it
// offers a setter whose climbs the list cannot show. Mirrors the server suite in
// packages/backend/src/__tests__/setter-stats-moonboard.test.ts.
describe('getSetterStatsLocal on Woods: the browsed-angle restriction', () => {
  let db: TestSqliteDb;
  const woodsInput = (overrides: Partial<SetterStatsInput> = {}) =>
    makeInput({ boardName: 'woods', sizeId: 1, angle: 25, ...overrides });

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);

    // The reporter's shape: a prolific setter with nothing at 25°.
    await insertClimb(db, {
      uuid: 'w20',
      boardType: 'woods',
      compatibleSizeIds: [1],
      setterUsername: 'prolific',
      angle: 20,
    });
    await insertStats(db, 'woods', 'w20', 20);
    await insertClimb(db, {
      uuid: 'w70',
      boardType: 'woods',
      compatibleSizeIds: [1],
      setterUsername: 'prolific',
      angle: 70,
    });
    await insertStats(db, 'woods', 'w70', 70);
    // Set at 40° but climbed at 25° too: the stats-here arm keeps it.
    await insertClimb(db, {
      uuid: 'w40',
      boardType: 'woods',
      compatibleSizeIds: [1],
      setterUsername: 'crossover',
      angle: 40,
    });
    await insertStats(db, 'woods', 'w40', 40);
    await insertStats(db, 'woods', 'w40', 25);
    // No set angle recorded: it belongs nowhere else, so it counts at every angle.
    await insertClimb(db, { uuid: 'wnull', boardType: 'woods', compatibleSizeIds: [1], setterUsername: 'unangled' });
  });

  it('drops a setter with no climb for the browsed angle, by default and with an explicit false', async () => {
    const expected = [
      { setterUsername: 'crossover', climbCount: 1 },
      { setterUsername: 'unangled', climbCount: 1 },
    ];

    expect(await getSetterStatsLocal(db, woodsInput())).toEqual(expected);
    expect(await getSetterStatsLocal(db, woodsInput({ crossAngleStats: false }))).toEqual(expected);
  });

  it('counts a climb set at the browsed angle, and only for that angle', async () => {
    expect(await getSetterStatsLocal(db, woodsInput({ angle: 20 }))).toEqual([
      { setterUsername: 'prolific', climbCount: 1 },
      { setterUsername: 'unangled', climbCount: 1 },
    ]);
  });

  it('counts every angle with the opt-in, one row per climb whatever it joins', async () => {
    expect(await getSetterStatsLocal(db, woodsInput({ crossAngleStats: true }))).toEqual([
      { setterUsername: 'prolific', climbCount: 2 },
      { setterUsername: 'crossover', climbCount: 1 },
      { setterUsername: 'unangled', climbCount: 1 },
    ]);
  });

  it('does not treat the setter search as a climb-name search', async () => {
    // A by-name climb search on Woods is cross-angle; a setter-username search
    // is not a name search, so the restriction still holds.
    expect(await getSetterStatsLocal(db, woodsInput({ search: 'prol' }))).toEqual([]);
    expect(await getSetterStatsLocal(db, woodsInput({ search: 'prol', crossAngleStats: true }))).toEqual([
      { setterUsername: 'prolific', climbCount: 2 },
    ]);
  });
});
