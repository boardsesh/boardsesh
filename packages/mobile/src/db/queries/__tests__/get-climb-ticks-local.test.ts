import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markUserDataComplete, runMigrations, stampLocalUserId, USER_DATA_COMPLETE_KEY } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { readClimbTicksLocal } from '../get-climb-ticks-local';

type TickFixture = {
  uuid: string;
  climbUuid?: string;
  ownerId?: string | null;
  boardName?: string;
  angle?: number | null;
  isMirror?: number;
  status?: string;
  attemptCount?: number;
  quality?: number | null;
  difficulty?: number | null;
  comment?: string;
  climbedAt?: string | null;
  climbRevision?: number | null;
};

let db: TestSqliteDb;

async function insertTick(fixture: TickFixture): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks
       (uuid, climb_uuid, user_id, board_type, angle, is_mirror, status, attempt_count,
        quality, difficulty, comment, climbed_at, climb_revision, is_benchmark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      fixture.uuid,
      fixture.climbUuid ?? 'climb-1',
      fixture.ownerId === undefined ? 'user-a' : fixture.ownerId,
      fixture.boardName ?? 'kilter',
      fixture.angle === undefined ? 40 : fixture.angle,
      fixture.isMirror ?? 0,
      fixture.status ?? 'send',
      fixture.attemptCount ?? 1,
      fixture.quality ?? null,
      fixture.difficulty ?? null,
      fixture.comment ?? '',
      fixture.climbedAt === undefined ? '2026-10-01T10:00:00.000Z' : fixture.climbedAt,
      fixture.climbRevision ?? null,
    ],
  );
}

async function queueTick(uuid: string, status = 'pending'): Promise<void> {
  await db.runAsync(
    `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, status)
     VALUES ('boardsesh_ticks', 'create', '{}', ?, ?)`,
    [uuid, status],
  );
}

const readTicks = (climbUuids: readonly string[] = ['climb-1'], viewerId = 'user-a') =>
  readClimbTicksLocal(db, 'kilter', climbUuids, viewerId);

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'user-a');
  await markUserDataComplete(db);
});

