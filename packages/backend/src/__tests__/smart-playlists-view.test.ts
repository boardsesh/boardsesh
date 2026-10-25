import { describe, it, expect, beforeAll, afterAll, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import { users } from '@boardsesh/db/schema';
import { getGradeLabel, withSerialPlan } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// The real guard, wrapped in a spy so a test can see the view path take it.
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return { ...actual, withSerialPlan: vi.fn(actual.withSerialPlan) };
});

// Integration tests (real DB) for #6651, part 3: `smartPlaylist` takes the same
// optional `view` as `playlistClimbs`. Without one it must answer exactly as
// before; with one, the list keeps its own membership, `position` is its own
// order, and the sorts, filters and counts read the same as a playlist's.
//
// Seeds use raw `sql` for the same reason as playlist-climbs-view.test.ts: the
// test DB is a hand-maintained DDL, not the full Drizzle schema.

const OWNER = 'smart-view-owner';
const STRANGER = 'smart-view-stranger';
const PRIVATE_OWNER = 'smart-view-private';
// A public logbook with a tick hidden from everyone else and a tick on its own
// draft climb, read by STRANGER: the privacy cases.
const GUARDED_OWNER = 'smart-view-guarded';
// A logbook whose attempt totals tie, for the tie-break.
const TIE_OWNER = 'smart-view-ties';
// Attempt totals tied across two board types, where the climb uuid order
// (what GROUP BY hands the sort) is not the (board_type, climb_uuid) order.
const BOARD_TIE_OWNER = 'smart-view-board-ties';
// A logbook holding a climb whose most-ascended angle is a tie, for the display angle.
const ANGLE_OWNER = 'smart-view-angles';

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: false,
    userId: null,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
    ...overrides,
  } as ConnectionContext;
}

const anonymous = makeCtx();
const owner = makeCtx({ isAuthenticated: true, userId: OWNER });
const stranger = makeCtx({ isAuthenticated: true, userId: STRANGER });

type SmartInput = Parameters<typeof playlistQueries.smartPlaylist>[1]['input'];

const ACTIVE_KILTER = { activeBoardName: 'kilter', activeAngle: 40, activeLayoutId: 1, activeSizeId: 10 };

async function fetchSmart(input: Omit<SmartInput, 'userId'> & { userId?: string }, ctx: ConnectionContext = owner) {
  return playlistQueries.smartPlaylist(null, { input: { userId: OWNER, ...input } }, ctx);
}

async function uuids(input: Omit<SmartInput, 'userId'> & { userId?: string }, ctx: ConnectionContext = owner) {
  const result = await fetchSmart({ pageSize: 100, ...input }, ctx);
  return result.climbs.map((climb) => climb.uuid);
}

/** Every row a client can reach by paging, `pageSize` at a time. */
async function pageThrough(input: Omit<SmartInput, 'userId'> & { userId?: string }, pageSize: number, ctx = owner) {
  const collected: string[] = [];
  let totalCount = -1;
  for (let page = 0; page < 20; page++) {
    const result = await fetchSmart({ ...input, page, pageSize }, ctx);
    totalCount = result.totalCount;
    collected.push(...result.climbs.map((climb) => climb.uuid));
    if (!result.hasMore) break;
  }
  return { collected, totalCount };
}

async function seedClimb(uuid: string, boardType: string, layoutId: number, name: string) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, frames_count, compatible_size_ids, required_set_ids)
    VALUES (${uuid}, ${boardType}, ${layoutId}, 'setter', ${name}, '', 'p1r12', true, false, 1,
            ${boardType === 'kilter' ? '{10}' : null}::int[], ${boardType === 'kilter' ? '{1}' : null}::int[])
  `);
}

async function seedStats(
  boardType: string,
  uuid: string,
  angle: number,
  displayDifficulty: number,
  quality: number,
  ascents: number,
) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, quality_average, ascensionist_count, benchmark_difficulty)
    VALUES (${boardType}, ${uuid}, ${angle}, ${displayDifficulty}, ${displayDifficulty}, ${quality}, ${ascents}, 0)
  `);
}

