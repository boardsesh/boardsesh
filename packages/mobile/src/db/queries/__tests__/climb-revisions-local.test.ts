import { describe, it, expect, beforeEach } from 'vitest';
import { ensureMutationQueueTable, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import {
  fillClimbRevisionNumbersLocal,
  readClimbRevisionNumbersLocal,
  readTickRevisionsLocal,
  tickOnCurrentHoldsLocalSql,
} from '../climb-revisions-local';

const OWNER = 'me';

async function insertClimb(
  db: TestSqliteDb,
  uuid: string,
  revisionNumber: number | null,
  holdsRevisionNumber: number | null,
  boardType = 'kilter',
): Promise<void> {
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, revision_number, holds_revision_number)
     VALUES (?, ?, 1, ?, 1, 0, ?, ?)`,
    [uuid, boardType, uuid, revisionNumber, holdsRevisionNumber],
  );
}

async function insertTick(
  db: TestSqliteDb,
  uuid: string,
  climbUuid: string,
  climbRevision: number | null,
  userId: string | null = OWNER,
  boardType = 'kilter',
): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
       is_benchmark, climbed_at, created_at, updated_at, climb_revision)
     VALUES (?, ?, ?, ?, 40, 0, 'send', 1, 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?)`,
    [uuid, userId, boardType, climbUuid, climbRevision],
  );
}

