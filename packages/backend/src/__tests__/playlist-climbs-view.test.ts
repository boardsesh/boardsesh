import { describe, it, expect, beforeAll, afterAll, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { users, playlistOwnership } from '@boardsesh/db/schema';
import { typeDefs, type ConnectionContext, type PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import { PLAYLIST_FILTER_SCOPE, withSerialPlan, type PlaylistFilterParamKey } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import type { PlaylistClimbsInput } from '../graphql/resolvers/playlists/queries/playlist-climbs';
import { PlaylistClimbViewInputSchema } from '../validation/schemas';

// The real guard, wrapped in a spy so a test can see the view path take it.
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return { ...actual, withSerialPlan: vi.fn(actual.withSerialPlan) };
});

// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — the query builder emits every default-bearing column which
// that DDL omits, so a builder insert fails.

// Integration tests (real DB) for #6651: `playlistClimbs` takes an optional
// `view` (sort + the Climbs list's filters). Without one it must answer exactly
// as before; with one, every order, filter and count runs over the playlist's
// own visible rows and nothing else.

const PLAYLIST_UUID = 'pl-view-6651';
const TIE_PLAYLIST_UUID = 'pl-view-6651-tie';
const GRADES_PLAYLIST_UUID = 'pl-view-6651-grades';
const OWNER = 'pl-view-owner';
const CLIMBER = 'pl-view-climber';
const STRANGER = 'pl-view-stranger';

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
const climber = makeCtx({ isAuthenticated: true, userId: CLIMBER });

async function seedClimb(climb: {
  uuid: string;
  boardType: string;
  layoutId: number;
  name: string;
  sizeIds?: number[];
  framesCount?: number;
  isDraft?: boolean;
  userId?: string | null;
}) {
  const sizeIdsLiteral = climb.sizeIds ? `{${climb.sizeIds.join(',')}}` : null;
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, is_draft, user_id, frames_count, compatible_size_ids)
    VALUES (${climb.uuid}, ${climb.boardType}, ${climb.layoutId}, 'setter', ${climb.name}, '', 'p1r12', true,
            ${climb.isDraft ?? false}, ${climb.userId ?? null}, ${climb.framesCount ?? 1}, ${sizeIdsLiteral}::int[])
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

async function seedGrade(uuid: string, angle: number, universalGrade: number, confidence = 'confirmed') {
  await db.execute(sql`
    INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, model_version, coeff_version)
    VALUES ('kilter', ${uuid}, ${angle}, ${universalGrade}, ${universalGrade}, ${confidence}, 'test', 'test')
    ON CONFLICT (board_type, climb_uuid, angle) DO UPDATE SET
      universal_grade = excluded.universal_grade, local_grade = excluded.local_grade, confidence = excluded.confidence
  `);
}

async function seedTick(
  uuid: string,
  climbUuid: string,
  boardType: string,
  angle: number,
  status: string,
  difficulty: number | null,
) {
  await db.execute(sql`
    INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at)
    VALUES (${uuid}, ${CLIMBER}, ${boardType}, ${climbUuid}, ${angle}, ${status}::tick_status, 1, ${difficulty}, '2026-06-01 10:00:00')
  `);
}

// The playlist, in position order. `angle` is the angle each climb was added at.
const PLAYLIST_ROWS = [
  { uuid: 'k-hard', angle: 40 },
  { uuid: 't-climb', angle: 30 },
  { uuid: 'k-easy', angle: 40 },
  { uuid: 'k-project', angle: 40 },
  { uuid: 'k-wrongsize', angle: 40 },
  { uuid: 'k-mid', angle: 40 },
  { uuid: 'k-draft-stranger', angle: 40 },
  { uuid: 'k-route', angle: 40 },
  { uuid: 't-climb2', angle: 35 },
  { uuid: 'k-no40', angle: 50 },
  { uuid: 'k-draft-climber', angle: 40 },
  { uuid: 's-spray', angle: 40 },
] as const;

