/**
 * Integration coverage for the serial-board consolidation apply path
 * (issue #3407). Builds a duplicate-serial cluster in a rolled-back transaction
 * and asserts every repoint, the dense/unique climb-event re-sequencing, the
 * vote latest-wins + rebuild, the session_boards / board_follows conflict
 * folds, the board_beta_links board_id repoint, generic-name adoption +
 * metadata backfill (including hide_location inheritance from the donor), the
 * loser tombstones, and idempotency (a second discovery finds nothing).
 *
 * Skips unless DATABASE_URL (or DEDUPE_SERIAL_BOARDS_DB_URL) points at a local,
 * migrated, writable Postgres.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import {
  fetchCandidates,
  refetchClusterForApply,
  mergeSerialCluster,
  type ClusterValidation,
} from './dedupe-serial-boards.js';
import { executeRows } from '../src/client/index.js';
import { groupSerialClusters, SYSTEM_USER_ID, type SerialCluster } from '../src/queries/boards/serial-dedupe.js';
import { lockBoardSerialWrite } from '../src/queries/boards/serial-write-lock.js';

/**
 * Drive the real apply path for one cluster: re-fetch it FOR UPDATE, re-validate,
 * and merge. Mirrors the per-cluster loop in the script's `main`.
 */
async function refetchAndMerge(
  transaction: ExecuteDb,
  cluster: SerialCluster,
): Promise<{ ok: false } | { ok: true; counts: Awaited<ReturnType<typeof mergeSerialCluster>> }> {
  const validation = await refetchClusterForApply(transaction, cluster);
  if (!validation.ok) {
    return { ok: false };
  }
  const counts = await mergeSerialCluster(
    transaction,
    validation.cluster,
    validation.canonical,
    validation.flattenBoardIds,
  );
  return { ok: true, counts };
}

type IdRow = { id: number | string };
type CountRow = { count: number | string };

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

function testDatabaseUrl(): string | null {
  return process.env.DEDUPE_SERIAL_BOARDS_DB_URL ?? localDatabaseUrl();
}

