import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import type { MoonBoardExportLogRow, StrippedMoonBoardExportData } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  importMoonBoardExportData,
  lossyNamePattern,
  moonBoardGradeToDifficultyId,
  moonBoardLayoutIdForSetup,
  pickClimbByName,
  type MoonBoardNameCandidate,
} from '../services/moonboard-import';

const TEST_USER_ID = 'moonboard-import-test-user';
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const SIX_A_PLUS_DIFFICULTY_ID = 17;
const SIX_B_DIFFICULTY_ID = 18;

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

describe('MoonBoard CSV grade mapping', () => {
  it('maps 8C/8C+ case-insensitively and leaves unknown future grades unresolved', () => {
    expect(moonBoardGradeToDifficultyId('8C')).toBe(32);
    expect(moonBoardGradeToDifficultyId('8c')).toBe(32);
    expect(moonBoardGradeToDifficultyId('8C+')).toBe(33);
    expect(moonBoardGradeToDifficultyId('8c+')).toBe(33);
    expect(moonBoardGradeToDifficultyId('9A')).toBeUndefined();
  });

  it('maps the bare "5" grade Moon uses on 25° 2024 problems to 5+', () => {
    expect(moonBoardGradeToDifficultyId('5')).toBe(13);
  });
});

describe('MoonBoard CSV setup mapping', () => {
  it('maps Moon setup names to layout ids regardless of case and spacing', () => {
    expect(moonBoardLayoutIdForSetup('MoonBoard 2016')).toBe(2);
    expect(moonBoardLayoutIdForSetup('moonboard  2024')).toBe(3);
    expect(moonBoardLayoutIdForSetup('MoonBoard Masters 2017')).toBe(4);
    expect(moonBoardLayoutIdForSetup('MoonBoard 2030')).toBeUndefined();
  });
});

describe('pickClimbByName', () => {
  const candidate = (overrides: Partial<MoonBoardNameCandidate> & { climbUuid: string }): MoonBoardNameCandidate => ({
    exactName: true,
    setter: 'Ben Moon',
    difficultyId: SIX_A_PLUS_DIFFICULTY_ID,
    ...overrides,
  });

  it('prefers name + setter + grade when the setter tells same-grade climbs apart', () => {
    const candidates = [
      candidate({ climbUuid: 'by-ben' }),
      candidate({ climbUuid: 'by-jerry', setter: 'Jerry Moffatt' }),
    ];

    expect(pickClimbByName(candidates, { setter: 'jerry moffatt', difficultyId: SIX_A_PLUS_DIFFICULTY_ID })).toEqual({
      climbUuid: 'by-jerry',
      method: 'nameSetterGrade',
    });
  });

  it('falls back to name + grade when the export has no setter', () => {
    const candidates = [
      candidate({ climbUuid: 'six-a-plus' }),
      candidate({ climbUuid: 'six-b', difficultyId: SIX_B_DIFFICULTY_ID }),
    ];

    expect(pickClimbByName(candidates, { difficultyId: SIX_B_DIFFICULTY_ID })).toEqual({
      climbUuid: 'six-b',
      method: 'nameGrade',
    });
  });

  it('accepts a lone name match even when the grade has drifted', () => {
    expect(pickClimbByName([candidate({ climbUuid: 'only-one' })], { difficultyId: SIX_B_DIFFICULTY_ID })).toEqual({
      climbUuid: 'only-one',
      method: 'name',
    });
  });

  it('leaves the row unresolved when no strategy narrows it to one climb', () => {
    const candidates = [candidate({ climbUuid: 'first' }), candidate({ climbUuid: 'second' })];

    expect(pickClimbByName(candidates, { difficultyId: SIX_A_PLUS_DIFFICULTY_ID })).toBeNull();
    expect(pickClimbByName([], { difficultyId: SIX_A_PLUS_DIFFICULTY_ID })).toBeNull();
  });

  it('never trusts a wildcard name match without the grade', () => {
    const candidates = [candidate({ climbUuid: 'wu-kadai', exactName: false })];

    expect(pickClimbByName(candidates, { difficultyId: SIX_B_DIFFICULTY_ID })).toBeNull();
    expect(pickClimbByName(candidates, { difficultyId: SIX_A_PLUS_DIFFICULTY_ID })).toEqual({
      climbUuid: 'wu-kadai',
      method: 'nameGrade',
    });
  });
});

