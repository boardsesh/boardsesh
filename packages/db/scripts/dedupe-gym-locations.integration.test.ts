import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { mergeGymCluster } from './dedupe-gym-locations.js';
import { executeRows } from '../src/client/index.js';
import type { CanonicalGymCandidate, PhysicalGymCluster } from '../src/queries/gyms/location-dedupe.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

type IdRow = {
  id: number | string;
};

type CountRow = {
  count: number | string;
};

type GymStateRow = {
  address: string | null;
  isPublic: boolean;
  deletedAt: Date | string | null;
};

type VoteRow = {
  userId: string;
  entityId: string;
  value: number | string;
};

type VoteCountRow = {
  entityId: string;
  upvotes: number | string;
  downvotes: number | string;
  score: number | string;
};

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }

  const databaseHostname = new URL(databaseUrl).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', 'postgres'].includes(databaseHostname)) {
    return null;
  }

  return databaseUrl;
}

function mergeTestDatabaseUrl(): string | null {
  return process.env.DEDUPE_GYM_LOCATIONS_DB_URL ?? process.env.LOCATION_TRIGGER_DB_URL ?? localDatabaseUrl();
}

async function skipReason(commandDb: ExecuteDb): Promise<string | null> {
  try {
    const [schemaState] = await executeRows<{
      aliasTable: string | null;
      hasVoteTrigger: boolean;
    }>(
      commandDb,
      sql`
        SELECT
          to_regclass('public.location_sync_gym_sources')::text AS "aliasTable",
          EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgname = 'votes_count_trigger'
              AND tgrelid = 'votes'::regclass
          ) AS "hasVoteTrigger"
      `,
    );

    if (!schemaState?.aliasTable) {
      return 'location_sync_gym_sources is missing; run migrations before this integration test';
    }
    if (!schemaState.hasVoteTrigger) {
      return 'votes_count_trigger is missing; run migrations before this integration test';
    }
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  return null;
}

async function insertGym(
  commandDb: ExecuteDb,
  values: {
    uuid: string;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    createdAt: string;
  },
): Promise<number> {
  const [insertedGym] = await executeRows<IdRow>(
    commandDb,
    sql`
      INSERT INTO gyms (uuid, name, owner_id, address, latitude, longitude, is_public, created_at, updated_at)
      VALUES (
        ${values.uuid},
        ${values.name},
        ${SYSTEM_USER_ID},
        ${values.address},
        ${values.latitude},
        ${values.longitude},
        true,
        ${values.createdAt},
        ${values.createdAt}
      )
      RETURNING id
    `,
  );

  assert.ok(insertedGym, 'expected inserted gym id');
  return Number(insertedGym.id);
}

function candidate(values: {
  id: number;
  uuid: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  createdAt: string;
  boardCount: number;
}): CanonicalGymCandidate {
  return {
    id: values.id,
    uuid: values.uuid,
    name: values.name,
    address: values.address,
    contactEmail: null,
    contactPhone: null,
    description: null,
    imageUrl: null,
    latitude: values.latitude,
    longitude: values.longitude,
    createdAt: values.createdAt,
    boardCount: values.boardCount,
    memberCount: 0,
    followerCount: 0,
    commentCount: 0,
  };
}

void describe('dedupe gym merge apply path', () => {
  void it('moves related rows, preserves latest votes, rebuilds vote counts, and soft-deletes duplicates', async (testContext) => {
    const databaseUrl = mergeTestDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip(
        'set DEDUPE_GYM_LOCATIONS_DB_URL to a migrated writable DB, or run a local DATABASE_URL, to execute this integration test',
      );
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailableReason = await skipReason(db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }

      const rollbackMarker = new Error('rollback merge fixture');

      try {
        await db.transaction(async (transaction) => {
          const tag = `dedupe-merge-${Date.now()}`;
          const canonicalGymUuid = `${tag}-canonical-gym`;
          const duplicateGymUuid = `${tag}-duplicate-gym`;
          const userAlphaId = `${tag}-user-alpha`;
          const userBetaId = `${tag}-user-beta`;
          const duplicateBoardUuid = `${tag}-board`;
          const duplicateCommentUuid = `${tag}-comment`;
          const duplicateNotificationUuid = `${tag}-notification`;

          await transaction.execute(sql`
            INSERT INTO users (id, email, name)
            VALUES
              (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh'),
              (${userAlphaId}, ${`${userAlphaId}@example.test`}, 'Alpha'),
              (${userBetaId}, ${`${userBetaId}@example.test`}, 'Beta')
            ON CONFLICT (id) DO NOTHING
          `);

          const canonicalGymId = await insertGym(transaction, {
            uuid: canonicalGymUuid,
            name: 'Merge Fixture Gym',
            address: null,
            latitude: -33.9,
            longitude: 151.2,
            createdAt: '2026-01-01T00:00:00Z',
          });
          const duplicateGymId = await insertGym(transaction, {
            uuid: duplicateGymUuid,
            name: 'Merge Fixture Gym',
            address: '12 Duplicate Lane',
            latitude: -33.90001,
            longitude: 151.20001,
            createdAt: '2026-01-02T00:00:00Z',
          });

          await transaction.execute(sql`
            INSERT INTO user_boards
              (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, gym_id, latitude, longitude, is_public)
            VALUES
              (${duplicateBoardUuid}, ${duplicateBoardUuid}, ${SYSTEM_USER_ID}, 'kilter', 1, 10, ${tag}, 'Fixture Board', ${duplicateGymId}, -33.9, 151.2, true)
          `);
          await transaction.execute(sql`
            INSERT INTO location_sync_gym_sources (source_key, gym_id)
            VALUES (${`${tag}:duplicate-source`}, ${duplicateGymId})
          `);
          await transaction.execute(sql`
            INSERT INTO gym_follows (gym_id, user_id, created_at)
            VALUES
              (${canonicalGymId}, ${userAlphaId}, '2026-01-01T00:00:00Z'),
              (${duplicateGymId}, ${userAlphaId}, '2026-01-02T00:00:00Z'),
              (${duplicateGymId}, ${userBetaId}, '2026-01-03T00:00:00Z')
          `);
          await transaction.execute(sql`
            INSERT INTO gym_members (gym_id, user_id, role, created_at)
            VALUES
              (${canonicalGymId}, ${userAlphaId}, 'member'::gym_member_role, '2026-01-01T00:00:00Z'),
              (${duplicateGymId}, ${userAlphaId}, 'admin'::gym_member_role, '2026-01-02T00:00:00Z'),
              (${duplicateGymId}, ${userBetaId}, 'member'::gym_member_role, '2026-01-03T00:00:00Z')
          `);
          await transaction.execute(sql`
            INSERT INTO comments (uuid, user_id, entity_type, entity_id, body)
            VALUES (${duplicateCommentUuid}, ${userAlphaId}, 'gym'::social_entity_type, ${duplicateGymUuid}, 'fixture comment')
          `);
          await transaction.execute(sql`
            INSERT INTO feed_items (recipient_id, actor_id, type, entity_type, entity_id)
            VALUES (${userAlphaId}, ${userBetaId}, 'comment'::feed_item_type, 'gym'::social_entity_type, ${duplicateGymUuid})
          `);
          await transaction.execute(sql`
            INSERT INTO notifications (uuid, recipient_id, actor_id, type, entity_type, entity_id)
            VALUES (${duplicateNotificationUuid}, ${userAlphaId}, ${userBetaId}, 'new_climb'::notification_type, 'gym'::social_entity_type, ${duplicateGymUuid})
          `);
          await transaction.execute(sql`
            INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
            VALUES
              (${userAlphaId}, 'gym'::social_entity_type, ${canonicalGymUuid}, 1, '2026-01-01T00:00:00Z'),
              (${userAlphaId}, 'gym'::social_entity_type, ${duplicateGymUuid}, -1, '2026-01-03T00:00:00Z'),
              (${userBetaId}, 'gym'::social_entity_type, ${duplicateGymUuid}, 1, '2026-01-02T00:00:00Z')
          `);

          const cluster: PhysicalGymCluster<CanonicalGymCandidate> = {
            normalizedName: 'merge fixture gym',
            gyms: [
              candidate({
                id: canonicalGymId,
                uuid: canonicalGymUuid,
                name: 'Merge Fixture Gym',
                address: null,
                latitude: -33.9,
                longitude: 151.2,
                createdAt: '2026-01-01T00:00:00Z',
                boardCount: 100,
              }),
              candidate({
                id: duplicateGymId,
                uuid: duplicateGymUuid,
                name: 'Merge Fixture Gym',
                address: '12 Duplicate Lane',
                latitude: -33.90001,
                longitude: 151.20001,
                createdAt: '2026-01-02T00:00:00Z',
                boardCount: 0,
              }),
            ],
          };

          const counts = await mergeGymCluster(transaction, cluster);

          assert.deepEqual(counts, {
            boardRowsMoved: 1,
            sourceAliasesMoved: 1,
            followsInserted: 1,
            followsDeleted: 2,
            membersInsertedOrUpdated: 2,
            membersDeleted: 2,
            commentsMoved: 1,
            feedItemsMoved: 1,
            notificationsMoved: 1,
            votesUpserted: 2,
            votesDeleted: 2,
            duplicateGymsSoftDeleted: 1,
          });

          const [canonicalGymState] = await executeRows<GymStateRow>(
            transaction,
            sql`SELECT address AS "address", is_public AS "isPublic", deleted_at AS "deletedAt" FROM gyms WHERE id = ${canonicalGymId}`,
          );
          assert.equal(canonicalGymState?.address, '12 Duplicate Lane');
          assert.equal(canonicalGymState?.isPublic, true);
          assert.equal(canonicalGymState?.deletedAt, null);

          const [duplicateGymState] = await executeRows<GymStateRow>(
            transaction,
            sql`SELECT address AS "address", is_public AS "isPublic", deleted_at AS "deletedAt" FROM gyms WHERE id = ${duplicateGymId}`,
          );
          assert.equal(duplicateGymState?.isPublic, false);
          assert.notEqual(duplicateGymState?.deletedAt, null);

          const [movedBoardCount] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM user_boards WHERE uuid = ${duplicateBoardUuid} AND gym_id = ${canonicalGymId}`,
          );
          assert.equal(Number(movedBoardCount?.count), 1);

          const [movedAliasCount] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM location_sync_gym_sources WHERE source_key = ${`${tag}:duplicate-source`} AND gym_id = ${canonicalGymId}`,
          );
          assert.equal(Number(movedAliasCount?.count), 1);

          const [canonicalFollowCount] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM gym_follows WHERE gym_id = ${canonicalGymId}`,
          );
          assert.equal(Number(canonicalFollowCount?.count), 2);

          const [adminMemberCount] = await executeRows<CountRow>(
            transaction,
            sql`
              SELECT count(*)::int AS count
              FROM gym_members
              WHERE gym_id = ${canonicalGymId}
                AND user_id = ${userAlphaId}
                AND role = 'admin'::gym_member_role
            `,
          );
          assert.equal(Number(adminMemberCount?.count), 1);

          const [movedSocialRowsCount] = await executeRows<CountRow>(
            transaction,
            sql`
              SELECT
                (
                  (SELECT count(*) FROM comments WHERE entity_type = 'gym'::social_entity_type AND entity_id = ${canonicalGymUuid})
                  + (SELECT count(*) FROM feed_items WHERE entity_type = 'gym'::social_entity_type AND entity_id = ${canonicalGymUuid})
                  + (SELECT count(*) FROM notifications WHERE entity_type = 'gym'::social_entity_type AND entity_id = ${canonicalGymUuid})
                )::int AS count
            `,
          );
          assert.equal(Number(movedSocialRowsCount?.count), 3);

          const canonicalVotes = await executeRows<VoteRow>(
            transaction,
            sql`
              SELECT user_id AS "userId", entity_id AS "entityId", value AS "value"
              FROM votes
              WHERE entity_type = 'gym'::social_entity_type
                AND entity_id = ${canonicalGymUuid}
              ORDER BY user_id
            `,
          );
          assert.deepEqual(
            canonicalVotes.map((vote) => ({
              userId: vote.userId,
              entityId: vote.entityId,
              value: Number(vote.value),
            })),
            [
              { userId: userAlphaId, entityId: canonicalGymUuid, value: -1 },
              { userId: userBetaId, entityId: canonicalGymUuid, value: 1 },
            ],
          );

          const duplicateVoteRows = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM votes WHERE entity_type = 'gym'::social_entity_type AND entity_id = ${duplicateGymUuid}`,
          );
          assert.equal(Number(duplicateVoteRows[0]?.count), 0);

          const voteCounts = await executeRows<VoteCountRow>(
            transaction,
            sql`
              SELECT entity_id AS "entityId", upvotes AS "upvotes", downvotes AS "downvotes", score AS "score"
              FROM vote_counts
              WHERE entity_type = 'gym'::social_entity_type
                AND entity_id IN (${canonicalGymUuid}, ${duplicateGymUuid})
              ORDER BY entity_id
            `,
          );
          assert.deepEqual(
            voteCounts.map((voteCount) => ({
              entityId: voteCount.entityId,
              upvotes: Number(voteCount.upvotes),
              downvotes: Number(voteCount.downvotes),
              score: Number(voteCount.score),
            })),
            [{ entityId: canonicalGymUuid, upvotes: 1, downvotes: 1, score: 0 }],
          );

          throw rollbackMarker;
        });
      } catch (error: unknown) {
        if (error !== rollbackMarker) {
          throw error;
        }
      }
    } finally {
      await close();
    }
  });
});
