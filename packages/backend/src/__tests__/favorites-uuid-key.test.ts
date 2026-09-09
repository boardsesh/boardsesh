import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { buildSchema, graphql } from 'graphql';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { favoriteQueries } from '../graphql/resolvers/favorites/queries';
import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { favoriteClimbsQuery } from '../graphql/resolvers/favorites/favorite-climbs-query';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';

// Integration test (real DB) for #2637: favorites are keyed by (user_id,
// climb_uuid), so a heart survives a board or angle switch instead of being a
// distinct favorite per (board, angle).
//
// Seeds use raw `sql` rather than `db.insert(...)` because the integration test
// DB is built from a minimal hand-maintained DDL (schema-sql.ts), not the full
// Drizzle schema — a builder insert emits default-bearing columns that DDL omits.

const USER_ID = 'fav-key-user';
const OTHER_USER_ID = 'fav-key-other-user';
const KILTER_CLIMB = 'fav-key-kilter-climb';
const TENSION_CLIMB = 'fav-key-tension-climb';
const ORPHAN_CLIMB = 'fav-key-orphan-climb';
const graphSchema = buildSchema(typeDefs.join('\n'));

function queryLegacyLibrary(context: ConnectionContext) {
  return graphql({
    schema: graphSchema,
    source: `
      query LegacyLibrary {
        userFavoritesCounts { ...CountFields }
        userActiveBoards
      }
      fragment CountFields on FavoritesCount { boardName count }
    `,
    rootValue: {
      userFavoritesCounts: () => favoriteQueries.userFavoritesCounts(undefined, undefined, context),
      userActiveBoards: () => favoriteQueries.userActiveBoards(undefined, undefined, context),
    },
  });
}

function ctx(userId: string = USER_ID): ConnectionContext {
  return {
    connectionId: 'conn-fav-key',
    isAuthenticated: true,
    userId,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function seedClimb(boardType: string, uuid: string, name: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
    VALUES (${uuid}, ${boardType}, 1, 'setter', ${name}, '', 'p1r1', true)
    ON CONFLICT (uuid) DO NOTHING
  `);
}

async function favoriteRowCount(climbUuid: string, userId = USER_ID): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM user_favorites
    WHERE user_id = ${userId} AND climb_uuid = ${climbUuid}
  `);
  return Number((rows as unknown as Array<{ count: number }>)[0].count);
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE user_favorites, user_favorites_dedup_backup_0194, sync_deletions RESTART IDENTITY CASCADE`,
  );
  await insertUser(USER_ID);
  await insertUser(OTHER_USER_ID);
  await seedClimb('kilter', KILTER_CLIMB, 'Kilter climb');
  await seedClimb('tension', TENSION_CLIMB, 'Tension climb');
});

describe('favorites are keyed by (userId, climbUuid)', () => {
  it('toggleFavorite adds then removes without any board or angle on the wire', async () => {
    const on = await favoriteMutations.toggleFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    expect(on).toEqual({ favorited: true });
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(1);

    const off = await favoriteMutations.toggleFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    expect(off).toEqual({ favorited: false });
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(0);
  });

  it('favoriting the same climb from two board contexts yields exactly one row', async () => {
    await favoriteMutations.addFavorite(
      undefined,
      { input: { boardName: 'kilter', climbUuid: KILTER_CLIMB, angle: 40 } },
      ctx(),
    );
    await favoriteMutations.addFavorite(
      undefined,
      { input: { boardName: 'tension', climbUuid: KILTER_CLIMB, angle: 25 } },
      ctx(),
    );

    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(1);
  });

  it('the favorites query reports the climb whatever board or angle the caller passes', async () => {
    await favoriteMutations.addFavorite(
      undefined,
      { input: { boardName: 'kilter', climbUuid: KILTER_CLIMB, angle: 40 } },
      ctx(),
    );

    // Same call an older binary makes, from a completely different board+angle.
    const fromOtherBoard = await favoriteQueries.favorites(
      undefined,
      { boardName: 'tension', climbUuids: [KILTER_CLIMB], angle: 25 },
      ctx(),
    );
    expect(fromOtherBoard).toEqual([KILTER_CLIMB]);

    // And from a client that sends nothing but the uuids.
    const boardless = await favoriteQueries.favorites(undefined, { climbUuids: [KILTER_CLIMB] }, ctx());
    expect(boardless).toEqual([KILTER_CLIMB]);
  });

  it('the favorites query stays scoped to the caller', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());

    const otherUsersView = await favoriteQueries.favorites(
      undefined,
      { climbUuids: [KILTER_CLIMB] },
      ctx(OTHER_USER_ID),
    );
    expect(otherUsersView).toEqual([]);
  });

  it('removeFavorite on a nonexistent row is a no-op', async () => {
    const result = await favoriteMutations.removeFavorite(undefined, { input: { climbUuid: 'never-existed' } }, ctx());
    expect(result).toBe(true);
  });
});

describe('shipped library GraphQL queries', () => {
  it('keeps count fragments and active boards working after the UUID rekey', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: TENSION_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: ORPHAN_CLIMB } }, ctx());
    // Legacy columns can be defaulted or stale; use the same catalog identity
    // as the favorite-climb page rather than grouping under an empty board.
    await db.execute(sql`UPDATE user_favorites SET board_name = '', angle = 0 WHERE user_id = ${USER_ID}`);
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, name)
      VALUES ('legacy-library-playlist', 'moonboard', 'Playlist-only board')
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${USER_ID}, 'owner' FROM playlists WHERE uuid = 'legacy-library-playlist'
    `);

    const result = await queryLegacyLibrary(ctx());
    expect(result.errors).toBeUndefined();
    expect(result.data?.userFavoritesCounts).toEqual(
      expect.arrayContaining([
        { boardName: 'kilter', count: 1 },
        { boardName: 'tension', count: 1 },
      ]),
    );
    expect(result.data?.userFavoritesCounts).toHaveLength(2);
    expect(result.data?.userActiveBoards).toEqual(['kilter', 'moonboard', 'tension']);

    const otherUser = await queryLegacyLibrary(ctx(OTHER_USER_ID));
    expect(otherUser.errors).toBeUndefined();
    expect(otherUser.data).toEqual({ userFavoritesCounts: [], userActiveBoards: [] });
  });

  it('keeps both legacy library queries authenticated', async () => {
    const result = await queryLegacyLibrary({ ...ctx(), isAuthenticated: false, userId: undefined });
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.data).toBeNull();
    await expect(
      favoriteQueries.userActiveBoards(undefined, undefined, { ...ctx(), isAuthenticated: false, userId: undefined }),
    ).rejects.toThrow();
  });
});