describe('climb revisions on the device (#6023)', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
  });

  describe('tickOnCurrentHoldsLocalSql', () => {
    it('coalesces both sides to 1', () => {
      expect(tickOnCurrentHoldsLocalSql('t')).toBe(
        'COALESCE(t.climb_revision, 1) >= COALESCE(c.holds_revision_number, 1)',
      );
      expect(tickOnCurrentHoldsLocalSql('rating_newer')).toContain('rating_newer.climb_revision');
    });
  });

  describe('readClimbRevisionNumbersLocal', () => {
    it('returns the numbers keyed by climb uuid, for the asked board only', async () => {
      await insertClimb(db, 'edited', 4, 3);
      await insertClimb(db, 'fresh', 1, 1);
      await insertClimb(db, 'on-another-board', 9, 9, 'tension');

      const numbers = await readClimbRevisionNumbersLocal(db, 'kilter', [
        'edited',
        'fresh',
        'on-another-board',
        'not-on-phone',
      ]);

      expect(numbers.get('edited')).toEqual({ revisionNumber: 4, holdsRevisionNumber: 3 });
      expect(numbers.get('fresh')).toEqual({ revisionNumber: 1, holdsRevisionNumber: 1 });
      expect(numbers.has('on-another-board')).toBe(false);
      expect(numbers.has('not-on-phone')).toBe(false);
    });

    it('leaves out a row pulled before the columns existed', async () => {
      await insertClimb(db, 'pre-v11', null, null);

      expect((await readClimbRevisionNumbersLocal(db, 'kilter', ['pre-v11'])).size).toBe(0);
    });

    it('reads a non-positive stored value as unknown', async () => {
      await insertClimb(db, 'odd', 0, 2);

      expect((await readClimbRevisionNumbersLocal(db, 'kilter', ['odd'])).get('odd')).toEqual({
        revisionNumber: null,
        holdsRevisionNumber: 2,
      });
    });

    it('reads more climbs than one statement binds, in chunks', async () => {
      const uuids = Array.from({ length: 950 }, (_, index) => `climb-${index}`);
      for (const uuid of uuids) await insertClimb(db, uuid, 2, 1);

      const numbers = await readClimbRevisionNumbersLocal(db, 'kilter', uuids);

      expect(numbers.size).toBe(950);
      expect(numbers.get('climb-949')).toEqual({ revisionNumber: 2, holdsRevisionNumber: 1 });
    });

    it('does nothing for an empty list', async () => {
      expect((await readClimbRevisionNumbersLocal(db, 'kilter', [])).size).toBe(0);
    });
  });

  describe('readTickRevisionsLocal', () => {
    it('returns known versions keyed by tick uuid and leaves unknown ones out', async () => {
      await insertTick(db, 'stamped', 'climb-1', 3);
      await insertTick(db, 'first-version', 'climb-1', 1);
      await insertTick(db, 'unknown', 'climb-1', null);
      await insertTick(db, 'other-climb', 'climb-2', 2);

      const revisions = await readTickRevisionsLocal(db, 'kilter', ['climb-1'], OWNER);

      expect(revisions).toEqual(
        new Map([
          ['first-version', 1],
          ['stamped', 3],
        ]),
      );
    });

    it('serves the owner’s rows and this device’s unsynced writes, never another account’s', async () => {
      await insertTick(db, 'mine', 'climb-1', 2);
      await insertTick(db, 'written-offline', 'climb-1', 2, null);
      await insertTick(db, 'left-behind', 'climb-1', 2, 'someone-else');

      const revisions = await readTickRevisionsLocal(db, 'kilter', ['climb-1'], OWNER);

      expect(new Set(revisions.keys())).toEqual(new Set(['mine', 'written-offline']));
    });

    it('is scoped to the board type', async () => {
      await insertTick(db, 'tension-tick', 'climb-1', 2, OWNER, 'tension');

      expect((await readTickRevisionsLocal(db, 'kilter', ['climb-1'], OWNER)).size).toBe(0);
    });
  });

  describe('fillClimbRevisionNumbersLocal', () => {
    it('fills the numbers a network climb arrived without', async () => {
      await insertClimb(db, 'edited', 4, 3);
      const climbs = [{ uuid: 'edited', name: 'Edited' }];

      const filled = await fillClimbRevisionNumbersLocal(db, 'kilter', climbs);

      expect(filled).toEqual([{ uuid: 'edited', name: 'Edited', revisionNumber: 4, holdsRevisionNumber: 3 }]);
    });

    it('keeps a number the climb already carries', async () => {
      await insertClimb(db, 'edited', 4, 3);
      const climbs = [{ uuid: 'edited', revisionNumber: 5, holdsRevisionNumber: null }];

      const [filled] = await fillClimbRevisionNumbersLocal(db, 'kilter', climbs);

      expect(filled).toEqual({ uuid: 'edited', revisionNumber: 5, holdsRevisionNumber: 3 });
    });

    it('returns the same array, and reads nothing, when every climb has both numbers', async () => {
      const climbs = [{ uuid: 'complete', revisionNumber: 2, holdsRevisionNumber: 1 }];
      let reads = 0;
      const countingDb = {
        getAllAsync: async () => {
          reads += 1;
          return [];
        },
      } as unknown as TestSqliteDb;

      expect(await fillClimbRevisionNumbersLocal(countingDb, 'kilter', climbs)).toBe(climbs);
      expect(reads).toBe(0);
    });

    it('returns the same array when the phone holds none of the climbs', async () => {
      const climbs = [{ uuid: 'not-on-phone' }];

      expect(await fillClimbRevisionNumbersLocal(db, 'kilter', climbs)).toBe(climbs);
    });

    it('leaves a climb the phone does not hold as it came, beside one it does', async () => {
      await insertClimb(db, 'on-phone', 2, 2);
      const notOnPhone = { uuid: 'not-on-phone' };

      const filled = await fillClimbRevisionNumbersLocal(db, 'kilter', [notOnPhone, { uuid: 'on-phone' }]);

      expect(filled[0]).toBe(notOnPhone);
      expect(filled[1]).toEqual({ uuid: 'on-phone', revisionNumber: 2, holdsRevisionNumber: 2 });
    });

    it('reads a whole page in one statement', async () => {
      const uuids = Array.from({ length: 40 }, (_, index) => `page-${index}`);
      for (const uuid of uuids) await insertClimb(db, uuid, 2, 2);
      let reads = 0;
      const countingDb: Pick<TestSqliteDb, 'getAllAsync'> = {
        getAllAsync: (async (sql: string, params?: unknown[]) => {
          reads += 1;
          return db.getAllAsync(sql, params as never);
        }) as TestSqliteDb['getAllAsync'],
      };

      const filled = await fillClimbRevisionNumbersLocal(
        countingDb as TestSqliteDb,
        'kilter',
        uuids.map((uuid) => ({ uuid })),
      );

      expect(reads).toBe(1);
      expect(filled.every((climb) => 'revisionNumber' in climb)).toBe(true);
    });
  });
});
