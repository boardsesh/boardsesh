import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
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
  await db.execute(sql`TRUNCATE TABLE user_favorites, sync_deletions RESTART IDENTITY CASCADE`);
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

describe('deploy-window compatibility with the previous backend', () => {
  // Migrations run in a gated job BEFORE the new backend image is live, so for
  // the minutes Railway takes to roll, the OLD resolver is serving against this
  // schema. Its insert infers `ON CONFLICT (user_id, board_name, climb_uuid,
  // angle)`; with no unique index on those four columns Postgres raises 42P10
  // and every favorite tap 500s. Migration 0190 keeps unique_user_favorite_legacy
  // for exactly that window — Release 2 drops it with the columns.
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
});
