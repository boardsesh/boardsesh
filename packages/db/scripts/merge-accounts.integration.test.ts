import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { applyMerge, assertAllUserFksHandled, buildDuplicateSets, fetchMembersForEmail } from './merge-accounts.js';
import { executeRows } from '../src/client/index.js';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};
type CountRow = { count: number | string };
type StringRow = { value: string | null };
type VoteCountRow = { entityId: string; upvotes: number | string; downvotes: number | string; score: number | string };

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const host = new URL(databaseUrl).hostname.toLowerCase();
  return ['localhost', '127.0.0.1', 'postgres'].includes(host) ? databaseUrl : null;
}

function mergeTestDatabaseUrl(): string | null {
  return process.env.MERGE_ACCOUNTS_DB_URL ?? localDatabaseUrl();
}

async function skipReason(commandDb: ExecuteDb): Promise<string | null> {
  try {
    const [state] = await executeRows<{ ticksTable: string | null; voteTrigger: boolean }>(
      commandDb,
      sql`
        SELECT
          to_regclass('public.boardsesh_ticks')::text AS "ticksTable",
          EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = 'votes_count_trigger' AND tgrelid = 'votes'::regclass
          ) AS "voteTrigger"
      `,
    );
    if (!state?.ticksTable) return 'boardsesh_ticks is missing; run migrations before this integration test';
    if (!state.voteTrigger) return 'votes_count_trigger is missing; run migrations before this integration test';
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function countRows(commandDb: ExecuteDb, query: SQLWrapper): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

void describe('merge-accounts FK coverage', () => {
  void it('handles every foreign key to users(id) in the live schema', async (testContext) => {
    const databaseUrl = mergeTestDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set MERGE_ACCOUNTS_DB_URL to a migrated writable DB, or run a local DATABASE_URL, to execute');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailable = await skipReason(db);
      if (unavailable) {
        testContext.skip(unavailable);
        return;
      }
      // Throws (listing the offending columns) if a migration added a user FK
      // the repoint lists don't cover — keeps the script honest as the schema grows.
      await assertAllUserFksHandled(db);
    } finally {
      await close();
    }
  });
});

void describe('merge-accounts apply path', () => {
  void it('repoints all owned rows onto the winner, dedupes uniques, and deletes losers', async (testContext) => {
    const databaseUrl = mergeTestDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set MERGE_ACCOUNTS_DB_URL to a migrated writable DB, or run a local DATABASE_URL, to execute');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailable = await skipReason(db);
      if (unavailable) {
        testContext.skip(unavailable);
        return;
      }

      const rollbackMarker = new Error('rollback merge fixture');
      try {
        await db.transaction(async (tx) => {
          // randomUUID, not Date.now(): two runs in the same millisecond (watch
          // mode, or a parallel worker) would otherwise collide on users.id.
          const tag = `merge-${randomUUID()}`;
          const lowerEmail = `${tag}@example.test`;
          const winnerId = `${tag}-winner`;
          const loserId = `${tag}-loser`;
          const thirdId = `${tag}-third`;
          const gymUuid = `${tag}-gym`;
          const winnerWallUuid = `${tag}-winner-wall`;
          const loserWallUuid = `${tag}-loser-wall`;
          const winnerKilterSerialWallUuid = `${tag}-winner-kilter-serial-wall`;
          const loserTensionSerialWallUuid = `${tag}-loser-tension-serial-wall`;
          const sharedCrossTypeSerial = `${tag}-cross-type-serial`;
          const sharedControllerSerial = `${tag}-same-controller`;
          const activityBoardUuid = `${tag}-activity-board`;
          const activityOnlyBoardUuid = `${tag}-activity-only-board`;
          const climbA = `${tag}-climb-a`;
          const climbB = `${tag}-climb-b`;

          // Winner email is upper-cased, loser is lower-case — same lower(email).
          await tx.execute(sql`
            INSERT INTO users (id, email, name, "emailVerified", created_at, updated_at)
            VALUES
              (${winnerId}, ${`${tag.toUpperCase()}@Example.test`}, 'Winner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
              (${loserId}, ${lowerEmail}, 'Loser', NULL, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'),
              (${thirdId}, ${`third-${tag}@example.test`}, 'Third', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
          `);

          await tx.execute(sql`
            INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name)
            VALUES
              (${activityBoardUuid}, ${`${tag}-activity`}, ${thirdId}, 'kilter', 99101, 99101, '', 'Activity fixture'),
              (${activityOnlyBoardUuid}, ${`${tag}-activity-only`}, ${thirdId}, 'kilter', 99102, 99102, '', 'Activity-only fixture')
          `);
          await tx.execute(sql`
            INSERT INTO user_boards (
              uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number
            )
            VALUES
              (${winnerWallUuid}, ${`${tag}-winner-wall`}, ${winnerId}, 'kilter', 99103, 99103, '', 'Winner wall', NULL),
              (${loserWallUuid}, ${`${tag}-loser-wall`}, ${loserId}, 'kilter', 99103, 99103, '', 'Loser wall', NULL),
              (${winnerKilterSerialWallUuid}, ${`${tag}-winner-kilter-serial`}, ${winnerId}, 'kilter', 99104, 99104, '', 'Kilter serial wall', ${sharedCrossTypeSerial}),
              (${loserTensionSerialWallUuid}, ${`${tag}-loser-tension-serial`}, ${loserId}, 'tension', 99105, 99105, '', 'Tension serial wall', ${sharedCrossTypeSerial})
          `);
          await tx.execute(sql`
            INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, user_id, confirmed_at)
            SELECT id, 'kilter', ${`${tag}-board-history-climb`}, 40, 1, ${loserId}, '2026-03-01T00:00:00Z'
              FROM user_boards
             WHERE uuid = ${loserWallUuid}
          `);
          await tx.execute(sql`
            INSERT INTO user_board_activity (user_id, board_uuid, last_used_at, pinned_at, created_at, updated_at)
            VALUES
              (${winnerId}, ${activityBoardUuid}, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
              (${loserId}, ${activityBoardUuid}, '2026-02-01T00:00:00Z', NULL, '2026-01-03T00:00:00Z', '2026-02-01T00:00:00Z'),
              (${loserId}, ${activityOnlyBoardUuid}, '2026-02-02T00:00:00Z', NULL, '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z')
          `);
          await tx.execute(sql`
            INSERT INTO user_board_serials (
              user_id, serial_number, board_name, layout_id, size_id, set_ids, api_level, board_uuid,
              created_at, updated_at
            )
            VALUES
              (${winnerId}, ${sharedControllerSerial}, 'kilter', 99103, 99103, 'winner-config', 2,
                ${winnerWallUuid}, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
              (${loserId}, ${sharedControllerSerial}, 'kilter', 99106, 99106, 'loser-latest-config', 3,
                ${loserWallUuid}, '2026-01-03T00:00:00Z', '2026-02-01T00:00:00Z'),
              (${loserId}, ${sharedControllerSerial}, 'tension', 99105, 99105, 'tension-config', 1,
                ${loserTensionSerialWallUuid}, '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z')
          `);

          // Winner has more ticks → wins selection. Loser ticks (one with an
          // aurora surrogate, one without) all move to the winner.
          await tx.execute(sql`
            INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, climbed_at)
            VALUES
              (${`${tag}-w1`}, ${winnerId}, 'kilter', ${climbA}, 40, 'send'::tick_status, 1, '2026-01-02T00:00:00Z'),
              (${`${tag}-w2`}, ${winnerId}, 'kilter', ${climbB}, 40, 'send'::tick_status, 1, '2026-01-02T00:00:00Z'),
              (${`${tag}-w3`}, ${winnerId}, 'kilter', ${`${tag}-c3`}, 40, 'send'::tick_status, 1, '2026-01-02T00:00:00Z'),
              (${`${tag}-w4`}, ${winnerId}, 'kilter', ${`${tag}-c4`}, 40, 'send'::tick_status, 1, '2026-01-02T00:00:00Z'),
              (${`${tag}-w5`}, ${winnerId}, 'kilter', ${`${tag}-c5`}, 40, 'send'::tick_status, 1, '2026-01-02T00:00:00Z'),
              (${`${tag}-l1`}, ${loserId}, 'kilter', ${`${tag}-c6`}, 40, 'send'::tick_status, 1, '2026-02-02T00:00:00Z'),
              (${`${tag}-l2`}, ${loserId}, 'tension', ${`${tag}-c7`}, 40, 'send'::tick_status, 1, '2026-02-02T00:00:00Z')
          `);
          await tx.execute(sql`
            UPDATE boardsesh_ticks SET aurora_id = ${`${tag}-aurora`} WHERE uuid = ${`${tag}-l1`}
          `);

          // Favorites: climbA collides (winner keeps), climbB unique (moves).
          await tx.execute(sql`
            INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle)
            VALUES
              (${winnerId}, 'kilter', ${climbA}, 40),
              (${loserId}, 'kilter', ${climbA}, 40),
              (${loserId}, 'kilter', ${climbB}, 40)
          `);

          // Follows: mutual loser↔winner (self-follow trap), loser→third and
          // winner→third (dedup), third→loser (moves to third→winner).
          await tx.execute(sql`
            INSERT INTO user_follows (follower_id, following_id)
            VALUES
              (${loserId}, ${winnerId}),
              (${winnerId}, ${loserId}),
              (${winnerId}, ${thirdId}),
              (${loserId}, ${thirdId}),
              (${thirdId}, ${loserId})
          `);

          // Both have a password — winner keeps its own.
          await tx.execute(sql`
            INSERT INTO user_credentials (user_id, password_hash)
            VALUES (${winnerId}, 'winner-hash'), (${loserId}, 'loser-hash')
          `);

          // Winner profile lacks a display name; loser supplies one.
          await tx.execute(sql`
            INSERT INTO user_profiles (user_id, display_name)
            VALUES (${winnerId}, NULL), (${loserId}, 'Loser Display')
          `);

          // Votes on 'climb' entities: climbA collides (winner +1 kept, loser -1
          // dropped), climbB moves. The votes_count_trigger maintains vote_counts.
          await tx.execute(sql`
            INSERT INTO votes (user_id, entity_type, entity_id, value)
            VALUES
              (${winnerId}, 'climb'::social_entity_type, ${climbA}, 1),
              (${loserId}, 'climb'::social_entity_type, ${climbA}, -1),
              (${loserId}, 'climb'::social_entity_type, ${climbB}, 1)
          `);

          // Loser owns a gym (gyms.owner_id is ON DELETE CASCADE — must repoint,
          // not let the gym be deleted with the loser).
          await tx.execute(sql`
            INSERT INTO gyms (uuid, name, owner_id, is_public, created_at, updated_at)
            VALUES (${gymUuid}, 'Loser Gym', ${loserId}, true, NOW(), NOW())
          `);

          // Loser linked a Tension board account; winner has none.
          await tx.execute(sql`
            INSERT INTO user_board_mappings (user_id, board_type, board_user_id, board_username)
            VALUES (${loserId}, 'tension', 999001, 'loserboard')
          `);

          // Provider control generations belong to the old account id. When
          // its credential survives, the merged control must be live but must
          // not retain a lease or queued job from either pre-merge account.
          await tx.execute(sql`
            INSERT INTO aurora_credentials (user_id, board_type, encrypted_username, encrypted_password)
            VALUES (${loserId}, 'kilter', 'fixture-user', 'fixture-secret')
          `);
          await tx.execute(sql`
            INSERT INTO provider_sync_controls (
              user_id, board_type, link_generation, linked, pending_run_id,
              notify_requester, active_run_id, active_lease_until
            )
            VALUES
              (${winnerId}, 'kilter', '10000000-0000-4000-8000-000000000001', false,
                '10000000-0000-4000-8000-000000000003', true,
                '10000000-0000-4000-8000-000000000005', '2026-04-01T00:00:00Z'),
              (${loserId}, 'kilter', '10000000-0000-4000-8000-000000000002', true,
                '10000000-0000-4000-8000-000000000004', true,
                '10000000-0000-4000-8000-000000000006', '2026-04-01T00:00:00Z'),
              (${loserId}, 'tension', '10000000-0000-4000-8000-000000000007', false,
                NULL, false, NULL, NULL)
          `);

          // Quarantined Aurora rows are durable replay data. Preserve a unique
          // loser row, and merge a same-key collision without dropping its
          // newer payload or retry history.
          const collisionAuroraId = `${tag}-skip-collision`;
          const uniqueAuroraId = `${tag}-skip-unique`;
          await tx.execute(sql`
            INSERT INTO logbook_sync_skips (
              user_id, board_type, aurora_type, aurora_id, reason, detail, payload,
              first_seen_at, last_seen_at, seen_count
            )
            VALUES
              (
                ${winnerId}, 'kilter', 'ascents'::aurora_table_type, ${collisionAuroraId},
                'db_write_rejected'::logbook_sync_skip_reason, 'winner detail',
                ${JSON.stringify({ source: 'winner' })}::jsonb,
                '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', 2
              ),
              (
                ${loserId}, 'kilter', 'ascents'::aurora_table_type, ${collisionAuroraId},
                'normalize_failed'::logbook_sync_skip_reason, 'loser latest detail',
                ${JSON.stringify({ source: 'loser-latest' })}::jsonb,
                '2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z', 3
              ),
              (
                ${loserId}, 'tension', 'bids'::aurora_table_type, ${uniqueAuroraId},
                'invalid_identity'::logbook_sync_skip_reason, 'unique loser detail',
                ${JSON.stringify({ source: 'unique-loser' })}::jsonb,
                '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z', 4
              )
          `);

          // Gym ownership claims (partial unique WHERE status='pending'): winner
          // and loser both have a PENDING claim on gym A (collides — loser's
          // dropped); loser also has an APPROVED claim on gym B (historical —
          // always moves). Gyms owned by the third user to stay out of the merge.
          const claimGymA = `${tag}-claimgym-a`;
          const claimGymB = `${tag}-claimgym-b`;
          await tx.execute(sql`
            INSERT INTO gyms (uuid, name, owner_id, is_public, created_at, updated_at)
            VALUES
              (${claimGymA}, 'Claim Gym A', ${thirdId}, true, NOW(), NOW()),
              (${claimGymB}, 'Claim Gym B', ${thirdId}, true, NOW(), NOW())
          `);
          await tx.execute(sql`
            INSERT INTO gym_claims (gym_id, claimant_user_id, method, status)
            VALUES
              ((SELECT id FROM gyms WHERE uuid = ${claimGymA}), ${winnerId}, 'admin'::gym_claim_method, 'pending'::gym_claim_status),
              ((SELECT id FROM gyms WHERE uuid = ${claimGymA}), ${loserId}, 'admin'::gym_claim_method, 'pending'::gym_claim_status),
              ((SELECT id FROM gyms WHERE uuid = ${claimGymB}), ${loserId}, 'admin'::gym_claim_method, 'approved'::gym_claim_status)
          `);

          // Ratings: climbA collides (winner rating 3 kept), climbB moves.
          await tx.execute(sql`
            INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating)
            VALUES
              ('kilter', ${climbA}, 40, ${winnerId}, 3),
              ('kilter', ${climbA}, 40, ${loserId}, 5),
              ('kilter', ${climbB}, 40, ${loserId}, 4)
          `);

          // Beta link attributed to the loser (created_by_user_id is a manual
          // users(id) FK ON DELETE SET NULL — must repoint, not null on delete).
          await tx.execute(sql`
            INSERT INTO board_beta_links (board_type, climb_uuid, link, created_by_user_id)
            VALUES ('kilter', ${climbA}, ${`https://instagram.com/p/${tag}/`}, ${loserId})
          `);

          // --- Run the merge through the real apply path ---
          const members = await fetchMembersForEmail(tx, lowerEmail);
          const duplicateSet = buildDuplicateSets(members)[0];
          assert.equal(duplicateSet.winner.id, winnerId, 'winner is the account with more ticks');

          const result = await applyMerge(tx, duplicateSet);
          assert.equal(result.merged, true);

          // --- Assertions ---
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM users WHERE id = ${loserId}`),
            0,
            'loser user deleted',
          );
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM users WHERE id = ${winnerId}`),
            1,
            'winner user kept',
          );
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM users WHERE lower(email) = ${lowerEmail}`),
            1,
            'no duplicate remains for the email',
          );

          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM boardsesh_ticks WHERE user_id = ${winnerId}`),
            7,
            'all 5 winner + 2 loser ticks now belong to the winner',
          );

          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM user_favorites WHERE user_id = ${winnerId}`),
            2,
            'colliding favorite deduped, unique favorite moved',
          );

          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_follows WHERE follower_id = ${winnerId} AND following_id = ${winnerId}`,
            ),
            0,
            'no self-follow created',
          );
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM user_follows WHERE follower_id = ${winnerId}`),
            1,
            'winner follows third once (loser→third deduped against winner→third)',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_follows WHERE follower_id = ${thirdId} AND following_id = ${winnerId}`,
            ),
            1,
            'third→loser repointed to third→winner',
          );

          const [credential] = await executeRows<StringRow>(
            tx,
            sql`SELECT password_hash AS value FROM user_credentials WHERE user_id = ${winnerId}`,
          );
          assert.equal(credential?.value, 'winner-hash', 'winner keeps its own password');

          const [profile] = await executeRows<StringRow>(
            tx,
            sql`SELECT display_name AS value FROM user_profiles WHERE user_id = ${winnerId}`,
          );
          assert.equal(profile?.value, 'Loser Display', 'winner profile back-filled from loser');

          const [emailVerified] = await executeRows<StringRow>(
            tx,
            sql`SELECT "emailVerified"::text AS value FROM users WHERE id = ${winnerId}`,
          );
          assert.notEqual(emailVerified?.value, null, 'verified timestamp preserved on the winner');

          const winnerVotes = await executeRows<{ entityId: string; value: number | string }>(
            tx,
            sql`SELECT entity_id AS "entityId", value FROM votes WHERE user_id = ${winnerId} AND entity_type = 'climb'::social_entity_type ORDER BY entity_id`,
          );
          assert.deepEqual(
            winnerVotes.map((vote) => ({ entityId: vote.entityId, value: Number(vote.value) })),
            [
              { entityId: climbA, value: 1 },
              { entityId: climbB, value: 1 },
            ],
            'winner keeps its climbA vote and inherits the climbB vote',
          );

          const voteCounts = await executeRows<VoteCountRow>(
            tx,
            sql`
              SELECT entity_id AS "entityId", upvotes, downvotes, score
              FROM vote_counts
              WHERE entity_type = 'climb'::social_entity_type AND entity_id IN (${climbA}, ${climbB})
              ORDER BY entity_id
            `,
          );
          assert.deepEqual(
            voteCounts.map((row) => ({
              entityId: row.entityId,
              upvotes: Number(row.upvotes),
              downvotes: Number(row.downvotes),
              score: Number(row.score),
            })),
            [
              { entityId: climbA, upvotes: 1, downvotes: 0, score: 1 },
              { entityId: climbB, upvotes: 1, downvotes: 0, score: 1 },
            ],
            'trigger-maintained vote_counts reflect the deduped winner votes',
          );

          const [gymOwner] = await executeRows<StringRow>(
            tx,
            sql`SELECT owner_id AS value FROM gyms WHERE uuid = ${gymUuid}`,
          );
          assert.equal(gymOwner?.value, winnerId, 'gym repointed to winner, not cascade-deleted');

          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_board_mappings WHERE user_id = ${winnerId} AND board_type = 'tension'`,
            ),
            1,
            'loser Tension board link moved to winner',
          );

          const [mergedActivity] = await executeRows<{ lastUsedAt: string; pinnedAt: string }>(
            tx,
            sql`
              SELECT last_used_at::timestamptz::text AS "lastUsedAt",
                     pinned_at::timestamptz::text AS "pinnedAt"
                FROM user_board_activity
               WHERE user_id = ${winnerId} AND board_uuid = ${activityBoardUuid}
            `,
          );
          assert.equal(
            new Date(mergedActivity?.lastUsedAt ?? '').toISOString(),
            '2026-02-01T00:00:00.000Z',
            'colliding board activity keeps the latest open time',
          );
          assert.equal(
            new Date(mergedActivity?.pinnedAt ?? '').toISOString(),
            '2026-01-02T00:00:00.000Z',
            'the canonical account pin choice remains authoritative',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_board_activity WHERE user_id = ${winnerId} AND board_uuid = ${activityOnlyBoardUuid}`,
            ),
            1,
            'non-colliding loser board activity moves to the winner',
          );

          const mergedWalls = await executeRows<{ uuid: string; ownerId: string }>(
            tx,
            sql`
              SELECT uuid, owner_id AS "ownerId"
                FROM user_boards
               WHERE uuid IN (${winnerWallUuid}, ${loserWallUuid}, ${winnerKilterSerialWallUuid}, ${loserTensionSerialWallUuid})
            `,
          );
          assert.equal(mergedWalls.length, 4, 'same-config and cross-board-type physical walls all survive');
          assert.ok(
            mergedWalls.every((board) => board.ownerId === winnerId),
            'every loser wall transfers to the winner',
          );
          assert.equal(
            await countRows(
              tx,
              sql`
                SELECT count(*)::int AS count
                  FROM board_climb_events
                 WHERE board_id = (SELECT id FROM user_boards WHERE uuid = ${loserWallUuid})
              `,
            ),
            1,
            'board history remains attached to the transferred physical wall',
          );
          const [preservedWallHistory] = await executeRows<{ userId: string | null }>(
            tx,
            sql`
              SELECT user_id AS "userId"
                FROM board_climb_events
               WHERE board_id = (SELECT id FROM user_boards WHERE uuid = ${loserWallUuid})
            `,
          );
          assert.equal(
            preservedWallHistory?.userId,
            winnerId,
            'loser attribution follows the merged account without removing wall history',
          );

          const [mergedController] = await executeRows<{
            layoutId: number | string;
            sizeId: number | string;
            setIds: string;
            apiLevel: number | null;
            boardUuid: string | null;
            createdAt: string;
            updatedAt: string;
          }>(
            tx,
            sql`
              SELECT layout_id AS "layoutId", size_id AS "sizeId", set_ids AS "setIds", api_level AS "apiLevel",
                     board_uuid AS "boardUuid", created_at::text AS "createdAt", updated_at::text AS "updatedAt"
                FROM user_board_serials
               WHERE user_id = ${winnerId} AND board_name = 'kilter' AND serial_number = ${sharedControllerSerial}
            `,
          );
          assert.equal(Number(mergedController?.layoutId), 99106, 'same-controller collision keeps the latest config');
          assert.equal(Number(mergedController?.sizeId), 99106);
          assert.equal(mergedController?.setIds, 'loser-latest-config');
          assert.equal(mergedController?.apiLevel, 3);
          assert.equal(mergedController?.boardUuid, loserWallUuid, 'latest controller row keeps its board link');
          assert.equal(new Date(mergedController?.createdAt ?? '').toISOString(), '2026-01-01T00:00:00.000Z');
          assert.equal(new Date(mergedController?.updatedAt ?? '').toISOString(), '2026-02-01T00:00:00.000Z');
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_board_serials WHERE user_id = ${winnerId} AND board_name = 'tension' AND serial_number = ${sharedControllerSerial}`,
            ),
            1,
            'the same numeric serial on another board app is preserved separately',
          );
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM user_board_serials WHERE user_id = ${loserId}`),
            0,
            'serial records no longer reference the losing account',
          );

          const providerControls = await executeRows<{
            boardType: string;
            linkGeneration: string;
            linked: boolean;
            pendingRunId: string | null;
            notifyRequester: boolean;
            activeRunId: string | null;
            activeLeaseUntil: string | null;
          }>(
            tx,
            sql`
              SELECT board_type AS "boardType", link_generation::text AS "linkGeneration", linked,
                     pending_run_id::text AS "pendingRunId", notify_requester AS "notifyRequester",
                     active_run_id::text AS "activeRunId", active_lease_until::text AS "activeLeaseUntil"
                FROM provider_sync_controls
               WHERE user_id = ${winnerId}
               ORDER BY board_type
            `,
          );
          const mergedKilterControl = providerControls.find((control) => control.boardType === 'kilter');
          assert.equal(mergedKilterControl?.linked, true, 'a surviving loser credential keeps its control live');
          assert.notEqual(
            mergedKilterControl?.linkGeneration,
            '10000000-0000-4000-8000-000000000001',
            'account merge rotates the provider link fence',
          );
          assert.equal(mergedKilterControl?.pendingRunId, null, 'old pending jobs are cleared');
          assert.equal(mergedKilterControl?.notifyRequester, false, 'old run notifications are cleared');
          assert.equal(mergedKilterControl?.activeRunId, null, 'old active jobs are cleared');
          assert.equal(mergedKilterControl?.activeLeaseUntil, null, 'old credential leases are cleared');
          const movedTensionControl = providerControls.find((control) => control.boardType === 'tension');
          assert.equal(
            movedTensionControl?.linked,
            false,
            'a control without either account credential stays unlinked',
          );
          assert.notEqual(
            movedTensionControl?.linkGeneration,
            '10000000-0000-4000-8000-000000000007',
            'a moved control also gets a fresh link fence',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM provider_sync_controls WHERE user_id = ${loserId}`,
            ),
            0,
            'provider controls no longer reference the losing account',
          );

          const [mergedSkip] = await executeRows<{
            reason: string;
            detail: string | null;
            payload: string | null;
            firstSeenAt: string;
            lastSeenAt: string;
            seenCount: number | string;
          }>(
            tx,
            sql`
              SELECT reason, detail, payload::text AS payload,
                     first_seen_at::text AS "firstSeenAt", last_seen_at::text AS "lastSeenAt",
                     seen_count::int AS "seenCount"
                FROM logbook_sync_skips
               WHERE user_id = ${winnerId}
                 AND board_type = 'kilter'
                 AND aurora_type = 'ascents'::aurora_table_type
                 AND aurora_id = ${collisionAuroraId}
            `,
          );
          assert.equal(mergedSkip?.reason, 'normalize_failed');
          assert.equal(mergedSkip?.detail, 'loser latest detail');
          assert.deepEqual(JSON.parse(mergedSkip?.payload ?? 'null'), { source: 'loser-latest' });
          assert.equal(new Date(mergedSkip?.firstSeenAt ?? '').toISOString(), '2026-01-01T00:00:00.000Z');
          assert.equal(new Date(mergedSkip?.lastSeenAt ?? '').toISOString(), '2026-04-01T00:00:00.000Z');
          assert.equal(Number(mergedSkip?.seenCount), 5, 'collision retry counts are combined');
          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM logbook_sync_skips WHERE user_id = ${winnerId}`),
            2,
            'both the merged collision and unique quarantined row remain replayable',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM logbook_sync_skips WHERE user_id = ${winnerId} AND aurora_id = ${uniqueAuroraId}`,
            ),
            1,
            'unique loser quarantine row moved to winner',
          );

          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM board_climb_ratings WHERE user_id = ${winnerId}`,
            ),
            2,
            'colliding rating deduped, unique rating moved',
          );

          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM board_beta_links WHERE created_by_user_id = ${winnerId}`,
            ),
            1,
            'beta-link attribution repointed to winner, not nulled',
          );

          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM gym_claims WHERE claimant_user_id = ${winnerId}`,
            ),
            2,
            'colliding pending claim dropped, historical approved claim moved',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count
                    FROM gym_claims gc JOIN gyms g ON g.id = gc.gym_id
                   WHERE g.uuid = ${claimGymA} AND gc.status = 'pending'`,
            ),
            1,
            'exactly one pending claim remains on the shared gym (no partial-unique violation)',
          );

          throw rollbackMarker;
        });
      } catch (error: unknown) {
        if (error !== rollbackMarker) throw error;
      }
    } finally {
      await close();
    }
  });

  void it('refuses active same-type serial collisions before changing a duplicate set', async (testContext) => {
    const databaseUrl = mergeTestDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set MERGE_ACCOUNTS_DB_URL to a migrated writable DB, or run a local DATABASE_URL, to execute');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailable = await skipReason(db);
      if (unavailable) {
        testContext.skip(unavailable);
        return;
      }

      const rollbackMarker = new Error('rollback serial-conflict fixture');
      try {
        await db.transaction(async (tx) => {
          const tag = `merge-board-conflict-${randomUUID()}`;
          const lowerEmail = `${tag}@example.test`;
          const winnerId = `${tag}-winner`;
          const firstLoserId = `${tag}-loser-a`;
          const secondLoserId = `${tag}-loser-b`;
          const firstBoardUuid = `${tag}-kilter-wall-a`;
          const secondBoardUuid = `${tag}-kilter-wall-b`;
          const serialNumber = `${tag}-shared-controller`;

          await tx.execute(sql`
            INSERT INTO users (id, email, name, "emailVerified", created_at, updated_at)
            VALUES
              (${winnerId}, ${`${tag.toUpperCase()}@Example.test`}, 'Winner', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
              (${firstLoserId}, ${lowerEmail}, 'First loser', NULL, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
              (${secondLoserId}, ${lowerEmail}, 'Second loser', NULL, '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')
          `);
          await tx.execute(sql`
            INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number)
            VALUES
              (${firstBoardUuid}, ${`${tag}-wall-a`}, ${firstLoserId}, 'kilter', 99201, 99201, '', 'Wall A', ${serialNumber}),
              (${secondBoardUuid}, ${`${tag}-wall-b`}, ${secondLoserId}, 'kilter', 99202, 99202, '', 'Wall B', ${serialNumber})
          `);
          await tx.execute(
            sql`INSERT INTO user_follows (follower_id, following_id) VALUES (${winnerId}, ${firstLoserId})`,
          );

          const duplicateSet = buildDuplicateSets(await fetchMembersForEmail(tx, lowerEmail))[0];
          assert.ok(duplicateSet, 'the three case-duplicate accounts form one merge set');
          let mergeError: unknown;
          try {
            await applyMerge(tx, duplicateSet);
          } catch (error: unknown) {
            mergeError = error;
          }
          assert.ok(mergeError instanceof Error, 'an unresolved physical serial collision aborts the merge');
          assert.ok(mergeError.message.includes(firstBoardUuid));
          assert.ok(mergeError.message.includes(secondBoardUuid));

          assert.equal(
            await countRows(tx, sql`SELECT count(*)::int AS count FROM users WHERE lower(email) = ${lowerEmail}`),
            3,
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_boards WHERE owner_id IN (${firstLoserId}, ${secondLoserId})`,
            ),
            2,
            'both conflicting physical walls keep their original owners',
          );
          assert.equal(
            await countRows(
              tx,
              sql`SELECT count(*)::int AS count FROM user_follows WHERE follower_id = ${winnerId} AND following_id = ${firstLoserId}`,
            ),
            1,
            'the preflight abort runs before any account repoints or edge deletion',
          );

          throw rollbackMarker;
        });
      } catch (error: unknown) {
        if (error !== rollbackMarker) throw error;
      }
    } finally {
      await close();
    }
  });
});
