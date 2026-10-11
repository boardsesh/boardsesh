import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getBoardseshGradeLocal, getBoardseshGradesForAnglesLocal } from '../get-boardsesh-grade-local';

// A grade row is read only under a climb the device holds. A climb that leaves
// the catalogue (it became a draft, or unlisted) is deleted with its rows, but a
// row delivered just before that can outlive its climb, and it must not be
// answered for a climb that is no longer here.
describe('the Boardsesh grade, read from the device', () => {
  let db: TestSqliteDb;
  const insertGrade = (climbUuid: string, angle: number) =>
    db.runAsync(
      `INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, confidence, computed_at)
       VALUES ('kilter', ?, ?, 21, 'high', '2026-09-25T10:00:00Z')`,
      [climbUuid, angle],
    );

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
    await db.runAsync("INSERT INTO board_climbs (uuid, board_type, layout_id) VALUES ('here', 'kilter', 1)");
    await insertGrade('here', 40);
    await insertGrade('here', 45);
    await insertGrade('withdrawn', 40);
  });

  it('answers for a climb the device holds', async () => {
    expect(await getBoardseshGradeLocal(db, { boardName: 'kilter', climbUuid: 'here', angle: 40 })).toMatchObject({
      localGrade: 21,
      confidence: 'high',
    });
    expect(
      (await getBoardseshGradesForAnglesLocal(db, { boardName: 'kilter', climbUuid: 'here' })).map(
        (grade) => grade.angle,
      ),
    ).toEqual([40, 45]);
  });

  it('answers nothing for a climb the device does not hold, though a grade row for it is still here', async () => {
    expect(await getBoardseshGradeLocal(db, { boardName: 'kilter', climbUuid: 'withdrawn', angle: 40 })).toBeNull();
    expect(await getBoardseshGradesForAnglesLocal(db, { boardName: 'kilter', climbUuid: 'withdrawn' })).toEqual([]);
  });

  it('does not answer for the same uuid on another board type', async () => {
    expect(await getBoardseshGradeLocal(db, { boardName: 'tension', climbUuid: 'here', angle: 40 })).toBeNull();
  });
});
