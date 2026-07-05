import { describe, it, expect, beforeEach } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { runMigrations } from '../../migrations';
import { ensureMutationQueueTable } from '../../../mutation-queue/schema';
import { createTestDatabase, type TestSqliteDb } from '../../__tests__/sqlite-test-db';
import { searchClimbsLocal, countClimbsLocal, isOfflineSearchSupported } from '../search-climbs-local';

// A minimal, well-formed search input; individual tests override the pieces they exercise.
function makeInput(overrides: Partial<ClimbSearchInput> = {}): ClimbSearchInput {
  return {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 5,
    setIds: '',
    angle: 40,
    page: 0,
    pageSize: 20,
    sortBy: 'ascents',
    sortOrder: 'desc',
    ...overrides,
  } as ClimbSearchInput;
}

type ClimbFixture = {
  uuid: string;
  boardType?: string;
  layoutId?: number;
  name?: string;
  isListed?: number;
  isDraft?: number;
  framesCount?: number | null;
  frames?: string;
  compatibleSizeIds?: number[] | null;
  requiredSetIds?: number[] | null;
  characteristics?: string[] | null;
  setterUsername?: string | null;
  createdAt?: string | null;
};

type StatFixture = {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  displayDifficulty?: number | null;
  difficultyAverage?: number | null;
  qualityAverage?: number | null;
  benchmarkDifficulty?: number | null;
  ascensionistCount?: number | null;
};

async function insertClimb(db: TestSqliteDb, fixture: ClimbFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, frames_count, frames,
       compatible_size_ids, required_set_ids, characteristics, setter_username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.uuid,
      fixture.boardType ?? 'kilter',
      fixture.layoutId ?? 1,
      fixture.name ?? `Climb ${fixture.uuid}`,
      fixture.isListed ?? 1,
      fixture.isDraft ?? 0,
      fixture.framesCount ?? 1,
      fixture.frames ?? '',
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
      fixture.characteristics === undefined || fixture.characteristics === null
        ? null
        : JSON.stringify(fixture.characteristics),
      fixture.setterUsername ?? 'setter',
      fixture.createdAt ?? '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ],
  );
}

async function insertStat(db: TestSqliteDb, fixture: StatFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_stats
      (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, benchmark_difficulty, ascensionist_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.boardType ?? 'kilter',
      fixture.climbUuid,
      fixture.angle ?? 40,
      fixture.displayDifficulty ?? null,
      fixture.difficultyAverage ?? null,
      fixture.qualityAverage ?? null,
      fixture.benchmarkDifficulty ?? null,
      fixture.ascensionistCount ?? null,
      '2026-01-01T00:00:00Z',
    ],
  );
}

