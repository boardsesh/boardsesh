import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markUserDataComplete, runMigrations, stampLocalUserId, USER_DATA_COMPLETE_KEY } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { toLogbookEntry } from '@boardsesh/board-react';
import { getTicksLocal } from '../get-ticks-local';

type TickFixture = {
  uuid: string;
  climbUuid?: string;
  boardType?: string;
  userId?: string | null;
  angle?: number;
  mirror?: number | null;
  status?: string;
  attempts?: number | null;
  quality?: number | null;
  difficulty?: number | null;
  benchmark?: number | null;
  comment?: string | null;
  climbedAt?: string;
};

let db: TestSqliteDb;

async function insertTick(fixture: TickFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks
      (uuid, board_type, climb_uuid, user_id, angle, is_mirror, status, attempt_count,
       quality, difficulty, is_benchmark, comment, climbed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.uuid,
      fixture.boardType ?? 'kilter',
      fixture.climbUuid ?? 'climb-1',
      fixture.userId === undefined ? 'user-a' : fixture.userId,
      fixture.angle ?? 40,
      fixture.mirror === undefined ? 0 : fixture.mirror,
      fixture.status ?? 'send',
      fixture.attempts === undefined ? 1 : fixture.attempts,
      fixture.quality ?? null,
      fixture.difficulty ?? null,
      fixture.benchmark === undefined ? 0 : fixture.benchmark,
      fixture.comment === undefined ? '' : fixture.comment,
      fixture.climbedAt ?? '2026-10-01T10:00:00.000Z',
    ],
  );
}

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await markUserDataComplete(db);
});

