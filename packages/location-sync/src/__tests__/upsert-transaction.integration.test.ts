import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { closePool, createDb, createPool, executeRows } from '@boardsesh/db/client';
import { gyms, locationSyncGymSources, userBoards, users } from '@boardsesh/db/schema';
import { boardUuidForSource, gymUuidForSource } from '../ids';
import { resolveLocationSyncIntegrationConfig } from '../integration-test-config';
import type { PublicBoardLocationInput } from '../types';
import {
  applyPublicBoardLocationsInTransaction,
  upsertPublicBoardLocations,
  type LocationSyncTransaction,
} from '../upsert';

const integrationConfig = resolveLocationSyncIntegrationConfig(process.env);
const restrictedRole = `location_apply_${randomUUID().replaceAll('-', '')}`;
let roleCreated = false;

function locationRecord(): PublicBoardLocationInput {
  const fixtureId = randomUUID();
  return {
    sourceKey: `moonboard:transaction-board-${fixtureId}`,
    gymSourceKey: `moonboard:transaction-gym-${fixtureId}`,
    name: `Transaction board ${fixtureId}`,
    slugBase: `transaction-board-${fixtureId}`,
    locationName: null,
    latitude: -71,
    longitude: 110,
    gymName: `Transaction gym ${fixtureId}`,
    gymAddress: null,
    boardType: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    isAngleAdjustable: false,
  };
}

async function transactionLimits(transaction: LocationSyncTransaction): Promise<void> {
  await transaction.execute(sql`SET LOCAL statement_timeout = '5s'`);
  await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
}

async function assertNoLocationRows(record: PublicBoardLocationInput): Promise<void> {
  const database = createDb();
  expect(
    await database
      .select({ id: userBoards.id })
      .from(userBoards)
      .where(eq(userBoards.uuid, boardUuidForSource(record.sourceKey))),
  ).toEqual([]);
  expect(
    await database
      .select({ id: gyms.id })
      .from(gyms)
      .where(eq(gyms.uuid, gymUuidForSource(record.gymSourceKey))),
  ).toEqual([]);
  expect(
    await database
      .select({ sourceKey: locationSyncGymSources.sourceKey })
      .from(locationSyncGymSources)
      .where(eq(locationSyncGymSources.sourceKey, record.gymSourceKey)),
  ).toEqual([]);
}

function postgresErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

