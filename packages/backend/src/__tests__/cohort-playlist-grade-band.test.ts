/**
 * The nightly recommendations job swaps a cohort playlist's climbs and
 * recomputes its grade band in one transaction (packages/db/src/jobs/
 * refresh-recommendations.ts). These pin the transaction shape that call
 * relies on: a recompute nested in a caller's transaction sees the swapped
 * climbs, commits with them and rolls back with them; and the job's own step
 * (`refreshCohortPlaylistBand`) keeps the swap and warns boundedly when the
 * recompute fails. The whole job under the batch worker's login is covered
 * in job-queue-roles.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, like, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { refreshPlaylistGradeSummariesFor } from '@boardsesh/db/queries';
import { describeBandFailure, refreshCohortPlaylistBand } from '@boardsesh/db/jobs';
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The job's swap: replace every climb with `hard`, in `transaction`. */
async function swapClimbsToHard(transaction: Transaction, playlistId: bigint) {
  await transaction.delete(dbSchema.playlistClimbs).where(eq(dbSchema.playlistClimbs.playlistId, playlistId));
  await transaction.insert(dbSchema.playlistClimbs).values({ playlistId, climbUuid: climb('hard'), angle: 40 });
}

/** The swap followed by a nested recompute, all in `transaction`. */
async function swapToHard(transaction: Transaction, playlistId: bigint) {
  await swapClimbsToHard(transaction, playlistId);
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

  it('the job step commits the new band with the swap', async () => {
    const playlistId = await seedPlaylist();
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (message: string) => warnings.push(message) };

    const lockTimeoutAfter = await db.transaction(async (transaction) => {
      await swapClimbsToHard(transaction, playlistId);
      await refreshCohortPlaylistBand(transaction, playlistId, 'Crowd Favorites', log);
      const rows = (await transaction.execute(sql`SHOW lock_timeout`)) as unknown as Array<{ lock_timeout: string }>;
      return rows[0].lock_timeout;
    });

    expect(lockTimeoutAfter).toBe('0');
    expect(await maxDifficultyOf(playlistId)).toBe(24);
    expect(warnings).toEqual([]);
  });

  it('the job step keeps the swap and the old band, and warns boundedly, when the lock is held', async () => {
    const playlistId = await seedPlaylist();
    const warnings: Array<{ message: string; title?: string }> = [];
    const log = {
      info: () => {},
      warn: (message: string, details?: { title?: string }) => warnings.push({ message, title: details?.title }),
    };

    // Held past the job's 5 s lock_timeout.
    const lockTimeoutAfter = await withPlaylistLockHeld(playlistId, () =>
      db.transaction(async (transaction) => {
        await swapClimbsToHard(transaction, playlistId);
        await refreshCohortPlaylistBand(transaction, playlistId, 'Crowd Favorites', log);
        // The step's lock_timeout rolled back with its savepoint, so the rest
        // of the job's transaction runs without it.
        const rows = (await transaction.execute(sql`SHOW lock_timeout`)) as unknown as Array<{ lock_timeout: string }>;
        return rows[0].lock_timeout;
      }),
    );
    expect(lockTimeoutAfter).toBe('0');

    const climbs = await db
      .select({ climbUuid: dbSchema.playlistClimbs.climbUuid })
      .from(dbSchema.playlistClimbs)
      .where(eq(dbSchema.playlistClimbs.playlistId, playlistId));
    expect(climbs).toEqual([{ climbUuid: climb('hard') }]);
    expect(await maxDifficultyOf(playlistId)).toBe(16);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].title).toBe('grade band skipped');
    expect(warnings[0].message).toContain('PostgresError, SQLSTATE 55P03');
    expect(warnings[0].message).not.toMatch(/Failed query|params:|SELECT|INSERT/);
  }, 20_000);

  it('describes a failure by its driver class and SQLSTATE only', () => {
    const cause = Object.assign(new Error('permission denied for table playlist_grade_summaries'), { code: '42501' });
    const wrapped = new Error('Failed query: INSERT INTO playlist_grade_summaries ...\nparams: 1', { cause });
    expect(describeBandFailure(wrapped)).toBe('Error, SQLSTATE 42501');
    expect(describeBandFailure('not an error')).toBe('unknown error, SQLSTATE none');
  });
});
