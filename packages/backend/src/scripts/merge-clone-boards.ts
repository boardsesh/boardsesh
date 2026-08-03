// One-off repair for the board identity split (see the "clone board" analysis
// in the PR that added this file).
//
// Most synced gym boards carry no `serial_number`, so before the selection-wins
// fix in `resolveSerialForUser` the first climber to BLE-connect at a gym fell
// through to `bindOrCreateOwnBoardForSerial` and minted a PRIVATE duplicate of
// that wall under their own account. Every climber who connected afterwards
// matched the serial to that duplicate, so one physical wall accumulated wall
// history and ticks under two board ids — and the map finder kept pointing at
// the gym's own (empty) listing.
//
// Two independent phases, both dry-run by default:
//
//   --backfill-serials  Stamp a recoverable serial onto the gym board that owns
//                       it, learnt from `user_board_serials` links. Safe on its
//                       own, moves no rows, and stops NEW clones appearing for
//                       walls whose serial we already know.
//
//   --merge             Repoint every clone's history/ticks/follows onto the
//                       gym board and soft-delete the clone.
//
// The two phases barely overlap, and NOT in the direction you'd assume:
// `findSerialBackfills` skips any serial another active board already carries,
// and a live clone carries exactly the serials the merge is about. So a wall
// with a clone gains its serial from `--merge` (the gym board adopts the
// clone's), never from `--backfill-serials` — the backfill only covers walls
// whose serial was recorded but which no clone ever took. Running the backfill
// first is still the right order, because it's the safe half; just don't expect
// it to touch anything in the merge set.
//
// Nothing is ever hard-deleted: a merged clone keeps its row with `deleted_at`
// set, so a bad pairing is reversible from the report CSV.
//
// Run:
//   node --import tsx packages/backend/src/scripts/merge-clone-boards.ts --backfill-serials
//   node --import tsx packages/backend/src/scripts/merge-clone-boards.ts --backfill-serials --apply
//   node --import tsx packages/backend/src/scripts/merge-clone-boards.ts --merge --report pairs.csv
//   node --import tsx packages/backend/src/scripts/merge-clone-boards.ts --merge --apply
//
// Needs DB_URL, and REDIS_URL for `--merge --apply` (see resetBoardCaches).

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import Redis from 'ioredis';
import { closePool } from '@boardsesh/db/client';
import { rowsOf } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { SYSTEM_BOARD_OWNER_ID, normalizeSetIds } from '../graphql/resolvers/board-presence/shared';
import { logger } from '../utils/logger';

type Database = typeof db;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A clone board and the gym board it belongs to. */
export type ClonePair = {
  cloneId: number;
  cloneUuid: string;
  cloneName: string;
  cloneOwnerId: string;
  serialNumber: string;
  targetId: number;
  targetUuid: string;
  targetName: string;
  targetSerialNumber: string | null;
  targetGymId: number | null;
};

/** A gym board whose serial we can recover from what climbers already recorded. */
export type SerialBackfill = {
  boardId: number;
  boardUuid: string;
  boardName: string;
  serialNumber: string;
};

export type MergeCounts = {
  climbEvents: number;
  ticks: number;
  follows: number;
  followsDropped: number;
  sessionBoards: number;
  sessionBoardsDropped: number;
  boardSessions: number;
  betaLinks: number;
  serialLinks: number;
};

// Headroom added on top of both boards' maxima when parking seqs out of the way
// for the renumber. `board_climb_events_board_seq_unique` is a plain unique
// index (not a deferrable constraint), so rows are checked as each statement
// touches them and an in-place renumber would collide. seq is a bigint, so the
// headroom costs nothing.
const SEQ_PARK_OFFSET = 1_000_000_000;

// --- Discovery ----------------------------------------------------------------

/**
 * Gym boards with no serial whose serial IS knowable: some climber connected to
 * the controller while that board was the one they had selected, which
 * `recordBoardSerial` wrote down as a (serial → board) link.
 *
 * A serial claimed by more than one distinct gym board is skipped, not guessed:
 * the LED supplier reuses serials across walls, so an ambiguous one has to stay
 * ambiguous (the runtime disambiguation prompt handles it).
 */
