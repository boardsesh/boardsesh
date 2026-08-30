import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations, stampLocalUserId } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getLocalProfileLogbookPage, getLocalProfileStats } from '../local-profile-logbook';

const LOCAL_OWNER = 'local:profile-1';

async function insertTick(
  db: TestSqliteDb,
  tick: {
    uuid: string;
    ownerId: string | null;
    climbUuid: string;
    status: 'attempt' | 'send' | 'flash';
    attempts: number;
    climbedAt: string;
    difficulty?: number | null;
  },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO boardsesh_ticks
      (uuid, user_id, board_type, climb_uuid, angle, is_mirror, status, attempt_count,
       difficulty, comment, climbed_at, created_at, updated_at)
     VALUES (?, ?, 'kilter', ?, 40, 0, ?, ?, ?, '', ?, ?, ?)`,
    [
      tick.uuid,
      tick.ownerId,
      tick.climbUuid,
      tick.status,
      tick.attempts,
      tick.difficulty ?? null,
      tick.climbedAt,
      tick.climbedAt,
      tick.climbedAt,
    ],
  );
}

describe('local profile logbook', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
    await stampLocalUserId(db, LOCAL_OWNER);
    await db.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, setter_username, is_draft, is_listed)
       VALUES ('climb-1', 'kilter', 1, 'Quiet Feet', 'setter', 0, 1)`,
      [],
    );
    await db.runAsync(
      `INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, display_difficulty)
       VALUES ('kilter', 'climb-1', 40, 18.4)`,
      [],
    );
  });

  it('returns only the stamped local owner and enriches entries from the downloaded catalog', async () => {
    await insertTick(db, {
      uuid: 'mine',
      ownerId: LOCAL_OWNER,
      climbUuid: 'climb-1',
      status: 'send',
      attempts: 2,
      climbedAt: '2026-08-30T12:00:00Z',
    });
    await insertTick(db, {
      uuid: 'other-profile',
      ownerId: 'local:profile-2',
      climbUuid: 'climb-1',
      status: 'flash',
      attempts: 1,
      climbedAt: '2026-08-31T12:00:00Z',
    });
    await insertTick(db, {
      uuid: 'legacy-null',
      ownerId: null,
      climbUuid: 'climb-1',
      status: 'send',
      attempts: 1,
      climbedAt: '2026-08-29T12:00:00Z',
    });

    await expect(getLocalProfileLogbookPage(db, 0)).resolves.toEqual({
      entries: [
        expect.objectContaining({
          uuid: 'mine',
          climbName: 'Quiet Feet',
          setterUsername: 'setter',
          difficulty: 18,
        }),
      ],
      hasMore: false,
    });
  });

  it('paginates in reverse chronological order without loading the whole logbook', async () => {
    for (let index = 0; index < 3; index += 1) {
      await insertTick(db, {
        uuid: `tick-${index}`,
        ownerId: LOCAL_OWNER,
        climbUuid: 'climb-1',
        status: 'attempt',
        attempts: 1,
        climbedAt: `2026-08-0${index + 1}T12:00:00Z`,
      });
    }

    const firstPage = await getLocalProfileLogbookPage(db, 0, 2);
    const secondPage = await getLocalProfileLogbookPage(db, 2, 2);
    expect(firstPage.entries.map((entry) => entry.uuid)).toEqual(['tick-2', 'tick-1']);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.entries.map((entry) => entry.uuid)).toEqual(['tick-0']);
    expect(secondPage.hasMore).toBe(false);
  });

  it('aggregates compact stats for only the stamped local owner', async () => {
    await insertTick(db, {
      uuid: 'flash',
      ownerId: LOCAL_OWNER,
      climbUuid: 'climb-1',
      status: 'flash',
      attempts: 1,
      climbedAt: '2026-08-01T12:00:00Z',
    });
    await insertTick(db, {
      uuid: 'send',
      ownerId: LOCAL_OWNER,
      climbUuid: 'climb-1',
      status: 'send',
      attempts: 3,
      climbedAt: '2026-08-02T12:00:00Z',
    });
    await insertTick(db, {
      uuid: 'project',
      ownerId: LOCAL_OWNER,
      climbUuid: 'climb-1',
      status: 'attempt',
      attempts: 2,
      climbedAt: '2026-08-03T12:00:00Z',
    });
    await insertTick(db, {
      uuid: 'other',
      ownerId: 'local:profile-2',
      climbUuid: 'climb-1',
      status: 'flash',
      attempts: 9,
      climbedAt: '2026-08-04T12:00:00Z',
    });

    await expect(getLocalProfileStats(db)).resolves.toEqual({ sends: 2, flashes: 1, attempts: 6 });
  });

  it('refuses to read an account-owned or unstamped database as a local profile', async () => {
    await stampLocalUserId(db, 'account-user');
    await expect(getLocalProfileLogbookPage(db, 0)).rejects.toThrow('Local profile owner is not initialized');
    await expect(getLocalProfileStats(db)).rejects.toThrow('Local profile owner is not initialized');
  });
});