describe('readClimbTicksLocal', () => {
  it('serves all angles, mirrors and results without a downloaded board', async () => {
    await insertTick({ uuid: 'flash', status: 'flash', angle: 30, quality: 4, difficulty: 18 });
    await insertTick({ uuid: 'send', status: 'send', angle: 40, isMirror: 1, difficulty: 20 });
    await insertTick({ uuid: 'attempt', status: 'attempt', angle: 50, attemptCount: 3 });

    expect(await readTicks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uuid: 'flash', angle: 30, is_mirror: false, is_ascent: true, difficulty: 18 }),
        expect.objectContaining({ uuid: 'send', angle: 40, is_mirror: true, is_ascent: true, difficulty: 20 }),
        expect.objectContaining({ uuid: 'attempt', angle: 50, tries: 3, is_ascent: false }),
      ]),
    );
  });

  it('deduplicates requested UUIDs and reads 950 climbs in three bounded statements', async () => {
    const climbUuids = Array.from({ length: 950 }, (_, index) => `climb-${index}`);
    for (const climbUuid of climbUuids) await insertTick({ uuid: `tick-${climbUuid}`, climbUuid });
    const reads = vi.spyOn(db, 'getAllAsync');

    const entries = await readTicks([...climbUuids, ...climbUuids]);

    expect(entries).toHaveLength(950);
    expect(new Set(entries?.map((entry) => entry.climb_uuid)).size).toBe(950);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls.map(([, params]) => (Array.isArray(params) ? params.length : 0))).toEqual([402, 402, 152]);
  });

  it('returns a valid empty answer for no requested climbs, without tick queries', async () => {
    const reads = vi.spyOn(db, 'getAllAsync');
    expect(await readTicks([])).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
  });

  it('returns a valid empty history when there are no matching ticks', async () => {
    expect(await readTicks()).toEqual([]);
  });

  it.each(['other-owner', 'no-stamp', 'incomplete'])('declines when the gate reports %s', async (gateState) => {
    await insertTick({ uuid: 'mine' });
    if (gateState === 'other-owner') await stampLocalUserId(db, 'user-b');
    if (gateState === 'no-stamp') await db.runAsync("DELETE FROM sync_meta WHERE key = 'local_user_id'", []);
    if (gateState === 'incomplete') await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [USER_DATA_COMPLETE_KEY]);
    const reads = vi.spyOn(db, 'getAllAsync');

    expect(await readTicks()).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it('keeps legacy ownerless rows and excludes other owners, boards and unrequested climbs', async () => {
    await insertTick({ uuid: 'mine' });
    await insertTick({ uuid: 'legacy', ownerId: null, isMirror: 1 });
    await insertTick({ uuid: 'leftover', ownerId: 'user-b', angle: 30 });
    await insertTick({ uuid: 'other-board', boardName: 'tension' });
    await insertTick({ uuid: 'other-climb', climbUuid: 'climb-2' });

    expect((await readTicks())?.map((entry) => entry.uuid).sort()).toEqual(['legacy', 'mine']);
  });

  it('excludes unsupported statuses and incomplete display rows', async () => {
    await insertTick({ uuid: 'mine' });
    await insertTick({ uuid: 'other-status', status: 'unknown' });
    await insertTick({ uuid: 'no-angle', angle: null });
    await insertTick({ uuid: 'no-date', climbedAt: null });

    expect((await readTicks())?.map((entry) => entry.uuid)).toEqual(['mine']);
  });

  it('preserves timestamps and grade payloads while collapsing only identical twins', async () => {
    await insertTick({ uuid: 'twin-b', difficulty: 18 });
    await insertTick({ uuid: 'twin-a', difficulty: 18 });
    await insertTick({ uuid: 'newer', difficulty: 20, climbedAt: '2026-10-02T10:00:00.000Z' });
    await insertTick({ uuid: 'same-time-other-grade', difficulty: 22 });
    await insertTick({ uuid: 'same-payload-other-climb', climbUuid: 'climb-2', difficulty: 18 });

    const entries = await readTicks(['climb-1', 'climb-2']);

    expect(entries).toHaveLength(4);
    expect(entries?.find((entry) => entry.uuid === 'twin-a')?.difficulty).toBe(18);
    expect(entries?.find((entry) => entry.uuid === 'newer')).toMatchObject({
      difficulty: 20,
      climbed_at: '2026-10-02T10:00:00.000Z',
    });
    expect(entries?.find((entry) => entry.uuid === 'same-payload-other-climb')?.climb_uuid).toBe('climb-2');
  });

  it.each(['pending', 'dead_letter'])('omits an unknown revision for an unanswered %s write', async (status) => {
    await insertTick({ uuid: 'written-here' });
    await queueTick('written-here', status);

    const [entry] = (await readTicks()) ?? [];

    expect(entry).toMatchObject({ uuid: 'written-here', is_ascent: true });
    expect(entry).not.toHaveProperty('climb_revision');
  });

  it('keeps a stamped pending revision and a synced null revision distinct', async () => {
    await insertTick({ uuid: 'stamped', climbRevision: 4 });
    await queueTick('stamped');
    await insertTick({ uuid: 'synced-null', angle: 30 });

    const entriesByUuid = new Map((await readTicks())?.map((entry) => [entry.uuid, entry]));

    expect(entriesByUuid.get('stamped')?.climb_revision).toBe(4);
    expect(entriesByUuid.get('synced-null')?.climb_revision).toBeNull();
  });

  it('keeps the highest known twin revision even when its smallest UUID is pending and unknown', async () => {
    await insertTick({ uuid: 'twin-a' });
    await queueTick('twin-a');
    await insertTick({ uuid: 'twin-b', climbRevision: 4 });
    await insertTick({ uuid: 'twin-c', climbRevision: 2 });

    expect(await readTicks()).toEqual([expect.objectContaining({ uuid: 'twin-a', climb_revision: 4 })]);
  });

  it('keeps a confirmed null supplied by an otherwise identical synced twin', async () => {
    await insertTick({ uuid: 'twin-a' });
    await queueTick('twin-a');
    await insertTick({ uuid: 'twin-b' });

    expect(await readTicks()).toEqual([expect.objectContaining({ uuid: 'twin-a', climb_revision: null })]);
  });

  it('declines a completed read if the disk owner changes while a batch is in flight', async () => {
    await insertTick({ uuid: 'mine' });
    const originalRead = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (source, ...params) => {
      const rows = await originalRead(source, ...(params as [never]));
      await stampLocalUserId(db, 'user-b');
      return rows;
    });

    expect(await readTicks()).toBeNull();
  });
});