describe('lossyNamePattern', () => {
  it('turns each "?" into a one-character wildcard and escapes LIKE metacharacters', () => {
    expect(lossyNamePattern('??? -kami hitoe-')).toBe('___ -kami hitoe-');
    expect(lossyNamePattern('100%_send ?')).toBe('100\\%\\_send _');
  });

  it('skips names without "?" or with too little left to match on', () => {
    expect(lossyNamePattern('wuthering heights')).toBeNull();
    expect(lossyNamePattern('????')).toBeNull();
    expect(lossyNamePattern('a ?')).toBeNull();
  });
});

type ImportedTickRow = {
  climb_uuid: string;
  status: string;
  attempt_count: number | string;
  climbed_on: string;
};

function moonBoardCandidateUuid(problemId: number): string {
  return uuidv5(`moonboard:${problemId}`, UUID_NAMESPACE);
}

function moonBoardLogRow(input: {
  lineNumber: number;
  problemId: number;
  grade?: string;
  tries: string;
  attempts?: number;
  rating?: number | null;
  date?: string;
}): MoonBoardExportLogRow {
  return {
    lineNumber: input.lineNumber,
    problemId: input.problemId,
    grade: input.grade ?? '6A+',
    tries: input.tries,
    attempts: input.attempts ?? 0,
    rating: 'rating' in input ? (input.rating ?? null) : 4,
    date: input.date ?? '13/02/26',
  };
}

function moonBoardImportData(logs: MoonBoardExportLogRow[]): StrippedMoonBoardExportData {
  return {
    user: { username: 'moonboard-import-test' },
    logs,
  };
}

async function insertMoonBoardClimb(input: {
  problemId: number;
  difficultyId?: number;
  canonicalUuid?: string;
}): Promise<string> {
  const climbUuid = input.canonicalUuid ?? moonBoardCandidateUuid(input.problemId);
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle)
    VALUES (${climbUuid}, 'moonboard', 2, ${'MoonBoard import fixture ' + input.problemId}, 40)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
    VALUES ('moonboard', ${climbUuid}, 40, ${input.difficultyId ?? SIX_A_PLUS_DIFFICULTY_ID})
  `);
  return climbUuid;
}

async function insertMoonBoardAlias(problemId: number, canonicalUuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
    VALUES ('moonboard', ${moonBoardCandidateUuid(problemId)}, ${canonicalUuid}, 'moonboard-import-test')
  `);
}

// The 2024-board fix: the catalog importer merges each problem onto its
// pre-existing legacy (name-based) climb and records an alias keyed off the
// stable problem-id UUID `moonboard:{id}:40` (the resolver's angle-suffixed
// candidate), so the climb is addressable by problem id.
async function insertMoonBoardAngleAlias(problemId: number, canonicalUuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
    VALUES ('moonboard', ${uuidv5(`moonboard:${problemId}:40`, UUID_NAMESPACE)}, ${canonicalUuid}, 'moonboard-catalog-import')
  `);
}

async function insertNamedMoonBoardClimb(input: {
  uuid: string;
  name: string;
  layoutId: number;
  angle: number;
  setter?: string;
  difficultyId?: number;
}): Promise<string> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, setter_username)
    VALUES (${input.uuid}, 'moonboard', ${input.layoutId}, ${input.name}, ${input.angle}, ${input.setter ?? null})
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
    VALUES ('moonboard', ${input.uuid}, ${input.angle}, ${input.difficultyId ?? SIX_A_PLUS_DIFFICULTY_ID})
  `);
  return input.uuid;
}

function namedLogRow(input: {
  lineNumber: number;
  name: string;
  setup: string;
  angle: number;
  grade?: string;
  setter?: string;
}): MoonBoardExportLogRow {
  return {
    lineNumber: input.lineNumber,
    name: input.name,
    setup: input.setup,
    angle: input.angle,
    ...(input.setter ? { setter: input.setter } : {}),
    grade: input.grade ?? '6A+',
    tries: 'Flashed',
    attempts: 0,
    rating: 4,
    date: '13/02/26',
  };
}

