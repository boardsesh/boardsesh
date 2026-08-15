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
});