async function seedTick(tick: {
  uuid: string;
  userId?: string;
  climbUuid: string;
  boardType?: string;
  angle?: number;
  status: 'send' | 'attempt' | 'flash';
  attempts: number;
  quality?: number | null;
  climbedAt: string;
}) {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, quality, climbed_at)
    VALUES (${tick.uuid}, ${tick.userId ?? OWNER}, ${tick.boardType ?? 'kilter'}, ${tick.climbUuid}, ${tick.angle ?? 40},
            ${tick.status}::tick_status, ${tick.attempts}, ${tick.quality ?? null}, ${tick.climbedAt})
  `);
}

// Each logbook list's own order, from the seed below.
const NATURAL: Record<'FIVE_STARS' | 'MOST_REPEATED' | 'PROJECTS' | 'LIKED_CLIMBS', string[]> = {
  // Latest five-star climb first.
  FIVE_STARS: ['k-1', 't-1', 'k-3', 'k-5'],
  // Most attempts first (more than one).
  MOST_REPEATED: ['k-5', 'k-4', 'k-3', 'k-1', 'k-2'],
  // Never sent, most attempts first.
  PROJECTS: ['k-5', 'k-4', 'k-2'],
  // Most recently liked first.
  LIKED_CLIMBS: ['k-2', 't-1', 'k-4', 'k-1'],
};
const SMART_TYPES = Object.keys(NATURAL) as Array<keyof typeof NATURAL>;

// The recommendations take no view: already ranked for the climber, and a view
// over their whole candidate set costs seconds a page.
const RECOMMENDED_TYPES = [
  'RECOMMENDED_CROWD_FAVORITES',
  'RECOMMENDED_HIDDEN_GEMS',
  'RECOMMENDED_AT_LEVEL',
  'RECOMMENDED_FRESH',
] as const;
// Crowd favourites without a view: ln(ascents + 1) × quality at 40°, without
// the owner's sends there (k-1, k-3).
const CROWD_FAVORITES = ['k-5', 'k-2', 'k-6', 'k-4'];

describe('smartPlaylist — views (real DB, #6651)', () => {
  beforeAll(async () => {
    await db
      .insert(users)
      .values(
        [OWNER, STRANGER, PRIVATE_OWNER, GUARDED_OWNER, TIE_OWNER, BOARD_TIE_OWNER, ANGLE_OWNER].map((id) => ({
          id,
          email: `${id}@test.invalid`,
        })),
      )
      .onConflictDoNothing();
    await db.execute(sql`INSERT INTO user_profiles (user_id, is_private) VALUES (${PRIVATE_OWNER}, true)`);
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id IN (${OWNER}, ${PRIVATE_OWNER}, ${BOARD_TIE_OWNER})`);

    // Kilter layout 1 (size 10, set 1) and one Tension climb. The grade each
    // logbook row shows is its most-ascended angle's: k-4 shows 20 (at 50°).
    await seedClimb('k-1', 'kilter', 1, 'Alpha');
    await seedClimb('k-2', 'kilter', 1, 'Bravo');
    await seedClimb('k-3', 'kilter', 1, 'Charlie');
    await seedClimb('k-4', 'kilter', 1, 'Delta');
    await seedClimb('k-5', 'kilter', 1, 'Echo');
    await seedClimb('k-6', 'kilter', 1, 'Golf');
    await seedClimb('t-1', 'tension', 9, 'Foxtrot');
    await seedStats('kilter', 'k-1', 40, 12, 4.5, 100);
    await seedStats('kilter', 'k-2', 40, 18, 4.2, 60);
    await seedStats('kilter', 'k-3', 40, 22, 4.8, 30);
    await seedStats('kilter', 'k-4', 40, 15, 4.1, 25);
    await seedStats('kilter', 'k-4', 50, 20, 3.0, 200);
    await seedStats('kilter', 'k-5', 40, 20, 4.6, 80);
    await seedStats('kilter', 'k-6', 40, 14, 4.3, 40);
    await seedStats('tension', 't-1', 30, 16, 3.0, 10);

    await seedTick({
      uuid: 'sv-1',
      climbUuid: 'k-1',
      status: 'send',
      attempts: 1,
      quality: 5,
      climbedAt: '2026-06-05 10:00',
    });
    await seedTick({ uuid: 'sv-2', climbUuid: 'k-1', status: 'attempt', attempts: 2, climbedAt: '2026-06-02 10:00' });
    await seedTick({
      uuid: 'sv-3',
      climbUuid: 'k-3',
      status: 'send',
      attempts: 4,
      quality: 5,
      climbedAt: '2026-06-03 10:00',
    });
    await seedTick({
      uuid: 'sv-4',
      climbUuid: 't-1',
      boardType: 'tension',
      angle: 30,
      status: 'send',
      attempts: 1,
      quality: 5,
      climbedAt: '2026-06-04 10:00',
    });
    await seedTick({
      uuid: 'sv-5',
      climbUuid: 'k-5',
      status: 'attempt',
      attempts: 6,
      quality: 5,
      climbedAt: '2026-06-01 10:00',
    });
    await seedTick({ uuid: 'sv-6', climbUuid: 'k-2', status: 'attempt', attempts: 2, climbedAt: '2026-06-06 10:00' });
    await seedTick({ uuid: 'sv-7', climbUuid: 'k-4', status: 'attempt', attempts: 5, climbedAt: '2026-06-07 10:00' });
    await seedTick({
      uuid: 'sv-8',
      userId: PRIVATE_OWNER,
      climbUuid: 'k-1',
      status: 'attempt',
      attempts: 3,
      climbedAt: '2026-06-07 10:00',
    });

    // STRANGER sent k-2, which OWNER only tried, and never touched k-1, which OWNER sent.
    await seedTick({
      uuid: 'sv-9',
      userId: STRANGER,
      climbUuid: 'k-2',
      status: 'send',
      attempts: 1,
      climbedAt: '2026-06-08 10:00',
    });

    // GUARDED_OWNER: a five-star send of k-1 anyone may read, a five-star tick on
    // k-3 kept to themselves, one on their own draft climb, one on k-ghost, a
    // climb with no board_climbs row, and one on k-merged, a catalog-dedup alias
    // of k-1 (an alias has no board_climbs row of its own).
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, user_id, frames_count, compatible_size_ids)
      VALUES ('k-draft', 'kilter', 1, 'setter', 'Hotel', '', 'p1r12', true, true, ${GUARDED_OWNER}, 1, '{10}'::int[])
    `);
    await seedTick({
      uuid: 'sv-g1',
      userId: GUARDED_OWNER,
      climbUuid: 'k-1',
      status: 'send',
      attempts: 2,
      quality: 5,
      climbedAt: '2026-06-05 10:00',
    });
    await seedTick({
      uuid: 'sv-g2',
      userId: GUARDED_OWNER,
      climbUuid: 'k-3',
      status: 'attempt',
      attempts: 3,
      quality: 5,
      climbedAt: '2026-06-06 10:00',
    });
    await seedTick({
      uuid: 'sv-g3',
      userId: GUARDED_OWNER,
      climbUuid: 'k-draft',
      status: 'attempt',
      attempts: 2,
      quality: 5,
      climbedAt: '2026-06-07 10:00',
    });
    await seedTick({
      uuid: 'sv-g4',
      userId: GUARDED_OWNER,
      climbUuid: 'k-ghost',
      status: 'attempt',
      attempts: 2,
      quality: 5,
      climbedAt: '2026-06-08 10:00',
    });
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES ('kilter', 'k-merged', 'k-1', 'test')
    `);
    await seedTick({
      uuid: 'sv-g5',
      userId: GUARDED_OWNER,
      climbUuid: 'k-merged',
      status: 'attempt',
      attempts: 2,
      quality: 5,
      climbedAt: '2026-06-09 10:00',
    });
    await db.execute(sql`
      INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
      VALUES ('tick', 'sv-g2', ${GUARDED_OWNER}, 'only_me')
    `);

    // TIE_OWNER: k-4 tried 5 times, then k-6, k-2 and k-5 three times each.
    for (const [index, [climbUuid, attempts]] of (
      [
        ['k-6', 3],
        ['k-4', 5],
        ['k-2', 3],
        ['k-5', 3],
      ] as const
    ).entries()) {
      await seedTick({
        uuid: `sv-t${index}`,
        userId: TIE_OWNER,
        climbUuid,
        status: 'attempt',
        attempts,
        climbedAt: `2026-06-0${index + 1} 10:00`,
      });
    }

    // BOARD_TIE_OWNER: three attempts each on Kilter k-2 and z-tie and Tension t-1,
    // all five-star and climbed at the same moment, and all three liked at once.
    await seedClimb('z-tie', 'kilter', 1, 'Juliet');
    for (const [index, [climbUuid, boardType]] of (
      [
        ['k-2', 'kilter'],
        ['t-1', 'tension'],
        ['z-tie', 'kilter'],
      ] as const
    ).entries()) {
      await seedTick({
        uuid: `sv-b${index}`,
        userId: BOARD_TIE_OWNER,
        climbUuid,
        boardType,
        angle: boardType === 'tension' ? 30 : 40,
        status: 'attempt',
        attempts: 3,
        quality: 5,
        climbedAt: '2026-06-01 10:00',
      });
    }
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at) VALUES
        (${BOARD_TIE_OWNER}, 'kilter', 'k-2', 40, '2026-06-01 10:00'),
        (${BOARD_TIE_OWNER}, 'tension', 't-1', 30, '2026-06-01 10:00'),
        (${BOARD_TIE_OWNER}, 'kilter', 'z-tie', 40, '2026-06-01 10:00')
    `);

    // ANGLE_OWNER: k-tie has 8 ascents at both 15° (a 10) and 30° (a 16), and is
    // a 20 at 40°; beside it k-1 (12 at 40°) and k-2 (18 at 40°).
    await seedClimb('k-tie', 'kilter', 1, 'India');
    await seedStats('kilter', 'k-tie', 15, 10, 3.0, 8);
    await seedStats('kilter', 'k-tie', 30, 16, 3.0, 8);
    await seedStats('kilter', 'k-tie', 40, 20, 3.0, 2);
    for (const [index, climbUuid] of ['k-tie', 'k-1', 'k-2'].entries()) {
      await seedTick({
        uuid: `sv-a${index}`,
        userId: ANGLE_OWNER,
        climbUuid,
        status: 'attempt',
        attempts: 2,
        climbedAt: `2026-06-0${index + 1} 10:00`,
      });
    }

    // k-2 liked twice (two angles): the later like is when it entered the list.
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at) VALUES
        (${OWNER}, 'kilter', 'k-2', 40, '2026-06-10 10:00'),
        (${OWNER}, 'kilter', 'k-2', 50, '2026-06-01 10:00'),
        (${OWNER}, 'tension', 't-1', 30, '2026-06-09 10:00'),
        (${OWNER}, 'kilter', 'k-4', 40, '2026-06-08 10:00'),
        (${OWNER}, 'kilter', 'k-1', 40, '2026-06-07 10:00')
    `);

    // The recommendations' board: Kilter layout 1, size 10, set 1, at 40°.
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, angle)
      VALUES ('smart-view-board', 'smart-view-board', ${OWNER}, 'kilter', 1, 10, '1,20', 'Home wall', 40)
    `);
  });

  afterAll(async () => {
    // Neither table is in setup.ts's per-file reset list.
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id IN (${OWNER}, ${PRIVATE_OWNER}, ${BOARD_TIE_OWNER})`);
    await db.execute(sql`DELETE FROM user_boards WHERE uuid = 'smart-view-board'`);
    await db.execute(sql`DELETE FROM user_profiles WHERE user_id = ${PRIVATE_OWNER}`);
    await db.execute(sql`DELETE FROM content_privacy WHERE entity_id = 'sv-g2'`);
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid = 'k-merged'`);
  });

  describe('no view', () => {
    it.each(SMART_TYPES)('%s answers in its own order with its own count and no unfilteredCount', async (type) => {
      const result = await fetchSmart({ type, pageSize: 100 });
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(NATURAL[type]);
      expect(result.totalCount).toBe(NATURAL[type].length);
      expect(result.meta.climbCount).toBe(NATURAL[type].length);
      expect(result).not.toHaveProperty('unfilteredCount');
    });

    it('a recommendation answers in its ranking, as before', async () => {
      const result = await fetchSmart({ type: 'RECOMMENDED_CROWD_FAVORITES', pageSize: 100 });
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(CROWD_FAVORITES);
      expect(result.totalCount).toBe(CROWD_FAVORITES.length);
      expect(result).not.toHaveProperty('unfilteredCount');
    });
  });

  describe('the list’s own order', () => {
    it.each(SMART_TYPES)('%s: position (and an empty view) is the list without a view', async (type) => {
      const plain = await fetchSmart({ type, pageSize: 100 });
      for (const view of [{}, { sortBy: 'position' as const }, { sortBy: 'position' as const, sortOrder: 'asc' }]) {
        const viewed = await fetchSmart({ type, view, pageSize: 100 });
        expect(viewed.climbs, JSON.stringify(view)).toEqual(plain.climbs);
        expect(viewed.totalCount).toBe(plain.totalCount);
        expect(viewed.meta).toEqual(plain.meta);
        expect(viewed.unfilteredCount).toBeNull();
      }
    });

    it.each(SMART_TYPES)('%s: position descending is the list reversed', async (type) => {
      expect(await uuids({ type, view: { sortBy: 'position', sortOrder: 'desc' } })).toEqual(
        [...NATURAL[type]].reverse(),
      );
    });

    it.each(SMART_TYPES)('%s: added opens on the list’s own order, and ascending reverses it', async (type) => {
      expect(await uuids({ type, view: { sortBy: 'added' } })).toEqual(NATURAL[type]);
      expect(await uuids({ type, view: { sortBy: 'added', sortOrder: 'asc' } })).toEqual([...NATURAL[type]].reverse());
    });

    it('breaks ties in the list’s own order on the climb, so paging one at a time repeats and skips nothing', async () => {
      for (const type of ['MOST_REPEATED', 'PROJECTS'] as const) {
        const ascending = await pageThrough({ type, userId: TIE_OWNER, view: { sortBy: 'position' } }, 1);
        // k-4 has the most attempts; the three tied on 3 follow in climb order.
        expect(ascending.collected, type).toEqual(['k-4', 'k-2', 'k-5', 'k-6']);
        expect(ascending.totalCount).toBe(4);
        const descending = await pageThrough(
          { type, userId: TIE_OWNER, view: { sortBy: 'position', sortOrder: 'desc' } },
          1,
        );
        expect(descending.collected, type).toEqual(['k-6', 'k-5', 'k-2', 'k-4']);
      }
    });

    it('breaks ties on the board type then the climb without a view too, so paging repeats and skips nothing (#6659)', async () => {
      for (const type of ['MOST_REPEATED', 'PROJECTS'] as const) {
        const paged = await pageThrough({ type, userId: TIE_OWNER }, 1);
        // The same order as the position view above.
        expect(paged.collected, type).toEqual(['k-4', 'k-2', 'k-5', 'k-6']);
        expect(paged.totalCount).toBe(4);
      }
      // Tied attempt totals, five-star dates and like dates: Kilter before
      // Tension, then the climb, so z-tie comes before t-1.
      for (const type of SMART_TYPES) {
        const acrossBoards = await pageThrough({ type, userId: BOARD_TIE_OWNER }, 1);
        expect(acrossBoards.collected, type).toEqual(['k-2', 'z-tie', 't-1']);
        expect(acrossBoards.totalCount, type).toBe(3);
        const viewed = await pageThrough({ type, userId: BOARD_TIE_OWNER, view: { sortBy: 'position' } }, 1);
        expect(viewed.collected, type).toEqual(acrossBoards.collected);
      }
    });

    it('pages a position view the same way as no view', async () => {
      const paged = await pageThrough({ type: 'MOST_REPEATED', view: { sortBy: 'position' } }, 2);
      expect(paged.collected).toEqual(NATURAL.MOST_REPEATED);
      expect(paged.totalCount).toBe(NATURAL.MOST_REPEATED.length);
    });
  });

  describe('sorting', () => {
    it('ranks logbook rows on the grade each shows, at its most-ascended angle', async () => {
      const result = await fetchSmart({ type: 'MOST_REPEATED', view: { sortBy: 'difficulty' }, pageSize: 100 });
      // k-4 grades 20 at its most-ascended 50°, level with k-5: the tie keeps the
      // list's own order (k-5 has more attempts).
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(['k-1', 'k-2', 'k-5', 'k-4', 'k-3']);
      expect(result.climbs.find((climb) => climb.uuid === 'k-4')?.statsAngle).toBe(50);
      expect(result.unfilteredCount).toBeNull();
      expect(result.totalCount).toBe(NATURAL.MOST_REPEATED.length);

      expect(await uuids({ type: 'FIVE_STARS', view: { sortBy: 'difficulty', sortOrder: 'desc' } })).toEqual([
        'k-3',
        'k-5',
        't-1',
        'k-1',
      ]);
    });

    it('the grade a row shows is the one it sorted by, on a tied most-ascended angle and at the wall angle', async () => {
      const sorted = async (board: Partial<SmartInput>) =>
        fetchSmart({
          type: 'MOST_REPEATED',
          userId: ANGLE_OWNER,
          ...board,
          view: { sortBy: 'difficulty' },
          pageSize: 100,
        });
      const tied = (climbs: Awaited<ReturnType<typeof sorted>>['climbs']) =>
        climbs.find((climb) => climb.uuid === 'k-tie');

      // No active board: the tie goes to the lower angle, 15° (a 10), for the
      // sort and the row alike, and the list without a view shows the same.
      const mostAscended = await sorted({});
      expect(mostAscended.climbs.map((climb) => climb.uuid)).toEqual(['k-tie', 'k-1', 'k-2']);
      expect(tied(mostAscended.climbs)?.statsAngle).toBe(15);
      expect(tied(mostAscended.climbs)?.difficulty).toBe(getGradeLabel(10, 'kilter'));
      const plain = await fetchSmart({ type: 'MOST_REPEATED', userId: ANGLE_OWNER, pageSize: 100 });
      expect(tied(plain.climbs)?.statsAngle).toBe(15);
      expect(tied(plain.climbs)?.difficulty).toBe(getGradeLabel(10, 'kilter'));

      // On the active board the row shows its 40° grade, the angle the app reads
      // its live stats at, and sorts by it.
      const atTheWall = await sorted(ACTIVE_KILTER);
      expect(atTheWall.climbs.map((climb) => climb.uuid)).toEqual(['k-1', 'k-2', 'k-tie']);
      expect(tied(atTheWall.climbs)?.statsAngle).toBe(40);
      expect(tied(atTheWall.climbs)?.angle).toBe(40);
      expect(tied(atTheWall.climbs)?.difficulty).toBe(getGradeLabel(20, 'kilter'));
    });

    it('a random order is stable across pages for one seed, and another seed reshuffles', async () => {
      const seeded = (sortSeed: string) => ({
        type: 'MOST_REPEATED' as const,
        view: { sortBy: 'random' as const, sortSeed },
      });
      const whole = await uuids(seeded('11'));
      expect([...whole].sort()).toEqual([...NATURAL.MOST_REPEATED].sort());
      const paged = await pageThrough(seeded('11'), 2);
      expect(paged.collected).toEqual(whole);
      expect(await uuids(seeded('11'))).toEqual(whole);

      const otherOrders = await Promise.all(['12', '13', '14', '15'].map((seed) => uuids(seeded(seed))));
      expect(otherOrders.some((order) => JSON.stringify(order) !== JSON.stringify(whole))).toBe(true);
    });
  });

  describe('filters and counts', () => {
    it('a grade band narrows the list in its own order; the count is what paging reaches', async () => {
      const input = { type: 'LIKED_CLIMBS' as const, view: { minGrade: 15, maxGrade: 20 } };
      const paged = await pageThrough(input, 2);
      // k-1 (12) drops out; k-4 shows 20 at 50°, t-1 16 on the Tension.
      expect(paged.collected).toEqual(['k-2', 't-1', 'k-4']);
      expect(paged.totalCount).toBe(paged.collected.length);

      const firstPage = await fetchSmart({ ...input, pageSize: 2 });
      expect(firstPage.unfilteredCount).toBe(NATURAL.LIKED_CLIMBS.length);
      // The hero keeps the list's size.
      expect(firstPage.meta.climbCount).toBe(NATURAL.LIKED_CLIMBS.length);
      expect(firstPage.hasMore).toBe(true);
    });

    it('unfilteredCount comes with page 0 only, and a page past the end still counts the matches', async () => {
      const input = { type: 'LIKED_CLIMBS' as const, view: { minGrade: 15, maxGrade: 20 }, pageSize: 2 };
      const first = await fetchSmart({ ...input, page: 0 });
      expect(first.unfilteredCount).toBe(NATURAL.LIKED_CLIMBS.length);
      const second = await fetchSmart({ ...input, page: 1 });
      expect(second.climbs.map((climb) => climb.uuid)).toEqual(['k-4']);
      expect(second.totalCount).toBe(3);
      expect(second.unfilteredCount).toBeNull();
      const pastTheEnd = await fetchSmart({ ...input, page: 5 });
      expect(pastTheEnd.climbs).toEqual([]);
      expect(pastTheEnd.totalCount).toBe(3);
      expect(pastTheEnd.hasMore).toBe(false);
    });

    it('a progress filter passes only climbs on the active board', async () => {
      const result = await fetchSmart({
        type: 'LIKED_CLIMBS',
        ...ACTIVE_KILTER,
        view: { hideCompleted: true },
        pageSize: 100,
      });
      // k-1 is sent at 40°; t-1 is not on the active board, so the filter cannot
      // vouch for it.
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(['k-2', 'k-4']);
      expect(result.totalCount).toBe(2);
      expect(result.unfilteredCount).toBe(NATURAL.LIKED_CLIMBS.length);

      const onTension = await uuids({
        type: 'LIKED_CLIMBS',
        activeBoardName: 'tension',
        activeAngle: 30,
        activeLayoutId: 9,
        view: { showOnlyCompleted: true },
      });
      expect(onTension).toEqual(['t-1']);
    });

    it('an active-board filter matches nothing without a complete active board', async () => {
      for (const board of [{}, { activeBoardName: 'kilter', activeAngle: 40 }]) {
        const result = await fetchSmart({ type: 'FIVE_STARS', ...board, view: { onlyActiveBoard: true } });
        expect(result.climbs).toEqual([]);
        expect(result.totalCount).toBe(0);
        expect(result.unfilteredCount).toBe(NATURAL.FIVE_STARS.length);
      }
    });

    it('a sort alone leaves unfilteredCount null', async () => {
      for (const type of SMART_TYPES) {
        const result = await fetchSmart({ type, view: { sortBy: 'quality' }, pageSize: 100 });
        expect(result.unfilteredCount, type).toBeNull();
        expect(result.totalCount, type).toBe(NATURAL[type].length);
      }
    });
  });

  describe('membership and privacy', () => {
    it('a view never adds a climb: name, setter and type filters only narrow', async () => {
      expect(await uuids({ type: 'PROJECTS', view: { name: 'o' } })).toEqual(['k-5', 'k-2']);
      expect(await uuids({ type: 'PROJECTS', view: { setter: ['nobody'] } })).toEqual([]);
      // k-6 has stats that pass, but is in no logbook list.
      expect(await uuids({ type: 'MOST_REPEATED', view: { minGrade: 1, maxGrade: 40 } })).not.toContain('k-6');
    });

    it('signed out, the climber-only filters are ignored on a public logbook', async () => {
      const result = await fetchSmart(
        { type: 'FIVE_STARS', ...ACTIVE_KILTER, view: { hideCompleted: true, onlyFavorited: true }, pageSize: 100 },
        anonymous,
      );
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(NATURAL.FIVE_STARS);
      expect(result.unfilteredCount).toBeNull();
    });

    it('a tick the owner keeps to themselves is missing for a stranger, with and without a view', async () => {
      const ownersOwn = makeCtx({ isAuthenticated: true, userId: GUARDED_OWNER });
      expect(await uuids({ type: 'FIVE_STARS', userId: GUARDED_OWNER }, ownersOwn)).toContain('k-3');
      for (const view of [undefined, { sortBy: 'position' as const }, { sortBy: 'difficulty' as const }]) {
        const seen = await uuids({ type: 'FIVE_STARS', userId: GUARDED_OWNER, view }, stranger);
        expect(seen, JSON.stringify(view)).toEqual(['k-1']);
      }
    });

    it('progress filters read the viewer’s ticks, not the owner’s', async () => {
      // STRANGER sent k-2 and never tried k-1; OWNER is the other way round.
      expect(await uuids({ type: 'LIKED_CLIMBS', ...ACTIVE_KILTER, view: { hideCompleted: true } }, stranger)).toEqual([
        'k-4',
        'k-1',
      ]);
    });

    it('a tick on the owner’s draft climb is missing for a stranger, and the count is what paging reaches', async () => {
      const ownersOwn = makeCtx({ isAuthenticated: true, userId: GUARDED_OWNER });
      expect(await uuids({ type: 'MOST_REPEATED', userId: GUARDED_OWNER }, ownersOwn)).toContain('k-draft');
      for (const view of [undefined, { sortBy: 'position' as const }, { minGrade: 1, maxGrade: 40 }]) {
        const paged = await pageThrough({ type: 'MOST_REPEATED', userId: GUARDED_OWNER, view }, 1, stranger);
        // k-3's tick is hidden from STRANGER too; only the k-1 send is left.
        expect(paged.collected, JSON.stringify(view)).toEqual(['k-1']);
        expect(paged.totalCount).toBe(1);
      }
      const filtered = await fetchSmart(
        { type: 'MOST_REPEATED', userId: GUARDED_OWNER, view: { minGrade: 1, maxGrade: 40 } },
        stranger,
      );
      expect(filtered.unfilteredCount).toBe(1);
    });

    it('a tick on a uuid with no board_climbs row takes no page slot and no count, even for the owner (#6661)', async () => {
      const ownersOwn = makeCtx({ isAuthenticated: true, userId: GUARDED_OWNER });
      for (const type of ['FIVE_STARS', 'MOST_REPEATED', 'PROJECTS'] as const) {
        const paged = await pageThrough({ type, userId: GUARDED_OWNER }, 1, ownersOwn);
        // Neither a deleted climb nor an alias of a published one: the hydrator
        // reads the tick's own uuid and finds no row for either.
        expect(paged.collected, type).not.toContain('k-ghost');
        expect(paged.collected, type).not.toContain('k-merged');
        expect(paged.collected, type).toContain('k-draft');
        expect(paged.totalCount, type).toBe(paged.collected.length);
        const firstPage = await fetchSmart({ type, userId: GUARDED_OWNER, pageSize: 1 }, ownersOwn);
        expect(firstPage.meta.climbCount, type).toBe(paged.collected.length);
      }
    });

    it('a private logbook stays hidden under a view', async () => {
      await expect(
        fetchSmart({ type: 'MOST_REPEATED', userId: PRIVATE_OWNER, view: { sortBy: 'difficulty' } }, anonymous),
      ).rejects.toThrow('Playlist not found');
    });
  });

  describe('serial plan', () => {
    it('runs a logbook view under the serial-plan guard and leaves the default request as it was', async () => {
      const guard = vi.mocked(withSerialPlan);
      guard.mockClear();
      await fetchSmart({ type: 'LIKED_CLIMBS' });
      expect(guard).not.toHaveBeenCalled();
      await fetchSmart({ type: 'LIKED_CLIMBS', view: { sortBy: 'difficulty', minGrade: 12 } });
      expect(guard).toHaveBeenCalledTimes(1);
    });
  });

  describe('recommendations', () => {
    it.each(RECOMMENDED_TYPES)('%s rejects a view with BAD_USER_INPUT before any database work', async (type) => {
      const guard = vi.mocked(withSerialPlan);
      for (const ctx of [owner, anonymous]) {
        for (const view of [{}, { sortBy: 'position' as const }, { sortBy: 'difficulty' as const, minGrade: 12 }]) {
          guard.mockClear();
          await expect(fetchSmart({ type, view }, ctx)).rejects.toMatchObject({
            extensions: { code: 'BAD_USER_INPUT' },
          });
          expect(guard).not.toHaveBeenCalled();
        }
      }
    });
  });

  describe('validation', () => {
    it('rejects a sort the list does not offer and active-board fields without a board type', async () => {
      await expect(fetchSmart({ type: 'PROJECTS', view: { sortBy: 'popular' as never } })).rejects.toThrow();
      await expect(fetchSmart({ type: 'PROJECTS', activeLayoutId: 1, view: {} })).rejects.toThrow();
      await expect(fetchSmart({ type: 'PROJECTS', activeBoardName: 'kilter', view: {} })).rejects.toThrow();
      const view: PlaylistClimbViewInput = { sortBy: 'name' };
      expect(await uuids({ type: 'PROJECTS', view })).toEqual(['k-2', 'k-4', 'k-5']);
    });
  });
});
