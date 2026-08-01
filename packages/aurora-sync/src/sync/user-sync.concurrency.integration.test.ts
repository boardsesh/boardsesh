// Real-PostgreSQL coverage for issue #3950. The test self-skips unless
// DATABASE_URL points at a local, migrated database. Run it with:
//
//   DATABASE_URL=postgres://...@localhost:5432/... \
//     vp test run --reporter=agent packages/aurora-sync/src/sync/user-sync.concurrency.integration.test.ts

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { boardCircuits, boardUsers, playlistClimbs, playlistOwnership, playlists, users } from '@boardsesh/db/schema';
import { getAuroraCircuitAdvisoryLockKey, upsertTableData } from './user-sync';

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;

  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', 'postgres'].includes(hostname) ? databaseUrl : null;
  } catch {
    return null;
  }
}

const describeIntegration = localDatabaseUrl() ? describe : describe.skip;
type UpsertDb = Parameters<typeof upsertTableData>[0];
type CircuitRow = Parameters<typeof upsertTableData>[5][number];
type IntegrationSqlClient = ReturnType<typeof postgres>;

type SchemaReadiness = {
  missing_relations: string[];
  missing_columns: string[];
  missing_indexes: string[];
  missing_constraints: string[];
};

async function integrationSchemaSkipReason(client: IntegrationSqlClient): Promise<string | null> {
  const [readiness] = await client<SchemaReadiness[]>`
    WITH required_relations(name) AS (
      VALUES
        ('users'),
        ('board_users'),
        ('board_circuits'),
        ('playlists'),
        ('playlist_ownership'),
        ('playlist_climbs')
    ),
    required_columns(table_name, column_name) AS (
      VALUES
        ('users', 'id'),
        ('users', 'email'),
        ('board_users', 'board_type'),
        ('board_users', 'id'),
        ('board_users', 'username'),
        ('board_circuits', 'board_type'),
        ('board_circuits', 'uuid'),
        ('board_circuits', 'name'),
        ('board_circuits', 'description'),
        ('board_circuits', 'color'),
        ('board_circuits', 'user_id'),
        ('board_circuits', 'is_public'),
        ('board_circuits', 'created_at'),
        ('board_circuits', 'updated_at'),
        ('playlists', 'id'),
        ('playlists', 'uuid'),
        ('playlists', 'board_type'),
        ('playlists', 'layout_id'),
        ('playlists', 'name'),
        ('playlists', 'description'),
        ('playlists', 'is_public'),
        ('playlists', 'color'),
        ('playlists', 'icon'),
        ('playlists', 'aurora_type'),
        ('playlists', 'aurora_id'),
        ('playlists', 'aurora_synced_at'),
        ('playlists', 'kilter_type'),
        ('playlists', 'kilter_id'),
        ('playlists', 'kilter_synced_at'),
        ('playlists', 'generated_recommendation'),
        ('playlists', 'created_at'),
        ('playlists', 'updated_at'),
        ('playlists', 'last_accessed_at'),
        ('playlist_ownership', 'playlist_id'),
        ('playlist_ownership', 'user_id'),
        ('playlist_ownership', 'role'),
        ('playlist_climbs', 'playlist_id'),
        ('playlist_climbs', 'climb_uuid'),
        ('playlist_climbs', 'angle'),
        ('playlist_climbs', 'position')
    ),
    required_indexes(name, table_name) AS (
      VALUES
        ('playlists_aurora_id_idx', 'playlists'),
        ('unique_playlist_ownership', 'playlist_ownership')
    ),
    required_constraints(name, table_name, constraint_type, delete_action) AS (
      VALUES
        ('users_pkey', 'users', 'p', NULL),
        ('board_users_board_type_id_pk', 'board_users', 'p', NULL),
        ('board_circuits_board_type_uuid_pk', 'board_circuits', 'p', NULL),
        ('playlists_pkey', 'playlists', 'p', NULL),
        ('board_circuits_user_fk', 'board_circuits', 'f', 'c'),
        ('playlist_climbs_playlist_id_playlists_id_fk', 'playlist_climbs', 'f', 'c'),
        ('playlist_ownership_playlist_id_playlists_id_fk', 'playlist_ownership', 'f', 'c'),
        ('playlist_ownership_user_id_users_id_fk', 'playlist_ownership', 'f', 'c')
    )
    SELECT
      ARRAY(
        SELECT required_relations.name
        FROM required_relations
        WHERE to_regclass('public.' || required_relations.name) IS NULL
        ORDER BY required_relations.name
      ) AS missing_relations,
      ARRAY(
        SELECT required_columns.table_name || '.' || required_columns.column_name
        FROM required_columns
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns AS schema_columns
          WHERE schema_columns.table_schema = 'public'
            AND schema_columns.table_name = required_columns.table_name
            AND schema_columns.column_name = required_columns.column_name
        )
        ORDER BY required_columns.table_name, required_columns.column_name
      ) AS missing_columns,
      ARRAY(
        SELECT required_indexes.name
        FROM required_indexes
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_class index_class
          INNER JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
          INNER JOIN pg_index index_metadata ON index_metadata.indexrelid = index_class.oid
          INNER JOIN pg_class table_class ON table_class.oid = index_metadata.indrelid
          WHERE index_namespace.nspname = 'public'
            AND index_class.relname = required_indexes.name
            AND table_class.relname = required_indexes.table_name
            AND index_metadata.indisunique
            AND index_metadata.indisvalid
            AND index_metadata.indisready
        )
        ORDER BY required_indexes.name
      ) AS missing_indexes,
      ARRAY(
        SELECT required_constraints.name
        FROM required_constraints
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint constraint_metadata
          INNER JOIN pg_class table_class ON table_class.oid = constraint_metadata.conrelid
          INNER JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
          WHERE table_namespace.nspname = 'public'
            AND table_class.relname = required_constraints.table_name
            AND constraint_metadata.conname = required_constraints.name
            AND constraint_metadata.contype::text = required_constraints.constraint_type
            AND constraint_metadata.convalidated
            AND (
              required_constraints.delete_action IS NULL
              OR constraint_metadata.confdeltype::text = required_constraints.delete_action
            )
        )
        ORDER BY required_constraints.name
      ) AS missing_constraints
  `;

  if (!readiness) return 'could not inspect the local PostgreSQL schema for issue #3950';

  const problems = [
    readiness.missing_relations.length > 0 ? `relations: ${readiness.missing_relations.join(', ')}` : null,
    readiness.missing_columns.length > 0 ? `columns: ${readiness.missing_columns.join(', ')}` : null,
    readiness.missing_indexes.length > 0 ? `unique indexes: ${readiness.missing_indexes.join(', ')}` : null,
    readiness.missing_constraints.length > 0 ? `constraints: ${readiness.missing_constraints.join(', ')}` : null,
  ].filter((problem): problem is string => problem !== null);

  return problems.length > 0
    ? `local PostgreSQL schema is not current for issue #3950 (${problems.join('; ')}); run the repo migrations before treating this integration test as passing`
    : null;
}