async function importedTicks(): Promise<ImportedTickRow[]> {
  return (await db.execute(sql`
    SELECT
      climb_uuid,
      status,
      attempt_count,
      to_char(climbed_at::date, 'YYYY-MM-DD') AS climbed_on
    FROM boardsesh_ticks
    WHERE user_id = ${TEST_USER_ID}
    ORDER BY climbed_at, status, attempt_count
  `)) as unknown as ImportedTickRow[];
}

describeWithDatabase('importMoonBoardExportData', () => {
  beforeEach(async () => {
    await db.execute(sql`
      TRUNCATE TABLE boardsesh_ticks, board_climb_aliases, board_climb_stats, board_climbs, users
      RESTART IDENTITY CASCADE
    `);
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${TEST_USER_ID}, 'moonboard-import@test.boardsesh.com', 'MoonBoard Import Test', now(), now())
    `);
  });

  it('skips existing MoonBoard ticks on the same calendar day even when the time differs', async () => {
    const climbUuid = await insertMoonBoardClimb({ problemId: 101 });
    await db.execute(sql`
      INSERT INTO boardsesh_ticks (
        uuid,
        user_id,
        board_type,
        climb_uuid,
        angle,
        origin,
        status,
        attempt_count,
        quality,
        difficulty,
        climbed_at
      )
      VALUES (
        'moonboard-import-existing-same-day',
        ${TEST_USER_ID},
        'moonboard',
        ${climbUuid},
        40,
        'native',
        'send',
        2,
        4,
        ${SIX_A_PLUS_DIFFICULTY_ID},
        '2026-02-13 09:06:00'
      )
    `);

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([moonBoardLogRow({ lineNumber: 1, problemId: 101, tries: 'Flashed' })]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(await importedTicks()).toHaveLength(1);
  });

  it('imports distinct project and send rows for the same climb on the same CSV date', async () => {
    const climbUuid = await insertMoonBoardClimb({ problemId: 102 });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([
        moonBoardLogRow({ lineNumber: 1, problemId: 102, tries: 'Project', attempts: 3, rating: null }),
        moonBoardLogRow({ lineNumber: 2, problemId: 102, tries: 'Flashed' }),
      ]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 2, skipped: 0, failed: 0 });
    expect(result.ascents).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(result.attempts).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(await importedTicks()).toEqual([
      { climb_uuid: climbUuid, status: 'flash', attempt_count: 1, climbed_on: '2026-02-13' },
      { climb_uuid: climbUuid, status: 'attempt', attempt_count: 3, climbed_on: '2026-02-13' },
    ]);
  });

  it('resolves aliases to canonical climbs and rejects grade mismatches', async () => {
    const canonicalUuid = 'moonboard-import-canonical-103';
    await insertMoonBoardClimb({
      problemId: 103,
      canonicalUuid,
      difficultyId: SIX_A_PLUS_DIFFICULTY_ID,
    });
    await insertMoonBoardAlias(103, canonicalUuid);
    await insertMoonBoardClimb({ problemId: 104, difficultyId: SIX_B_DIFFICULTY_ID });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([
        moonBoardLogRow({ lineNumber: 1, problemId: 103, tries: 'Flashed' }),
        moonBoardLogRow({ lineNumber: 2, problemId: 104, tries: 'Flashed' }),
      ]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 1, skipped: 0, failed: 1 });
    expect(result.ascents).toEqual({ imported: 1, skipped: 0, failed: 1 });
    expect(result.unresolvedClimbs).toEqual(['104']);
    expect(await importedTicks()).toEqual([
      { climb_uuid: canonicalUuid, status: 'flash', attempt_count: 1, climbed_on: '2026-02-13' },
    ]);
  });

  it('resolves a legacy (name-based) 2024 climb via its moonboard:{id}:40 alias', async () => {
    // A MoonBoard 2024 climb whose canonical UUID has no problem id in it (seeded
    // under the name+setter+frames scheme). Before the importer wrote the
    // angle-suffixed alias, neither `moonboard:{id}` nor `moonboard:{id}:40`
    // reached it, so every 2024 tick dropped as "unknown problem".
    const canonicalUuid = 'moonboard-2024-legacy-name-based-uuid';
    await insertMoonBoardClimb({ problemId: 509834, canonicalUuid });
    await insertMoonBoardAngleAlias(509834, canonicalUuid);

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([moonBoardLogRow({ lineNumber: 1, problemId: 509834, tries: 'Flashed' })]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(result.unresolvedClimbs).toEqual([]);
    expect(await importedTicks()).toEqual([
      { climb_uuid: canonicalUuid, status: 'flash', attempt_count: 1, climbed_on: '2026-02-13' },
    ]);
  });

  it('matches name-only rows within their setup and angle, and saves the tick at that angle', async () => {
    const at25 = await insertNamedMoonBoardClimb({
      uuid: 'named-2016-25',
      name: 'Wuthering Heights',
      layoutId: 2,
      angle: 25,
    });
    await insertNamedMoonBoardClimb({ uuid: 'named-2016-40', name: 'Wuthering Heights', layoutId: 2, angle: 40 });
    await insertNamedMoonBoardClimb({ uuid: 'named-masters-25', name: 'Wuthering Heights', layoutId: 4, angle: 25 });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([
        namedLogRow({ lineNumber: 2, name: 'WUTHERING  heights', setup: 'MoonBoard 2016', angle: 25 }),
      ]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(result.matchedBy).toEqual({ id: 0, nameSetterGrade: 0, nameGrade: 1, name: 0 });
    const ticks = (await db.execute(sql`
      SELECT climb_uuid, angle FROM boardsesh_ticks WHERE user_id = ${TEST_USER_ID}
    `)) as unknown as { climb_uuid: string; angle: number }[];
    expect(ticks).toEqual([{ climb_uuid: at25, angle: 25 }]);
  });

  it('uses the setter to pick between same-name, same-grade climbs', async () => {
    await insertNamedMoonBoardClimb({
      uuid: 'monkeys-a',
      name: '12 Monkeys',
      layoutId: 2,
      angle: 40,
      setter: 'Kyle Knapp',
    });
    const bySecondSetter = await insertNamedMoonBoardClimb({
      uuid: 'monkeys-b',
      name: '12 Monkeys',
      layoutId: 2,
      angle: 40,
      setter: 'Ben Moon',
    });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([
        namedLogRow({ lineNumber: 2, name: '12 Monkeys', setup: 'MoonBoard 2016', angle: 40, setter: 'ben moon' }),
        namedLogRow({ lineNumber: 3, name: '12 Monkeys', setup: 'MoonBoard 2016', angle: 40 }),
      ]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 1, skipped: 0, failed: 1 });
    expect(result.matchedBy?.nameSetterGrade).toBe(1);
    expect(result.unresolvedClimbs).toEqual(['12 Monkeys']);
    expect((await importedTicks()).map((tick) => tick.climb_uuid)).toEqual([bySecondSetter]);
  });

  it('matches names whose non-Latin characters the export replaced with "?"', async () => {
    const kamiHitoe = await insertNamedMoonBoardClimb({
      uuid: 'kami-hitoe',
      name: '紙一重 -KAMI HITOE-',
      layoutId: 2,
      angle: 40,
    });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([
        namedLogRow({ lineNumber: 2, name: '??? -KAMI HITOE-', setup: 'MoonBoard 2016', angle: 40 }),
      ]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect((await importedTicks()).map((tick) => tick.climb_uuid)).toEqual([kamiHitoe]);
  });

  it('fails name-only rows from an unknown setup instead of guessing a layout', async () => {
    await insertNamedMoonBoardClimb({ uuid: 'named-2016', name: 'Klingon Easy', layoutId: 2, angle: 40 });

    const result = await importMoonBoardExportData(
      db,
      TEST_USER_ID,
      moonBoardImportData([namedLogRow({ lineNumber: 2, name: 'Klingon Easy', setup: 'MoonBoard 2099', angle: 40 })]),
      () => {},
    );

    expect(result.ticks).toEqual({ imported: 0, skipped: 0, failed: 1 });
    expect(result.unresolvedClimbs).toEqual(['Klingon Easy']);
  });
});
