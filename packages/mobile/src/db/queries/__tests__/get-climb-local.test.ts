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