describe('userFavoriteClimbs — count and page use the same board scope', () => {
  const input = {
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '1',
    angle: 40,
  };

  it('counts and returns only the requested board, from the climbs join', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: TENSION_CLIMB } }, ctx());

    const result = await favoriteClimbsQuery.userFavoriteClimbs(undefined, { input }, ctx());

    // The favorite rows carry no board of their own now — a mismatched count and
    // page (the #2789 regression) would show up as totalCount 2 with 1 climb.
    expect(result.totalCount).toBe(1);
    expect(result.climbs.map((climb) => climb.uuid)).toEqual([KILTER_CLIMB]);
  });

  it('drops an orphan favorite (no board_climbs row) from BOTH the count and the page', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: ORPHAN_CLIMB } }, ctx());

    const result = await favoriteClimbsQuery.userFavoriteClimbs(undefined, { input }, ctx());

    expect(result.totalCount).toBe(1);
    expect(result.climbs).toHaveLength(1);
  });

  it('lists a climb ONCE even though it used to be favoritable per angle', async () => {
    // Pre-re-keying, favoriting at 40 and at 50 made two rows and the liked page
    // showed the climb twice (totalCount counted both). One row now, one card.
    await favoriteMutations.addFavorite(
      undefined,
      { input: { boardName: 'kilter', climbUuid: KILTER_CLIMB, angle: 40 } },
      ctx(),
    );
    await favoriteMutations.addFavorite(
      undefined,
      { input: { boardName: 'kilter', climbUuid: KILTER_CLIMB, angle: 50 } },
      ctx(),
    );

    const result = await favoriteClimbsQuery.userFavoriteClimbs(undefined, { input }, ctx());

    expect(result.totalCount).toBe(1);
    expect(result.climbs).toHaveLength(1);
  });
});

describe('mySmartPlaylistCounts — the liked-climbs card', () => {
  // The liked_climbs CTE is raw SQL (co-defined CTEs the query builder can't
  // express) and smart-playlists.test.ts mocks db.execute, so nothing else in
  // the suite runs this statement against Postgres. A mistake in the
  // board_climbs join would take out every count on the playlists tab, not just
  // this one, with no compile-time signal.
  it('counts a favorite once per catalog climb and drops orphans, matching the list', async () => {
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: TENSION_CLIMB } }, ctx());
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: ORPHAN_CLIMB } }, ctx());

    const counts = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx());
    const likedClimbs = counts.find((entry) => entry.type === 'LIKED_CLIMBS');

    // Two catalog climbs across two boards; the orphan favorite is excluded
    // here exactly as it is from the list.
    expect(likedClimbs?.count).toBe(2);
  });

  it('reports zero for a user with no favorites', async () => {
    const counts = await playlistQueries.mySmartPlaylistCounts(null, undefined, ctx(OTHER_USER_ID));
    expect(counts.find((entry) => entry.type === 'LIKED_CLIMBS')?.count).toBe(0);
  });
});

describe('legacy index and offline deletion compatibility', () => {
  // The legacy index preserves conflict-target inference only. It does not
  // make pre-compatibility writers safe against the new UUID unique key;
  // the compatibility backend must be fully deployed before this migration.
  it('still resolves the old four-column ON CONFLICT target', async () => {
    const insertTheOldWay = () =>
      db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES (${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40, now(), now())
        ON CONFLICT (user_id, board_name, climb_uuid, angle) DO NOTHING
      `);

    await insertTheOldWay();
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(1);

    // Replaying it is a no-op, not a 42P10 and not a second row.
    await insertTheOldWay();
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(1);

    // And the new key still governs: the same climb from another board context
    // collapses onto the one row.
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(1);
  });

  it('removes archived angle variants from old devices without leaking another user or climb', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites_dedup_backup_0194
        (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES
        (9001, ${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40, now(), now()),
        (9002, ${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40, now(), now()),
        (9003, ${OTHER_USER_ID}, 'kilter', ${KILTER_CLIMB}, 30, now(), now()),
        (9004, ${USER_ID}, 'tension', ${TENSION_CLIMB}, 25, now(), now())
    `);
    await favoriteMutations.addFavorite(undefined, { input: { climbUuid: KILTER_CLIMB, angle: 50 } }, ctx());
    await favoriteMutations.removeFavorite(undefined, { input: { climbUuid: KILTER_CLIMB } }, ctx());

    const deletions = await db.execute(sql`
      SELECT record_id, user_id FROM sync_deletions WHERE table_name = 'user_favorites' ORDER BY record_id
    `);
    expect(Array.from(deletions)).toEqual([
      { record_id: `kilter:${KILTER_CLIMB}:40`, user_id: USER_ID },
      { record_id: `kilter:${KILTER_CLIMB}:50`, user_id: USER_ID },
    ]);
    expect(await favoriteRowCount(KILTER_CLIMB)).toBe(0);
  });
});
