import { describe, it, expect, beforeAll, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { buildSchema, graphql } from 'graphql';
import postgres from 'postgres';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { favoriteQueries } from '../graphql/resolvers/favorites/queries';
import { favoriteMutations } from '../graphql/resolvers/favorites/mutations';
import { favoriteClimbsQuery } from '../graphql/resolvers/favorites/favorite-climbs-query';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { getPostgresErrorCode } from '../utils/postgres-errors';

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
const favoritesRekeyMigration = readFileSync(
  new URL('../../../db/drizzle/0251_favorites_key_by_climb_uuid.sql', import.meta.url),
  'utf8',
);

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

async function archivedFavoriteCount(userId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM user_favorites_dedup_backup_0194 WHERE user_id = ${userId}
  `);
  return Number((rows as unknown as Array<{ count: number }>)[0].count);
}

async function restoreLegacyFavoriteSchema(): Promise<void> {
  await db.execute(sql`DROP INDEX IF EXISTS public.unique_user_favorite`);
  await db.execute(sql`DROP INDEX IF EXISTS public.unique_user_favorite_legacy`);
  await db.execute(sql`DROP INDEX IF EXISTS public.user_favorites_climb_idx`);
  await db.execute(sql`DROP TABLE IF EXISTS public.user_favorites_dedup_backup_0194`);
  await db.execute(sql`ALTER TABLE public.user_favorites ALTER COLUMN board_name DROP DEFAULT`);
  await db.execute(sql`ALTER TABLE public.user_favorites ALTER COLUMN angle DROP DEFAULT`);
  await db.execute(sql`
    CREATE UNIQUE INDEX unique_user_favorite
    ON public.user_favorites (user_id, board_name, climb_uuid, angle)
  `);
  await db.execute(sql`
    CREATE INDEX user_favorites_climb_idx ON public.user_favorites (climb_uuid)
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION public.log_deletion_favorites() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO sync_deletions (table_name, record_id, user_id)
      VALUES (TG_TABLE_NAME,
              OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
              OLD.user_id);
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

async function runFavoritesRekeyMigration(client: postgres.Sql | postgres.TransactionSql): Promise<void> {
  for (const statement of favoritesRekeyMigration.split('--> statement-breakpoint')) {
    const trimmedStatement = statement.trim();
    if (trimmedStatement.length > 0) {
      await client.unsafe(trimmedStatement);
    }
  }
}

async function ensureRekeyedFavoriteSchema(client: postgres.Sql): Promise<void> {
  const [archive] = await client`
    SELECT to_regclass('public.user_favorites_dedup_backup_0194') IS NOT NULL AS present
  `;
  if (!archive?.present) {
    // Recover the precise pre-0250 index expected by the migration after a
    // deliberately interrupted test run. The worker DB is PR-owned and this
    // helper restores its current schema by running the real migration below.
    await client.unsafe('CREATE INDEX IF NOT EXISTS user_favorites_climb_idx ON public.user_favorites (climb_uuid)');
    await client.begin(async (transaction) => runFavoritesRekeyMigration(transaction));
  }
}

async function waitForFavoriteMigrationLock(observer: postgres.Sql, migrationPid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const lockWait = await observer`
      SELECT waiting.pid
      FROM pg_locks AS waiting_lock
      JOIN pg_stat_activity AS waiting ON waiting.pid = waiting_lock.pid
      JOIN pg_locks AS blocker_lock
        ON blocker_lock.relation = waiting_lock.relation
       AND blocker_lock.pid = ${migrationPid}
      WHERE waiting_lock.locktype = 'relation'
        AND waiting_lock.relation = 'public.user_favorites'::regclass
        AND waiting_lock.mode = 'RowExclusiveLock'
        AND NOT waiting_lock.granted
        AND blocker_lock.mode = 'AccessExclusiveLock'
        AND blocker_lock.granted
        AND ${migrationPid} = ANY(pg_blocking_pids(waiting.pid))
        AND waiting.query ILIKE 'LOCK TABLE public.user_favorites%'
      LIMIT 1
    `;
    if (lockWait.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('The isolated worker DATABASE_URL is required');
  const migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await ensureRekeyedFavoriteSchema(migrationClient);
  } finally {
    await migrationClient.end();
  }
});

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

  it('removes only the deleted account’s archived favorites in the same transaction', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
      VALUES (${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40)
    `);
    await db.execute(sql`
      INSERT INTO user_favorites_dedup_backup_0194
        (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES
        (9101, ${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40, now(), now()),
        (9102, ${USER_ID}, 'kilter', ${KILTER_CLIMB}, 50, now(), now()),
        (9103, ${OTHER_USER_ID}, 'kilter', ${KILTER_CLIMB}, 30, now(), now())
    `);

    await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, ctx(USER_ID));

    expect(await favoriteRowCount(KILTER_CLIMB, USER_ID)).toBe(0);
    expect(await archivedFavoriteCount(USER_ID)).toBe(0);
    expect(await archivedFavoriteCount(OTHER_USER_ID)).toBe(1);
    const deletedUsers = await db.execute(sql`SELECT id FROM users WHERE id = ${USER_ID}`);
    expect(Array.from(deletedUsers)).toEqual([]);
  });

  it('restores archive rows when a later account-delete step fails', async () => {
    await db.execute(sql`
      INSERT INTO user_favorites_dedup_backup_0194
        (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
      VALUES (9201, ${USER_ID}, 'kilter', ${KILTER_CLIMB}, 40, now(), now())
    `);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION public.reject_fav_key_account_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = 'fav-key-user' THEN
          RAISE EXCEPTION 'test-only account deletion failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER reject_fav_key_account_delete
      BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION public.reject_fav_key_account_delete()
    `);

    try {
      let deletionError: unknown;
      try {
        await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, ctx(USER_ID));
      } catch (error) {
        deletionError = error;
      }
      expect(getPostgresErrorCode(deletionError)).toBe('P0001');
      expect(await archivedFavoriteCount(USER_ID)).toBe(1);
      const users = await db.execute(sql`SELECT id FROM users WHERE id = ${USER_ID}`);
      expect(Array.from(users)).toEqual([{ id: USER_ID }]);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS reject_fav_key_account_delete ON users`);
      await db.execute(sql`DROP FUNCTION IF EXISTS public.reject_fav_key_account_delete()`);
    }
  });
});

describe('account deletion and favorites re-key ordering', () => {
  it('waits for migration 0250, then removes the deleted account archive rows', async () => {
    await restoreLegacyFavoriteSchema();
    for (const angle of [20, 40]) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
        VALUES (${USER_ID}, 'kilter', ${KILTER_CLIMB}, ${angle})
      `);
    }
    for (const angle of [25, 35]) {
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
        VALUES (${OTHER_USER_ID}, 'kilter', ${KILTER_CLIMB}, ${angle})
      `);
    }

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('The isolated worker DATABASE_URL is required');
    const migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
    const observer = postgres(connectionString, { max: 1, onnotice: () => {} });
    let signalReady!: (pid: number) => void;
    let signalFailure!: (error: unknown) => void;
    const migrationReady = new Promise<number>((resolve, reject) => {
      signalReady = resolve;
      signalFailure = reject;
    });
    let releaseMigration!: () => void;
    let migrationReleased = false;
    const migrationRelease = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const resumeMigration = () => {
      if (!migrationReleased) {
        migrationReleased = true;
        releaseMigration();
      }
    };

    const migrationPromise = migrationClient
      .begin(async (transaction) => {
        try {
          const [backend] = await transaction`SELECT pg_backend_pid() AS pid`;
          await runFavoritesRekeyMigration(transaction);
          signalReady(Number(backend.pid));
          await migrationRelease;
        } catch (error) {
          signalFailure(error);
          throw error;
        }
      })
      .catch((error: unknown) => {
        signalFailure(error);
        throw error;
      });
    void migrationPromise.catch(() => {});

    let deletionFinished = false;
    let deletionError: unknown;
    let deletionPromise: Promise<void> | undefined;

    try {
      const migrationPid = await migrationReady;
      deletionPromise = userMutations
        .deleteAccount(undefined, { input: { removeSetterName: false } }, ctx(USER_ID))
        .then(
          () => {
            deletionFinished = true;
          },
          (error: unknown) => {
            deletionFinished = true;
            deletionError = error;
          },
        );
      const [archiveState] = await observer`
        SELECT to_regclass('public.user_favorites_dedup_backup_0194') IS NULL AS absent
      `;
      expect(archiveState.absent).toBe(true);
      expect(await waitForFavoriteMigrationLock(observer, migrationPid)).toBe(true);
      expect(deletionFinished).toBe(false);

      resumeMigration();
      await migrationPromise;
      await deletionPromise;
      if (deletionError !== undefined) throw deletionError;

      expect(await archivedFavoriteCount(USER_ID)).toBe(0);
      expect(await archivedFavoriteCount(OTHER_USER_ID)).toBe(1);
      expect(await favoriteRowCount(KILTER_CLIMB, OTHER_USER_ID)).toBe(1);
      const deletedUser = await db.execute(sql`SELECT id FROM users WHERE id = ${USER_ID}`);
      expect(Array.from(deletedUser)).toEqual([]);
    } finally {
      resumeMigration();
      await migrationPromise.catch(() => {});
      await deletionPromise;
      await ensureRekeyedFavoriteSchema(migrationClient);
      await observer.end();
      await migrationClient.end();
    }
  });

  it('deletes before migration without leaving favorites to archive', async () => {
    await restoreLegacyFavoriteSchema();
    for (const userId of [USER_ID, OTHER_USER_ID]) {
      for (const angle of [20, 40]) {
        await db.execute(sql`
          INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
          VALUES (${userId}, 'kilter', ${KILTER_CLIMB}, ${angle})
        `);
      }
    }

    await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, ctx(USER_ID));

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('The isolated worker DATABASE_URL is required');
    const migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await migrationClient.begin(async (transaction) => runFavoritesRekeyMigration(transaction));

      expect(await archivedFavoriteCount(USER_ID)).toBe(0);
      expect(await archivedFavoriteCount(OTHER_USER_ID)).toBe(1);
      expect(await favoriteRowCount(KILTER_CLIMB, OTHER_USER_ID)).toBe(1);
      const deletedUser = await db.execute(sql`SELECT id FROM users WHERE id = ${USER_ID}`);
      expect(Array.from(deletedUser)).toEqual([]);
    } finally {
      await ensureRekeyedFavoriteSchema(migrationClient);
      await migrationClient.end();
    }
  });
});

describe('smart LIKED_CLIMBS visibility uses catalog identity', () => {
  const privateWallUuid = 'fav-key-private-wall';
  const publicWallUuid = 'fav-key-public-wall';
  const privateClimbUuid = 'fav-key-private-spray-climb';
  const publicClimbUuid = 'fav-key-public-spray-climb';

  async function seedSprayWall(boardUuid: string, layoutId: number, climbUuid: string, isPublic: boolean) {
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, has_leds)
      VALUES (${boardUuid}, ${boardUuid}, ${OTHER_USER_ID}, 'spray', ${layoutId}, ${layoutId}, '1', ${boardUuid}, ${isPublic}, false)
    `);
    await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${boardUuid}, ${layoutId})`);
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, created_at)
      VALUES (${climbUuid}, 'spray', ${layoutId}, ${climbUuid}, 'p1r1', 1, false, true, '2026-01-01')
    `);
  }

  it('keeps a stale legacy board name from inflating a stranger’s private-climb count', async () => {
    try {
      await seedSprayWall(privateWallUuid, 851201, privateClimbUuid, false);
      await seedSprayWall(publicWallUuid, 851202, publicClimbUuid, true);
      await db.execute(sql`
        INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
        VALUES
          (${OTHER_USER_ID}, 'kilter', ${privateClimbUuid}, 40),
          (${OTHER_USER_ID}, 'spray', ${publicClimbUuid}, 40)
      `);

      const strangerView = await playlistQueries.smartPlaylist(
        undefined,
        { input: { type: 'LIKED_CLIMBS', userId: OTHER_USER_ID, page: 0, pageSize: 10 } },
        ctx(USER_ID),
      );
      expect(strangerView.totalCount).toBe(1);
      expect(strangerView.climbs.map((climb) => climb.uuid)).toEqual([publicClimbUuid]);

      const ownerView = await playlistQueries.smartPlaylist(
        undefined,
        { input: { type: 'LIKED_CLIMBS', userId: OTHER_USER_ID, page: 0, pageSize: 10 } },
        ctx(OTHER_USER_ID),
      );
      expect(ownerView.totalCount).toBe(2);
      expect(ownerView.climbs.map((climb) => climb.uuid).sort()).toEqual([privateClimbUuid, publicClimbUuid]);
      const legacyMetadata = await db.execute(
        sql`SELECT board_name FROM user_favorites WHERE user_id = ${OTHER_USER_ID} AND climb_uuid = ${privateClimbUuid}`,
      );
      expect(Array.from(legacyMetadata)).toEqual([{ board_name: 'kilter' }]);
    } finally {
      await db.execute(sql`
        DELETE FROM user_favorites WHERE climb_uuid IN (${privateClimbUuid}, ${publicClimbUuid})
      `);
      await db.execute(sql`DELETE FROM spray_walls WHERE board_uuid IN (${privateWallUuid}, ${publicWallUuid})`);
      await db.execute(sql`DELETE FROM user_boards WHERE uuid IN (${privateWallUuid}, ${publicWallUuid})`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid IN (${privateClimbUuid}, ${publicClimbUuid})`);
    }
  });
});