describe('getTicksLocal', () => {
  it('returns the selected GraphQL fields without requiring board reference rows', async () => {
    await insertTick({
      uuid: 'tick-1',
      mirror: 1,
      status: 'attempt',
      attempts: 3,
      quality: 4,
      difficulty: 18,
      benchmark: 1,
      comment: 'Close on the last move',
    });

    expect(await getTicksLocal(db, { boardType: 'kilter', climbUuids: ['climb-1'] }, 'user-a')).toEqual({
      ticks: [
        {
          uuid: 'tick-1',
          climbUuid: 'climb-1',
          angle: 40,
          isMirror: true,
          status: 'attempt',
          attemptCount: 3,
          quality: 4,
          effectiveQuality: 4,
          difficulty: 18,
          boardseshDifficulty: null,
          boardseshConfidence: null,
          isBenchmark: true,
          comment: 'Close on the last move',
          climbedAt: '2026-10-01T10:00:00.000Z',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
          climbRevision: null,
        },
      ],
    });
  });

  it.each([undefined, []])('matches the server with no UUID filter (%s)', async (climbUuids) => {
    await insertTick({ uuid: 'first', climbUuid: 'climb-1' });
    await insertTick({ uuid: 'second', climbUuid: 'climb-2' });
    await insertTick({ uuid: 'other-board', boardType: 'tension' });
    const response = await getTicksLocal(db, { boardType: 'kilter', climbUuids }, 'user-a');
    expect(response?.ticks.map((tick) => tick.uuid).sort()).toEqual(['first', 'second']);
  });

  it('excludes other accounts, boards and unrequested climbs but keeps ownerless writes', async () => {
    await insertTick({ uuid: 'mine' });
    await insertTick({ uuid: 'legacy', userId: null, status: 'flash' });
    await insertTick({ uuid: 'other-user', userId: 'user-b' });
    await insertTick({ uuid: 'other-board', boardType: 'tension' });
    await insertTick({ uuid: 'other-climb', climbUuid: 'climb-2' });

    const response = await getTicksLocal(db, { boardType: 'kilter', climbUuids: ['climb-1'] }, 'user-a');
    expect(response?.ticks.map((tick) => tick.uuid).sort()).toEqual(['legacy', 'mine']);
  });

  it('keeps nullable payload fields and supplies the existing legacy display defaults', async () => {
    await insertTick({ uuid: 'legacy', mirror: null, attempts: null, benchmark: null, comment: null });

    const response = await getTicksLocal(db, { boardType: 'kilter' }, 'user-a');
    expect(response?.ticks[0]).toMatchObject({
      isMirror: false,
      attemptCount: 1,
      quality: null,
      effectiveQuality: null,
      difficulty: null,
      isBenchmark: false,
      comment: '',
    });
  });

  it('collapses null-identical twins while retaining benchmark, comment and angle differences', async () => {
    await insertTick({ uuid: 'twin-b', comment: null });
    await insertTick({ uuid: 'twin-a', comment: null });
    await insertTick({ uuid: 'different-benchmark', comment: null, benchmark: 1 });
    await insertTick({ uuid: 'different-comment', comment: '' });
    await insertTick({ uuid: 'different-angle', comment: null, angle: 30 });

    const response = await getTicksLocal(db, { boardType: 'kilter' }, 'user-a');
    expect(response?.ticks.map((tick) => tick.uuid).sort()).toEqual([
      'different-angle',
      'different-benchmark',
      'different-comment',
      'twin-a',
    ]);
  });

  it.each([null, 1])('keeps the stamped twin revision when the selected UUID carries %s', async (originalRevision) => {
    await insertTick({ uuid: 'a-import' });
    await insertTick({ uuid: 'b-stamped' });
    await db.runAsync('UPDATE boardsesh_ticks SET climb_revision = ? WHERE uuid = ?', [originalRevision, 'a-import']);
    await db.runAsync('UPDATE boardsesh_ticks SET climb_revision = 4 WHERE uuid = ?', ['b-stamped']);

    const response = await getTicksLocal(db, { boardType: 'kilter', climbUuids: ['climb-1'] }, 'user-a');
    expect(response?.ticks).toHaveLength(1);
    expect(response?.ticks[0]).toMatchObject({ uuid: 'a-import', climbRevision: 4 });
    expect(response?.ticks.map(toLogbookEntry)[0]?.climb_revision).toBe(4);
  });

  it('distinguishes a synced versionless import from an unknown pending tick', async () => {
    await insertTick({ uuid: 'synced-import', climbUuid: 'import-climb' });
    await insertTick({ uuid: 'pending-tick', climbUuid: 'pending-climb' });
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, status)
       VALUES ('boardsesh_ticks', 'create', '{}', 'pending-tick', 'pending')`,
    );

    const response = await getTicksLocal(db, { boardType: 'kilter' }, 'user-a');
    const entries = new Map(response?.ticks.map((tick) => [tick.uuid, toLogbookEntry(tick)]));
    expect(entries.get('synced-import')).toHaveProperty('climb_revision', null);
    expect(entries.get('pending-tick')).not.toHaveProperty('climb_revision');
  });

  it('chunks requests and orders the whole answer newest first without changing timestamps', async () => {
    const climbUuids = Array.from({ length: 805 }, (_, index) => `climb-${index}`);
    await insertTick({ uuid: 'oldest', climbUuid: climbUuids[0], climbedAt: '2026-10-01T10:00:00.000Z' });
    await insertTick({ uuid: 'newest', climbUuid: climbUuids[800], climbedAt: '2026-10-02T16:00:00+02:00' });
    const reads = vi.spyOn(db, 'getAllAsync');

    const response = await getTicksLocal(
      db,
      { boardType: 'kilter', climbUuids: [...climbUuids, ...climbUuids] },
      'user-a',
    );
    expect(response?.ticks.map((tick) => tick.uuid)).toEqual(['newest', 'oldest']);
    expect(response?.ticks[0].climbedAt).toBe('2026-10-02T16:00:00+02:00');
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls.map(([, params]) => (Array.isArray(params) ? params.length : 0))).toEqual([402, 402, 7]);
  });

  it('returns an empty GraphQL answer only when the owner and completeness gates pass', async () => {
    expect(await getTicksLocal(db, { boardType: 'kilter', climbUuids: ['missing'] }, 'user-a')).toEqual({ ticks: [] });
  });

  it('does not include incomplete rows when reading the whole board', async () => {
    await insertTick({ uuid: 'mine' });
    await db.runAsync(
      `INSERT INTO boardsesh_ticks (uuid, board_type, user_id, angle, status, climbed_at)
       VALUES ('missing-climb', 'kilter', 'user-a', 40, 'send', '2026-10-01T10:00:00.000Z')`,
      [],
    );
    const response = await getTicksLocal(db, { boardType: 'kilter' }, 'user-a');
    expect(response?.ticks.map((tick) => tick.uuid)).toEqual(['mine']);
  });

  it.each(['other-owner', 'no-stamp', 'incomplete', 'signed-out'])(
    'declines instead of inventing an empty answer for %s',
    async (gateState) => {
      await insertTick({ uuid: 'mine' });
      if (gateState === 'other-owner') await stampLocalUserId(db, 'user-b');
      if (gateState === 'no-stamp') await db.runAsync("DELETE FROM sync_meta WHERE key = 'local_user_id'", []);
      if (gateState === 'incomplete')
        await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
      const reads = vi.spyOn(db, 'getAllAsync');

      expect(await getTicksLocal(db, { boardType: 'kilter' }, gateState === 'signed-out' ? '' : 'user-a')).toBeNull();
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it('discards the answer when completeness is cleared while its SQL is in flight', async () => {
    await insertTick({ uuid: 'mine' });
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
      return rows;
    });

    expect(await getTicksLocal(db, { boardType: 'kilter' }, 'user-a')).toBeNull();
  });

  it('does not publish an earlier chunk after ownership changes during a later batch', async () => {
    const climbUuids = Array.from({ length: 401 }, (_, index) => `climb-${index}`);
    await insertTick({ uuid: 'mine', climbUuid: climbUuids[0] });
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await stampLocalUserId(db, 'user-b');
      return rows;
    });

    expect(await getTicksLocal(db, { boardType: 'kilter', climbUuids }, 'user-a')).toBeNull();
  });
});
