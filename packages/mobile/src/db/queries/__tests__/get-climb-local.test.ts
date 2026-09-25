import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations, ensureMutationQueueTable } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getClimbLocal } from '../get-climb-local';

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

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'c1' });
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

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'c2' });
    expect(climb?.boardseshDifficulty).toBeNull();
    expect(climb?.boardseshConfidence).toBeNull();
  });

  it('still opens a community-hidden climb by uuid, and says that it is hidden (#5049)', async () => {
    // Hiding removes a climb from browsing, not from the link somebody already
    // has — offline included.
    await insertClimb(db, 'hidden', 'kilter', 1);

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'hidden' });
    expect(climb?.uuid).toBe('hidden');
    expect(climb?.is_hidden).toBe(true);
  });

  it('reads null grade when no grade row exists at all', async () => {
    await insertClimb(db, 'c3');

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'c3' });
    expect(climb?.boardseshDifficulty).toBeNull();
    expect(climb?.boardseshConfidence).toBeNull();
  });
});

describe('getClimbLocal — spray-wall hold integrity', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('carries missing_hold_count through to the climb', async () => {
    // The detail screen is where the lost-holds badge is drawn, and it is a
    // different read from the list — the filter tests cover `searchClimbsLocal`
    // and would not notice this column being dropped from the projection here.
    await insertClimb(db, 'broken');
    await db.runAsync('UPDATE board_climbs SET missing_hold_count = 2 WHERE uuid = ?', ['broken']);

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'broken' });

    expect(climb?.missingHoldCount).toBe(2);
  });

  it('reads null for a climb no reset has touched', async () => {
    // Nullable on purpose, matching the server: "no reset has taken anything off
    // this climb" and "this is not a spray climb" are the same NULL, and neither
    // is the statement "0 holds lost".
    await insertClimb(db, 'intact');

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 40, climbUuid: 'intact' });

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

    const climb = await getClimbLocal(db, { boardName: 'woods', layoutId: 1, angle: 30, climbUuid: 'woods-40' });

    expect(climb?.angle).toBe(30);
    expect(climb?.statsAngle).toBe(40);
    expect(climb?.ascensionist_count).toBe(500);
    expect(climb?.difficulty).not.toBe('');
  });

  it('keeps a Kilter climb pinned to the browsed angle', async () => {
    await insertSetAngleClimb('kilter-40', 'kilter', 40);

    const climb = await getClimbLocal(db, { boardName: 'kilter', layoutId: 1, angle: 30, climbUuid: 'kilter-40' });

    expect(climb?.statsAngle).toBeNull();
    expect(climb?.ascensionist_count).toBe(0);
  });
});