// What an anonymous viewer sees in all-boards mode, in playlist order: no
// drafts, no spray climb whose wall they cannot see.
const ANONYMOUS_ALL_BOARDS = [
  'k-hard',
  't-climb',
  'k-easy',
  'k-project',
  'k-wrongsize',
  'k-mid',
  'k-route',
  't-climb2',
  'k-no40',
];

const SPECIFIC_KILTER: Omit<PlaylistClimbsInput, 'playlistId'> = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  angle: 40,
};

const ACTIVE_KILTER: Omit<PlaylistClimbsInput, 'playlistId'> = {
  activeBoardName: 'kilter',
  activeAngle: 40,
  activeLayoutId: 1,
  activeSizeId: 10,
};

async function fetchPage(
  input: Omit<PlaylistClimbsInput, 'playlistId'> & { playlistId?: string },
  ctx: ConnectionContext = anonymous,
) {
  return playlistQueries.playlistClimbs(null, { input: { playlistId: PLAYLIST_UUID, ...input } }, ctx);
}

async function uuids(input: Omit<PlaylistClimbsInput, 'playlistId'>, ctx: ConnectionContext = anonymous) {
  const result = await fetchPage({ pageSize: 100, ...input }, ctx);
  return result.climbs.map((climb) => climb.uuid);
}

/** Every row a client can reach by paging, `pageSize` at a time. */
async function pageThrough(input: Omit<PlaylistClimbsInput, 'playlistId'>, pageSize: number, ctx = anonymous) {
  const collected: string[] = [];
  let totalCount = -1;
  for (let page = 0; page < 50; page++) {
    const result = await fetchPage({ ...input, page, pageSize }, ctx);
    totalCount = result.totalCount;
    collected.push(...result.climbs.map((climb) => climb.uuid));
    if (!result.hasMore) break;
  }
  return { collected, totalCount };
}