async function skipReason(commandDb: ExecuteDb): Promise<string | null> {
  try {
    const [state] = await executeRows<{ hasTombstone: boolean; hasPresenceSeq: boolean; hasVoteTrigger: boolean }>(
      commandDb,
      sql`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'user_boards' AND column_name = 'merged_into_board_uuid'
          ) AS "hasTombstone",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'user_boards' AND column_name = 'presence_seq'
          ) AS "hasPresenceSeq",
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'votes_count_trigger' AND tgrelid = 'votes'::regclass
          ) AS "hasVoteTrigger"
      `,
    );
    if (!state?.hasTombstone) {
      return 'user_boards.merged_into_board_uuid missing; apply the true_hellion migration before this integration test';
    }
    if (!state.hasPresenceSeq) {
      return 'user_boards.presence_seq missing; apply the windy_fenris migration before this integration test';
    }
    if (!state.hasVoteTrigger) {
      return 'votes_count_trigger is missing; run migrations before this integration test';
    }
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function lockTestSkipReason(commandDb: ExecuteDb): Promise<string | null> {
  try {
    const [state] = await executeRows<{ boardsTable: string | null }>(
      commandDb,
      sql`SELECT to_regclass('public.user_boards')::text AS "boardsTable"`,
    );
    if (!state?.boardsTable) return 'user_boards is missing; run migrations before this integration test';
  } catch (error: unknown) {
    return `database unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The lock cases go through the same cluster refetch as the apply path, so
  // they need the same columns. Checking only for the table left them failing
  // with a raw "column does not exist" on a database that hadn't taken this
  // branch's migrations, while the apply cases next door skipped cleanly.
  return skipReason(commandDb);
}

async function insertBoard(
  commandDb: ExecuteDb,
  values: {
    uuid: string;
    slug: string;
    ownerId: string;
    name: string;
    serial: string;
    layoutId?: number;
    gymId?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    locationName?: string | null;
    hideLocation?: boolean;
    isUnlisted?: boolean;
    isPublic?: boolean;
  },
): Promise<number> {
  const [inserted] = await executeRows<IdRow>(
    commandDb,
    sql`
      INSERT INTO user_boards
        (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, serial_number,
         gym_id, latitude, longitude, location_name, hide_location, is_unlisted, is_public, is_owned)
      VALUES (
        ${values.uuid}, ${values.slug}, ${values.ownerId}, 'kilter', ${values.layoutId ?? 1}, 10, '20,21',
        ${values.name}, ${values.serial},
        ${values.gymId ?? null}, ${values.latitude ?? null}, ${values.longitude ?? null},
        ${values.locationName ?? null}, ${values.hideLocation ?? false}, ${values.isUnlisted ?? false},
        ${values.isPublic ?? false}, false
      )
      RETURNING id
    `,
  );
  assert.ok(inserted, 'expected inserted board id');
  return Number(inserted.id);
}

async function insertClimbEvent(commandDb: ExecuteDb, boardId: number, seq: number): Promise<void> {
  await commandDb.execute(sql`
    INSERT INTO board_climb_events (board_id, board_type, climb_uuid, angle, seq, confirmed_at)
    VALUES (${boardId}, 'kilter', ${`climb-${boardId}-${seq}`}, 40, ${seq}, NOW())
  `);
}

function createBarrier(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createValueBarrier<Result>(): { promise: Promise<Result>; release: (result: Result) => void } {
  let release = (_result: Result): void => undefined;
  const promise = new Promise<Result>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function currentBackendPid(commandDb: ExecuteDb): Promise<number> {
  const [session] = await executeRows<{ pid: number | string }>(commandDb, sql`SELECT pg_backend_pid() AS pid`);
  assert.ok(session, 'expected a PostgreSQL backend pid');
  return Number(session.pid);
}

async function waitForBlockedSession(
  observerDb: ExecuteDb,
  blockingPid: number,
  waitKind: 'advisory' | 'row',
): Promise<number> {
  const lockTypeCondition =
    waitKind === 'advisory'
      ? sql`waiting_lock.locktype = 'advisory'`
      : sql`waiting_lock.locktype IN ('transactionid', 'tuple')`;
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const [blockedSession] = await executeRows<{ pid: number | string }>(
      observerDb,
      sql`
        SELECT DISTINCT activity.pid AS pid
          FROM pg_stat_activity activity
          JOIN pg_locks waiting_lock
            ON waiting_lock.pid = activity.pid
           AND waiting_lock.granted = false
         WHERE activity.datname = current_database()
           AND ${blockingPid} = ANY(pg_blocking_pids(activity.pid))
           AND ${lockTypeCondition}
         LIMIT 1
      `,
    );
    if (blockedSession) return Number(blockedSession.pid);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`timed out waiting for a PostgreSQL ${waitKind} lock blocked by pid ${blockingPid}`);
}

async function createCommittedCluster(
  commandDb: ExecuteDb,
  tag: string,
): Promise<{
  serial: string;
  cluster: SerialCluster;
  boardIds: [number, number];
  boardUuids: [string, string];
}> {
  const serial = `${tag}-serial`;
  const firstBoardUuid = `${tag}-first`;
  const secondBoardUuid = `${tag}-second`;
  await commandDb.execute(sql`
    INSERT INTO users (id, email, name)
    VALUES (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh')
    ON CONFLICT (id) DO NOTHING
  `);
  const firstBoardId = await insertBoard(commandDb, {
    uuid: firstBoardUuid,
    slug: `${tag}-first`,
    ownerId: SYSTEM_USER_ID,
    name: 'First duplicate',
    serial,
  });
  const secondBoardId = await insertBoard(commandDb, {
    uuid: secondBoardUuid,
    slug: `${tag}-second`,
    ownerId: SYSTEM_USER_ID,
    name: 'Second duplicate',
    serial,
  });
  const clusters = groupSerialClusters(await fetchCandidates(commandDb, serial));
  assert.equal(clusters.length, 1, 'expected one committed duplicate cluster');
  return {
    serial,
    cluster: clusters[0]!,
    boardIds: [firstBoardId, secondBoardId],
    boardUuids: [firstBoardUuid, secondBoardUuid],
  };
}

void describe('dedupe serial boards apply path', () => {
  void it('merges a same-config cluster, repoints everything, and is idempotent', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailableReason = await skipReason(db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }

      const rollbackMarker = new Error('rollback serial-merge fixture');
      try {
        await db.transaction(async (transaction) => {
          const tag = `serial-merge-${Date.now()}`;
          const serial = `SER-${Date.now()}`;
          const gymUuid = `${tag}-gym`;
          const users = {
            alpha: `${tag}-alpha`,
            beta: `${tag}-beta`,
            gamma: `${tag}-gamma`,
            epsilon: `${tag}-epsilon`,
            delta: `${tag}-delta`,
            theta: `${tag}-theta`,
          };

          await transaction.execute(sql`
            INSERT INTO users (id, email, name)
            VALUES
              (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh'),
              (${users.alpha}, ${`${users.alpha}@example.test`}, 'Alpha'),
              (${users.beta}, ${`${users.beta}@example.test`}, 'Beta'),
              (${users.gamma}, ${`${users.gamma}@example.test`}, 'Gamma'),
              (${users.epsilon}, ${`${users.epsilon}@example.test`}, 'Epsilon'),
              (${users.delta}, ${`${users.delta}@example.test`}, 'Delta'),
              (${users.theta}, ${`${users.theta}@example.test`}, 'Theta')
            ON CONFLICT (id) DO NOTHING
          `);

          const [gym] = await executeRows<IdRow>(
            transaction,
            sql`
              INSERT INTO gyms (uuid, name, owner_id, is_public)
              VALUES (${gymUuid}, ${`${tag} gym`}, ${SYSTEM_USER_ID}, true)
              RETURNING id
            `,
          );
          const gymId = Number(gym?.id);

          // Survivor: most climb events, generic name, no gym/location.
          const canonicalUuid = `${tag}-canonical`;
          const canonicalId = await insertBoard(transaction, {
            uuid: canonicalUuid,
            slug: `${tag}-canonical`,
            ownerId: users.alpha,
            name: 'Kilter Board',
            serial,
            isPublic: true,
          });
          // Loser 1: fewer events, gym + specific name (metadata donor). Its
          // location is hidden, so the survivor (null coords) must inherit
          // hide_location = true along with the donated coordinates.
          const loserOneUuid = `${tag}-loser-1`;
          const loserOneId = await insertBoard(transaction, {
            uuid: loserOneUuid,
            slug: `${tag}-loser-1`,
            ownerId: users.beta,
            name: 'Movement Kilter',
            serial,
            gymId,
            latitude: -33.9,
            longitude: 151.2,
            locationName: 'Movement Boulder',
            hideLocation: true,
            isPublic: true,
          });
          // Loser 2: fewest events, system-owned, generic name.
          const loserTwoUuid = `${tag}-loser-2`;
          const loserTwoId = await insertBoard(transaction, {
            uuid: loserTwoUuid,
            slug: `${tag}-loser-2`,
            ownerId: SYSTEM_USER_ID,
            name: 'Kilter Board Original',
            serial,
            isPublic: false,
          });
          const historicalLoserUuid = `${tag}-historical-loser`;
          const historicalLoserId = await insertBoard(transaction, {
            uuid: historicalLoserUuid,
            slug: `${tag}-historical-loser`,
            ownerId: users.theta,
            name: 'Historical loser',
            serial,
          });
          await transaction.execute(sql`
            UPDATE user_boards
               SET deleted_at = NOW(), merged_into_board_uuid = ${loserOneUuid}
             WHERE id = ${historicalLoserId}
          `);

          // Simulate live sequence reservations that are ahead of durable event
          // rows (for example Redis/DB reservations whose event was non-durable).
          // Moved events must start above the highest reservation, and the
          // survivor must retain the resulting floor after the merge.
          await transaction.execute(sql`
            UPDATE user_boards
               SET presence_seq = CASE id
                 WHEN ${canonicalId} THEN 10
                 WHEN ${loserOneId} THEN 20
                 ELSE 15
               END
             WHERE id IN (${canonicalId}, ${loserOneId}, ${loserTwoId})
          `);

          // Climb events: survivor 3 (seq 1..3), loser1 2 (seq 1,2), loser2 1 (seq 1).
          await insertClimbEvent(transaction, canonicalId, 1);
          await insertClimbEvent(transaction, canonicalId, 2);
          await insertClimbEvent(transaction, canonicalId, 3);
          await insertClimbEvent(transaction, loserOneId, 1);
          await insertClimbEvent(transaction, loserOneId, 2);
          await insertClimbEvent(transaction, loserTwoId, 1);

          // Tick on loser1.
          await transaction.execute(sql`
            INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, board_id)
            VALUES (${`${tag}-tick`}, ${users.beta}, 'kilter', 'climb-tick', 40, 'send'::tick_status, NOW(), ${loserOneId})
          `);

          // Beta link pinned to loser1 by board_id. Losers are soft-deleted, so
          // the ON DELETE SET NULL FK never fires — the merge must repoint this.
          await transaction.execute(sql`
            INSERT INTO board_beta_links (board_type, climb_uuid, link, board_id, created_by_user_id)
            VALUES ('kilter', 'climb-beta', ${`https://example.test/${tag}-beta`}, ${loserOneId}, ${users.beta})
          `);

          // Sessions + session_boards, with a conflict on the survivor.
          await transaction.execute(sql`
            INSERT INTO board_sessions (id, board_path, board_id)
            VALUES
              (${`${tag}-s1`}, 'kilter/1/10/20,21/40', ${loserOneId}),
              (${`${tag}-s2`}, 'kilter/1/10/20,21/40', ${loserOneId})
          `);
          await transaction.execute(sql`
            INSERT INTO session_boards (session_id, board_id, created_at)
            VALUES
              (${`${tag}-s1`}, ${canonicalId}, '2026-01-01T00:00:00Z'),
              (${`${tag}-s1`}, ${loserOneId}, '2026-01-02T00:00:00Z'),
              (${`${tag}-s2`}, ${loserOneId}, '2026-01-03T00:00:00Z')
          `);

          // Follows: gamma follows both survivor + loser1 (conflict fold);
          // epsilon follows loser1 only (inserted).
          await transaction.execute(sql`
            INSERT INTO board_follows (user_id, board_uuid, created_at)
            VALUES
              (${users.gamma}, ${canonicalUuid}, '2026-01-01T00:00:00Z'),
              (${users.gamma}, ${loserOneUuid}, '2026-01-02T00:00:00Z'),
              (${users.epsilon}, ${loserOneUuid}, '2026-01-03T00:00:00Z')
          `);

          // Serial pointers scattered across losers (the actual #3407 fix).
          await transaction.execute(sql`
            INSERT INTO user_board_serials (user_id, serial_number, board_name, layout_id, size_id, set_ids, board_uuid, updated_at)
            VALUES
              (${users.delta}, ${serial}, 'Kilter Board', 1, 10, '20,21', ${loserOneUuid}, NOW()),
              (${users.theta}, ${serial}, 'Kilter Board', 1, 10, '20,21', ${loserTwoUuid}, NOW())
          `);

          // Comment on loser1.
          await transaction.execute(sql`
            INSERT INTO comments (uuid, user_id, entity_type, entity_id, body)
            VALUES (${`${tag}-comment`}, ${users.alpha}, 'board'::social_entity_type, ${loserOneUuid}, 'fixture comment')
          `);

          // Votes: alpha voted survivor +1 (older), alpha voted loser1 -1 (newer, wins);
          // beta voted loser1 +1 (inserted).
          await transaction.execute(sql`
            INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
            VALUES
              (${users.alpha}, 'board'::social_entity_type, ${canonicalUuid}, 1, '2026-01-01T00:00:00Z'),
              (${users.alpha}, 'board'::social_entity_type, ${loserOneUuid}, -1, '2026-01-05T00:00:00Z'),
              (${users.beta}, 'board'::social_entity_type, ${loserOneUuid}, 1, '2026-01-02T00:00:00Z')
          `);

          // Feed items: one by entity_id (loser1), one by board_uuid (loser2).
          await transaction.execute(sql`
            INSERT INTO feed_items (recipient_id, actor_id, type, entity_type, entity_id, board_uuid)
            VALUES
              (${users.alpha}, ${users.beta}, 'comment'::feed_item_type, 'board'::social_entity_type, ${loserOneUuid}, NULL),
              (${users.alpha}, ${users.beta}, 'ascent'::feed_item_type, 'climb'::social_entity_type, ${`${tag}-climb`}, ${loserTwoUuid})
          `);

          // Notification on loser1.
          await transaction.execute(sql`
            INSERT INTO notifications (uuid, recipient_id, actor_id, type, entity_type, entity_id)
            VALUES (${`${tag}-notif`}, ${users.alpha}, ${users.beta}, 'new_climb'::notification_type, 'board'::social_entity_type, ${loserOneUuid})
          `);

          // --- Apply the merge via the real discovery + refetch + merge path ---
          const candidates = await fetchCandidates(transaction, serial);
          const clusters = groupSerialClusters(candidates);
          assert.equal(clusters.length, 1, 'expected one cluster');
          assert.equal(clusters[0]?.skipReason, null, 'cluster should be mergeable');

          const merged = await refetchAndMerge(transaction, clusters[0]!);
          assert.ok(merged.ok, 'merge should succeed');
          const counts = merged.counts;

          assert.equal(counts.boardsWithMetadataBackfilled, 1);
          assert.equal(counts.climbEventsMoved, 3);
          assert.equal(counts.sequenceFloorsAdvanced, 1);
          assert.equal(counts.betaLinksMoved, 1);
          assert.equal(counts.sessionsMoved, 2);
          assert.equal(counts.sessionBoardsInserted, 1);
          assert.equal(counts.sessionBoardsDeleted, 2);
          assert.equal(counts.ticksMoved, 1);
          assert.equal(counts.followsInserted, 1); // epsilon; gamma conflicts
          assert.equal(counts.followsDeleted, 2);
          assert.equal(counts.ownerFollowsInserted, 1); // beta; system + alpha skipped
          assert.equal(counts.serialPointersRepointed, 2);
          assert.equal(counts.commentsMoved, 1);
          assert.equal(counts.votesUpserted, 2);
          assert.equal(counts.votesDeleted, 2);
          assert.equal(counts.feedItemsEntityMoved, 1);
          assert.equal(counts.feedItemsBoardUuidMoved, 1);
          assert.equal(counts.notificationsMoved, 1);
          assert.equal(counts.tombstonesFlattened, 1);
          assert.equal(counts.losersSoftDeleted, 2);

          // Survivor metadata + generic-name adoption.
          const [survivor] = await executeRows<{
            name: string;
            gymId: number | string | null;
            latitude: number | string | null;
            locationName: string | null;
            hideLocation: boolean;
            isPublic: boolean;
            isUnlisted: boolean;
            presenceSeq: number | string;
          }>(
            transaction,
            sql`
              SELECT name AS "name", gym_id AS "gymId", latitude AS "latitude",
                     location_name AS "locationName", hide_location AS "hideLocation", is_public AS "isPublic",
                     is_unlisted AS "isUnlisted", presence_seq AS "presenceSeq"
              FROM user_boards WHERE id = ${canonicalId}
            `,
          );
          assert.equal(survivor?.name, 'Movement Kilter', 'generic survivor name adopts donor name');
          assert.equal(Number(survivor?.gymId), gymId);
          assert.equal(Number(survivor?.latitude), -33.9);
          assert.equal(survivor?.locationName, 'Movement Boulder');
          assert.equal(survivor?.hideLocation, true, 'survivor inherits donor hide_location with donated coords');
          assert.equal(survivor?.isPublic, true, 'is_public true because a cluster row was public');
          assert.equal(survivor?.isUnlisted, false, 'no cluster row requested unlisted privacy');
          assert.equal(Number(survivor?.presenceSeq), 23, 'survivor sequence floor covers every moved event');

          // Beta link repointed off the soft-deleted loser onto the survivor.
          const [betaLink] = await executeRows<{ boardId: number | string | null }>(
            transaction,
            sql`SELECT board_id AS "boardId" FROM board_beta_links WHERE link = ${`https://example.test/${tag}-beta`}`,
          );
          assert.equal(Number(betaLink?.boardId), canonicalId, 'beta link points at survivor after merge');

          // Climb events: existing canonical seqs stay put; loser rows start
          // above the highest pre-merge reservation (20), not merely max(seq).
          const survivorSeqs = await executeRows<{ seq: number | string }>(
            transaction,
            sql`SELECT seq AS "seq" FROM board_climb_events WHERE board_id = ${canonicalId} ORDER BY seq`,
          );
          assert.deepEqual(
            survivorSeqs.map((row) => Number(row.seq)),
            [1, 2, 3, 21, 22, 23],
          );

          // Losers tombstoned, serial retained.
          const losers = await executeRows<{
            id: number | string;
            deletedAt: Date | string | null;
            isPublic: boolean;
            mergedInto: string | null;
            serial: string | null;
          }>(
            transaction,
            sql`
              SELECT id AS "id", deleted_at AS "deletedAt", is_public AS "isPublic",
                     merged_into_board_uuid AS "mergedInto", serial_number AS "serial"
              FROM user_boards WHERE id IN (${loserOneId}, ${loserTwoId}) ORDER BY id
            `,
          );
          for (const loser of losers) {
            assert.notEqual(loser.deletedAt, null, 'loser soft-deleted');
            assert.equal(loser.isPublic, false, 'loser no longer public');
            assert.equal(loser.mergedInto, canonicalUuid, 'loser tombstoned to survivor');
            assert.equal(loser.serial, serial, 'loser serial retained for forensics');
          }
          const [flattenedHistoricalLoser] = await executeRows<{ mergedInto: string | null }>(
            transaction,
            sql`
              SELECT merged_into_board_uuid AS "mergedInto"
                FROM user_boards
               WHERE id = ${historicalLoserId}
            `,
          );
          assert.equal(
            flattenedHistoricalLoser?.mergedInto,
            canonicalUuid,
            'only the prelocked historical predecessor is flattened to the survivor',
          );

          // Loser owner (beta) now follows survivor.
          const [betaFollow] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM board_follows WHERE user_id = ${users.beta} AND board_uuid = ${canonicalUuid}`,
          );
          assert.equal(Number(betaFollow?.count), 1);

          // Serial pointers converged on survivor.
          const [pointerCount] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM user_board_serials WHERE serial_number = ${serial} AND board_uuid = ${canonicalUuid}`,
          );
          assert.equal(Number(pointerCount?.count), 2);

          // Votes: alpha=-1 (latest), beta=+1 on survivor; loser votes gone.
          const survivorVotes = await executeRows<{ userId: string; value: number | string }>(
            transaction,
            sql`
              SELECT user_id AS "userId", value AS "value" FROM votes
              WHERE entity_type = 'board'::social_entity_type AND entity_id = ${canonicalUuid} ORDER BY user_id
            `,
          );
          assert.deepEqual(
            survivorVotes.map((vote) => ({ userId: vote.userId, value: Number(vote.value) })),
            [
              { userId: users.alpha, value: -1 },
              { userId: users.beta, value: 1 },
            ],
          );

          // vote_counts rebuilt for survivor.
          const [voteCount] = await executeRows<{
            upvotes: number | string;
            downvotes: number | string;
            score: number | string;
          }>(
            transaction,
            sql`
              SELECT upvotes AS "upvotes", downvotes AS "downvotes", score AS "score" FROM vote_counts
              WHERE entity_type = 'board'::social_entity_type AND entity_id = ${canonicalUuid}
            `,
          );
          assert.equal(Number(voteCount?.upvotes), 1);
          assert.equal(Number(voteCount?.downvotes), 1);
          assert.equal(Number(voteCount?.score), 0);

          // Feed items repointed.
          const [feedEntity] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM feed_items WHERE entity_type = 'board'::social_entity_type AND entity_id = ${canonicalUuid}`,
          );
          assert.equal(Number(feedEntity?.count), 1);
          const [feedBoardUuid] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM feed_items WHERE board_uuid = ${canonicalUuid}`,
          );
          assert.equal(Number(feedBoardUuid?.count), 1);

          // --- Idempotency: a second discovery finds no cluster ---
          const secondPass = await fetchCandidates(transaction, serial);
          const secondClusters = groupSerialClusters(secondPass);
          assert.equal(secondClusters.length, 0, 'no duplicate cluster remains after merge');

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

  void it('keeps a higher-usage private row private and backfills a public survivor only from public metadata', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailableReason = await skipReason(db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }

      const rollbackMarker = new Error('rollback serial-public-metadata fixture');
      try {
        await db.transaction(async (transaction) => {
          const tag = `serial-public-metadata-${Date.now()}`;
          const serial = `SERPM-${Date.now()}`;
          const privateOwnerId = `${tag}-private-owner`;
          const publicOwnerId = `${tag}-public-owner`;
          await transaction.execute(sql`
            INSERT INTO users (id, email, name)
            VALUES
              (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh'),
              (${privateOwnerId}, ${`${privateOwnerId}@example.test`}, 'Private owner'),
              (${publicOwnerId}, ${`${publicOwnerId}@example.test`}, 'Public owner')
            ON CONFLICT (id) DO NOTHING
          `);

          // This private row has the most usage and tempting location/name
          // metadata. It must become a tombstone rather than a public
          // survivor, and none of its metadata may reach discovery.
          const privateHighUsageId = await insertBoard(transaction, {
            uuid: `${tag}-private-high-usage`,
            slug: `${tag}-private-high-usage`,
            ownerId: privateOwnerId,
            name: 'Private gym MoonBoard',
            serial,
            latitude: 1.1,
            longitude: 2.2,
            locationName: 'Private Gym',
            isPublic: false,
          });
          await insertClimbEvent(transaction, privateHighUsageId, 1);
          await insertClimbEvent(transaction, privateHighUsageId, 2);

          // The first public row wins the public-only ranking. It has a generic
          // name and empty metadata, so the public loser below may backfill it.
          const publicCanonicalId = await insertBoard(transaction, {
            uuid: `${tag}-public-canonical`,
            slug: `${tag}-public-canonical`,
            ownerId: publicOwnerId,
            name: 'Kilter Board',
            serial,
            hideLocation: true,
            isPublic: true,
          });

          await insertBoard(transaction, {
            uuid: `${tag}-public-donor`,
            slug: `${tag}-public-donor`,
            ownerId: SYSTEM_USER_ID,
            name: 'Public Gym Kilter',
            serial,
            latitude: 3.3,
            longitude: 4.4,
            locationName: 'Public Gym',
            isPublic: true,
            isUnlisted: true,
          });

          const candidates = await fetchCandidates(transaction, serial);
          const clusters = groupSerialClusters(candidates);
          assert.equal(clusters.length, 1);
          const merged = await refetchAndMerge(transaction, clusters[0]!);
          assert.ok(merged.ok, 'public metadata fixture should merge');

          const [survivor] = await executeRows<{
            name: string;
            isPublic: boolean;
            hideLocation: boolean;
            isUnlisted: boolean;
            latitude: number | string | null;
            longitude: number | string | null;
            locationName: string | null;
            ownerId: string;
          }>(
            transaction,
            sql`
              SELECT name AS "name", is_public AS "isPublic", hide_location AS "hideLocation", is_unlisted AS "isUnlisted",
                     latitude AS "latitude", longitude AS "longitude", location_name AS "locationName",
                     owner_id AS "ownerId"
              FROM user_boards
              WHERE id = ${publicCanonicalId}
            `,
          );
          assert.equal(survivor?.name, 'Public Gym Kilter', 'public donor may replace a generic public name');
          assert.equal(Number(survivor?.latitude), 3.3, 'private coordinates are not copied to the public survivor');
          assert.equal(Number(survivor?.longitude), 4.4, 'public donor coordinates are backfilled');
          assert.equal(survivor?.locationName, 'Public Gym', 'private location name is not copied to discovery');
          assert.equal(survivor?.isPublic, true);
          assert.equal(survivor?.hideLocation, true, 'private and public flags retain the strongest location privacy');
          assert.equal(survivor?.isUnlisted, true, 'a public loser keeps the survivor unlisted');
          assert.equal(survivor?.ownerId, publicOwnerId, 'public survivor keeps its public owner identity');
          assert.notEqual(survivor?.ownerId, privateOwnerId, 'private owner is never promoted onto the public board');

          const [privateLoser] = await executeRows<{ deletedAt: Date | string | null; isPublic: boolean }>(
            transaction,
            sql`
              SELECT deleted_at AS "deletedAt", is_public AS "isPublic"
                FROM user_boards
               WHERE id = ${privateHighUsageId}
            `,
          );
          assert.notEqual(privateLoser?.deletedAt, null, 'higher-usage private row is merged away');
          assert.equal(privateLoser?.isPublic, false, 'private loser is never promoted');

          // Merge access continuity is intentionally distinct from survivor
          // identity: the private loser owner follows the public canonical but
          // never becomes its owner.
          const [privateOwnerFollow] = await executeRows<CountRow>(
            transaction,
            sql`
              SELECT count(*)::int AS count
                FROM board_follows
               WHERE user_id = ${privateOwnerId}
                 AND board_uuid = ${`${tag}-public-canonical`}
            `,
          );
          assert.equal(Number(privateOwnerFollow?.count), 1, 'private loser owner retains access by following');

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

  void it('keeps private loser flags when the canonical board is already public', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailableReason = await skipReason(db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }

      const rollbackMarker = new Error('rollback public-canonical privacy fixture');
      try {
        await db.transaction(async (transaction) => {
          const tag = `serial-public-privacy-${Date.now()}`;
          const serial = `SERPP-${Date.now()}`;
          await transaction.execute(sql`
            INSERT INTO users (id, email, name)
            VALUES (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh')
            ON CONFLICT (id) DO NOTHING
          `);

          const canonicalId = await insertBoard(transaction, {
            uuid: `${tag}-canonical`,
            slug: `${tag}-canonical`,
            ownerId: SYSTEM_USER_ID,
            name: 'Public survivor',
            serial,
            isPublic: true,
          });
          await insertClimbEvent(transaction, canonicalId, 1);
          const hiddenLoserId = await insertBoard(transaction, {
            uuid: `${tag}-hidden-private`,
            slug: `${tag}-hidden-private`,
            ownerId: SYSTEM_USER_ID,
            name: 'Hidden private duplicate',
            serial,
            hideLocation: true,
            isPublic: false,
          });
          await insertBoard(transaction, {
            uuid: `${tag}-unlisted-private`,
            slug: `${tag}-unlisted-private`,
            ownerId: SYSTEM_USER_ID,
            name: 'Unlisted private duplicate',
            serial,
            isUnlisted: true,
            isPublic: false,
          });
          await transaction.execute(sql`
            UPDATE user_boards SET presence_seq = 50 WHERE id = ${hiddenLoserId}
          `);

          const candidates = await fetchCandidates(transaction, serial);
          const clusters = groupSerialClusters(candidates);
          assert.equal(clusters.length, 1);
          const merged = await refetchAndMerge(transaction, clusters[0]!);
          assert.ok(merged.ok, 'public-canonical privacy fixture should merge');

          const [survivor] = await executeRows<{
            isPublic: boolean;
            hideLocation: boolean;
            isUnlisted: boolean;
            presenceSeq: number | string;
          }>(
            transaction,
            sql`
              SELECT is_public AS "isPublic", hide_location AS "hideLocation", is_unlisted AS "isUnlisted",
                     presence_seq AS "presenceSeq"
                FROM user_boards
               WHERE id = ${canonicalId}
            `,
          );
          assert.equal(survivor?.isPublic, true);
          assert.equal(survivor?.hideLocation, true, 'a hidden loser keeps the canonical location hidden');
          assert.equal(survivor?.isUnlisted, true, 'an unlisted loser keeps the canonical board unlisted');
          assert.equal(Number(survivor?.presenceSeq), 50, 'a loser reservation is retained without durable events');

          throw rollbackMarker;
        });
      } catch (error: unknown) {
        if (error !== rollbackMarker) throw error;
      }
    } finally {
      await close();
    }
  });

  void it('reports a distinct-config cluster as skipped and never merges it', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    try {
      const unavailableReason = await skipReason(db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }

      const rollbackMarker = new Error('rollback distinct-config fixture');
      try {
        await db.transaction(async (transaction) => {
          const tag = `serial-distinct-${Date.now()}`;
          const serial = `SERD-${Date.now()}`;
          await transaction.execute(sql`
            INSERT INTO users (id, email, name)
            VALUES (${SYSTEM_USER_ID}, 'system@boardsesh.test', 'Boardsesh')
            ON CONFLICT (id) DO NOTHING
          `);
          // System-owned catalog rows are exempt from the per-owner serial
          // uniqueness index, so this mirrors the prod distinct-config pairs
          // (same serial shipped to two walls with different configs).
          const boardOneId = await insertBoard(transaction, {
            uuid: `${tag}-b1`,
            slug: `${tag}-b1`,
            ownerId: SYSTEM_USER_ID,
            name: 'Config A',
            serial,
            layoutId: 1,
          });
          const boardTwoId = await insertBoard(transaction, {
            uuid: `${tag}-b2`,
            slug: `${tag}-b2`,
            ownerId: SYSTEM_USER_ID,
            name: 'Config B',
            serial,
            layoutId: 2, // different layout → distinct config
          });

          const candidates = await fetchCandidates(transaction, serial);
          const clusters = groupSerialClusters(candidates);
          assert.equal(clusters.length, 1);
          assert.equal(clusters[0]?.skipReason, 'distinct-configs');
          assert.equal(clusters[0]?.configKey, null);

          // Neither board is mutated (both still active).
          const [activeCount] = await executeRows<CountRow>(
            transaction,
            sql`SELECT count(*)::int AS count FROM user_boards WHERE id IN (${boardOneId}, ${boardTwoId}) AND deleted_at IS NULL`,
          );
          assert.equal(Number(activeCount?.count), 2);

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

  void it('shares the backend serial lock and revalidates membership after contention', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const setup = createScriptDb(databaseUrl);
    const onlineWriter = createScriptDb(databaseUrl);
    const dedupe = createScriptDb(databaseUrl);
    const tag = `serial-lock-contention-${Date.now()}`;
    const releaseOnlineWriter = createBarrier();
    const onlineWriterReady = createValueBarrier<number>();
    let onlineWriterPromise: Promise<void> | undefined;
    let dedupePromise: Promise<ClusterValidation> | undefined;
    let databaseAvailable = false;

    try {
      const unavailableReason = await lockTestSkipReason(setup.db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }
      databaseAvailable = true;
      const { serial, cluster } = await createCommittedCluster(setup.db, tag);

      onlineWriterPromise = onlineWriter.db.transaction(async (transaction) => {
        const onlineWriterPid = await currentBackendPid(transaction);
        await lockBoardSerialWrite(transaction, serial);
        await insertBoard(transaction, {
          uuid: `${tag}-late`,
          slug: `${tag}-late`,
          ownerId: SYSTEM_USER_ID,
          name: 'Concurrent duplicate',
          serial,
        });
        onlineWriterReady.release(onlineWriterPid);
        await releaseOnlineWriter.promise;
      });
      const onlineWriterPid = await onlineWriterReady.promise;

      dedupePromise = dedupe.db.transaction((transaction) => refetchClusterForApply(transaction, cluster));
      await waitForBlockedSession(setup.db, onlineWriterPid, 'advisory');

      releaseOnlineWriter.release();
      await onlineWriterPromise;
      const validation = await dedupePromise;
      assert.equal(validation.ok, false, 'dedupe must skip after the active serial membership changes');
      if (!validation.ok) {
        assert.match(validation.reason, /active board set changed since discovery/);
      }
    } finally {
      releaseOnlineWriter.release();
      await Promise.allSettled([onlineWriterPromise, dedupePromise].filter((promise) => promise !== undefined));
      if (databaseAvailable) {
        await setup.db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${`${tag}-serial`}`);
      }
      await Promise.all([setup.close(), onlineWriter.close(), dedupe.close()]);
    }
  });

  void it('waits for cluster rows before acquiring the per-serial lock', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const setup = createScriptDb(databaseUrl);
    const rowHolder = createScriptDb(databaseUrl);
    const dedupe = createScriptDb(databaseUrl);
    const tag = `serial-row-order-${Date.now()}`;
    const rowLocked = createValueBarrier<number>();
    const acquireSerial = createBarrier();
    const serialLocked = createBarrier();
    const releaseRowHolder = createBarrier();
    let rowHolderPromise: Promise<void> | undefined;
    let dedupePromise: Promise<ClusterValidation> | undefined;
    let databaseAvailable = false;

    try {
      const unavailableReason = await lockTestSkipReason(setup.db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }
      databaseAvailable = true;
      const { serial, cluster, boardIds } = await createCommittedCluster(setup.db, tag);

      rowHolderPromise = rowHolder.db.transaction(async (transaction) => {
        const rowHolderPid = await currentBackendPid(transaction);
        await transaction.execute(sql`SELECT id FROM user_boards WHERE id = ${boardIds[0]} FOR UPDATE`);
        rowLocked.release(rowHolderPid);
        await acquireSerial.promise;
        await lockBoardSerialWrite(transaction, serial);
        serialLocked.release();
        await releaseRowHolder.promise;
      });
      const rowHolderPid = await rowLocked.promise;

      dedupePromise = dedupe.db.transaction((transaction) => refetchClusterForApply(transaction, cluster));
      await waitForBlockedSession(setup.db, rowHolderPid, 'row');

      acquireSerial.release();
      await Promise.race([
        serialLocked.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('row holder could not acquire serial lock; lock order may be inverted')),
            2_000,
          ),
        ),
      ]);
      releaseRowHolder.release();
      await rowHolderPromise;
      const validation = await dedupePromise;
      assert.equal(validation.ok, true);
    } finally {
      acquireSerial.release();
      releaseRowHolder.release();
      await Promise.allSettled([rowHolderPromise, dedupePromise].filter((promise) => promise !== undefined));
      if (databaseAvailable) {
        await setup.db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${`${tag}-serial`}`);
      }
      await Promise.all([setup.close(), rowHolder.close(), dedupe.close()]);
    }
  });

  void it('prelocks historical tombstones before a concurrent restore can wait on the serial', async (testContext) => {
    const databaseUrl = testDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip('set DEDUPE_SERIAL_BOARDS_DB_URL or a local DATABASE_URL to run this integration test');
      return;
    }

    const setup = createScriptDb(databaseUrl);
    const restore = createScriptDb(databaseUrl);
    const dedupe = createScriptDb(databaseUrl);
    const tag = `serial-tombstone-restore-${Date.now()}`;
    const restoreRowLocked = createValueBarrier<number>();
    const allowRestoreSerial = createBarrier();
    const restoreUpdated = createBarrier();
    const releaseRestore = createBarrier();
    let restorePromise: Promise<void> | undefined;
    let dedupePromise: Promise<Awaited<ReturnType<typeof refetchAndMerge>>> | undefined;
    let databaseAvailable = false;

    try {
      const unavailableReason = await lockTestSkipReason(setup.db);
      if (unavailableReason) {
        testContext.skip(unavailableReason);
        return;
      }
      databaseAvailable = true;
      const { serial, cluster, boardUuids } = await createCommittedCluster(setup.db, tag);
      const historicalBoardId = await insertBoard(setup.db, {
        uuid: `${tag}-historical`,
        slug: `${tag}-historical`,
        ownerId: SYSTEM_USER_ID,
        name: 'Historical loser',
        serial,
      });
      await setup.db.execute(sql`
        UPDATE user_boards
           SET deleted_at = NOW(), merged_into_board_uuid = ${boardUuids[1]}
         WHERE id = ${historicalBoardId}
      `);

      restorePromise = restore.db.transaction(async (transaction) => {
        const restorePid = await currentBackendPid(transaction);
        await transaction.execute(sql`SELECT id FROM user_boards WHERE id = ${historicalBoardId} FOR UPDATE`);
        restoreRowLocked.release(restorePid);
        await allowRestoreSerial.promise;
        await lockBoardSerialWrite(transaction, serial);
        await transaction.execute(sql`
          UPDATE user_boards
             SET deleted_at = NULL, updated_at = NOW()
           WHERE id = ${historicalBoardId}
        `);
        restoreUpdated.release();
        await releaseRestore.promise;
      });
      const restorePid = await restoreRowLocked.promise;

      dedupePromise = dedupe.db.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
        return refetchAndMerge(transaction, cluster);
      });
      // The fixed path waits here, while pre-locking the historical predecessor.
      // The old path first took the serial key and only blocked on this row in
      // mergeSerialCluster's flatten UPDATE, creating the restore↔dedupe cycle.
      await waitForBlockedSession(setup.db, restorePid, 'row');

      allowRestoreSerial.release();
      await Promise.race([
        restoreUpdated.promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('restore could not acquire the serial lock after holding its row')), 2_000),
        ),
      ]);
      releaseRestore.release();
      await restorePromise;

      const mergeAttempt = await dedupePromise;
      assert.equal(mergeAttempt.ok, false, 'dedupe must skip after the tombstone becomes an active serial member');
      const [historicalBoard] = await executeRows<{ deletedAt: Date | string | null }>(
        setup.db,
        sql`SELECT deleted_at AS "deletedAt" FROM user_boards WHERE id = ${historicalBoardId}`,
      );
      assert.equal(historicalBoard?.deletedAt, null, 'the restore commits without a deadlock victim');
    } finally {
      allowRestoreSerial.release();
      releaseRestore.release();
      await Promise.allSettled([restorePromise, dedupePromise].filter((promise) => promise !== undefined));
      if (databaseAvailable) {
        await setup.db.execute(sql`DELETE FROM user_boards WHERE serial_number = ${`${tag}-serial`}`);
      }
      await Promise.all([setup.close(), restore.close(), dedupe.close()]);
    }
  });
});