function circuitRow(uuid: string, name: string, climbUuid: string): CircuitRow {
  return {
    uuid,
    name,
    description: '',
    color: '',
    is_public: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    climbs: [{ climb_uuid: climbUuid }],
  } as unknown as CircuitRow;
}

/** Release all participants only after every database transaction is open. */
function createTransactionBarrier(participantCount: number, timeoutMs = 5_000): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const allArrived = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for both circuit transactions')), timeoutMs);
    release = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  return async () => {
    arrived += 1;
    if (arrived === participantCount) release?.();
    await allArrived;
  };
}

async function waitForBlockedCircuitSourceUpsert(
  client: IntegrationSqlClient,
  claimantApplicationNamePrefix: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [activity] = await client<{ blocked_count: number }[]>`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name LIKE ${`${claimantApplicationNamePrefix}%`}
        AND wait_event_type = 'Lock'
        AND query ILIKE '%board_circuits%'
    `;
    if ((activity?.blocked_count ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for a claimant to block on the board_circuits source upsert');
}

describeIntegration('Aurora circuit ownership arbitration concurrency (#3950)', () => {
  it('holds the advisory lock before a blocked source upsert and gives one claimant sole ownership', async (testContext) => {
    const databaseUrl = localDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DATABASE_URL to a local, migrated PostgreSQL database to run issue #3950 coverage');
      return;
    }

    const client = postgres(databaseUrl, { max: 4, prepare: false, idle_timeout: 5, onnotice: () => {} });
    const db = drizzle(client);
    const schemaSkipReason = await integrationSchemaSkipReason(client);
    if (schemaSkipReason) {
      await client.end();
      testContext.skip(schemaSkipReason);
      return;
    }

    const testTag = randomUUID();
    const circuitUuid = `issue-3950-${testTag}`;
    const userIds = [`issue-3950-a-${testTag}`, `issue-3950-b-${testTag}`] as const;
    let insertedUserIds: string[] = [];
    let auroraUserId: number | undefined;
    let ownsCircuitFixture = false;
    const climbUuids = [`issue-3950-climb-a-${testTag}`, `issue-3950-climb-b-${testTag}`] as const;
    const logs: string[][] = [[], []];

    try {
      const insertedUsers = await db
        .insert(users)
        .values([
          { id: userIds[0], email: `${userIds[0]}@example.invalid` },
          { id: userIds[1], email: `${userIds[1]}@example.invalid` },
        ])
        .onConflictDoNothing()
        .returning({ id: users.id });
      insertedUserIds = insertedUsers.map((row) => row.id);
      if (insertedUsers.length !== userIds.length) {
        throw new Error('Could not allocate isolated user fixtures for issue #3950');
      }

      // board_users has a composite integer PK and shared developer databases
      // may already contain high IDs. Claim one with INSERT ... DO NOTHING and
      // only ever clean up the row this test actually inserted.
      const candidateBase = 1_900_000_000 + (Number.parseInt(testTag.slice(0, 7), 16) % 100_000_000);
      for (let attempt = 0; attempt < 20 && auroraUserId === undefined; attempt += 1) {
        const candidateId = candidateBase + attempt;
        const insertedBoardUsers = await db
          .insert(boardUsers)
          .values({
            boardType: 'tension',
            id: candidateId,
            username: `issue-3950-${testTag}`,
          })
          .onConflictDoNothing()
          .returning({ id: boardUsers.id });
        auroraUserId = insertedBoardUsers[0]?.id;
      }
      if (auroraUserId === undefined) {
        throw new Error('Could not allocate an isolated board_users fixture for issue #3950');
      }
      const claimedAuroraUserId = auroraUserId;

      const [existingPlaylists, existingCircuits] = await Promise.all([
        db.select({ id: playlists.id }).from(playlists).where(eq(playlists.auroraId, circuitUuid)),
        db
          .select({ uuid: boardCircuits.uuid })
          .from(boardCircuits)
          .where(and(eq(boardCircuits.boardType, 'tension'), eq(boardCircuits.uuid, circuitUuid))),
      ]);
      if (existingPlaylists.length > 0 || existingCircuits.length > 0) {
        throw new Error('Could not allocate an isolated circuit namespace for issue #3950');
      }
      await db.insert(boardCircuits).values({
        boardType: 'tension',
        uuid: circuitUuid,
        name: 'Source-lock fixture',
        userId: claimedAuroraUserId,
      });
      ownsCircuitFixture = true;

      let releaseSourceBlocker: (() => void) | undefined;
      let markSourceBlockerReady: (() => void) | undefined;
      const sourceBlockerRelease = new Promise<void>((resolve) => {
        releaseSourceBlocker = resolve;
      });
      const sourceBlockerReady = new Promise<void>((resolve) => {
        markSourceBlockerReady = resolve;
      });
      const sourceBlockerApplicationName = `issue-3950-source-blocker-${testTag}`;
      const sourceBlockerPromise = db.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT set_config('application_name', ${sourceBlockerApplicationName}, true)`);
        await transaction.execute(sql`
          SELECT uuid
          FROM board_circuits
          WHERE board_type = 'tension' AND uuid = ${circuitUuid}
          FOR UPDATE
        `);
        markSourceBlockerReady?.();
        await sourceBlockerRelease;
      });
      await Promise.race([
        sourceBlockerReady,
        sourceBlockerPromise.then(() => {
          throw new Error('Source blocker transaction exited before acquiring its row lock');
        }),
      ]);

      const awaitBothTransactions = createTransactionBarrier(2);
      const claimantApplicationNamePrefix = `issue-3950-claimant-${testTag}`;
      const claimCircuit = (claimantIndex: 0 | 1) =>
        db.transaction(async (transaction) => {
          // Exercise the production shape: syncUserData owns this outer
          // transaction, upsertTableData opens the arbitration savepoint, and
          // each circuit opens its own nested playlist-write savepoint.
          await transaction.execute(
            sql`SELECT set_config('application_name', ${`${claimantApplicationNamePrefix}-${claimantIndex}`}, true)`,
          );
          await awaitBothTransactions();
          return upsertTableData(
            transaction as unknown as UpsertDb,
            'tension',
            'circuits',
            claimedAuroraUserId,
            userIds[claimantIndex],
            [circuitRow(circuitUuid, `Claim ${claimantIndex === 0 ? 'A' : 'B'}`, climbUuids[claimantIndex])],
            (message) => logs[claimantIndex].push(message),
          );
        });

      const claimantOutcomesPromise = Promise.all([claimCircuit(0), claimCircuit(1)]);
      let outcomes: Awaited<ReturnType<typeof upsertTableData>>[];
      try {
        // The fixture source row is deliberately locked by a third transaction.
        // A claimant must therefore hold the advisory lock while blocked on its
        // board_circuits upsert. Without advisory acquisition, the probe would
        // succeed and this regression test would fail even though the source-row
        // lock later happens to serialize the two playlist claims.
        await waitForBlockedCircuitSourceUpsert(client, claimantApplicationNamePrefix);
        const [advisoryProbe] = await client<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended(${getAuroraCircuitAdvisoryLockKey('tension', circuitUuid)}, 0::bigint)
          ) AS acquired
        `;
        expect(advisoryProbe?.acquired).toBe(false);

        releaseSourceBlocker?.();
        await sourceBlockerPromise;
        outcomes = await claimantOutcomesPromise;
      } finally {
        releaseSourceBlocker?.();
        await Promise.allSettled([sourceBlockerPromise, claimantOutcomesPromise]);
      }

      expect(outcomes.map((outcome) => outcome.skipped).sort((left, right) => left - right)).toEqual([0, 1]);
      const winnerIndex = outcomes[0].skipped === 0 ? 0 : 1;
      const loserIndex = winnerIndex === 0 ? 1 : 0;

      const ownerRows = await db
        .select({ userId: playlistOwnership.userId })
        .from(playlists)
        .innerJoin(playlistOwnership, eq(playlistOwnership.playlistId, playlists.id))
        .where(and(eq(playlists.auroraId, circuitUuid), eq(playlistOwnership.role, 'owner')));
      expect(ownerRows).toEqual([{ userId: userIds[winnerIndex] }]);

      const climbRows = await db
        .select({ climbUuid: playlistClimbs.climbUuid })
        .from(playlists)
        .innerJoin(playlistClimbs, eq(playlistClimbs.playlistId, playlists.id))
        .where(eq(playlists.auroraId, circuitUuid));
      expect(climbRows).toEqual([{ climbUuid: climbUuids[winnerIndex] }]);
      expect(logs[loserIndex].some((line) => line.includes('"reason":"foreign"'))).toBe(true);
      // The loser reaches the fresh ownership check only after the winning
      // production-shaped outer transaction commits.
      expect(logs[loserIndex].some((line) => line.includes('"stage":"ownership-check"'))).toBe(true);
    } finally {
      if (ownsCircuitFixture) {
        await db.delete(playlists).where(eq(playlists.auroraId, circuitUuid));
        await db
          .delete(boardCircuits)
          .where(and(eq(boardCircuits.boardType, 'tension'), eq(boardCircuits.uuid, circuitUuid)));
      }
      if (auroraUserId !== undefined) {
        await db.delete(boardUsers).where(and(eq(boardUsers.boardType, 'tension'), eq(boardUsers.id, auroraUserId)));
      }
      if (insertedUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, insertedUserIds));
      }
      await client.end();
    }
  }, 20_000);

  it('promotes an existing viewer edge when the syncing user claims an orphaned playlist', async (testContext) => {
    const databaseUrl = localDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DATABASE_URL to a local, migrated PostgreSQL database to run issue #3950 coverage');
      return;
    }

    const client = postgres(databaseUrl, { max: 2, prepare: false, idle_timeout: 5, onnotice: () => {} });
    const db = drizzle(client);
    const schemaSkipReason = await integrationSchemaSkipReason(client);
    if (schemaSkipReason) {
      await client.end();
      testContext.skip(schemaSkipReason);
      return;
    }

    const testTag = randomUUID();
    const circuitUuid = `issue-3950-promotion-${testTag}`;
    const userId = `issue-3950-viewer-${testTag}`;
    let insertedUserId: string | undefined;
    let auroraUserId: number | undefined;
    let insertedPlaylistId: bigint | undefined;
    let ownsCircuitFixture = false;

    try {
      const insertedUsers = await db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.invalid` })
        .onConflictDoNothing()
        .returning({ id: users.id });
      insertedUserId = insertedUsers[0]?.id;
      if (!insertedUserId) throw new Error('Could not allocate isolated promotion user fixture');

      const candidateBase = 1_800_000_000 + (Number.parseInt(testTag.slice(0, 7), 16) % 100_000_000);
      for (let attempt = 0; attempt < 20 && auroraUserId === undefined; attempt += 1) {
        const insertedBoardUsers = await db
          .insert(boardUsers)
          .values({
            boardType: 'tension',
            id: candidateBase + attempt,
            username: `issue-3950-promotion-${testTag}`,
          })
          .onConflictDoNothing()
          .returning({ id: boardUsers.id });
        auroraUserId = insertedBoardUsers[0]?.id;
      }
      if (auroraUserId === undefined) {
        throw new Error('Could not allocate isolated promotion board_users fixture');
      }
      const claimedAuroraUserId = auroraUserId;

      const existingCircuits = await db
        .select({ uuid: boardCircuits.uuid })
        .from(boardCircuits)
        .where(and(eq(boardCircuits.boardType, 'tension'), eq(boardCircuits.uuid, circuitUuid)));
      if (existingCircuits.length > 0) {
        throw new Error('Could not allocate an isolated promotion circuit namespace');
      }

      const [playlist] = await db
        .insert(playlists)
        .values({
          uuid: circuitUuid,
          boardType: 'tension',
          layoutId: null,
          name: 'Orphaned circuit',
          auroraType: 'circuits',
          auroraId: circuitUuid,
        })
        .returning({ id: playlists.id });
      if (!playlist) throw new Error('Could not create promotion playlist fixture');
      insertedPlaylistId = playlist.id;
      ownsCircuitFixture = true;
      await db.insert(playlistOwnership).values({ playlistId: playlist.id, userId, role: 'viewer' });

      const result = await db.transaction((transaction) =>
        upsertTableData(
          transaction as unknown as UpsertDb,
          'tension',
          'circuits',
          claimedAuroraUserId,
          userId,
          [circuitRow(circuitUuid, 'Claimed circuit', 'issue-3950-promotion-climb')],
          () => {},
        ),
      );

      expect(result.skipped).toBe(0);
      const [ownerEdge] = await db
        .select({ role: playlistOwnership.role })
        .from(playlistOwnership)
        .where(and(eq(playlistOwnership.playlistId, playlist.id), eq(playlistOwnership.userId, userId)));
      expect(ownerEdge?.role).toBe('owner');
    } finally {
      if (insertedPlaylistId !== undefined) {
        await db.delete(playlists).where(eq(playlists.id, insertedPlaylistId));
      }
      if (ownsCircuitFixture) {
        await db
          .delete(boardCircuits)
          .where(and(eq(boardCircuits.boardType, 'tension'), eq(boardCircuits.uuid, circuitUuid)));
      }
      if (auroraUserId !== undefined) {
        await db.delete(boardUsers).where(and(eq(boardUsers.boardType, 'tension'), eq(boardUsers.id, auroraUserId)));
      }
      if (insertedUserId) await db.delete(users).where(eq(users.id, insertedUserId));
      await client.end();
    }
  }, 20_000);
});