async function insertTick(
  db: TestSqliteDb,
  opts: { uuid: string; climbUuid: string; boardType?: string; angle?: number; status: string },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, is_benchmark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, 0, ?, ?)`,
    [
      opts.uuid,
      'me',
      opts.boardType ?? 'kilter',
      opts.climbUuid,
      opts.angle ?? 40,
      opts.status,
      '2026-02-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
    ],
  );
}

const uuids = (result: { climbs: { uuid: string }[] }) => result.climbs.map((c) => c.uuid);

describe('searchClimbsLocal', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
  });

  it('scopes to board + layout, only listed non-drafts', async () => {
    await insertClimb(db, { uuid: 'a' });
    await insertClimb(db, { uuid: 'wrong-layout', layoutId: 2 });
    await insertClimb(db, { uuid: 'wrong-board', boardType: 'tension' });
    await insertClimb(db, { uuid: 'unlisted', isListed: 0 });
    await insertClimb(db, { uuid: 'draft', isDraft: 1 });

    const result = await searchClimbsLocal(db, makeInput());
    expect(uuids(result)).toEqual(['a']);
    expect(result.hasMore).toBe(false);
    expect(await countClimbsLocal(db, makeInput())).toBe(1);
  });

  it('filters by size via compatible_size_ids (contains), excluding NULL', async () => {
    await insertClimb(db, { uuid: 'fits', compatibleSizeIds: [5, 6] });
    await insertClimb(db, { uuid: 'other-size', compatibleSizeIds: [7] });
    await insertClimb(db, { uuid: 'null-sizes', compatibleSizeIds: null });

    const result = await searchClimbsLocal(db, makeInput({ sizeId: 5 }));
    expect(uuids(result)).toEqual(['fits']);
  });

  it('skips the size filter for moonboard and allows NULL required sets', async () => {
    await insertClimb(db, { uuid: 'm-null', boardType: 'moonboard', compatibleSizeIds: null, requiredSetIds: null });
    await insertClimb(db, { uuid: 'm-any', boardType: 'moonboard', compatibleSizeIds: [99], requiredSetIds: [1] });

    const result = await searchClimbsLocal(db, makeInput({ boardName: 'moonboard', sizeId: 5, setIds: '1,2' }));
    expect(uuids(result).sort()).toEqual(['m-any', 'm-null']);
  });

  it('applies set-subset semantics with the NULL trap (non-draft NULL excluded)', async () => {
    await insertClimb(db, { uuid: 'subset', requiredSetIds: [1] }); // ⊆ {1,2}
    await insertClimb(db, { uuid: 'exact', requiredSetIds: [1, 2] }); // ⊆ {1,2}
    await insertClimb(db, { uuid: 'superset', requiredSetIds: [1, 3] }); // 3 ∉ {1,2}
    await insertClimb(db, { uuid: 'empty', requiredSetIds: [] }); // ⊆ anything
    await insertClimb(db, { uuid: 'null-sets', requiredSetIds: null }); // excluded (non-draft)

    const result = await searchClimbsLocal(db, makeInput({ setIds: '1,2' }));
    expect(uuids(result).sort()).toEqual(['empty', 'exact', 'subset']);
  });

  it('filters by rounded grade range', async () => {
    await insertClimb(db, { uuid: 'v3' });
    await insertClimb(db, { uuid: 'v5' });
    await insertClimb(db, { uuid: 'v8' });
    await insertStat(db, { climbUuid: 'v3', displayDifficulty: 16.4, ascensionistCount: 1 }); // rounds to 16
    await insertStat(db, { climbUuid: 'v5', displayDifficulty: 20.5, ascensionistCount: 1 }); // rounds to 21
    await insertStat(db, { climbUuid: 'v8', displayDifficulty: 24.0, ascensionistCount: 1 }); // 24

    const result = await searchClimbsLocal(db, makeInput({ minGrade: 16, maxGrade: 21 }));
    expect(uuids(result).sort()).toEqual(['v3', 'v5']);
  });

  it('orders by ascents desc with a uuid tiebreak and pages with hasMore', async () => {
    await insertClimb(db, { uuid: 'a' });
    await insertClimb(db, { uuid: 'b' });
    await insertClimb(db, { uuid: 'c' });
    await insertStat(db, { climbUuid: 'a', ascensionistCount: 100 });
    await insertStat(db, { climbUuid: 'b', ascensionistCount: 50 });
    await insertStat(db, { climbUuid: 'c', ascensionistCount: 50 });

    const page0 = await searchClimbsLocal(db, makeInput({ pageSize: 2 }));
    // a (100) first; then b/c tie at 50 broken by uuid DESC → c before b.
    expect(uuids(page0)).toEqual(['a', 'c']);
    expect(page0.hasMore).toBe(true);

    const page1 = await searchClimbsLocal(db, makeInput({ pageSize: 2, page: 1 }));
    expect(uuids(page1)).toEqual(['b']);
    expect(page1.hasMore).toBe(false);
  });

  it('supports name (case-insensitive), quality sort, and present-hold filters', async () => {
    await insertClimb(db, { uuid: 'crimpy', name: 'Crimpy Line', frames: 'p11r15p22r12' });
    await insertClimb(db, { uuid: 'juggy', name: 'JUGGY roof', frames: 'p33r15' });
    await insertStat(db, { climbUuid: 'crimpy', qualityAverage: 3.0, ascensionistCount: 5 });
    await insertStat(db, { climbUuid: 'juggy', qualityAverage: 4.9, ascensionistCount: 5 });

    expect(uuids(await searchClimbsLocal(db, makeInput({ name: 'crimp' })))).toEqual(['crimpy']);
    expect(uuids(await searchClimbsLocal(db, makeInput({ sortBy: 'quality' })))).toEqual(['juggy', 'crimpy']);
    expect(uuids(await searchClimbsLocal(db, makeInput({ holdsFilter: { hold_22: { ANY: 'include' } } })))).toEqual([
      'crimpy',
    ]);
  });

  it('applies personal-progress filters against local ticks and surfaces user counts', async () => {
    await insertClimb(db, { uuid: 'sent' });
    await insertClimb(db, { uuid: 'tried' });
    await insertClimb(db, { uuid: 'fresh' });
    await insertStat(db, { climbUuid: 'sent', ascensionistCount: 3 });
    await insertStat(db, { climbUuid: 'tried', ascensionistCount: 3 });
    await insertStat(db, { climbUuid: 'fresh', ascensionistCount: 3 });
    await insertTick(db, { uuid: 't1', climbUuid: 'sent', status: 'send' });
    await insertTick(db, { uuid: 't2', climbUuid: 'tried', status: 'attempt' });

    expect(uuids(await searchClimbsLocal(db, makeInput({ hideCompleted: true })))).toEqual(
      expect.arrayContaining(['tried', 'fresh']),
    );
    expect(uuids(await searchClimbsLocal(db, makeInput({ hideCompleted: true })))).not.toContain('sent');
    expect(uuids(await searchClimbsLocal(db, makeInput({ showOnlyAttempted: true })))).toEqual(['tried']);

    const withCounts = await searchClimbsLocal(db, makeInput());
    const sent = withCounts.climbs.find((c) => c.uuid === 'sent');
    expect(sent?.userAscents).toBe(1);
    expect(sent?.userAttempts).toBe(0);
  });

  it('maps difficulty label, stars, and is_no_match from local columns', async () => {
    await insertClimb(db, { uuid: 'x', characteristics: ['no_match'] });
    await insertStat(db, {
      climbUuid: 'x',
      displayDifficulty: 16.0,
      difficultyAverage: 16.3,
      qualityAverage: 4.4,
      ascensionistCount: 10,
    });

    const [climb] = (await searchClimbsLocal(db, makeInput())).climbs;
    expect(climb.difficulty).toBe('6a/V3'); // grade id 16
    expect(climb.stars).toBe(4);
    expect(climb.is_no_match).toBe(true);
    expect(climb.boardType).toBe('kilter');
    expect(climb.angle).toBe(40);
  });
});

describe('isOfflineSearchSupported', () => {
  it('supports the core filters', () => {
    expect(isOfflineSearchSupported(makeInput({ minGrade: 16, name: 'x', boulders: true }))).toBe(true);
    expect(isOfflineSearchSupported(makeInput({ holdsFilter: { hold_5: { ANY: 'include' } } }))).toBe(true);
  });

  it('falls back for filters that need un-synced tables or the drafts path', () => {
    expect(isOfflineSearchSupported(makeInput({ onlyDrafts: true }))).toBe(false);
    expect(isOfflineSearchSupported(makeInput({ onlyWithBetaVideos: true }))).toBe(false);
    expect(isOfflineSearchSupported(makeInput({ onlyTallClimbs: true }))).toBe(false);
    expect(
      isOfflineSearchSupported(makeInput({ zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 } })),
    ).toBe(false);
    expect(isOfflineSearchSupported(makeInput({ holdsFilter: { hold_5: { STARTING: 'include' } } }))).toBe(false);
  });
});
