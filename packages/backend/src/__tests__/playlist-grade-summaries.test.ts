/**
 * Discover's grade and "Following" filters and the playlist grade band, end to
 * end against the real test Postgres: how a summary is computed, kept fresh by
 * the playlist mutations and the daily refresh, and how discoverPlaylists
 * filters on it (#6217, docs/playlist-grade-summaries.md).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, inArray, like, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { refreshAllPlaylistGradeSummaries, refreshPlaylistGradeSummariesFor } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';

const BOARD = 'kilter';
const PREFIX = 'pgs-test-';
const OWNER_ID = 'user-123'; // seeded by setup.ts
const FOLLOWED_ID = 'pgs-followed-setter';
const STRANGER_ID = 'pgs-stranger';

const climb = (name: string) => PREFIX + name;

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

const signedOut = makeCtx({ isAuthenticated: false, userId: undefined });

/** Stats rows at an angle. `ascents` decides which angle a null-angle row is graded at. */
async function insertStats(rows: Array<{ name: string; angle: number; grade: number | null; ascents?: number }>) {
  await db.insert(dbSchema.boardClimbStats).values(
    rows.map((row) => ({
      boardType: BOARD,
      climbUuid: climb(row.name),
      angle: row.angle,
      displayDifficulty: row.grade,
      ascensionistCount: row.ascents ?? 10,
    })),
  );
}

/** A public playlist owned by `ownerId`, holding these climbs (null angle = a synced circuit row). */
async function createPlaylist(
  uuid: string,
  ownerId: string,
  climbs: Array<{ name: string; angle: number | null }>,
): Promise<bigint> {
  const [playlist] = await db
    .insert(dbSchema.playlists)
    .values({ uuid, boardType: BOARD, layoutId: 1, name: uuid, isPublic: true })
    .returning({ id: dbSchema.playlists.id });
  await db.insert(dbSchema.playlistOwnership).values({ playlistId: playlist.id, userId: ownerId, role: 'owner' });
  if (climbs.length > 0) {
    await db.insert(dbSchema.playlistClimbs).values(
      climbs.map((entry, position) => ({
        playlistId: playlist.id,
        climbUuid: climb(entry.name),
        angle: entry.angle,
        position,
      })),
    );
  }
  return playlist.id;
}

async function summaryOf(playlistId: bigint) {
  const [row] = await db
    .select()
    .from(dbSchema.playlistGradeSummaries)
    .where(eq(dbSchema.playlistGradeSummaries.playlistId, playlistId));
  return row ?? null;
}

async function discover(input: Record<string, unknown>, ctx: ConnectionContext = signedOut) {
  const result = await playlistQueries.discoverPlaylists(null, { input: { pageSize: 50, ...input } }, ctx);
  return {
    uuids: (result.playlists as Array<{ uuid: string }>).map((playlist) => playlist.uuid).sort(),
    playlists: result.playlists as Array<{ uuid: string; gradeSummary: Record<string, number> | null }>,
    totalCount: result.totalCount,
  };
}

async function resetFixtures() {
  await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  await db.delete(dbSchema.boardClimbStats).where(like(dbSchema.boardClimbStats.climbUuid, `${PREFIX}%`));
  await db
    .delete(dbSchema.userFollows)
    .where(inArray(dbSchema.userFollows.followerId, [OWNER_ID, FOLLOWED_ID, STRANGER_ID]));
}

