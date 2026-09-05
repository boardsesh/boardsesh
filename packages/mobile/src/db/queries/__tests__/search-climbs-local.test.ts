import { describe, it, expect, beforeEach } from 'vitest';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { runMigrations } from '@boardsesh/offline-sync';
import { ensureMutationQueueTable, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { canAddClimbToBoard, type BoardCompatibilityTarget } from '@boardsesh/board-config';
import {
  searchClimbsLocal,
  countClimbsLocal,
  isOfflineSearchSupported,
  parseCompatibleSizeIds,
} from '../search-climbs-local';

// The climber whose rows this device holds — written into sync_meta by the
// offline-sync bridge on sign-in, and the value every tick predicate binds.
const LOCAL_OWNER = 'me';

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
  /** Nullable on purpose: rows pulled before migration v5 added the column have
   *  no value, and the search must read that as visible. */
  isHidden?: number | null;
  framesCount?: number | null;
  frames?: string;
  compatibleSizeIds?: number[] | null;
  requiredSetIds?: number[] | null;
  characteristics?: string[] | null;
  setterUsername?: string | null;
  createdAt?: string | null;
  description?: string | null;
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
      (uuid, board_type, layout_id, name, description, is_listed, is_draft, is_hidden, frames_count, frames,
       compatible_size_ids, required_set_ids, characteristics, setter_username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.uuid,
      fixture.boardType ?? 'kilter',
      fixture.layoutId ?? 1,
      fixture.name ?? `Climb ${fixture.uuid}`,
      fixture.description ?? null,
      fixture.isListed ?? 1,
      fixture.isDraft ?? 0,
      fixture.isHidden === undefined ? 0 : fixture.isHidden,
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

type GradeFixture = {
  climbUuid: string;
  boardType?: string;
  angle?: number;
  localGrade?: number | null;
  universalGrade?: number | null;
  gradeLow?: number | null;
  gradeHigh?: number | null;
  confidence?: string | null;
  ascensionistCount?: number | null;
};

async function insertGrade(db: TestSqliteDb, fixture: GradeFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at, sync_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.boardType ?? 'kilter',
      fixture.climbUuid,
      fixture.angle ?? 40,
      fixture.localGrade ?? null,
      fixture.universalGrade ?? null,
      fixture.gradeLow ?? null,
      fixture.gradeHigh ?? null,
      fixture.confidence ?? 'confirmed',
      fixture.ascensionistCount ?? null,
      '2026-01-01T00:00:00Z',
      1,
    ],
  );
}