export async function findSerialBackfills(database: Database | Transaction = db): Promise<SerialBackfill[]> {
  const rows = await database
    .select({
      boardId: dbSchema.userBoards.id,
      boardUuid: dbSchema.userBoards.uuid,
      boardName: dbSchema.userBoards.name,
      serialNumber: dbSchema.userBoardSerials.serialNumber,
    })
    .from(dbSchema.userBoardSerials)
    .innerJoin(
      dbSchema.userBoards,
      and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
    )
    .where(
      and(
        isNull(dbSchema.userBoards.serialNumber),
        isNotNull(dbSchema.userBoards.gymId),
        // Synced gym listings only. 1,554 user-owned boards also carry a gym_id
        // (a home wall attached to its own auto-created gym, a board captured
        // via the stray-board flow), and stamping a serial onto one of those
        // would redirect it for every climber who connects afterwards — the
        // exact failure this script exists to undo. Matches findClonePairs'
        // guard on the merge target.
        eq(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
      ),
    )
    .groupBy(
      dbSchema.userBoards.id,
      dbSchema.userBoards.uuid,
      dbSchema.userBoards.name,
      dbSchema.userBoardSerials.serialNumber,
    );

  // Drop anything ambiguous in EITHER direction: a board that saw two serials,
  // or a serial recorded against two different gym boards.
  const boardCounts = new Map<number, number>();
  const serialCounts = new Map<string, number>();
  for (const row of rows) {
    boardCounts.set(Number(row.boardId), (boardCounts.get(Number(row.boardId)) ?? 0) + 1);
    serialCounts.set(row.serialNumber, (serialCounts.get(row.serialNumber) ?? 0) + 1);
  }

  const unambiguous = rows
    .filter((row) => boardCounts.get(Number(row.boardId)) === 1 && serialCounts.get(row.serialNumber) === 1)
    .map((row) => ({
      boardId: Number(row.boardId),
      boardUuid: row.boardUuid,
      boardName: row.boardName,
      serialNumber: row.serialNumber,
    }));
  if (unambiguous.length === 0) return [];

  // Finally, never stamp a serial that some other ACTIVE board already carries —
  // that would create the many-boards-one-serial case the prompt exists for.
  const taken = await database
    .select({ serialNumber: dbSchema.userBoards.serialNumber })
    .from(dbSchema.userBoards)
    .where(
      and(
        isNull(dbSchema.userBoards.deletedAt),
        inArray(
          dbSchema.userBoards.serialNumber,
          unambiguous.map((row) => row.serialNumber),
        ),
      ),
    );
  const takenSerials = new Set(
    taken.map((row) => row.serialNumber).filter((serial): serial is string => serial !== null),
  );

  return unambiguous
    .filter((row) => !takenSerials.has(row.serialNumber))
    .sort((first, second) => first.boardId - second.boardId);
}

/**
 * Clone boards paired with the gym board they duplicate.
 *
 * A pair needs ALL of:
 *  - the clone is active, user-owned, and carries a serial;
 *  - some climber recorded that same serial against an active, SYSTEM-owned,
 *    gym-linked board (i.e. the synced catalog listing for the wall);
 *  - both boards describe the SAME wall — board type, layout, size, and
 *    normalized hold sets all match.
 *
 * The config equality is the load-bearing guard. A serial alone is not proof
 * two rows are the same wall (they get reused), but a reused serial on an
 * identically-configured board that a climber explicitly linked to a gym is.
 */
export async function findClonePairs(database: Database | Transaction = db): Promise<ClonePair[]> {
  const clone = alias(dbSchema.userBoards, 'clone_board');
  const target = alias(dbSchema.userBoards, 'target_board');

  const rows = await database
    .selectDistinct({
      cloneId: clone.id,
      cloneUuid: clone.uuid,
      cloneName: clone.name,
      cloneOwnerId: clone.ownerId,
      cloneBoardType: clone.boardType,
      cloneLayoutId: clone.layoutId,
      cloneSizeId: clone.sizeId,
      cloneSetIds: clone.setIds,
      serialNumber: clone.serialNumber,
      targetId: target.id,
      targetUuid: target.uuid,
      targetName: target.name,
      targetSerialNumber: target.serialNumber,
      targetGymId: target.gymId,
      targetBoardType: target.boardType,
      targetLayoutId: target.layoutId,
      targetSizeId: target.sizeId,
      targetSetIds: target.setIds,
    })
    .from(clone)
    // The (serial → board) links climbers already recorded are what say "this
    // serial belongs to that gym's listing".
    .innerJoin(dbSchema.userBoardSerials, eq(dbSchema.userBoardSerials.serialNumber, clone.serialNumber))
    .innerJoin(
      target,
      and(
        eq(target.uuid, dbSchema.userBoardSerials.boardUuid),
        isNull(target.deletedAt),
        eq(target.ownerId, SYSTEM_BOARD_OWNER_ID),
        isNotNull(target.gymId),
        ne(target.id, clone.id),
      ),
    )
    .where(and(isNull(clone.deletedAt), isNotNull(clone.serialNumber), ne(clone.ownerId, SYSTEM_BOARD_OWNER_ID)))
    .orderBy(asc(clone.id));

  const matched = rows
    .filter(
      (row) =>
        row.serialNumber !== null &&
        row.cloneBoardType === row.targetBoardType &&
        Number(row.cloneLayoutId) === Number(row.targetLayoutId) &&
        Number(row.cloneSizeId) === Number(row.targetSizeId) &&
        normalizeSetIds(row.cloneSetIds) === normalizeSetIds(row.targetSetIds),
    )
    .map((row) => ({
      cloneId: Number(row.cloneId),
      cloneUuid: row.cloneUuid,
      cloneName: row.cloneName,
      cloneOwnerId: row.cloneOwnerId,
      serialNumber: row.serialNumber!,
      targetId: Number(row.targetId),
      targetUuid: row.targetUuid,
      targetName: row.targetName,
      targetSerialNumber: row.targetSerialNumber,
      targetGymId: row.targetGymId === null ? null : Number(row.targetGymId),
    }));

  // The serial join is on the serial alone, so a clone can come back paired with
  // SEVERAL gym listings — different climbers recorded the same (reused) serial
  // against different gyms. There is no way to tell from here which one the
  // clone's history actually belongs to, and merging into the wrong gym is
  // unrecoverable in spirit even if the rows survive. Skip those loudly and
  // leave them for a human.
  const targetsPerClone = new Map<number, Set<number>>();
  for (const pair of matched) {
    const targets = targetsPerClone.get(pair.cloneId) ?? new Set<number>();
    targets.add(pair.targetId);
    targetsPerClone.set(pair.cloneId, targets);
  }
  const ambiguous = matched.filter((pair) => (targetsPerClone.get(pair.cloneId)?.size ?? 0) > 1);
  if (ambiguous.length > 0) {
    const cloneIds = [...new Set(ambiguous.map((pair) => pair.cloneId))];
    logger.warn(
      `[merge-clone-boards] skipping ${cloneIds.length} clone board(s) matching more than one gym listing: ${cloneIds.join(', ')}`,
    );
  }
  return matched.filter((pair) => targetsPerClone.get(pair.cloneId)?.size === 1);
}

// --- Merge --------------------------------------------------------------------

/**
 * Move one clone's rows onto its gym board, inside a single transaction.
 *
 * `board_climb_events` is the only table needing more than a repoint: seq is
 * unique per board and orders `boardHistory` (newest first), so the two boards'
 * rows are renumbered together by `confirmed_at` — otherwise the merged-in
 * history, which is almost always the OLDER half, would sort above what the gym
 * board already had.
 *
 * `board_follows` and `session_boards` carry unique keys that the repoint can
 * collide with (a climber who followed both boards, a session that touched
 * both); those rows are dropped rather than duplicated.
 */
export async function mergeClonePair(pair: ClonePair, tx: Transaction): Promise<MergeCounts> {
  // 1. Park both boards' seqs into two DISJOINT ranges, both above anything
  //    either board currently holds. Disjoint matters: the two boards usually
  //    both number from 1, so shifting them by the same amount would leave them
  //    still colliding the moment step 2 puts them on one board. And "above
  //    everything" matters because step 3's renumber writes back into 1..N,
  //    which must not meet a not-yet-renumbered row mid-statement.
  const maxima = rowsOf<{ max_target: string; max_clone: string }>(
    await tx.execute(sql`
      SELECT
        COALESCE(MAX(seq) FILTER (WHERE board_id = ${pair.targetId}), 0)::text AS max_target,
        COALESCE(MAX(seq) FILTER (WHERE board_id = ${pair.cloneId}), 0)::text  AS max_clone
      FROM board_climb_events
      WHERE board_id IN (${pair.cloneId}, ${pair.targetId})
    `),
  )[0];
  const maxTargetSeq = Number(maxima?.max_target ?? 0);
  const maxCloneSeq = Number(maxima?.max_clone ?? 0);
  const targetPark = maxTargetSeq + maxCloneSeq + SEQ_PARK_OFFSET;
  // Clone lands entirely above the target's parked band. The second offset is
  // belt-and-braces: `maxTargetSeq` alone already separates the bands whenever
  // the target has rows (seq starts at 1, so maxTargetSeq = 0 means it has
  // none), but that's a proof a reader has to reconstruct. A fixed gap makes
  // the bands obviously disjoint and costs nothing on a bigint.
  const clonePark = targetPark + maxTargetSeq + SEQ_PARK_OFFSET;
  await tx.execute(sql`
    UPDATE board_climb_events SET seq = seq + ${targetPark} WHERE board_id = ${pair.targetId}
  `);
  await tx.execute(sql`
    UPDATE board_climb_events SET seq = seq + ${clonePark} WHERE board_id = ${pair.cloneId}
  `);

  // 2. Repoint the clone's events, then renumber the union chronologically.
  //    `id` breaks confirmed_at ties so the ordering is total and repeatable.
  const climbEvents = await tx
    .update(dbSchema.boardClimbEvents)
    .set({ boardId: pair.targetId })
    .where(eq(dbSchema.boardClimbEvents.boardId, pair.cloneId))
    .returning({ id: dbSchema.boardClimbEvents.id });
  await tx.execute(sql`
    UPDATE board_climb_events AS merged
       SET seq = renumbered.new_seq
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY confirmed_at, id) AS new_seq
          FROM board_climb_events
         WHERE board_id = ${pair.targetId}
      ) AS renumbered
     WHERE merged.id = renumbered.id
  `);

  // 3. Plain repoints — no board-scoped unique key to collide with.
  const ticks = await tx
    .update(dbSchema.boardseshTicks)
    .set({ boardId: pair.targetId })
    .where(eq(dbSchema.boardseshTicks.boardId, pair.cloneId))
    .returning({ id: dbSchema.boardseshTicks.id });
  const boardSessions = await tx
    .update(dbSchema.boardSessions)
    .set({ boardId: pair.targetId })
    .where(eq(dbSchema.boardSessions.boardId, pair.cloneId))
    .returning({ id: dbSchema.boardSessions.id });
  const betaLinks = await tx
    .update(dbSchema.boardBetaLinks)
    .set({ boardId: pair.targetId })
    .where(eq(dbSchema.boardBetaLinks.boardId, pair.cloneId))
    // No surrogate id — board_beta_links is keyed on (board_type, climb_uuid, link).
    .returning({ id: dbSchema.boardBetaLinks.link });
  const serialLinks = await tx
    .update(dbSchema.userBoardSerials)
    .set({ boardUuid: pair.targetUuid, updatedAt: new Date() })
    .where(eq(dbSchema.userBoardSerials.boardUuid, pair.cloneUuid))
    .returning({ id: dbSchema.userBoardSerials.id });

  // 4. Repoints guarded by a unique key: keep the pre-existing row, drop the
  //    duplicate the move would have created.
  const followsDropped = await tx
    .delete(dbSchema.boardFollows)
    .where(
      and(
        eq(dbSchema.boardFollows.boardUuid, pair.cloneUuid),
        sql`EXISTS (
          SELECT 1 FROM board_follows AS kept
           WHERE kept.user_id = ${dbSchema.boardFollows.userId} AND kept.board_uuid = ${pair.targetUuid}
        )`,
      ),
    )
    .returning({ id: dbSchema.boardFollows.id });
  const follows = await tx
    .update(dbSchema.boardFollows)
    .set({ boardUuid: pair.targetUuid })
    .where(eq(dbSchema.boardFollows.boardUuid, pair.cloneUuid))
    .returning({ id: dbSchema.boardFollows.id });
  const sessionBoardsDropped = await tx
    .delete(dbSchema.sessionBoards)
    .where(
      and(
        eq(dbSchema.sessionBoards.boardId, pair.cloneId),
        sql`EXISTS (
          SELECT 1 FROM session_boards AS kept
           WHERE kept.session_id = ${dbSchema.sessionBoards.sessionId} AND kept.board_id = ${pair.targetId}
        )`,
      ),
    )
    .returning({ id: dbSchema.sessionBoards.id });
  const sessionBoards = await tx
    .update(dbSchema.sessionBoards)
    .set({ boardId: pair.targetId })
    .where(eq(dbSchema.sessionBoards.boardId, pair.cloneId))
    .returning({ id: dbSchema.sessionBoards.id });

  // 5. The gym board adopts the serial it should have carried all along, and
  //    the clone is soft-deleted (never dropped — the report CSV plus this row
  //    is what makes a bad pairing reversible).
  if (pair.targetSerialNumber === null) {
    await tx
      .update(dbSchema.userBoards)
      .set({ serialNumber: pair.serialNumber, updatedAt: new Date() })
      .where(and(eq(dbSchema.userBoards.id, pair.targetId), isNull(dbSchema.userBoards.serialNumber)));
  }
  await tx
    .update(dbSchema.userBoards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(dbSchema.userBoards.id, pair.cloneId));

  return {
    climbEvents: climbEvents.length,
    ticks: ticks.length,
    follows: follows.length,
    followsDropped: followsDropped.length,
    sessionBoards: sessionBoards.length,
    sessionBoardsDropped: sessionBoardsDropped.length,
    boardSessions: boardSessions.length,
    betaLinks: betaLinks.length,
    serialLinks: serialLinks.length,
  };
}

/**
 * Drop the Redis state that the merge just invalidated for a target board.
 *
 * The seq counter is the one that MATTERS. `nextBoardSeq` only re-reads the
 * durable floor when INCR returns a small value, so a board whose counter sits
 * at, say, 60 while the merge pushed `MAX(seq)` to 200 would keep handing out
 * seqs that already exist — and `onConflictDoNothing` would silently drop every
 * new send. Deleting the key forces the next INCR to return 1, which trips the
 * reseed and lifts the counter above the durable floor.
 *
 * The stats cache is just staleness (60s TTL), cleared for tidiness.
 */
export async function resetBoardCaches(redis: Redis, boardIds: number[]): Promise<void> {
  if (boardIds.length === 0) return;
  const keys = boardIds.flatMap((boardId) => [`board:${boardId}:seq`, `boardsesh:board-stats:v1:${boardId}`]);
  await redis.del(...keys);
}

// --- CLI ----------------------------------------------------------------------

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeReport(path: string, pairs: ClonePair[]): void {
  const header =
    'clone_id,clone_uuid,clone_name,clone_owner_id,serial_number,target_id,target_uuid,target_name,target_gym_id';
  const lines = pairs.map((pair) =>
    [
      pair.cloneId,
      pair.cloneUuid,
      pair.cloneName,
      pair.cloneOwnerId,
      pair.serialNumber,
      pair.targetId,
      pair.targetUuid,
      pair.targetName,
      pair.targetGymId,
    ]
      .map(csvCell)
      .join(','),
  );
  writeFileSync(path, `${[header, ...lines].join('\n')}\n`, 'utf8');
}

export async function runMerge(argv: string[]): Promise<void> {
  const apply = argv.includes('--apply');
  const doBackfill = argv.includes('--backfill-serials');
  const doMerge = argv.includes('--merge');
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;

  if (!doBackfill && !doMerge) {
    logger.error('[merge-clone-boards] pass --backfill-serials and/or --merge (add --apply to write)');
    process.exitCode = 1;
    return;
  }
  const mode = apply ? 'APPLY' : 'DRY RUN';

  if (doBackfill) {
    const backfills = await findSerialBackfills();
    logger.info(`[merge-clone-boards] ${mode}: ${backfills.length} gym boards can adopt a recoverable serial`);
    for (const backfill of backfills) {
      logger.info(
        `[merge-clone-boards]   board ${backfill.boardId} "${backfill.boardName}" ← ${backfill.serialNumber}`,
      );
      if (!apply) continue;
      await db
        .update(dbSchema.userBoards)
        .set({ serialNumber: backfill.serialNumber, updatedAt: new Date() })
        .where(and(eq(dbSchema.userBoards.id, backfill.boardId), isNull(dbSchema.userBoards.serialNumber)));
    }
  }

  if (!doMerge) return;

  const pairs = await findClonePairs();
  logger.info(`[merge-clone-boards] ${mode}: ${pairs.length} clone boards to merge`);
  if (reportPath) {
    writeReport(reportPath, pairs);
    logger.info(`[merge-clone-boards] wrote report to ${reportPath}`);
  }
  if (pairs.length === 0) return;

  if (!apply) {
    for (const pair of pairs) {
      const counts = rowsOf<{ events: string; ticks: string }>(
        await db.execute(sql`
          SELECT
            (SELECT count(*) FROM board_climb_events WHERE board_id = ${pair.cloneId})::text AS events,
            (SELECT count(*) FROM boardsesh_ticks    WHERE board_id = ${pair.cloneId})::text AS ticks
        `),
      )[0];
      logger.info(
        `[merge-clone-boards]   ${pair.cloneId} "${pair.cloneName}" → ${pair.targetId} "${pair.targetName}" ` +
          `(serial ${pair.serialNumber}, ${counts?.events ?? '?'} events, ${counts?.ticks ?? '?'} ticks)`,
      );
    }
    logger.info('[merge-clone-boards] dry run complete — re-run with --apply to write');
    return;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    // Applying without clearing the seq counters would silently drop new sends
    // on every merged board (see resetBoardCaches) — refuse rather than corrupt.
    logger.error('[merge-clone-boards] REDIS_URL is required for --apply: the seq counters must be reset');
    process.exitCode = 1;
    return;
  }
  const redis = new Redis(redisUrl);

  try {
    const merged: number[] = [];
    for (const pair of pairs) {
      const counts = await db.transaction((tx) => mergeClonePair(pair, tx));
      merged.push(pair.targetId);
      logger.info(
        `[merge-clone-boards] merged ${pair.cloneId} → ${pair.targetId}: ` +
          `${counts.climbEvents} events, ${counts.ticks} ticks, ${counts.follows} follows ` +
          `(+${counts.followsDropped} duplicate follows dropped), ${counts.serialLinks} serial links`,
      );
    }
    await resetBoardCaches(redis, [...new Set(merged)]);
    logger.info(`[merge-clone-boards] reset seq + stats caches for ${new Set(merged).size} boards`);
  } finally {
    await redis.quit();
  }
}

// Only run when executed directly, never when imported by a test.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  runMerge(process.argv.slice(2))
    .catch((error) => {
      logger.error('[merge-clone-boards] run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
