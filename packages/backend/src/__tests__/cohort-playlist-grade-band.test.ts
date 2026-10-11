/**
 * The nightly recommendations job swaps a cohort playlist's climbs and
 * recomputes its grade band in one transaction (packages/db/src/jobs/
 * refresh-recommendations.ts). These pin the transaction shape that call
 * relies on: a recompute nested in a caller's transaction sees the swapped
 * climbs, commits with them, rolls back with them, and fails alone in its
 * savepoint when the caller catches the failure. The job path itself,
 * under the batch worker's login, is covered in job-queue-roles.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, like, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { refreshPlaylistGradeSummariesFor } from '@boardsesh/db/queries';
import { describeBandFailure } from '@boardsesh/db/jobs';
import { db } from '../db/client';

const BOARD = 'kilter';
const PREFIX = 'cohort-band-test-';
const OWNER_ID = 'user-123'; // seeded by setup.ts

const climb = (name: string) => PREFIX + name;
/** `PLAYLIST_GRADE_SUMMARY_LOCK_NAMESPACE` in grade-summaries.ts. */
const PLAYLIST_LOCK_NAMESPACE = 0x5047534c;

async function resetFixtures() {
  await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  await db.delete(dbSchema.boardClimbStats).where(like(dbSchema.boardClimbStats.climbUuid, `${PREFIX}%`));
}

/** A public playlist holding `easy` at 40°, graded 16 at that angle; `hard` is graded 24. */
async function seedPlaylist(): Promise<bigint> {
  await db.insert(dbSchema.boardClimbStats).values([
    { boardType: BOARD, climbUuid: climb('easy'), angle: 40, displayDifficulty: 16, ascensionistCount: 10 },
    { boardType: BOARD, climbUuid: climb('hard'), angle: 40, displayDifficulty: 24, ascensionistCount: 10 },
  ]);
  const [playlist] = await db
    .insert(dbSchema.playlists)
    .values({ uuid: `${PREFIX}playlist`, boardType: BOARD, layoutId: 1, name: 'Crowd Favorites', isPublic: true })
    .returning({ id: dbSchema.playlists.id });
  await db.insert(dbSchema.playlistOwnership).values({ playlistId: playlist.id, userId: OWNER_ID, role: 'owner' });
  await db.insert(dbSchema.playlistClimbs).values({ playlistId: playlist.id, climbUuid: climb('easy'), angle: 40 });
  await refreshPlaylistGradeSummariesFor(db, [playlist.id]);
  return playlist.id;
}

/** The job's swap: replace every climb with `hard`, then recompute, all in `transaction`. */
async function swapToHard(transaction: Parameters<Parameters<typeof db.transaction>[0]>[0], playlistId: bigint) {
  await transaction.delete(dbSchema.playlistClimbs).where(eq(dbSchema.playlistClimbs.playlistId, playlistId));
  await transaction.insert(dbSchema.playlistClimbs).values({ playlistId, climbUuid: climb('hard'), angle: 40 });
  await refreshPlaylistGradeSummariesFor(transaction, [playlistId]);
}

/** The playlist's grade-summary lock, held by another connection while `run` runs. */
async function withPlaylistLockHeld<T>(playlistId: bigint, run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  let locked!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const lockTaken = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(${PLAYLIST_LOCK_NAMESPACE}, (${playlistId}::bigint % 2147483647)::int)`,
    );
    locked();
    await released;
  });
  await lockTaken;
  try {
    return await run();
  } finally {
    release();
    await holder;
  }
}

async function maxDifficultyOf(playlistId: bigint) {
  const [row] = await db
    .select({ maxDifficulty: dbSchema.playlistGradeSummaries.maxDifficulty })
    .from(dbSchema.playlistGradeSummaries)
    .where(eq(dbSchema.playlistGradeSummaries.playlistId, playlistId));
  return row?.maxDifficulty ?? null;
}

describe('cohort playlist grade band', () => {
  beforeEach(resetFixtures);
  afterAll(resetFixtures);

  it('commits the recomputed band with the swapped climbs', async () => {
    const playlistId = await seedPlaylist();
    expect(await maxDifficultyOf(playlistId)).toBe(16);

    await db.transaction((transaction) => swapToHard(transaction, playlistId));

    expect(await maxDifficultyOf(playlistId)).toBe(24);
  });

  it('rolls the band back when the swap fails after it', async () => {
    const playlistId = await seedPlaylist();

    await expect(
      db.transaction(async (transaction) => {
        await swapToHard(transaction, playlistId);
        throw new Error('swap failed');
      }),
    ).rejects.toThrow('swap failed');

    expect(await maxDifficultyOf(playlistId)).toBe(16);
  });

  it('keeps the swap and the old band when the recompute times out on its lock and the caller catches it', async () => {
    const playlistId = await seedPlaylist();
    const failure = await withPlaylistLockHeld(playlistId, () =>
      db.transaction(async (transaction) => {
        await transaction.delete(dbSchema.playlistClimbs).where(eq(dbSchema.playlistClimbs.playlistId, playlistId));
        await transaction.insert(dbSchema.playlistClimbs).values({ playlistId, climbUuid: climb('hard'), angle: 40 });
        await transaction.execute(sql`SET LOCAL lock_timeout = '100ms'`);
        try {
          await refreshPlaylistGradeSummariesFor(transaction, [playlistId]);
          return null;
        } catch (error) {
          return error;
        }
      }),
    );

    expect(describeBandFailure(failure)).toMatch(/SQLSTATE 55P03$/);
    const climbs = await db
      .select({ climbUuid: dbSchema.playlistClimbs.climbUuid })
      .from(dbSchema.playlistClimbs)
      .where(eq(dbSchema.playlistClimbs.playlistId, playlistId));
    expect(climbs).toEqual([{ climbUuid: climb('hard') }]);
    expect(await maxDifficultyOf(playlistId)).toBe(16);
  });

  it('describes a failed recompute by class and SQLSTATE, never by its SQL or parameters', async () => {
    const playlistId = await seedPlaylist();
    const failure = await withPlaylistLockHeld(playlistId, () =>
      db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '100ms'`);
        return refreshPlaylistGradeSummariesFor(transaction, [playlistId]).then(
          () => null,
          (error: unknown) => error,
        );
      }),
    );

    const description = describeBandFailure(failure);
    expect(description).toBe('PostgresError, SQLSTATE 55P03');
    expect(description).not.toMatch(/Failed query|params:|SELECT|INSERT/);
  });
});