async function insertTick(
  db: TestSqliteDb,
  opts: {
    uuid: string;
    climbUuid: string;
    boardType?: string;
    angle?: number;
    status: string;
    // Star rating and when it was given — the personal-rating filter reads both
    // (latest rating wins).
    quality?: number | null;
    // The climber's own grade for the climb, on the Aurora difficulty scale.
    // NULL means "they gave no grade" — 0 is a real difficulty id (#4828).
    difficulty?: number | null;
    climbedAt?: string;
    // Whose tick. Defaults to the stamped device owner; pass something else to
    // stand in for rows a failed sign-out wipe left behind, or `null` for a row
    // the offline dual-write inserted before it had a server user id.
    userId?: string | null;
  },
): Promise<void> {
  const timestamp = opts.climbedAt ?? '2026-02-01T00:00:00Z';
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count, quality, difficulty, is_benchmark, climbed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, 0, ?, ?, ?)`,
    [
      opts.uuid,
      opts.userId === undefined ? LOCAL_OWNER : opts.userId,
      opts.boardType ?? 'kilter',
      opts.climbUuid,
      opts.angle ?? 40,
      opts.status,
      opts.quality ?? null,
      opts.difficulty ?? null,
      timestamp,
      timestamp,
      timestamp,
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
    await stampLocalUserId(db, LOCAL_OWNER);
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

  // Mirrors hiddenClimbCondition in packages/db/src/queries/climbs/create-climb-filters.ts:
  // an offline search that showed what the online one hides is the whole failure
  // mode this pair of predicates exists to prevent.
  it('hides community-hidden climbs from browsing', async () => {
    await insertClimb(db, { uuid: 'visible' });
    await insertClimb(db, { uuid: 'hidden', isHidden: 1 });

    const result = await searchClimbsLocal(db, makeInput());
    expect(uuids(result)).toEqual(['visible']);
    expect(await countClimbsLocal(db, makeInput())).toBe(1);
  });

  it('still finds a hidden climb by an explicit name search', async () => {
    await insertClimb(db, { uuid: 'hidden', name: 'Spiders Man', isHidden: 1 });

    const byName = makeInput({ name: 'spiders' });
    const result = await searchClimbsLocal(db, byName);
    expect(uuids(result)).toEqual(['hidden']);
    expect(result.climbs[0].is_hidden).toBe(true);
    // The count has to agree with the page, or the list renders a row it then
    // claims does not exist.
    expect(await countClimbsLocal(db, byName)).toBe(1);
  });

  it('treats a NULL is_hidden (a row pulled before migration v5) as visible', async () => {
    await insertClimb(db, { uuid: 'pre-v5', isHidden: null });

    const result = await searchClimbsLocal(db, makeInput());
    expect(uuids(result)).toEqual(['pre-v5']);
    expect(result.climbs[0].is_hidden).toBe(false);
    expect(await countClimbsLocal(db, makeInput())).toBe(1);
  });

  // #4494: the search read used to drop board_climbs.description on the floor,
  // so a climb opened from the Climbs list reached the play drawer with no
  // setter notes at all — and the offline path is the one most users hit.
  it('carries the setter description through to the mapped climb', async () => {
    await insertClimb(db, { uuid: 'with-notes', description: 'Match the rail, then\nbig move to the jug.' });

    const result = await searchClimbsLocal(db, makeInput());
    expect(result.climbs).toHaveLength(1);
    expect(result.climbs[0].description).toBe('Match the rail, then\nbig move to the jug.');
  });

  it('reports an empty description (not undefined) when the setter wrote none', async () => {
    await insertClimb(db, { uuid: 'no-notes' });

    const result = await searchClimbsLocal(db, makeInput());
    expect(result.climbs[0].description).toBe('');
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

  // Woods numbers its holds from 0, so hold 0 is a real hold. It used to be
  // dropped by the key parser here and online both — boardsesh/boardsesh#4748.
  it('filters on hold id 0 without matching p10r/p20r', async () => {
    await insertClimb(db, { uuid: 'ground-up', name: 'Ground Up', frames: 'p0r4p18r2' });
    await insertClimb(db, { uuid: 'high-start', name: 'High Start', frames: 'p10r4p203r2' });
    await insertStat(db, { climbUuid: 'ground-up', ascensionistCount: 5 });
    await insertStat(db, { climbUuid: 'high-start', ascensionistCount: 5 });

    expect(uuids(await searchClimbsLocal(db, makeInput({ holdsFilter: { hold_0: { ANY: 'include' } } })))).toEqual([
      'ground-up',
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

  // Same three-case matrix the server test asserts (packages/backend
  // Cross-user leak guard. Sign-out's wipe is best-effort — a locked database
  // (#4314) or a crash mid-sign-out leaves the previous account's ticks behind —
  // and these reads used to carry no user predicate at all, so one failed wipe
  // showed user A's send and attempt glyphs to user B.
  describe('scopes ticks to the climber who owns the local rows', () => {
    it("ignores another account's leftover ticks in the counts and the filters", async () => {
      await insertClimb(db, { uuid: 'theirs' });
      await insertTick(db, { uuid: 'their-tick', climbUuid: 'theirs', status: 'send', userId: 'someone-else' });

      const result = await searchClimbsLocal(db, makeInput());
      expect(result.climbs.find((climb) => climb.uuid === 'theirs')?.userAscents).toBe(0);

      // The climb reads as unclimbed, so "hide completed" keeps it and
      // "show only completed" drops it.
      expect(uuids(await searchClimbsLocal(db, makeInput({ hideCompleted: true })))).toContain('theirs');
      expect(uuids(await searchClimbsLocal(db, makeInput({ showOnlyCompleted: true })))).toEqual([]);
    });

    it("still counts this device's own offline write, which has no user_id yet", async () => {
      // writeTickLocal now stamps the owner, but rows written before that (and
      // any written while unstamped) are NULL. Dropping them would hide a tick
      // the climber just logged with no signal.
      await insertClimb(db, { uuid: 'mine-offline' });
      await insertTick(db, { uuid: 'offline-tick', climbUuid: 'mine-offline', status: 'send', userId: null });

      const result = await searchClimbsLocal(db, makeInput());
      expect(result.climbs.find((climb) => climb.uuid === 'mine-offline')?.userAscents).toBe(1);
      expect(uuids(await searchClimbsLocal(db, makeInput({ showOnlyCompleted: true })))).toEqual(['mine-offline']);
    });

    it("excludes another account's ratings from the personal-rating filters", async () => {
      await insertClimb(db, { uuid: 'rated-by-them' });
      await insertTick(db, {
        uuid: 'their-rating',
        climbUuid: 'rated-by-them',
        status: 'send',
        quality: 1,
        userId: 'someone-else',
      });

      // Neither "I rated this" nor "drop what I rated below 3" may consult it.
      expect(uuids(await searchClimbsLocal(db, makeInput({ onlyRatedByMe: true })))).toEqual([]);
      expect(uuids(await searchClimbsLocal(db, makeInput({ minUserRating: 3 })))).toEqual(['rated-by-them']);
    });

    it('counts nothing but its own unsynced writes on a device with no owner stamp', async () => {
      // A fresh or pre-upgrade database. Degrading to "this device's own writes"
      // is the safe direction: never another account's rows.
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', ['local_user_id']);
      await insertClimb(db, { uuid: 'synced' });
      await insertClimb(db, { uuid: 'written-here' });
      await insertTick(db, { uuid: 'synced-tick', climbUuid: 'synced', status: 'send', userId: 'me' });
      await insertTick(db, { uuid: 'local-tick', climbUuid: 'written-here', status: 'send', userId: null });

      expect(uuids(await searchClimbsLocal(db, makeInput({ showOnlyCompleted: true })))).toEqual(['written-here']);
    });

    it('keeps countClimbsLocal in step with the scoped search', async () => {
      await insertClimb(db, { uuid: 'theirs' });
      await insertTick(db, { uuid: 'their-tick', climbUuid: 'theirs', status: 'send', userId: 'someone-else' });

      await expect(countClimbsLocal(db, makeInput({ showOnlyCompleted: true }))).resolves.toBe(0);
      await expect(countClimbsLocal(db, makeInput({ hideCompleted: true }))).resolves.toBe(1);
    });
  });

  // src/__tests__/climb-queries.test.ts), so an offline search returns the same
  // rows as an online one.
  describe('personal rating filters (#2645)', () => {
    beforeEach(async () => {
      for (const uuid of ['rated5', 'rated2', 'reratedUp', 'reratedDown', 'sentUnrated', 'untouched', 'otherAngle']) {
        await insertClimb(db, { uuid });
        await insertStat(db, { climbUuid: uuid, ascensionistCount: 3 });
      }
      await insertTick(db, { uuid: 'r5', climbUuid: 'rated5', status: 'send', quality: 5 });
      await insertTick(db, { uuid: 'r2', climbUuid: 'rated2', status: 'send', quality: 2 });
      // Re-rated in both directions: the later climbed_at is the opinion that counts.
      await insertTick(db, {
        uuid: 'up-old',
        climbUuid: 'reratedUp',
        status: 'send',
        quality: 2,
        climbedAt: '2026-01-01T00:00:00Z',
      });
      await insertTick(db, {
        uuid: 'up-new',
        climbUuid: 'reratedUp',
        status: 'send',
        quality: 5,
        climbedAt: '2026-03-01T00:00:00Z',
      });
      await insertTick(db, {
        uuid: 'down-old',
        climbUuid: 'reratedDown',
        status: 'send',
        quality: 5,
        climbedAt: '2026-01-01T00:00:00Z',
      });
      await insertTick(db, {
        uuid: 'down-new',
        climbUuid: 'reratedDown',
        status: 'send',
        quality: 2,
        climbedAt: '2026-03-01T00:00:00Z',
      });
      await insertTick(db, { uuid: 'unrated', climbUuid: 'sentUnrated', status: 'send', quality: null });
      await insertTick(db, { uuid: 'other', climbUuid: 'otherAngle', status: 'send', quality: 5, angle: 20 });
    });

    it('minUserRating keeps unrated climbs and drops only the ones rated below it', async () => {
      const result = await searchClimbsLocal(db, makeInput({ minUserRating: 4, pageSize: 50 }));

      expect(uuids(result).sort()).toEqual(['otherAngle', 'rated5', 'reratedUp', 'sentUnrated', 'untouched']);
      expect(await countClimbsLocal(db, makeInput({ minUserRating: 4 }))).toBe(5);
    });

    it('onlyRatedByMe keeps every climb rated at this angle, whatever the stars', async () => {
      const result = await searchClimbsLocal(db, makeInput({ onlyRatedByMe: true, pageSize: 50 }));

      expect(uuids(result).sort()).toEqual(['rated2', 'rated5', 'reratedDown', 'reratedUp']);
    });

    it('both together drop the unrated climbs too', async () => {
      const result = await searchClimbsLocal(db, makeInput({ minUserRating: 4, onlyRatedByMe: true, pageSize: 50 }));

      expect(uuids(result).sort()).toEqual(['rated5', 'reratedUp']);
      expect(await countClimbsLocal(db, makeInput({ minUserRating: 4, onlyRatedByMe: true }))).toBe(2);
    });

    it('stays offline-expressible so the search does not fall back to the network', () => {
      expect(isOfflineSearchSupported(makeInput({ minUserRating: 4, onlyRatedByMe: true }))).toBe(true);
    });
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

  it('joins the Boardsesh grade + confidence, preferring universal over local', async () => {
    await insertClimb(db, { uuid: 'graded' });
    await insertStat(db, { climbUuid: 'graded', ascensionistCount: 30 });
    await insertGrade(db, {
      climbUuid: 'graded',
      localGrade: 21.4,
      universalGrade: 20.2,
      confidence: 'confirmed',
    });

    const [climb] = (await searchClimbsLocal(db, makeInput())).climbs;
    // COALESCE(universal, local) → universal wins when present.
    expect(climb.boardseshDifficulty).toBe(20.2);
    expect(climb.boardseshConfidence).toBe('confirmed');
  });

  it('falls back to local_grade when universal_grade is null (unanchored board)', async () => {
    await insertClimb(db, { uuid: 'local-only' });
    await insertStat(db, { climbUuid: 'local-only', ascensionistCount: 30 });
    await insertGrade(db, {
      climbUuid: 'local-only',
      localGrade: 18.7,
      universalGrade: null,
      confidence: 'provisional',
    });

    const [climb] = (await searchClimbsLocal(db, makeInput())).climbs;
    expect(climb.boardseshDifficulty).toBe(18.7);
    expect(climb.boardseshConfidence).toBe('provisional');
  });

  it('reads null grade + confidence when no board_climb_grades row is joined', async () => {
    await insertClimb(db, { uuid: 'ungraded' });
    await insertStat(db, { climbUuid: 'ungraded', ascensionistCount: 30 });
    // No insertGrade — the LEFT JOIN misses.

    const [climb] = (await searchClimbsLocal(db, makeInput())).climbs;
    expect(climb.boardseshDifficulty).toBeNull();
    expect(climb.boardseshConfidence).toBeNull();
  });

  it('joins the grade for the requested angle only (a different-angle grade does not leak)', async () => {
    await insertClimb(db, { uuid: 'multi' });
    await insertStat(db, { climbUuid: 'multi', ascensionistCount: 30 });
    // Grade exists only at angle 25; the search runs at angle 40.
    await insertGrade(db, { climbUuid: 'multi', angle: 25, universalGrade: 15.0 });

    const [climb] = (await searchClimbsLocal(db, makeInput({ angle: 40 }))).climbs;
    expect(climb.boardseshDifficulty).toBeNull();
    expect(climb.boardseshConfidence).toBeNull();
  });
});

describe('searchClimbsLocal: tall/wide (Kilter Homewall size grid)', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    // Active size 25 (10x12): shorter sizes = {17,18,19,21,22,29}, narrower = {17,18,19,23,24}.
    // Each climb is compatible with 25 so it passes the base size filter.
    await insertClimb(db, { uuid: 'tall-wide', layoutId: 8, compatibleSizeIds: [25, 26] });
    await insertClimb(db, { uuid: 'tall-only', layoutId: 8, compatibleSizeIds: [23, 24, 25, 26] });
    await insertClimb(db, { uuid: 'wide-only', layoutId: 8, compatibleSizeIds: [21, 22, 25, 26] });
    await insertClimb(db, { uuid: 'neither', layoutId: 8, compatibleSizeIds: [21, 24, 25] });
  });

  const homewall = (overrides: Partial<ClimbSearchInput> = {}) => makeInput({ layoutId: 8, sizeId: 25, ...overrides });

  it('tall = climbs compatible with no shorter Homewall size', async () => {
    const result = await searchClimbsLocal(db, homewall({ onlyTallClimbs: true }));
    expect(uuids(result).sort()).toEqual(['tall-only', 'tall-wide']);
  });

  it('wide = climbs compatible with no narrower Homewall size', async () => {
    const result = await searchClimbsLocal(db, homewall({ onlyWideClimbs: true }));
    expect(uuids(result).sort()).toEqual(['tall-wide', 'wide-only']);
  });

  it('tall AND wide narrows to climbs that need the largest size', async () => {
    const result = await searchClimbsLocal(db, homewall({ onlyTallClimbs: true, onlyWideClimbs: true }));
    expect(uuids(result)).toEqual(['tall-wide']);
  });

  it('count mirrors the tall/wide search', async () => {
    expect(await countClimbsLocal(db, homewall({ onlyTallClimbs: true }))).toBe(2);
    expect(await countClimbsLocal(db, homewall({ onlyWideClimbs: true }))).toBe(2);
  });

  it('fails closed on the shortest/narrowest size (the filter has no option there)', async () => {
    // A climb that fits the 7x10 size 17 (both shortest and narrowest).
    await insertClimb(db, { uuid: 'small', layoutId: 8, compatibleSizeIds: [17, 18, 19, 21, 25] });
    const base = await searchClimbsLocal(db, makeInput({ layoutId: 8, sizeId: 17 }));
    expect(uuids(base)).toContain('small');
    const tall = await searchClimbsLocal(db, makeInput({ layoutId: 8, sizeId: 17, onlyTallClimbs: true }));
    const wide = await searchClimbsLocal(db, makeInput({ layoutId: 8, sizeId: 17, onlyWideClimbs: true }));
    expect(tall.climbs).toHaveLength(0);
    expect(wide.climbs).toHaveLength(0);
  });
});

describe('isOfflineSearchSupported', () => {
  it('supports the core filters', () => {
    expect(isOfflineSearchSupported(makeInput({ minGrade: 16, name: 'x', boulders: true }))).toBe(true);
    expect(isOfflineSearchSupported(makeInput({ holdsFilter: { hold_5: { ANY: 'include' } } }))).toBe(true);
    // Tall/wide are expressible against the synced compatible_size_ids.
    expect(isOfflineSearchSupported(makeInput({ onlyTallClimbs: true }))).toBe(true);
    expect(isOfflineSearchSupported(makeInput({ onlyWideClimbs: true }))).toBe(true);
    // Personal grades read the synced ticks, which carry both `difficulty` and
    // `uuid` — so the local SQL implements the same latest-graded-tick rule the
    // server does and this search may be answered on-device (#4828).
    expect(isOfflineSearchSupported(makeInput({ useMyGrades: true, minGrade: 26, maxGrade: 28 }))).toBe(true);
  });

  it('falls back for filters that need un-synced tables or the drafts path', () => {
    expect(isOfflineSearchSupported(makeInput({ onlyDrafts: true }))).toBe(false);
    expect(isOfflineSearchSupported(makeInput({ onlyWithBetaVideos: true }))).toBe(false);
    expect(
      isOfflineSearchSupported(makeInput({ zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 } })),
    ).toBe(false);
    expect(isOfflineSearchSupported(makeInput({ holdsFilter: { hold_5: { STARTING: 'include' } } }))).toBe(false);
  });

  // Random needs no un-synced tables, so it stays offline-supported.
  it('supports the random sort offline', () => {
    expect(isOfflineSearchSupported(makeInput({ sortBy: 'random', sortSeed: '42' }))).toBe(true);
  });
});

describe('searchClimbsLocal: random sort', () => {
  let db: TestSqliteDb;

  // 24 climbs with varied 32-char hex-ish uuids. The two low/high index nibbles
  // land on positions the mixer samples (1 and 7), so every uuid is unique AND
  // hashes to a distinct key (a plain period-16 fill would collide i with i+16).
  const HEX = '0123456789abcdef';
  const climbUuids = Array.from({ length: 24 }, (_unused, climbIndex) => {
    const chars = Array.from({ length: 32 }, (_char, position) => HEX[(climbIndex * 7 + position * 13) % 16]);
    chars[0] = HEX[climbIndex % 16];
    chars[6] = HEX[Math.floor(climbIndex / 16) % 16];
    return chars.join('');
  });

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    for (const uuid of climbUuids) {
      await insertClimb(db, { uuid });
      await insertStat(db, { climbUuid: uuid, ascensionistCount: 1 });
    }
  });

  const orderFor = async (sortSeed: string): Promise<string[]> => {
    // Two pages drain the full set; concatenation is the flat shuffle order.
    const page0 = await searchClimbsLocal(db, makeInput({ sortBy: 'random', sortSeed, pageSize: 12 }));
    const page1 = await searchClimbsLocal(db, makeInput({ sortBy: 'random', sortSeed, pageSize: 12, page: 1 }));
    return [...uuids(page0), ...uuids(page1)];
  };

  it('is deterministic for a fixed seed and paginates without gaps or dupes', async () => {
    const first = await orderFor('12345');
    const second = await orderFor('12345');
    expect(second).toEqual(first);
    // Every climb appears exactly once across the two pages.
    expect(new Set(first).size).toBe(climbUuids.length);
    expect([...first].sort()).toEqual([...climbUuids].sort());
  });

  it('falls back to a stable order for an empty/absent seed (Number("") === 0 guard)', async () => {
    // An empty-string seed must not throw or pin to seed 0 differently than absent —
    // both take the fallback seed, so the two orders match.
    const emptySeed = await searchClimbsLocal(db, makeInput({ sortBy: 'random', sortSeed: '', pageSize: 24 }));
    const noSeed = await searchClimbsLocal(db, makeInput({ sortBy: 'random', pageSize: 24 }));
    expect(uuids(emptySeed)).toEqual(uuids(noSeed));
    expect(uuids(emptySeed).length).toBe(climbUuids.length);
  });

  it('reshuffles across seeds (more than one distinct order)', async () => {
    const orders = await Promise.all(['1', '7', '99', '2026', '31337'].map((seed) => orderFor(seed)));
    const distinct = new Set(orders.map((order) => order.join(',')));
    expect(distinct.size).toBeGreaterThan(1);
    // A shuffle is not the default ascents/uuid order (uuid DESC tiebreak).
    const ascentsOrder = uuids(await searchClimbsLocal(db, makeInput({ pageSize: 24 })));
    expect(orders.every((order) => order.join(',') === ascentsOrder.join(','))).toBe(false);
  });
});

/**
 * The offline read is where `compatibleSizeIds` has to survive a JSON-in-TEXT
 * round-trip, and it is the read that feeds the queue when a phone is on a wall
 * with no signal. Woods is the board that needs it: its 8x10 numbers holds
 * 0-484 and its 12x12 numbers its own 0-893, so an 8x10 climb's hold ids all
 * exist on a 12x12 as different holds. Without this field on the mapped climb,
 * `canAddClimbToBoard` waves it through and the wall lights the wrong holds.
 */
describe('searchClimbsLocal: compatibleSizeIds survives the row -> Climb mapping', () => {
  let db: TestSqliteDb;

  const WOODS_12X12_HOLDS = Array.from({ length: 894 }, (_, index) => ({ id: index }));

  function woodsWall(sizeId: number): BoardCompatibilityTarget {
    return { board_name: 'woods', layout_id: 1, size_id: sizeId, set_ids: [1], holdsData: WOODS_12X12_HOLDS };
  }

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);
  });

  it('decodes the stored JSON array onto the mapped climb', async () => {
    await insertClimb(db, { uuid: 'both-sizes', compatibleSizeIds: [5, 6] });

    const [climb] = (await searchClimbsLocal(db, makeInput({ sizeId: 5 }))).climbs;
    expect(climb.compatibleSizeIds).toEqual([5, 6]);
  });

  it('reports anything that is not a usable array as null, so it reads as "no constraint"', () => {
    // A size-scoped search never returns a NULL-sizes row (the filter excludes
    // them), so the decode itself is the unit under test here. Empty and
    // malformed both have to land on null rather than on `[]`, which a stricter
    // consumer would read as "fits nothing".
    expect(parseCompatibleSizeIds(null)).toBeNull();
    expect(parseCompatibleSizeIds('')).toBeNull();
    expect(parseCompatibleSizeIds('[]')).toBeNull();
    expect(parseCompatibleSizeIds('not json')).toBeNull();
    expect(parseCompatibleSizeIds('{"1":true}')).toBeNull();
    expect(parseCompatibleSizeIds('[1, "two", 3]')).toEqual([1, 3]);
  });

  it('lets the size rule reject a Woods 8x10 climb on a 12x12 wall, and accept it on an 8x10', async () => {
    // Hold ids well inside the 8x10's 0-484 range, so hold-id containment alone
    // cannot separate the two walls — only compatibleSizeIds can.
    await insertClimb(db, {
      uuid: 'woods-8x10-climb',
      boardType: 'woods',
      layoutId: 1,
      frames: 'p12r4p207r2p418r3',
      compatibleSizeIds: [1],
      // Woods ships one synthetic hold set; the search's subset predicate
      // excludes a NULL required_set_ids row on every non-MoonBoard board.
      requiredSetIds: [],
    });

    const [climb] = (
      await searchClimbsLocal(db, makeInput({ boardName: 'woods', layoutId: 1, sizeId: 1, setIds: '1' }))
    ).climbs;

    expect(climb.compatibleSizeIds).toEqual([1]);
    expect(canAddClimbToBoard(climb, woodsWall(2))).toEqual({ ok: false, reason: 'size' });
    expect(canAddClimbToBoard(climb, woodsWall(1))).toEqual({ ok: true });
  });
});

/**
 * Personal grades on-device (#4796 / #4828).
 *
 * A downloaded board reads locally even while ONLINE, so this SQL is not a
 * degraded offline fallback — it is what a user with a downloaded board sees
 * every time. If it answered the grade filter differently from the server, the
 * same search would return different climbs depending on whether the board
 * happened to be downloaded, with no error anywhere.
 *
 * The cases mirror packages/backend/src/__tests__/climb-queries.test.ts one for
 * one, against the same crowd grade on every fixture so any difference can only
 * have come from the personal grade.
 */
describe('searchClimbsLocal: personal grades (#4828)', () => {
  let db: TestSqliteDb;

  // The crowd's grade on every fixture.
  const CROWD_GRADE = 16;

  const gradeInput = (overrides: Partial<ClimbSearchInput> = {}): ClimbSearchInput =>
    makeInput({ useMyGrades: true, sortBy: 'creation', sortOrder: 'desc', ...overrides });

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);

    for (const uuid of [
      'ungraded',
      'graded-hard',
      'graded-easy',
      'regraded-up',
      'regraded-down',
      'graded-zero',
      'over-scale',
      'other-angle',
      'other-user',
    ]) {
      await insertClimb(db, { uuid });
      await insertStat(db, { climbUuid: uuid, displayDifficulty: CROWD_GRADE, difficultyAverage: CROWD_GRADE });
    }

    await insertTick(db, { uuid: 't-hard', climbUuid: 'graded-hard', status: 'send', difficulty: 27 });
    await insertTick(db, { uuid: 't-easy', climbUuid: 'graded-easy', status: 'send', difficulty: 13 });
    // Re-graded UP: the stale 13 must not keep it out of the band.
    await insertTick(db, {
      uuid: 't-up-old',
      climbUuid: 'regraded-up',
      status: 'send',
      difficulty: 13,
      climbedAt: '2026-01-01T00:00:00Z',
    });
    await insertTick(db, {
      uuid: 't-up-new',
      climbUuid: 'regraded-up',
      status: 'send',
      difficulty: 27,
      climbedAt: '2026-03-01T00:00:00Z',
    });
    // Re-graded DOWN: the stale 27 must not keep it IN. A MAX(difficulty)
    // implementation passes every other case here and fails this one.
    await insertTick(db, {
      uuid: 't-down-old',
      climbUuid: 'regraded-down',
      status: 'send',
      difficulty: 27,
      climbedAt: '2026-01-01T00:00:00Z',
    });
    await insertTick(db, {
      uuid: 't-down-new',
      climbUuid: 'regraded-down',
      status: 'send',
      difficulty: 13,
      climbedAt: '2026-03-01T00:00:00Z',
    });
    // 0 is a real difficulty id, not an absence.
    await insertTick(db, { uuid: 't-zero', climbUuid: 'graded-zero', status: 'send', difficulty: 0 });
    // Above the top of the scale — clamped, not dropped.
    await insertTick(db, { uuid: 't-over', climbUuid: 'over-scale', status: 'send', difficulty: 99 });
    // Graded 27 at 20 degrees; the browsed angle is 40.
    await insertTick(db, {
      uuid: 't-other-angle',
      climbUuid: 'other-angle',
      status: 'send',
      difficulty: 27,
      angle: 20,
    });
    // Someone else's grade, left behind by a failed sign-out wipe.
    await insertTick(db, {
      uuid: 't-other-user',
      climbUuid: 'other-user',
      status: 'send',
      difficulty: 27,
      userId: 'someone-else',
    });
  });

  it('filters the band on my own grade, falling back to the crowd grade', async () => {
    const input = gradeInput({ minGrade: 26, maxGrade: 28 });
    const result = await searchClimbsLocal(db, input);

    expect(uuids(result).sort()).toEqual(['graded-hard', 'regraded-up']);
    expect(await countClimbsLocal(db, input)).toBe(2);
  });

  it('clamps an out-of-scale grade rather than dropping the climb', async () => {
    expect(uuids(await searchClimbsLocal(db, gradeInput({ minGrade: 33, maxGrade: 33 })))).toContain('over-scale');
    expect(uuids(await searchClimbsLocal(db, gradeInput({ minGrade: 99, maxGrade: 99 })))).not.toContain('over-scale');
  });

  it('treats difficulty 0 as a real grade, not as ungraded', async () => {
    expect(uuids(await searchClimbsLocal(db, gradeInput({ minGrade: 10, maxGrade: 10 })))).toContain('graded-zero');
    expect(
      uuids(await searchClimbsLocal(db, gradeInput({ minGrade: CROWD_GRADE, maxGrade: CROWD_GRADE }))),
    ).not.toContain('graded-zero');
  });

  it('keeps a graded tick at another angle out of this angle answer', async () => {
    const atCrowdGrade = uuids(
      await searchClimbsLocal(db, gradeInput({ minGrade: CROWD_GRADE, maxGrade: CROWD_GRADE })),
    );
    expect(atCrowdGrade).toContain('other-angle');

    const inPersonalBand = uuids(await searchClimbsLocal(db, gradeInput({ minGrade: 26, maxGrade: 28 })));
    expect(inPersonalBand).not.toContain('other-angle');
  });

  it('reads only my ticks, so a stale row from another account cannot re-grade a climb', async () => {
    const inPersonalBand = uuids(await searchClimbsLocal(db, gradeInput({ minGrade: 26, maxGrade: 28 })));
    expect(inPersonalBand).not.toContain('other-user');
  });

  it('sorts on the effective grade, so a re-graded climb lands among the hard ones', async () => {
    const order = uuids(await searchClimbsLocal(db, gradeInput({ sortBy: 'difficulty', sortOrder: 'desc' })));
    const rank = (uuid: string) => order.indexOf(uuid);

    expect(rank('over-scale')).toBeLessThan(rank('ungraded'));
    expect(rank('graded-hard')).toBeLessThan(rank('ungraded'));
    expect(rank('regraded-up')).toBeLessThan(rank('ungraded'));
    expect(rank('graded-easy')).toBeGreaterThan(rank('ungraded'));
    expect(rank('regraded-down')).toBeGreaterThan(rank('ungraded'));
    expect(rank('graded-zero')).toBeGreaterThan(rank('graded-easy'));
    // Nothing is dropped: an ungraded climb keeps its crowd position.
    expect(order).toHaveLength(9);
  });

  it('projects myDifficulty so a row cannot disagree with its own position', async () => {
    const result = await searchClimbsLocal(db, gradeInput({ sortBy: 'difficulty', sortOrder: 'desc' }));
    const byUuid = new Map(result.climbs.map((climb) => [climb.uuid, climb]));

    expect(byUuid.get('graded-hard')?.myDifficulty).toBe(27);
    expect(byUuid.get('regraded-down')?.myDifficulty).toBe(13);
    expect(byUuid.get('graded-zero')?.myDifficulty).toBe(10);
    expect(byUuid.get('over-scale')?.myDifficulty).toBe(33);
    expect(byUuid.get('ungraded')?.myDifficulty).toBeNull();
    expect(byUuid.get('other-angle')?.myDifficulty).toBeNull();
    expect(byUuid.get('other-user')?.myDifficulty).toBeNull();
  });

  it('omits myDifficulty entirely when the search did not ask for personal grades', async () => {
    const result = await searchClimbsLocal(db, makeInput());
    const row = result.climbs.find((climb) => climb.uuid === 'graded-hard');

    expect(row).toBeDefined();
    expect('myDifficulty' in row!).toBe(false);
  });

  it('keeps the crowd grade filter when personal grades are off', async () => {
    const crowdOnly = makeInput({ minGrade: 26, maxGrade: 28 });
    expect(uuids(await searchClimbsLocal(db, crowdOnly))).toEqual([]);
    expect(await countClimbsLocal(db, crowdOnly)).toBe(0);
  });
});
