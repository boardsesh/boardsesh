import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations, ensureMutationQueueTable } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getClimbLocal } from '../get-climb-local';
import { getBoardseshGradeLocal, getBoardseshGradesForAnglesLocal } from '../get-boardsesh-grade-local';
import { getClimbStatsHistoryLocal } from '../get-climb-stats-history-local';

// Focused coverage for the get-climb-local grade join. The Climb-field mapping is
// shared with search-climbs-local (mapRowToClimb) and covered there; what this file
// pins is that the detail query's LEFT JOIN board_climb_grades binds the right
// (board_type, angle) — an easy positional-parameter bug — and that the grade
// surfaces on the detail read.

async function insertClimb(db: TestSqliteDb, uuid: string, boardType = 'kilter', isHidden = 0): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, description, is_listed, is_draft, is_hidden, frames_count, frames, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, 1, 0, ?, 1, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [uuid, boardType, `Climb ${uuid}`, 'a description', isHidden],
  );
}

async function insertGrade(
  db: TestSqliteDb,
  opts: {
    climbUuid: string;
    angle?: number;
    localGrade?: number | null;
    universalGrade?: number | null;
    confidence?: string;
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at, sync_seq)
     VALUES ('kilter', ?, ?, ?, ?, NULL, NULL, ?, 42, '2026-01-01T00:00:00Z', 1)`,
    [
      opts.climbUuid,
      opts.angle ?? 40,
      opts.localGrade ?? null,
      opts.universalGrade ?? null,
      opts.confidence ?? 'confirmed',
    ],
  );
}

describe('getClimbLocal — Boardsesh grade join', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
  });

  it('surfaces the grade + confidence for the requested angle (universal preferred)', async () => {
    await insertClimb(db, 'c1');
    await insertGrade(db, { climbUuid: 'c1', angle: 40, localGrade: 21.0, universalGrade: 19.5 });

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'c1',
      viewerId: null,
    });
    expect(climb).not.toBeNull();
    expect(climb?.boardseshDifficulty).toBe(19.5);
    expect(climb?.boardseshConfidence).toBe('confirmed');
    // The detail read still carries description + a false mirrored flag.
    expect(climb?.description).toBe('a description');
    expect(climb?.mirrored).toBe(false);
  });

  it('reads null grade when the only grade row is at a different angle', async () => {
    await insertClimb(db, 'c2');
    await insertGrade(db, { climbUuid: 'c2', angle: 25, universalGrade: 15.0 });

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'c2',
      viewerId: null,
    });
    expect(climb?.boardseshDifficulty).toBeNull();
    expect(climb?.boardseshConfidence).toBeNull();
  });

  it('still opens a community-hidden climb by uuid, and says that it is hidden (#5049)', async () => {
    // Hiding removes a climb from browsing, not from the link somebody already
    // has — offline included.
    await insertClimb(db, 'hidden', 'kilter', 1);

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'hidden',
      viewerId: null,
    });
    expect(climb?.uuid).toBe('hidden');
    expect(climb?.is_hidden).toBe(true);
  });

  it('reads null grade when no grade row exists at all', async () => {
    await insertClimb(db, 'c3');

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'c3',
      viewerId: null,
    });
    expect(climb?.boardseshDifficulty).toBeNull();
    expect(climb?.boardseshConfidence).toBeNull();
  });
});

// #6023: the detail read carries the climb's version numbers, so a tick logged
// from a climb opened offline names the version on screen.
describe('getClimbLocal — climb version numbers', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('carries holds_revision_number through to the climb', async () => {
    await insertClimb(db, 'edited');
    await db.runAsync('UPDATE board_climbs SET revision_number = 5, holds_revision_number = 3 WHERE uuid = ?', [
      'edited',
    ]);

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'edited',
      viewerId: null,
    });
    expect(climb?.holdsRevisionNumber).toBe(3);
  });

  it('reads null for a row pulled before the columns existed', async () => {
    await insertClimb(db, 'pre-v11');

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'pre-v11',
      viewerId: null,
    });
    expect(climb?.holdsRevisionNumber).toBeNull();
  });
});

describe('getClimbLocal — climbs that lost holds', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('carries missing_hold_count through to the climb', async () => {
    // The board-compatibility rule reads it to keep a lost-hold climb loggable
    // and queueable, and it is a different read from the list — the search tests
    // cover `searchClimbsLocal` and would not notice this column being dropped
    // from the projection here.
    await insertClimb(db, 'broken');
    await db.runAsync('UPDATE board_climbs SET missing_hold_count = 2 WHERE uuid = ?', ['broken']);

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'broken',
      viewerId: null,
    });

    expect(climb?.missingHoldCount).toBe(2);
  });

  it('opens a published spray climb that lost a hold by uuid, though search hides it', async () => {
    // A logbook entry, a playlist, the queue or a link still reaches it, drawn
    // with the holds that remain. Retired by a full reset makes no difference.
    await insertClimb(db, 'old-blue', 'spray');
    await db.runAsync('UPDATE board_climbs SET missing_hold_count = 3, retired_by_reset = 1 WHERE uuid = ?', [
      'old-blue',
    ]);

    const climb = await getClimbLocal(db, {
      boardName: 'spray',
      layoutId: 1,
      angle: 40,
      climbUuid: 'old-blue',
      viewerId: null,
    });

    expect(climb?.uuid).toBe('old-blue');
    expect(climb?.missingHoldCount).toBe(3);
  });

  it('reads null for a climb no reset has touched', async () => {
    // Nullable on purpose, matching the server: "no reset has taken anything off
    // this climb" and "this is not a spray climb" are the same NULL, and neither
    // is the statement "0 holds lost".
    await insertClimb(db, 'intact');

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'intact',
      viewerId: null,
    });

    expect(climb?.missingHoldCount).toBeNull();
  });
});

// Issue #5642. A Woods list is restricted to the browsed angle unless the climber
// opts in, but the detail read stays cross-angle on Woods: a climb set at another
// angle still reaches it (a name search, an opted-in list, a playlist) and must
// open with its set-angle grade, badged, rather than a blank one.
describe('getClimbLocal — cross-angle detail on an angle-bound board', () => {
  let db: TestSqliteDb;

  async function insertSetAngleClimb(uuid: string, boardType: string, setAngle: number): Promise<void> {
    await db.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, description, is_listed, is_draft, is_hidden, frames_count, frames, angle, created_at, updated_at)
       VALUES (?, ?, 1, ?, '', 1, 0, 0, 1, '', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [uuid, boardType, `Climb ${uuid}`, setAngle],
    );
    await db.runAsync(
      `INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, updated_at)
       VALUES (?, ?, ?, 20, 20, 4, 500, '2026-01-01T00:00:00Z')`,
      [boardType, uuid, setAngle],
    );
  }

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('opens a Woods climb set at 40° with its 40° grade when read at 30°', async () => {
    await insertSetAngleClimb('woods-40', 'woods', 40);

    const climb = await getClimbLocal(db, {
      boardName: 'woods',
      layoutId: 1,
      angle: 30,
      climbUuid: 'woods-40',
      viewerId: null,
    });

    expect(climb?.angle).toBe(30);
    expect(climb?.statsAngle).toBe(40);
    expect(climb?.ascensionist_count).toBe(500);
    expect(climb?.difficulty).not.toBe('');
  });

  it('keeps a Kilter climb pinned to the browsed angle', async () => {
    await insertSetAngleClimb('kilter-40', 'kilter', 40);

    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 30,
      climbUuid: 'kilter-40',
      viewerId: null,
    });

    expect(climb?.statsAngle).toBeNull();
    expect(climb?.ascensionist_count).toBe(0);
  });
});

// A draft goes to its owner alone. The phone can still hold someone else's: the
// previous account's drafts outlive the sign-out wipe that keeps the catalogue,
// and a phone that pulled before that rule kept drafts with no Boardsesh owner.
// Those rows stay on disk (nothing deletes them) and read as missing for anyone
// but their owner; online the request then goes to the server.
describe('drafts read for their owner only', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await insertClimb(db, 'published-by-a');
    await insertClimb(db, 'draft-by-a');
    await insertClimb(db, 'ownerless-draft');
    await db.runAsync("UPDATE board_climbs SET user_id = 'account-a' WHERE uuid IN ('published-by-a', 'draft-by-a')");
    await db.runAsync("UPDATE board_climbs SET is_draft = 1 WHERE uuid IN ('draft-by-a', 'ownerless-draft')");
    for (const climbUuid of ['published-by-a', 'draft-by-a', 'ownerless-draft']) {
      await insertGrade(db, { climbUuid, localGrade: 20 });
      await db.runAsync(
        `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
         VALUES ('kilter', ?, 40, 3, '2026-01-01T00:00:00Z')`,
        [climbUuid],
      );
    }
  });

  async function readAll(climbUuid: string, viewerId: string | null) {
    return {
      climb: await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid, viewerId }),
      grade: await getBoardseshGradeLocal(db, { boardName: 'kilter', climbUuid, angle: 40, viewerId }),
      grades: await getBoardseshGradesForAnglesLocal(db, { boardName: 'kilter', climbUuid, viewerId }),
      stats: await getClimbStatsHistoryLocal(db, { boardName: 'kilter', climbUuid, viewerId }),
    };
  }

  it("opens a draft, its grades and its stats for the draft's owner", async () => {
    const own = await readAll('draft-by-a', 'account-a');
    expect(own.climb?.uuid).toBe('draft-by-a');
    expect(own.grade).not.toBeNull();
    expect(own.grades).toHaveLength(1);
    expect(own.stats).toHaveLength(1);
  });

  it.each([
    ['another account', 'account-b'],
    ['nobody signed in', null],
  ])("hides another account's draft from %s, leaving its rows on disk", async (_who, viewerId) => {
    expect(await readAll('draft-by-a', viewerId)).toEqual({ climb: null, grade: null, grades: [], stats: [] });
    const kept = await db.getFirstAsync<{ count: number }>(
      "SELECT COUNT(*) AS count FROM board_climbs WHERE uuid = 'draft-by-a'",
    );
    expect(kept?.count).toBe(1);
  });

  it('hides a draft with no Boardsesh owner from everyone', async () => {
    expect(await readAll('ownerless-draft', 'account-b')).toEqual({ climb: null, grade: null, grades: [], stats: [] });
  });

  it("still opens another account's published climb", async () => {
    const published = await readAll('published-by-a', 'account-b');
    expect(published.climb?.uuid).toBe('published-by-a');
    expect(published.grade).not.toBeNull();
    expect(published.grades).toHaveLength(1);
    expect(published.stats).toHaveLength(1);
  });
});

// The detail read's send and attempt counts are the viewer's own: another
// account's ticks left on the phone never count as theirs. A tick with no
// user_id is this device's own offline write and counts.
describe("getClimbLocal — the viewer's own ticks only", () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await insertClimb(db, 'c1');
    for (const [uuid, userId, status] of [
      ['send-by-a', 'account-a', 'send'],
      ['attempt-by-a', 'account-a', 'attempt'],
      ['send-by-b', 'account-b', 'send'],
      ['offline-attempt', null, 'attempt'],
    ] as const) {
      await db.runAsync(
        `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status) VALUES (?, ?, 'kilter', 'c1', 40, ?)`,
        [uuid, userId, status],
      );
    }
  });

  it("counts the viewer's ticks and this device's offline writes, never another account's", async () => {
    const climb = await getClimbLocal(db, {
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      climbUuid: 'c1',
      viewerId: 'account-b',
    });
    expect(climb?.userAscents).toBe(1);
    expect(climb?.userAttempts).toBe(1);
  });
});