describe('playlist grade summaries', () => {
  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES
        (${FOLLOWED_ID}, 'pgs-followed@test.com', 'Followed Setter', now(), now()),
        (${STRANGER_ID}, 'pgs-stranger@test.com', 'Stranger', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    await resetFixtures();
  });

  afterAll(async () => {
    await resetFixtures();
  });

  describe('the summary', () => {
    it('takes the 10th..90th percentile band of rounded grades at each row’s own angle', async () => {
      // Nine climbs between 6a and 6c, plus one 8a outlier.
      const grades = [16, 16, 17, 18, 18, 18, 19, 20, 20, 28];
      await insertStats(grades.map((grade, index) => ({ name: `band-${index}`, angle: 40, grade: grade + 0.3 })));
      // Same climb at another angle carries a different grade the row must not use.
      await insertStats([{ name: 'band-0', angle: 50, grade: 30 }]);
      const playlistId = await createPlaylist(
        'band',
        OWNER_ID,
        grades.map((_, index) => ({ name: `band-${index}`, angle: 40 })),
      );

      await refreshPlaylistGradeSummariesFor(db, [playlistId]);

      expect(await summaryOf(playlistId)).toMatchObject({
        boardType: BOARD,
        gradedClimbCount: 10,
        minDifficulty: 16,
        p10Difficulty: 16,
        medianDifficulty: 18,
        p90Difficulty: 20,
        maxDifficulty: 28,
      });
    });

    it('grades a null-angle row at the climb’s most-repeated angle and skips climbs with no grade', async () => {
      await insertStats([
        { name: 'circuit-a', angle: 40, grade: 18, ascents: 300 },
        { name: 'circuit-a', angle: 50, grade: 24, ascents: 20 },
        // Ungraded at its most-repeated angle, so the graded one wins.
        { name: 'circuit-b', angle: 25, grade: null, ascents: 900 },
        { name: 'circuit-b', angle: 45, grade: 21.6, ascents: 4 },
        // Graded only at 40: a row saved at 35 has no grade and never falls back.
        { name: 'circuit-c', angle: 40, grade: 30, ascents: 50 },
        // A tie on ascents goes to the lower angle.
        { name: 'circuit-d', angle: 45, grade: 26, ascents: 70 },
        { name: 'circuit-d', angle: 40, grade: 20, ascents: 70 },
      ]);
      const playlistId = await createPlaylist('circuit', OWNER_ID, [
        { name: 'circuit-a', angle: null },
        { name: 'circuit-b', angle: null },
        // No stats row at all, and a row whose own angle has no stats row.
        { name: 'circuit-none', angle: null },
        { name: 'circuit-c', angle: 35 },
        { name: 'circuit-d', angle: null },
      ]);

      await refreshPlaylistGradeSummariesFor(db, [playlistId]);

      // circuit-a 18, circuit-b 22, circuit-d 20.
      expect(await summaryOf(playlistId)).toMatchObject({
        gradedClimbCount: 3,
        minDifficulty: 18,
        medianDifficulty: 20,
        maxDifficulty: 22,
      });
    });

    it('writes no row for a playlist without a graded climb', async () => {
      const playlistId = await createPlaylist('ungraded', OWNER_ID, [{ name: 'nothing', angle: 40 }]);
      await refreshPlaylistGradeSummariesFor(db, [playlistId]);
      expect(await summaryOf(playlistId)).toBeNull();
    });
  });

  describe('the playlist mutations', () => {
    it('recompute the band when a climb is added and when one is removed', async () => {
      await insertStats([
        { name: 'easy', angle: 40, grade: 16 },
        { name: 'hard', angle: 40, grade: 24 },
      ]);
      const playlistId = await createPlaylist('editing', OWNER_ID, []);
      // Another playlist's summary must survive every recompute of this one.
      const bystander = await createPlaylist('bystander', OWNER_ID, [{ name: 'hard', angle: 40 }]);
      await refreshPlaylistGradeSummariesFor(db, [bystander]);
      const ctx = makeCtx();

      await playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: 'editing', climbUuid: climb('easy'), angle: 40 } },
        ctx,
      );
      expect(await summaryOf(playlistId)).toMatchObject({ gradedClimbCount: 1, maxDifficulty: 16 });

      await playlistMutations.addClimbToPlaylist(
        null,
        { input: { playlistId: 'editing', climbUuid: climb('hard'), angle: 40 } },
        ctx,
      );
      expect(await summaryOf(playlistId)).toMatchObject({ gradedClimbCount: 2, minDifficulty: 16, maxDifficulty: 24 });

      await playlistMutations.removeClimbFromPlaylist(
        null,
        { input: { playlistId: 'editing', climbUuid: climb('easy') } },
        ctx,
      );
      expect(await summaryOf(playlistId)).toMatchObject({ gradedClimbCount: 1, minDifficulty: 24 });

      await playlistMutations.removeClimbFromPlaylist(
        null,
        { input: { playlistId: 'editing', climbUuid: climb('hard') } },
        ctx,
      );
      expect(await summaryOf(playlistId)).toBeNull();
      expect(await summaryOf(bystander)).toMatchObject({ gradedClimbCount: 1, p10Difficulty: 24 });
    });
  });

  describe('the daily refresh', () => {
    it('writes only the summaries whose values moved, and deletes the ones left ungraded', async () => {
      await insertStats([
        { name: 'steady', angle: 40, grade: 18 },
        { name: 'drifting', angle: 40, grade: 20 },
        { name: 'vanishing', angle: 40, grade: 22 },
      ]);
      const steady = await createPlaylist('steady', OWNER_ID, [{ name: 'steady', angle: 40 }]);
      const drifting = await createPlaylist('drifting', OWNER_ID, [{ name: 'drifting', angle: 40 }]);
      const vanishing = await createPlaylist('vanishing', OWNER_ID, [{ name: 'vanishing', angle: 40 }]);

      // The first run is the backfill: every graded playlist gets a row.
      const first = await refreshAllPlaylistGradeSummaries(db);
      expect(first).toMatchObject({ written: 3, deleted: 0, completed: true });
      // Make an untouched row's updated_at recognisable.
      await db
        .update(dbSchema.playlistGradeSummaries)
        .set({ updatedAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(dbSchema.playlistGradeSummaries.playlistId, steady));

      // Nothing changed: no writes at all.
      expect(await refreshAllPlaylistGradeSummaries(db)).toMatchObject({ written: 0, deleted: 0, completed: true });

      // An upstream sync regrades one climb and ungrades another.
      await db
        .update(dbSchema.boardClimbStats)
        .set({ displayDifficulty: 23 })
        .where(eq(dbSchema.boardClimbStats.climbUuid, climb('drifting')));
      await db
        .update(dbSchema.boardClimbStats)
        .set({ displayDifficulty: null })
        .where(eq(dbSchema.boardClimbStats.climbUuid, climb('vanishing')));

      expect(await refreshAllPlaylistGradeSummaries(db)).toMatchObject({ written: 1, deleted: 1, completed: true });
      expect(await summaryOf(drifting)).toMatchObject({ p10Difficulty: 23, p90Difficulty: 23 });
      expect(await summaryOf(vanishing)).toBeNull();
      expect((await summaryOf(steady))?.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('walks every chunk and deletes only inside the chunk it is on', async () => {
      const names = ['c0', 'c1', 'c2', 'c3', 'c4'];
      await insertStats(names.map((name, index) => ({ name, angle: 40, grade: 16 + index })));
      const ids = [];
      for (const name of names) ids.push(await createPlaylist(name, OWNER_ID, [{ name, angle: 40 }]));

      expect(await refreshAllPlaylistGradeSummaries(db, { chunkPlaylists: 2 })).toMatchObject({
        written: 5,
        deleted: 0,
        chunks: 3,
        completed: true,
      });

      // Ungrade the playlist in the middle chunk.
      await db
        .update(dbSchema.boardClimbStats)
        .set({ displayDifficulty: null })
        .where(eq(dbSchema.boardClimbStats.climbUuid, climb('c2')));
      expect(await refreshAllPlaylistGradeSummaries(db, { chunkPlaylists: 2 })).toMatchObject({
        written: 0,
        deleted: 1,
        chunks: 3,
        completed: true,
      });
      expect(await summaryOf(ids[2])).toBeNull();
      for (const index of [0, 1, 3, 4]) {
        expect(await summaryOf(ids[index])).toMatchObject({ p10Difficulty: 16 + index });
      }
    });

    it('stops between chunks when its budget runs out', async () => {
      const names = ['b0', 'b1', 'b2'];
      await insertStats(names.map((name) => ({ name, angle: 40, grade: 18 })));
      const ids = [];
      for (const name of names) ids.push(await createPlaylist(name, OWNER_ID, [{ name, angle: 40 }]));

      let chunksAllowed = 1;
      const stopped = await refreshAllPlaylistGradeSummaries(db, {
        chunkPlaylists: 2,
        shouldContinue: () => chunksAllowed-- > 0,
      });

      expect(stopped).toMatchObject({ written: 2, chunks: 1, completed: false });
      expect(await summaryOf(ids[0])).not.toBeNull();
      expect(await summaryOf(ids[2])).toBeNull();
    });

    it('leaves alone a summary written after its clock read, which only a racing mutation could write', async () => {
      await insertStats([{ name: 'raced', angle: 40, grade: 18 }]);
      const raced = await createPlaylist('raced', OWNER_ID, [{ name: 'raced', angle: 40 }]);
      const orphan = await createPlaylist('orphan', OWNER_ID, [{ name: 'no-grade', angle: 40 }]);
      // Stand-ins for rows a mutation wrote while the job was computing: a later
      // updated_at than the job's clock read, and values the job would change.
      const later = sql`localtimestamp + interval '1 hour'`;
      await db.insert(dbSchema.playlistGradeSummaries).values([
        {
          playlistId: raced,
          boardType: BOARD,
          gradedClimbCount: 2,
          minDifficulty: 18,
          p10Difficulty: 18,
          medianDifficulty: 18,
          p90Difficulty: 24,
          maxDifficulty: 24,
          updatedAt: later,
        },
        {
          playlistId: orphan,
          boardType: BOARD,
          gradedClimbCount: 1,
          minDifficulty: 20,
          p10Difficulty: 20,
          medianDifficulty: 20,
          p90Difficulty: 20,
          maxDifficulty: 20,
          updatedAt: later,
        },
      ]);

      expect(await refreshAllPlaylistGradeSummaries(db)).toMatchObject({ written: 0, deleted: 0 });
      expect(await summaryOf(raced)).toMatchObject({ gradedClimbCount: 2, p90Difficulty: 24 });
      expect(await summaryOf(orphan)).not.toBeNull();

      // The mutation path has no such guard: it always writes what it just read.
      await refreshPlaylistGradeSummariesFor(db, [raced, orphan]);
      expect(await summaryOf(raced)).toMatchObject({ gradedClimbCount: 1, p90Difficulty: 18 });
      expect(await summaryOf(orphan)).toBeNull();
    });
  });

  describe('discoverPlaylists', () => {
    async function seedDiscoverFixtures() {
      // V3–V5 with one V11 outlier: the band ignores the outlier.
      const moderate = [16, 16, 17, 18, 18, 19, 20, 20, 20, 28];
      await insertStats(moderate.map((grade, index) => ({ name: `moderate-${index}`, angle: 40, grade })));
      await insertStats([
        { name: 'hard-0', angle: 40, grade: 24 },
        { name: 'hard-1', angle: 40, grade: 25 },
        { name: 'hard-2', angle: 40, grade: 26 },
      ]);
      await createPlaylist(
        'moderate',
        OWNER_ID,
        moderate.map((_, index) => ({ name: `moderate-${index}`, angle: 40 })),
      );
      await createPlaylist('hard', FOLLOWED_ID, [
        { name: 'hard-0', angle: 40 },
        { name: 'hard-1', angle: 40 },
        { name: 'hard-2', angle: 40 },
      ]);
      await createPlaylist('ungraded', STRANGER_ID, [
        { name: 'unknown-0', angle: 40 },
        { name: 'unknown-1', angle: 40 },
      ]);
      await refreshAllPlaylistGradeSummaries(db);
    }

    it('returns each playlist’s grade band, null when it has none', async () => {
      await seedDiscoverFixtures();
      const { playlists } = await discover({});
      const byUuid = new Map(playlists.map((playlist) => [playlist.uuid, playlist.gradeSummary]));
      expect(byUuid.get('moderate')).toEqual({
        gradedClimbCount: 10,
        minDifficulty: 16,
        p10Difficulty: 16,
        medianDifficulty: 18,
        p90Difficulty: 20,
        maxDifficulty: 28,
      });
      expect(byUuid.get('hard')).toMatchObject({ p10Difficulty: 24, p90Difficulty: 26 });
      expect(byUuid.get('ungraded')).toBeNull();
    });

    it('keeps a playlist whose 10th..90th band sits inside the bounds, whatever its outliers', async () => {
      await seedDiscoverFixtures();
      expect(await discover({ minGrade: 16, maxGrade: 20 })).toMatchObject({ uuids: ['moderate'], totalCount: 1 });
      // The band ends at 20, so a ceiling of 19 drops it.
      expect(await discover({ minGrade: 16, maxGrade: 19 })).toMatchObject({ uuids: [], totalCount: 0 });
      expect(await discover({ minGrade: 22 })).toMatchObject({ uuids: ['hard'], totalCount: 1 });
      expect(await discover({ maxGrade: 26 })).toMatchObject({ uuids: ['hard', 'moderate'], totalCount: 2 });
    });

    it('leaves out playlists with no graded climb whenever a grade bound is set', async () => {
      await seedDiscoverFixtures();
      expect((await discover({})).uuids).toEqual(['hard', 'moderate', 'ungraded']);
      expect((await discover({ minGrade: 1, maxGrade: 100 })).uuids).toEqual(['hard', 'moderate']);
    });

    it('keeps totalCount in step when the grade band and the size band combine', async () => {
      await seedDiscoverFixtures();
      // `moderate` has 10 climbs, `hard` 3.
      expect(await discover({ minGrade: 10, maxGrade: 30, minClimbs: 5 })).toMatchObject({
        uuids: ['moderate'],
        totalCount: 1,
      });
      expect(await discover({ minGrade: 10, maxGrade: 30, maxClimbs: 5 })).toMatchObject({
        uuids: ['hard'],
        totalCount: 1,
      });
    });

    it('rejects an inverted grade band', async () => {
      await expect(discover({ minGrade: 20, maxGrade: 16 })).rejects.toThrow(/minGrade/);
    });

    it('limits followedOnly to the creators the signed-in viewer follows', async () => {
      await seedDiscoverFixtures();
      await db.insert(dbSchema.userFollows).values({ followerId: OWNER_ID, followingId: FOLLOWED_ID });

      expect(await discover({ followedOnly: true }, makeCtx())).toMatchObject({ uuids: ['hard'], totalCount: 1 });
      // Combines with the grade band.
      expect(await discover({ followedOnly: true, maxGrade: 20 }, makeCtx())).toMatchObject({
        uuids: [],
        totalCount: 0,
      });
      // Another viewer's follows are theirs: the stranger follows nobody.
      expect(await discover({ followedOnly: true }, makeCtx({ userId: STRANGER_ID }))).toMatchObject({
        uuids: [],
        totalCount: 0,
      });
      // Off, everyone's playlists come back.
      expect((await discover({ followedOnly: false }, makeCtx())).uuids).toEqual(['hard', 'moderate', 'ungraded']);
    });

    it('answers followedOnly with an empty page when signed out', async () => {
      await seedDiscoverFixtures();
      await db.insert(dbSchema.userFollows).values({ followerId: OWNER_ID, followingId: FOLLOWED_ID });

      expect(await playlistQueries.discoverPlaylists(null, { input: { followedOnly: true } }, signedOut)).toEqual({
        playlists: [],
        totalCount: 0,
        hasMore: false,
      });
    });
  });
});
