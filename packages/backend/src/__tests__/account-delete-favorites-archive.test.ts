import postgres from 'postgres';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { executeFirstRow } from '@boardsesh/db/client';
import { db } from '../db/client';
import { userMutations } from '../graphql/resolvers/users/mutations';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const OWNER_ID = 'favorites-archive-delete-owner';
const OTHER_USER_ID = 'favorites-archive-delete-other';
const OWNER_CLIMB = 'favorites-archive-delete-owner-climb';
const OTHER_CLIMB = 'favorites-archive-delete-other-climb';

function context(userId = OWNER_ID): ConnectionContext {
  return {
    connectionId: 'favorites-archive-delete-test',
    isAuthenticated: true,
    userId,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

async function insertUser(userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${`${userId}@test.invalid`}, ${userId}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertFavorite(userId: string, climbUuid: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.user_favorites (user_id, board_name, climb_uuid, angle, created_at, updated_at)
    VALUES (${userId}, 'kilter', ${climbUuid}, ${angle}, now(), now())
  `);
}

async function archiveExists(): Promise<boolean> {
  const row = await executeFirstRow<{ present: boolean }>(
    db,
    sql`SELECT to_regclass('public.user_favorites_dedup_backup_0194') IS NOT NULL AS present`,
  );
  return row?.present === true;
}

async function archiveCount(userId: string): Promise<number> {
  const row = await executeFirstRow<{ count: number }>(
    db,
    sql`SELECT count(*)::int AS count FROM public.user_favorites_dedup_backup_0194 WHERE user_id = ${userId}`,
  );
  return Number(row?.count ?? 0);
}

async function favoriteCount(userId: string): Promise<number> {
  const row = await executeFirstRow<{ count: number }>(
    db,
    sql`SELECT count(*)::int AS count FROM public.user_favorites WHERE user_id = ${userId}`,
  );
  return Number(row?.count ?? 0);
}

async function userExists(userId: string): Promise<boolean> {
  const row = await executeFirstRow<{ present: boolean }>(
    db,
    sql`SELECT EXISTS (SELECT 1 FROM public.users WHERE id = ${userId}) AS present`,
  );
  return row?.present === true;
}

async function createArchiveTable(client: postgres.Sql | postgres.TransactionSql): Promise<void> {
  await client`
    CREATE TABLE public.user_favorites_dedup_backup_0194 (
      id bigint PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      board_name text NOT NULL,
      climb_uuid text NOT NULL,
      angle integer NOT NULL,
      created_at timestamp NOT NULL,
      updated_at timestamp NOT NULL
    )
  `;
  await client`
    CREATE INDEX user_favorites_dedup_backup_0194_user_climb_idx
    ON public.user_favorites_dedup_backup_0194 (user_id, climb_uuid)
  `;
}

async function createArchiveFromDuplicateFavorites(client: postgres.TransactionSql): Promise<void> {
  // This models the archive-table DDL and population inside migration 0250's
  // transaction. The test intentionally leaves that migration out of this PR.
  await createArchiveTable(client);
  await client`
    INSERT INTO public.user_favorites_dedup_backup_0194
      (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
    SELECT id, user_id, board_name, climb_uuid, angle, created_at, updated_at
    FROM (
      SELECT id, user_id, board_name, climb_uuid, angle, created_at, updated_at,
             row_number() OVER (
               PARTITION BY user_id, climb_uuid
               ORDER BY created_at DESC, id DESC
             ) AS rn
      FROM public.user_favorites
    ) ranked
    WHERE ranked.rn > 1
  `;
  await client`ALTER TABLE public.user_favorites DISABLE TRIGGER trg_favorites_delete`;
  await client`
    DELETE FROM public.user_favorites AS favorites
    USING public.user_favorites_dedup_backup_0194 AS archived
    WHERE favorites.id = archived.id
  `;
  await client`ALTER TABLE public.user_favorites ENABLE TRIGGER trg_favorites_delete`;
}

async function waitForDeleteLock(observer: postgres.Sql, migrationPid: number): Promise<boolean> {
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
  const row = await executeFirstRow<{ database_name: string }>(db, sql`SELECT current_database() AS database_name`);
  if (!row?.database_name.startsWith('boardsesh_backend_test_w')) {
    throw new Error('Archive-delete integration tests require an isolated backend worker database');
  }
});

beforeEach(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS favorites_archive_guard_reject_account_delete ON public.users`);
  await db.execute(sql`DROP FUNCTION IF EXISTS public.favorites_archive_guard_reject_account_delete()`);
  await db.execute(sql`DROP TABLE IF EXISTS public.user_favorites_dedup_backup_0194`);
  await db.execute(sql`DELETE FROM public.users WHERE id IN (${OWNER_ID}, ${OTHER_USER_ID})`);
  await insertUser(OWNER_ID);
  await insertUser(OTHER_USER_ID);
  await insertFavorite(OWNER_ID, OWNER_CLIMB, 20);
  await insertFavorite(OTHER_USER_ID, OTHER_CLIMB, 30);
});

afterAll(async () => {
  await db.execute(sql`DROP TRIGGER IF EXISTS favorites_archive_guard_reject_account_delete ON public.users`);
  await db.execute(sql`DROP FUNCTION IF EXISTS public.favorites_archive_guard_reject_account_delete()`);
  await db.execute(sql`DROP TABLE IF EXISTS public.user_favorites_dedup_backup_0194`);
  await db.execute(sql`DELETE FROM public.users WHERE id IN (${OWNER_ID}, ${OTHER_USER_ID})`);
});

describe('account deletion cleans legacy favorite archives safely', () => {
  it('keeps the pre-migration path working when the archive table is absent', async () => {
    expect(await archiveExists()).toBe(false);

    await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context());

    expect(await archiveExists()).toBe(false);
    expect(await userExists(OWNER_ID)).toBe(false);
    expect(await userExists(OTHER_USER_ID)).toBe(true);
    expect(await favoriteCount(OWNER_ID)).toBe(0);
    expect(await favoriteCount(OTHER_USER_ID)).toBe(1);
  });

  it('removes only the account’s archived favorites and leaves another account intact', async () => {
    const archiveClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await createArchiveTable(archiveClient);
      await archiveClient`
        INSERT INTO public.user_favorites_dedup_backup_0194
          (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES
          (810001, ${OWNER_ID}, 'kilter', ${OWNER_CLIMB}, 20, now(), now()),
          (810002, ${OWNER_ID}, 'kilter', ${OWNER_CLIMB}, 40, now(), now()),
          (810003, ${OTHER_USER_ID}, 'kilter', ${OTHER_CLIMB}, 30, now(), now())
      `;
    } finally {
      await archiveClient.end();
    }

    await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context());

    expect(await archiveCount(OWNER_ID)).toBe(0);
    expect(await archiveCount(OTHER_USER_ID)).toBe(1);
    expect(await userExists(OWNER_ID)).toBe(false);
    expect(await userExists(OTHER_USER_ID)).toBe(true);
    expect(await favoriteCount(OTHER_USER_ID)).toBe(1);
  });

  it('restores archived favorites if a later account-delete step fails', async () => {
    const archiveClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await createArchiveTable(archiveClient);
      await archiveClient`
        INSERT INTO public.user_favorites_dedup_backup_0194
          (id, user_id, board_name, climb_uuid, angle, created_at, updated_at)
        VALUES (820001, ${OWNER_ID}, 'kilter', ${OWNER_CLIMB}, 20, now(), now())
      `;
    } finally {
      await archiveClient.end();
    }
    await db.execute(sql`
      CREATE FUNCTION public.favorites_archive_guard_reject_account_delete() RETURNS trigger AS $body$
      BEGIN
        IF OLD.id = 'favorites-archive-delete-owner' THEN
          RAISE EXCEPTION 'synthetic account-delete failure';
        END IF;
        RETURN OLD;
      END;
      $body$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      CREATE TRIGGER favorites_archive_guard_reject_account_delete BEFORE DELETE ON public.users
      FOR EACH ROW EXECUTE FUNCTION public.favorites_archive_guard_reject_account_delete()
    `);

    let deletionError: unknown;
    try {
      await userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context());
    } catch (error) {
      deletionError = error;
    }

    expect(getPostgresErrorCode(deletionError)).toBe('P0001');
    expect(await archiveCount(OWNER_ID)).toBe(1);
    expect(await userExists(OWNER_ID)).toBe(true);
    expect(await favoriteCount(OWNER_ID)).toBe(1);
  });

  it('waits for archive DDL, then observes and removes the committed archive row', async () => {
    await insertFavorite(OWNER_ID, OWNER_CLIMB, 40);
    await insertFavorite(OTHER_USER_ID, OTHER_CLIMB, 50);
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('The owned worker DATABASE_URL is required');
    const migrationClient = postgres(connectionString, { max: 1, onnotice: () => {} });
    const observer = postgres(connectionString, { max: 1, onnotice: () => {} });
    let signalMigrationReady!: (pid: number) => void;
    let rejectMigrationReady!: (error: unknown) => void;
    const migrationReady = new Promise<number>((resolve, reject) => {
      signalMigrationReady = resolve;
      rejectMigrationReady = reject;
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
          // Migration 0250's ALTER TABLE takes this mode before creating and
          // populating the archive; use the same relation lock in this fixture.
          await transaction`LOCK TABLE public.user_favorites IN ACCESS EXCLUSIVE MODE`;
          await createArchiveFromDuplicateFavorites(transaction);
          signalMigrationReady(Number(backend.pid));
          await migrationRelease;
        } catch (error) {
          rejectMigrationReady(error);
          throw error;
        }
      })
      .catch((error: unknown) => {
        rejectMigrationReady(error);
        throw error;
      });
    void migrationPromise.catch(() => {});

    let deletionFinished = false;
    let deletionError: unknown;
    let deletionPromise: Promise<void> | undefined;

    try {
      const migrationPid = await migrationReady;
      const [visibleArchive] = await observer`
        SELECT to_regclass('public.user_favorites_dedup_backup_0194') IS NOT NULL AS present
      `;
      expect(visibleArchive.present).toBe(false);

      deletionPromise = userMutations.deleteAccount(undefined, { input: { removeSetterName: false } }, context()).then(
        () => {
          deletionFinished = true;
        },
        (error: unknown) => {
          deletionFinished = true;
          deletionError = error;
        },
      );

      expect(await waitForDeleteLock(observer, migrationPid)).toBe(true);
      expect(deletionFinished).toBe(false);

      resumeMigration();
      await migrationPromise;
      await deletionPromise;
      if (deletionError !== undefined) throw deletionError;

      expect(await archiveCount(OWNER_ID)).toBe(0);
      expect(await archiveCount(OTHER_USER_ID)).toBe(1);
      expect(await favoriteCount(OWNER_ID)).toBe(0);
      expect(await favoriteCount(OTHER_USER_ID)).toBe(1);
      expect(await userExists(OWNER_ID)).toBe(false);
      expect(await userExists(OTHER_USER_ID)).toBe(true);
    } finally {
      resumeMigration();
      await migrationPromise.catch(() => {});
      await deletionPromise;
      await observer.end();
      await migrationClient.end();
    }
  }, 20_000);
});