describe('playlistClimbs — views (real DB, #6651)', () => {
  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db
      .insert(users)
      .values([OWNER, CLIMBER, STRANGER].map((id) => ({ id, email: `${id}@test.invalid` })))
      .onConflictDoNothing();
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${CLIMBER}`);

    await seedClimb({ uuid: 'k-hard', boardType: 'kilter', layoutId: 1, name: 'Delta', sizeIds: [10, 11] });
    await seedClimb({ uuid: 'k-easy', boardType: 'kilter', layoutId: 1, name: 'Alpha', sizeIds: [10, 11] });
    await seedClimb({ uuid: 'k-mid', boardType: 'kilter', layoutId: 1, name: 'Charlie', sizeIds: [10] });
    await seedClimb({ uuid: 'k-no40', boardType: 'kilter', layoutId: 1, name: 'Echo', sizeIds: [10] });
    await seedClimb({ uuid: 'k-project', boardType: 'kilter', layoutId: 1, name: 'Foxtrot', sizeIds: [10] });
    await seedClimb({
      uuid: 'k-route',
      boardType: 'kilter',
      layoutId: 1,
      name: 'Bravo',
      sizeIds: [10],
      framesCount: 2,
    });
    await seedClimb({ uuid: 'k-wrongsize', boardType: 'kilter', layoutId: 1, name: 'Golf', sizeIds: [99] });
    await seedClimb({ uuid: 't-climb', boardType: 'tension', layoutId: 9, name: 'Hotel' });
    await seedClimb({ uuid: 't-climb2', boardType: 'tension', layoutId: 9, name: 'India' });
    await seedClimb({
      uuid: 'k-draft-stranger',
      boardType: 'kilter',
      layoutId: 1,
      name: 'Juliet',
      sizeIds: [10],
      isDraft: true,
      userId: STRANGER,
    });
    await seedClimb({
      uuid: 'k-draft-climber',
      boardType: 'kilter',
      layoutId: 1,
      name: 'Kilo',
      sizeIds: [10],
      isDraft: true,
      userId: CLIMBER,
    });
    // A spray climb whose wall does not exist, so nobody may read it.
    await seedClimb({ uuid: 's-spray', boardType: 'spray', layoutId: 9999, name: 'Lima' });
    // Its own playlist: two angles with the SAME ascent count and none at the
    // added-at angle, so the most-ascended fallback has a tie to break.
    await seedClimb({ uuid: 'k-tie', boardType: 'kilter', layoutId: 1, name: 'Mike', sizeIds: [10] });
    await seedClimb({ uuid: 'k-tie-partner', boardType: 'kilter', layoutId: 1, name: 'November', sizeIds: [10] });

    await seedStats('kilter', 'k-easy', 40, 12, 3.0, 100);
    await seedStats('kilter', 'k-easy', 50, 18, 2.0, 10);
    await seedStats('kilter', 'k-mid', 40, 16, 2.5, 50);
    await seedStats('kilter', 'k-hard', 40, 22, 4.0, 5);
    await seedStats('kilter', 'k-no40', 50, 20, 3.5, 30);
    await seedStats('kilter', 'k-route', 40, 14, 2.0, 40);
    await seedStats('kilter', 'k-wrongsize', 40, 15, 1.5, 60);
    await seedStats('kilter', 'k-draft-stranger', 40, 10, 3.0, 3);
    await seedStats('tension', 't-climb', 30, 13, 2.2, 20);
    await seedStats('tension', 't-climb2', 35, 19, 3.8, 70);
    await seedStats('kilter', 'k-tie', 45, 11, 3.0, 25);
    await seedStats('kilter', 'k-tie', 55, 25, 3.0, 25);
    await seedStats('kilter', 'k-tie-partner', 40, 18, 3.0, 25);

    // The climber sent k-easy and tried k-hard (grading it 12) on the Kilter at
    // 40°, and sent the Tension climb at 30°.
    await seedTick('pl-view-tick-1', 'k-easy', 'kilter', 40, 'send', null);
    await seedTick('pl-view-tick-2', 'k-hard', 'kilter', 40, 'attempt', 12);
    await seedTick('pl-view-tick-3', 't-climb', 'tension', 30, 'send', null);
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
      VALUES (${CLIMBER}, 'kilter', 'k-hard', 40), (${CLIMBER}, 'tension', 't-climb2', 35)
    `);

    // The Boardsesh-grade playlist (all Kilter, walls at 40°):
    //   g-stats      stats at 40 (12), Boardsesh grade at 40 (20)
    //   g-nostats    no stats row anywhere, Boardsesh grade at 40 (18)
    //   g-fallback   stats only at 50 (14), Boardsesh grades at 50 (22) and 40 (16)
    //   g-setteronly stats at 40 (17), a setter-only Boardsesh grade at 40 (10)
    await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE 'g-%'`);
    for (const uuid of ['g-stats', 'g-nostats', 'g-fallback', 'g-setteronly']) {
      await seedClimb({ uuid, boardType: 'kilter', layoutId: 1, name: uuid, sizeIds: [10] });
    }
    await seedStats('kilter', 'g-stats', 40, 12, 3.0, 10);
    await seedStats('kilter', 'g-fallback', 50, 14, 3.0, 10);
    await seedStats('kilter', 'g-setteronly', 40, 17, 3.0, 10);
    await seedGrade('g-stats', 40, 20);
    await seedGrade('g-nostats', 40, 18);
    await seedGrade('g-fallback', 50, 22);
    await seedGrade('g-fallback', 40, 16);
    await seedGrade('g-setteronly', 40, 10, 'setter_only');

    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Views', true),
             (2, ${TIE_PLAYLIST_UUID}, 'kilter', 1, 'Tie', true),
             (3, ${GRADES_PLAYLIST_UUID}, 'kilter', 1, 'Grades', true)
    `);
    await db
      .insert(playlistOwnership)
      .values([1, 2, 3].map((playlistId) => ({ playlistId: BigInt(playlistId), userId: OWNER, role: 'owner' })));
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (3, 'g-stats', 40, 0), (3, 'g-nostats', 40, 1), (3, 'g-fallback', 40, 2), (3, 'g-setteronly', 40, 3)
    `);
    for (const [position, row] of PLAYLIST_ROWS.entries()) {
      const addedAt = `2026-01-${String(position + 1).padStart(2, '0')} 12:00:00`;
      await db.execute(sql`
        INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position, added_at)
        VALUES (1, ${row.uuid}, ${row.angle}, ${position}, ${addedAt})
      `);
    }
    await db.execute(sql`
      INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
      VALUES (2, 'k-tie', 40, 0), (2, 'k-tie-partner', 40, 1)
    `);
  });

  afterAll(async () => {
    // Neither table is in setup.ts's per-file reset list.
    await db.execute(sql`DELETE FROM user_favorites WHERE user_id = ${CLIMBER}`);
    await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE 'g-%'`);
  });

  describe('no view', () => {
    it('answers exactly as before: playlist order, visible rows only, no unfilteredCount', async () => {
      const allBoards = await fetchPage({ pageSize: 100 });
      expect(allBoards.climbs.map((climb) => climb.uuid)).toEqual(ANONYMOUS_ALL_BOARDS);
      expect(allBoards.totalCount).toBe(ANONYMOUS_ALL_BOARDS.length);
      expect(allBoards).not.toHaveProperty('unfilteredCount');

      const specific = await fetchPage({ ...SPECIFIC_KILTER, pageSize: 100 });
      expect(specific.climbs.map((climb) => climb.uuid)).toEqual([
        'k-hard',
        'k-easy',
        'k-project',
        'k-mid',
        'k-route',
        'k-no40',
      ]);
      expect(specific.totalCount).toBe(6);
    });

    it('an empty view and a position view return the same rows, order, angles and count as no view', async () => {
      for (const input of [{ ...ACTIVE_KILTER }, { ...SPECIFIC_KILTER }]) {
        const plain = await fetchPage({ ...input, pageSize: 100 });
        for (const view of [{}, { sortBy: 'position' as const }, { sortBy: 'position' as const, sortOrder: 'asc' }]) {
          const viewed = await fetchPage({ ...input, view, pageSize: 100 });
          expect(viewed.climbs).toEqual(plain.climbs);
          expect(viewed.totalCount).toBe(plain.totalCount);
          expect(viewed.unfilteredCount).toBeNull();
        }
      }
    });
  });

  describe('sorting', () => {
    it('difficulty ascending puts ungraded climbs first and ranks on the grade each row shows', async () => {
      const result = await fetchPage({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty', sortOrder: 'asc' } });
      expect(result.climbs.map((climb) => climb.uuid)).toEqual([
        'k-project',
        'k-easy',
        'k-route',
        'k-mid',
        // No stats at 40°: graded, and ranked, at its most-ascended 50° (20).
        'k-no40',
        'k-hard',
      ]);
      const noStatsAt40 = result.climbs.find((climb) => climb.uuid === 'k-no40');
      expect(noStatsAt40?.statsAngle).toBe(50);
      // The live wall angle is still what the row reports.
      expect(noStatsAt40?.angle).toBe(40);
    });

    it('difficulty descending is the reverse, ungraded climbs last', async () => {
      const descending = await uuids({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty', sortOrder: 'desc' } });
      expect(descending).toEqual(['k-hard', 'k-no40', 'k-mid', 'k-route', 'k-easy', 'k-project']);
    });

    it('opens difficulty on easiest first and "added" on newest first when no direction is sent', async () => {
      expect(await uuids({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty' } })).toEqual(
        await uuids({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty', sortOrder: 'asc' } }),
      );
      expect(await uuids({ view: { sortBy: 'added' } })).toEqual([...ANONYMOUS_ALL_BOARDS].reverse());
    });

    it('reads off-board climbs at the angle they were added at in all-boards mode', async () => {
      const result = await fetchPage({ ...ACTIVE_KILTER, view: { sortBy: 'difficulty', sortOrder: 'asc' } });
      expect(result.climbs.map((climb) => climb.uuid)).toEqual([
        'k-project',
        'k-easy',
        't-climb',
        'k-route',
        'k-wrongsize',
        'k-mid',
        't-climb2',
        'k-no40',
        'k-hard',
      ]);
      expect(result.climbs.find((climb) => climb.uuid === 't-climb2')?.statsAngle).toBe(35);
    });

    it('the all-boards order equals the specific-board order once the off-board rows are removed', async () => {
      const views: PlaylistClimbViewInput[] = [
        { sortBy: 'position' },
        { sortBy: 'position', sortOrder: 'desc' },
        { sortBy: 'added' },
        { sortBy: 'difficulty', sortOrder: 'asc' },
        { sortBy: 'difficulty', sortOrder: 'desc' },
        { sortBy: 'quality' },
        { sortBy: 'ascents' },
        { sortBy: 'name' },
        { sortBy: 'random', sortSeed: '7' },
        { sortBy: 'difficulty', useMyGrades: true },
      ];
      for (const view of views) {
        const specific = await uuids({ ...SPECIFIC_KILTER, view }, climber);
        const allBoards = await uuids({ ...ACTIVE_KILTER, view }, climber);
        const onBoardOnly = allBoards.filter((uuid) => specific.includes(uuid));
        expect(onBoardOnly, JSON.stringify(view)).toEqual(specific);
      }
    });

    it('a random order is stable across pages for one seed, and another seed reshuffles', async () => {
      const seeded = (sortSeed: string) => ({ ...ACTIVE_KILTER, view: { sortBy: 'random' as const, sortSeed } });
      const whole = await uuids(seeded('11'));
      expect([...whole].sort()).toEqual([...ANONYMOUS_ALL_BOARDS].sort());
      const paged = await pageThrough(seeded('11'), 2);
      expect(paged.collected).toEqual(whole);
      expect(await uuids(seeded('11'))).toEqual(whole);

      const otherOrders = await Promise.all(['12', '13', '14'].map((seed) => uuids(seeded(seed))));
      expect(otherOrders.some((order) => JSON.stringify(order) !== JSON.stringify(whole))).toBe(true);
    });

    it('sorts on the climber’s own grade with useMyGrades, and the crowd grade without it', async () => {
      const crowd = await uuids({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty' } }, climber);
      expect(crowd).toEqual(['k-project', 'k-draft-climber', 'k-easy', 'k-route', 'k-mid', 'k-no40', 'k-hard']);
      // The climber graded k-hard (crowd 22) as a 12: it moves in with the 12s,
      // ahead of k-easy because it comes first in the playlist.
      const personal = await uuids({ ...SPECIFIC_KILTER, view: { sortBy: 'difficulty', useMyGrades: true } }, climber);
      expect(personal).toEqual(['k-project', 'k-draft-climber', 'k-hard', 'k-easy', 'k-route', 'k-mid', 'k-no40']);
    });

    it('the grade a row shows is the grade it was sorted by, even when the fallback angle is a tie', async () => {
      const result = await playlistQueries.playlistClimbs(
        null,
        {
          input: {
            playlistId: TIE_PLAYLIST_UUID,
            ...SPECIFIC_KILTER,
            view: { sortBy: 'difficulty', sortOrder: 'asc' },
          },
        },
        anonymous,
      );
      // Equal ascents at 45° and 55°: the tie goes to the lower angle, which
      // grades it 11, so it sorts before the partner's 18 and shows that grade.
      const tie = result.climbs.find((climb) => climb.uuid === 'k-tie');
      expect(tie?.statsAngle).toBe(45);
      expect(result.climbs.map((climb) => climb.uuid)).toEqual(['k-tie', 'k-tie-partner']);
    });
  });

  describe('filters and counts', () => {
    it('totalCount is the number of rows a client can page through, and unfilteredCount the playlist', async () => {
      const input = { ...ACTIVE_KILTER, view: { sortBy: 'difficulty' as const, minGrade: 14, maxGrade: 20 } };
      const paged = await pageThrough(input, 2);
      expect(paged.collected).toEqual(['k-route', 'k-wrongsize', 'k-mid', 't-climb2', 'k-no40']);
      expect(paged.totalCount).toBe(paged.collected.length);
      const firstPage = await fetchPage({ ...input, pageSize: 2 });
      expect(firstPage.unfilteredCount).toBe(ANONYMOUS_ALL_BOARDS.length);
    });

    it('unfilteredCount comes with page 0 only, and a page past the end still counts the matches', async () => {
      const input = { ...ACTIVE_KILTER, view: { sortBy: 'difficulty' as const, minGrade: 14, maxGrade: 20 } };
      const second = await fetchPage({ ...input, page: 1, pageSize: 2 });
      expect(second.climbs.map((climb) => climb.uuid)).toEqual(['k-mid', 't-climb2']);
      expect(second.totalCount).toBe(5);
      expect(second.unfilteredCount).toBeNull();
      const pastTheEnd = await fetchPage({ ...input, page: 9, pageSize: 2 });
      expect(pastTheEnd.climbs).toEqual([]);
      expect(pastTheEnd.totalCount).toBe(5);
      expect(pastTheEnd.hasMore).toBe(false);
    });

    it('a sort alone leaves unfilteredCount null and totalCount the playlist count', async () => {
      const result = await fetchPage({ view: { sortBy: 'quality' } });
      expect(result.unfilteredCount).toBeNull();
      expect(result.totalCount).toBe(ANONYMOUS_ALL_BOARDS.length);
    });

    it('the grade band applies to every board, at each row’s displayed angle', async () => {
      expect(await uuids({ ...ACTIVE_KILTER, view: { minGrade: 14, maxGrade: 20 } })).toEqual([
        'k-wrongsize',
        'k-mid',
        'k-route',
        't-climb2',
        'k-no40',
      ]);
    });

    it('name, setter and climb-type filters apply to every board', async () => {
      expect(await uuids({ view: { name: 'otel' } })).toEqual(['t-climb']);
      expect(await uuids({ view: { boulders: false, routes: true } })).toEqual(['k-route']);
      expect(await uuids({ view: { setter: ['nobody'] } })).toEqual([]);
    });

    it('progress filters keep only active-board climbs the climber has not sent', async () => {
      const result = await fetchPage({ ...ACTIVE_KILTER, view: { hideCompleted: true }, pageSize: 100 }, climber);
      // k-easy is sent; Tension climbs and the climb that doesn't fit size 10 are
      // not on the active board, so a progress filter cannot vouch for them.
      expect(result.climbs.map((climb) => climb.uuid)).toEqual([
        'k-hard',
        'k-project',
        'k-mid',
        'k-route',
        'k-no40',
        'k-draft-climber',
      ]);
      expect(result.totalCount).toBe(6);
      expect(result.unfilteredCount).toBe(ANONYMOUS_ALL_BOARDS.length + 1);
    });

    it('liked climbs only counts hearts on the active board', async () => {
      expect(await uuids({ ...ACTIVE_KILTER, view: { onlyFavorited: true } }, climber)).toEqual(['k-hard']);
    });

    it('signed out, the climber-only filters are ignored, with or without an active board', async () => {
      const climberOnly: PlaylistClimbViewInput = {
        onlyFavorited: true,
        hideCompleted: true,
        onlyFollowedAuthors: true,
      };
      for (const input of [{ ...ACTIVE_KILTER }, {}]) {
        const result = await fetchPage({ ...input, view: climberOnly, pageSize: 100 });
        expect(result.climbs.map((climb) => climb.uuid)).toEqual(ANONYMOUS_ALL_BOARDS);
        expect(result.unfilteredCount).toBeNull();
      }
    });

    it('onlyActiveBoard keeps the climbs that fit the active board’s type, layout and size', async () => {
      expect(await uuids({ ...ACTIVE_KILTER, view: { onlyActiveBoard: true } })).toEqual([
        'k-hard',
        'k-easy',
        'k-project',
        'k-mid',
        'k-route',
        'k-no40',
      ]);
    });

    it('an active-board filter matches nothing without a complete active board', async () => {
      for (const input of [
        {},
        { activeBoardName: 'kilter', activeAngle: 40 },
        { activeBoardName: 'kilter', activeAngle: 40, activeSizeId: 10 },
      ]) {
        const result = await fetchPage({ ...input, view: { onlyActiveBoard: true } });
        expect(result.climbs).toEqual([]);
        expect(result.totalCount).toBe(0);
        expect(result.unfilteredCount).toBe(ANONYMOUS_ALL_BOARDS.length);
      }
    });
  });

  describe('Boardsesh grades', () => {
    const gradesPage = (view: PlaylistClimbViewInput) =>
      playlistQueries.playlistClimbs(
        null,
        { input: { playlistId: GRADES_PLAYLIST_UUID, ...SPECIFIC_KILTER, pageSize: 100, view } },
        anonymous,
      );

    it('filters on the Boardsesh grade at the wall angle, with or without a stats row there', async () => {
      // g-nostats has only a Boardsesh grade (18); g-setteronly's setter-only
      // grade is never shown, so it reads its upstream 17.
      const band = await gradesPage({ minGrade: 17, maxGrade: 19, gradeSource: 'BOARDSESH' });
      expect(band.climbs.map((climb) => climb.uuid)).toEqual(['g-nostats', 'g-setteronly']);
      expect(band.totalCount).toBe(2);
    });

    it('the upstream band falls back to the Boardsesh grade for a climb with no stats row', async () => {
      const band = await gradesPage({ minGrade: 17, maxGrade: 19 });
      expect(band.climbs.map((climb) => climb.uuid)).toEqual(['g-nostats', 'g-setteronly']);
      expect((await gradesPage({ minGrade: 11, maxGrade: 13 })).climbs.map((climb) => climb.uuid)).toEqual(['g-stats']);
    });

    it('sorts on the Boardsesh grade and shows the grade it sorted by', async () => {
      const sorted = await gradesPage({ sortBy: 'difficulty', sortOrder: 'asc', gradeSource: 'BOARDSESH' });
      expect(sorted.climbs.map((climb) => climb.uuid)).toEqual(['g-setteronly', 'g-nostats', 'g-stats', 'g-fallback']);
      const byUuid = Object.fromEntries(sorted.climbs.map((climb) => [climb.uuid, climb]));
      // No stats row: graded at the wall angle, which the row now shows too.
      expect(byUuid['g-nostats'].statsAngle).toBeNull();
      expect(byUuid['g-nostats'].boardseshDifficulty).toBe(18);
      // Stats only at 50°: the grade comes from 50° as well, not from the 40° row.
      expect(byUuid['g-fallback'].statsAngle).toBe(50);
      expect(byUuid['g-fallback'].boardseshDifficulty).toBe(22);
      expect(byUuid['g-stats'].boardseshDifficulty).toBe(20);
    });
  });

  describe('personal grades on the row', () => {
    it('carries myDifficulty when the order used it, and leaves it off otherwise', async () => {
      const personal = await fetchPage(
        { ...SPECIFIC_KILTER, pageSize: 100, view: { sortBy: 'difficulty', useMyGrades: true } },
        climber,
      );
      const byUuid = Object.fromEntries(personal.climbs.map((climb) => [climb.uuid, climb]));
      expect(byUuid['k-hard'].myDifficulty).toBe(12);
      expect(byUuid['k-easy'].myDifficulty).toBeNull();

      const crowd = await fetchPage({ ...SPECIFIC_KILTER, pageSize: 100, view: { sortBy: 'difficulty' } }, climber);
      expect(crowd.climbs.every((climb) => climb.myDifficulty === undefined)).toBe(true);
    });
  });

  describe('serial plan', () => {
    it('runs a view under the serial-plan guard and leaves the default request as it was', async () => {
      const guard = vi.mocked(withSerialPlan);
      guard.mockClear();
      await fetchPage({ ...ACTIVE_KILTER });
      expect(guard).not.toHaveBeenCalled();
      await fetchPage({ ...ACTIVE_KILTER, view: { sortBy: 'difficulty', minGrade: 12 } });
      expect(guard).toHaveBeenCalledTimes(1);
    });
  });

  describe('visibility', () => {
    it('keeps the draft and spray rules under a view', async () => {
      const views: PlaylistClimbViewInput[] = [
        { sortBy: 'difficulty' },
        { sortBy: 'name', boulders: true, routes: true },
        { minGrade: 1, maxGrade: 40, sortBy: 'random', sortSeed: '3' },
      ];
      for (const view of views) {
        const signedOut = await uuids({ view });
        expect(signedOut).not.toContain('k-draft-stranger');
        expect(signedOut).not.toContain('k-draft-climber');
        expect(signedOut).not.toContain('s-spray');

        const owner = await uuids({ ...SPECIFIC_KILTER, view }, climber);
        expect(owner).not.toContain('k-draft-stranger');
        expect(owner).not.toContain('s-spray');
      }
      // The climber's own draft shows to them under a view that doesn't need stats.
      expect(await uuids({ view: { sortBy: 'name' } }, climber)).toContain('k-draft-climber');
    });

    it('a view narrows the playlist and never adds an unlisted, hidden or off-playlist climb', async () => {
      await db.execute(sql`UPDATE board_climbs SET is_listed = false, is_hidden = true WHERE uuid = 'k-mid'`);
      try {
        expect(await uuids({ view: { sortBy: 'name' } })).toContain('k-mid');
        expect(await uuids({ view: { sortBy: 'name' } })).not.toContain('k-tie');
      } finally {
        await db.execute(sql`UPDATE board_climbs SET is_listed = true, is_hidden = false WHERE uuid = 'k-mid'`);
      }
    });
  });

  describe('validation', () => {
    it('rejects a sort the playlist does not offer and a direction that is not asc or desc', async () => {
      await expect(fetchPage({ view: { sortBy: 'popular' as never } })).rejects.toThrow();
      await expect(fetchPage({ view: { sortBy: 'name', sortOrder: 'sideways' } })).rejects.toThrow();
    });

    it('rejects active-board fields without activeBoardName', async () => {
      await expect(fetchPage({ activeLayoutId: 1, view: { onlyActiveBoard: true } })).rejects.toThrow();
      await expect(fetchPage({ activeSizeId: 10 })).rejects.toThrow();
    });
  });
});

describe('PlaylistClimbViewInput contract', () => {
  it('has one Zod key per GraphQL input field', () => {
    const sdl = typeDefs.join('\n');
    const inputBlock = /input PlaylistClimbViewInput\s*\{([\s\S]*?)\n\s*\}/.exec(sdl);
    expect(inputBlock).not.toBeNull();
    const sdlFields = (inputBlock?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('"') && !line.startsWith('#'))
      .map((line) => line.split(':')[0].trim())
      .sort();
    expect(sdlFields.length).toBeGreaterThan(0);
    expect(Object.keys(PlaylistClimbViewInputSchema.shape).sort()).toEqual(sdlFields);
  });

  it('every view field is a filter param the playlist builder has classified as supported', () => {
    // The GraphQL name differs from the param name in one place: setter -> settername.
    const paramKeyFor = (field: string): string => (field === 'setter' ? 'settername' : field);
    for (const field of Object.keys(PlaylistClimbViewInputSchema.shape)) {
      const paramKey = paramKeyFor(field);
      expect(Object.keys(PLAYLIST_FILTER_SCOPE), field).toContain(paramKey);
      expect(PLAYLIST_FILTER_SCOPE[paramKey as PlaylistFilterParamKey], field).not.toBe('unsupported');
    }
  });
});