/** Every fixture transaction rolls back; a failed assertion remains a failure. */
async function rollbackFixture(callback: (transaction: LocationSyncTransaction) => Promise<void>): Promise<void> {
  const rollback = new Error('rollback location transaction fixture');
  try {
    await createDb().transaction(async (transaction) => {
      await transactionLimits(transaction);
      await callback(transaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe.skipIf(integrationConfig.databaseUrl === null)('caller-owned location transaction (PostGIS)', () => {
  beforeAll(async () => {
    const database = createDb();
    const [prerequisites] = await executeRows<{ postgis: boolean; triggers: boolean; administrator: boolean }>(
      database,
      sql`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis,
             (SELECT count(*) = 2 FROM pg_trigger
              WHERE (tgname = 'gyms_set_location' AND tgrelid = 'public.gyms'::regclass
                  OR tgname = 'user_boards_set_location' AND tgrelid = 'public.user_boards'::regclass)
                AND NOT tgisinternal AND tgenabled <> 'D') AS triggers,
             (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS administrator
    `,
    );
    expect(prerequisites).toEqual({ postgis: true, triggers: true, administrator: true });
    await database.execute(
      sql`CREATE ROLE ${sql.identifier(restrictedRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    roleCreated = true;
    await database.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(restrictedRole)}`);
    await database.execute(
      sql`GRANT SELECT, INSERT, UPDATE ON public.gyms, public.user_boards, public.location_sync_gym_sources TO ${sql.identifier(restrictedRole)}`,
    );
    await database.execute(
      sql`GRANT SELECT ON public.gym_claims, public.gym_members, public.gym_follows, public.comments TO ${sql.identifier(restrictedRole)}`,
    );
    await database.execute(
      sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql.identifier(restrictedRole)}`,
    );
  });

  afterAll(async () => {
    try {
      if (roleCreated) {
        const database = createDb();
        // This fresh NOLOGIN role owns no objects; revoke its fixture grants.
        await database.execute(sql`DROP OWNED BY ${sql.identifier(restrictedRole)}`);
        await database.execute(sql`DROP ROLE ${sql.identifier(restrictedRole)}`);
      }
    } finally {
      await closePool();
    }
  });

  it('applies geography and aliases without permission to ensure or read users', async () => {
    const record = locationRecord();
    await rollbackFixture(async (transaction) => {
      await upsertPublicBoardLocations(transaction, []);
      await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(restrictedRole)}`);
      let deniedCode: string | undefined;
      try {
        await transaction.transaction(async (savepoint) => upsertPublicBoardLocations(savepoint, []));
      } catch (error) {
        deniedCode = postgresErrorCode(error);
      }
      expect(deniedCode).toBe('42501');
      let readDeniedCode: string | undefined;
      try {
        await transaction.transaction(async (savepoint) => savepoint.select({ id: users.id }).from(users).limit(0));
      } catch (error) {
        readDeniedCode = postgresErrorCode(error);
      }
      expect(readDeniedCode).toBe('42501');
      const summary = await applyPublicBoardLocationsInTransaction(transaction, [record]);
      expect(summary).toMatchObject({
        boardsSeen: 1,
        boardsUpserted: 1,
        gymsSeen: 1,
        gymsUpserted: 1,
        boardsSkipped: 0,
        skipped: [],
      });
      const [stored] = await executeRows<{ boardPoint: string; gymPoint: string; aliasMatches: boolean }>(
        transaction,
        sql`
        SELECT ST_AsText(board.location::geometry) AS "boardPoint",
               ST_AsText(gym.location::geometry) AS "gymPoint",
               alias.gym_id = gym.id AS "aliasMatches"
        FROM user_boards board JOIN gyms gym ON gym.id = board.gym_id
        JOIN location_sync_gym_sources alias ON alias.gym_id = gym.id
        WHERE board.uuid = ${boardUuidForSource(record.sourceKey)} AND alias.source_key = ${record.gymSourceKey}
      `,
      );
      expect(stored).toEqual({ boardPoint: 'POINT(110 -71)', gymPoint: 'POINT(110 -71)', aliasMatches: true });
    });
    await assertNoLocationRows(record);
  });

  it('keeps all location writes inside the supplied outer rollback', async () => {
    const record = locationRecord();
    const rejected = new Error('reject after successful location apply');
    await expect(
      createDb().transaction(async (transaction) => {
        await transactionLimits(transaction);
        await upsertPublicBoardLocations(transaction, []);
        const summary = await applyPublicBoardLocationsInTransaction(transaction, [record]);
        expect(summary.boardsUpserted).toBe(1);
        throw rejected;
      }),
    ).rejects.toBe(rejected);
    await assertNoLocationRows(record);
  });

  it('rolls back an actual completed board insert when its checkpoint throws', async () => {
    const first = locationRecord();
    const second = locationRecord();
    const stopped = new Error('stop after real board insert');
    let boardInsertObserved = false;
    const database = drizzle(createPool(), {
      logger: {
        logQuery(query: string) {
          if (query.startsWith('insert into "user_boards"')) boardInsertObserved = true;
        },
      },
    });
    await expect(
      database.transaction(async (transaction) => {
        await transactionLimits(transaction);
        await upsertPublicBoardLocations(transaction, []);
        await applyPublicBoardLocationsInTransaction(transaction, [first, second], {
          assertActive() {
            if (boardInsertObserved) throw stopped;
          },
        });
      }),
    ).rejects.toBe(stopped);
    expect(boardInsertObserved).toBe(true);
    await assertNoLocationRows(first);
    await assertNoLocationRows(second);
  });

  it('retains record-level invalid-coordinate skips through the supplied transaction', async () => {
    const record = { ...locationRecord(), latitude: Number.NaN };
    await rollbackFixture(async (transaction) => {
      await upsertPublicBoardLocations(transaction, []);
      await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(restrictedRole)}`);
      expect(await applyPublicBoardLocationsInTransaction(transaction, [record])).toEqual({
        boardsSeen: 1,
        boardsUpserted: 0,
        boardsSkipped: 1,
        gymsSeen: 0,
        gymsUpserted: 0,
        skipped: [{ sourceKey: record.sourceKey, reason: 'invalid coordinates' }],
      });
    });
    await assertNoLocationRows(record);
  });
});
