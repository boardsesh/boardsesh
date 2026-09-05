/**
 * Consolidate duplicate `user_boards` rows that share a serial number and the
 * same climbing configuration into a single canonical board (issue #3407).
 *
 * The LED supplier reuses serials and a run of app bugs let one physical wall
 * accumulate several active boards for the same serial. The sticky per-user
 * serial pointers in `user_board_serials` then scatter across those duplicates,
 * so two climbers on the same wall open different board pages. This merges each
 * same-config cluster into its most-used board and repoints every reference
 * (climb events, sessions, ticks, follows, serial pointers, comments, votes,
 * feed items, notifications) at the survivor. Losers are soft-deleted with
 * `merged_into_board_uuid` set so stale links still resolve to the survivor.
 *
 * Clusters whose boards hold genuinely different configs are reported and left
 * untouched — a human must reconcile two distinct walls that share a serial.
 *
 * When a cluster contains public rows, its survivor is selected from that
 * public subset. Private rows therefore never become public through a merge,
 * and private metadata is never copied onto the public survivor.
 *
 * Default mode is dry-run. Use --apply only after reading the candidate report.
 *
 * Usage:
 *   vp run db:dedupe-serial-boards
 *   vp run db:dedupe-serial-boards --only-serial 751737
 *   vp run db:dedupe-serial-boards --apply --limit 10
 *
 * (A `--` separator before the flags also works — `vp` forwards it verbatim and
 * parseArgs skips it — but it isn't needed.)
 */

import { sql, type SQLWrapper } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';
import {
  boardConfigKey,
  chooseCanonicalBoard,
  chooseMetadataDonor,
  groupSerialClusters,
  isGenericBoardName,
  loserBoards,
  SYSTEM_USER_ID,
  type SerialBoardRow,
  type SerialCluster,
} from '../src/queries/boards/serial-dedupe.js';
import { lockBoardSerialWrite } from '../src/queries/boards/serial-write-lock.js';

const APPLY_FLAG = '--apply';
const LIMIT_FLAG = '--limit';
const ONLY_SERIAL_FLAG = '--only-serial';
const HELP_FLAG = '--help';
const ARG_SEPARATOR = '--';

type ExecuteDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

// Raw discovery-row shape: postgres-js can hand bigint/bigserial columns back as
// strings, so accept the loose form and coerce in `coerceBoardRow`.
type CandidateDatabaseRow = {
  id: number | string;
  uuid: string;
  ownerId: string;
  boardType: string;
  layoutId: number | string;
  sizeId: number | string;
  setIds: string;
  name: string;
  gymId: number | string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  locationName: string | null;
  hideLocation: boolean;
  isUnlisted: boolean;
  isPublic: boolean;
  serialNumber: string;
  climbEventCount: number | string;
  tickCount: number | string;
  followCount: number | string;
};

type ScriptArgs = {
  apply: boolean;
  limit: number | null;
  onlySerial: string | null;
  help: boolean;
};

type MergeCounts = {
  boardsWithMetadataBackfilled: number;
  climbEventsMoved: number;
  sequenceFloorsAdvanced: number;
  betaLinksMoved: number;
  sessionsMoved: number;
  sessionBoardsInserted: number;
  sessionBoardsDeleted: number;
  ticksMoved: number;
  followsInserted: number;
  followsDeleted: number;
  ownerFollowsInserted: number;
  boardActivityInserted: number;
  boardActivityDeleted: number;
  serialPointersRepointed: number;
  commentsMoved: number;
  votesUpserted: number;
  votesDeleted: number;
  feedItemsEntityMoved: number;
  feedItemsBoardUuidMoved: number;
  notificationsMoved: number;
  tombstonesFlattened: number;
  losersSoftDeleted: number;
};

type CountRow = {
  count: number | string | null;
};

function parsePositiveInteger(rawValue: string | undefined, flagName: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    console.error(`[dedupe-serial-boards] ${flagName} requires a positive integer.`);
    process.exit(2);
  }
  return parsedValue;
}

function readRequiredOptionValue(args: string[], optionIndex: number, flagName: string): string {
  const optionValue = args[optionIndex + 1];
  if (!optionValue || optionValue.startsWith('--')) {
    console.error(`[dedupe-serial-boards] ${flagName} requires a value.`);
    process.exit(2);
  }
  return optionValue;
}

export function parseArgs(args: string[]): ScriptArgs {
  const parsedArgs: ScriptArgs = {
    apply: false,
    limit: null,
    onlySerial: null,
    help: false,
  };

  for (let index = 0; index < args.length; index++) {
    const currentArg = args[index];
    if (currentArg === ARG_SEPARATOR) {
      // `vp run db:dedupe-serial-boards -- --apply` forwards the separator
      // verbatim; tolerate it so both `-- --apply` and `--apply` work.
      continue;
    }
    if (currentArg === APPLY_FLAG) {
      parsedArgs.apply = true;
      continue;
    }
    if (currentArg === HELP_FLAG) {
      parsedArgs.help = true;
      continue;
    }
    if (currentArg === LIMIT_FLAG) {
      parsedArgs.limit = parsePositiveInteger(readRequiredOptionValue(args, index, LIMIT_FLAG), LIMIT_FLAG);
      index += 1;
      continue;
    }
    if (currentArg === ONLY_SERIAL_FLAG) {
      parsedArgs.onlySerial = readRequiredOptionValue(args, index, ONLY_SERIAL_FLAG);
      index += 1;
      continue;
    }

    console.error(`[dedupe-serial-boards] Unknown argument: ${currentArg}`);
    process.exit(2);
  }

  return parsedArgs;
}

function printHelp(): void {
  console.info(`Usage:
  vp run db:dedupe-serial-boards
  vp run db:dedupe-serial-boards --only-serial 751737
  vp run db:dedupe-serial-boards --apply --limit 10

Options:
  --apply                Merge clusters. Omit for dry-run.
  --limit <n>            Limit the number of duplicate serial clusters processed.
  --only-serial <serial> Restrict candidates to one serial number.
  --help                 Show this help text.`);
}

function coerceBoardRow(row: CandidateDatabaseRow): SerialBoardRow {
  return {
    id: Number(row.id),
    uuid: row.uuid,
    ownerId: row.ownerId,
    boardType: row.boardType,
    layoutId: Number(row.layoutId),
    sizeId: Number(row.sizeId),
    setIds: row.setIds,
    name: row.name,
    gymId: row.gymId === null ? null : Number(row.gymId),
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    locationName: row.locationName,
    hideLocation: row.hideLocation,
    isUnlisted: row.isUnlisted,
    isPublic: row.isPublic,
    serialNumber: row.serialNumber,
    climbEventCount: Number(row.climbEventCount),
    tickCount: Number(row.tickCount),
    followCount: Number(row.followCount),
  };
}

function sqlNumberList(values: number[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function sqlTextList(values: string[]): SQLWrapper {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

async function executeCount(commandDb: ExecuteDb, query: SQLWrapper): Promise<number> {
  const [row] = await executeRows<CountRow>(commandDb, query);
  return Number(row?.count ?? 0);
}

/**
 * The discovery projection, shared by the dry-run scan and the apply-path
 * re-fetch. `boardsFilter` narrows to a specific set of ids (apply path) or the
 * serial-population filter (dry run). The apply path locks board rows separately
 * before re-fetching, preserving the global row-to-serial lock order.
 */
function boardCandidatesQuery(boardsFilter: SQLWrapper): SQLWrapper {
  return sql`
    SELECT
      b.id AS "id",
      b.uuid AS "uuid",
      b.owner_id AS "ownerId",
      b.board_type AS "boardType",
      b.layout_id AS "layoutId",
      b.size_id AS "sizeId",
      b.set_ids AS "setIds",
      b.name AS "name",
      b.gym_id AS "gymId",
      b.latitude AS "latitude",
      b.longitude AS "longitude",
      b.location_name AS "locationName",
      b.hide_location AS "hideLocation",
      b.is_unlisted AS "isUnlisted",
      b.is_public AS "isPublic",
      b.serial_number AS "serialNumber",
      COALESCE(climb_counts.count, 0)::int AS "climbEventCount",
      COALESCE(tick_counts.count, 0)::int AS "tickCount",
      COALESCE(follow_counts.count, 0)::int AS "followCount"
    FROM user_boards b
    LEFT JOIN (
      SELECT board_id, count(*) AS count
      FROM board_climb_events
      GROUP BY board_id
    ) climb_counts ON climb_counts.board_id = b.id
    LEFT JOIN (
      SELECT board_id, count(*) AS count
      FROM boardsesh_ticks
      WHERE board_id IS NOT NULL
      GROUP BY board_id
    ) tick_counts ON tick_counts.board_id = b.id
    LEFT JOIN (
      SELECT board_uuid, count(*) AS count
      FROM board_follows
      GROUP BY board_uuid
    ) follow_counts ON follow_counts.board_uuid = b.uuid
    WHERE b.deleted_at IS NULL
      AND b.serial_number IS NOT NULL
      AND b.serial_number <> ''
      AND ${boardsFilter}
    ORDER BY b.serial_number, b.id
  `;
}

export async function fetchCandidates(commandDb: ExecuteDb, onlySerial: string | null): Promise<SerialBoardRow[]> {
  const serialClause = onlySerial ? sql`b.serial_number = ${onlySerial}` : sql`TRUE`;
  const boardsFilter = sql`
    ${serialClause}
    AND b.serial_number IN (
      SELECT serial_number
      FROM user_boards
      WHERE deleted_at IS NULL
        AND serial_number IS NOT NULL
        AND serial_number <> ''
      GROUP BY serial_number
      HAVING count(*) > 1
    )
  `;
  const rows = await executeRows<CandidateDatabaseRow>(commandDb, boardCandidatesQuery(boardsFilter));
  return rows.map(coerceBoardRow);
}

async function fetchCandidatesForApply(commandDb: ExecuteDb, boardIds: number[]): Promise<SerialBoardRow[]> {
  const boardIdList = sqlNumberList(boardIds);
  const rows = await executeRows<CandidateDatabaseRow>(commandDb, boardCandidatesQuery(sql`b.id IN (${boardIdList})`));
  return rows.map(coerceBoardRow);
}

type PrelockedBoardRow = {
  id: number | string;
  mergedIntoBoardUuid: string | null;
};

/**
 * Lock the complete user_boards mutation surface for this merge in id order:
 * the discovered active cluster plus every historical predecessor whose merge
 * pointer may be flattened past one of those boards. This must run before the
 * per-serial advisory lock because updateBoard restore takes row→serial too.
 */
async function lockClusterAndFlattenCandidates(commandDb: ExecuteDb, cluster: SerialCluster): Promise<number[]> {
  const clusterBoardIdList = sqlNumberList(boardIdsOf(cluster.boards));
  const clusterBoardUuidList = sqlTextList(cluster.boards.map((board) => board.uuid));
  const lockedRows = await executeRows<PrelockedBoardRow>(
    commandDb,
    sql`
      SELECT id, merged_into_board_uuid AS "mergedIntoBoardUuid"
        FROM user_boards
       WHERE id IN (${clusterBoardIdList})
          OR merged_into_board_uuid IN (${clusterBoardUuidList})
       ORDER BY id
       FOR UPDATE
    `,
  );
  return lockedRows.filter((board) => board.mergedIntoBoardUuid !== null).map((board) => Number(board.id));
}

async function fetchActiveCandidatesForSerial(commandDb: ExecuteDb, serial: string): Promise<SerialBoardRow[]> {
  const rows = await executeRows<CandidateDatabaseRow>(
    commandDb,
    boardCandidatesQuery(sql`b.serial_number = ${serial}`),
  );
  return rows.map(coerceBoardRow);
}

function boardIdsOf(boards: SerialBoardRow[]): number[] {
  return boards.map((board) => board.id).sort((first, second) => first - second);
}

function boardIdsKey(boards: SerialBoardRow[]): string {
  return boardIdsOf(boards).join(',');
}

type ClusterRowsValidation =
  | { ok: true; cluster: SerialCluster; canonical: SerialBoardRow }
  | { ok: false; reason: string };

export type ClusterValidation =
  | { ok: true; cluster: SerialCluster; canonical: SerialBoardRow; flattenBoardIds: number[] }
  | { ok: false; reason: string };

function validateClusterRows(cluster: SerialCluster, rows: SerialBoardRow[]): ClusterRowsValidation {
  const originalKey = boardIdsKey(cluster.boards);
  if (boardIdsKey(rows) !== originalKey) {
    return {
      ok: false,
      reason: `active board set changed since discovery (was [${originalKey}], now [${boardIdsKey(rows)}])`,
    };
  }

  const currentClusters = groupSerialClusters(rows);
  const currentCluster = currentClusters.find((candidate) => candidate.serial === cluster.serial);

  if (!currentCluster || boardIdsKey(currentCluster.boards) !== originalKey) {
    return { ok: false, reason: 'cluster no longer groups to the same board set' };
  }
  if (currentCluster.skipReason) {
    return { ok: false, reason: currentCluster.skipReason };
  }

  const canonical = chooseCanonicalBoard(currentCluster);
  if (!canonical) {
    return { ok: false, reason: 'no canonical board could be chosen' };
  }

  return { ok: true, cluster: currentCluster, canonical };
}

/**
 * Pre-lock the complete user_boards mutation set, then acquire the matching
 * per-serial lock and re-read the active serial membership before mutating.
 * This strict row→serial order matches online row-changing writers and prevents
 * deadlocks. The post-lock read catches a writer that committed while this
 * transaction waited for the serial lock; no new user_boards rows are locked
 * after taking that lock.
 */
export async function refetchClusterForApply(commandDb: ExecuteDb, cluster: SerialCluster): Promise<ClusterValidation> {
  const flattenBoardIds = await lockClusterAndFlattenCandidates(commandDb, cluster);
  const lockedRows = await fetchCandidatesForApply(commandDb, boardIdsOf(cluster.boards));
  const lockedValidation = validateClusterRows(cluster, lockedRows);
  if (!lockedValidation.ok) return lockedValidation;

  await lockBoardSerialWrite(commandDb, cluster.serial);
  const recheckedRows = await fetchActiveCandidatesForSerial(commandDb, cluster.serial);
  const recheckedValidation = validateClusterRows(cluster, recheckedRows);
  if (!recheckedValidation.ok) return recheckedValidation;
  return { ...recheckedValidation, flattenBoardIds };
}

async function setVoteCountMaintenanceSkipped(commandDb: ExecuteDb, skipped: boolean): Promise<void> {
  await commandDb.execute(sql`SELECT set_config('boardsesh.skip_vote_counts', ${skipped ? 'on' : 'off'}, true)`);
}

/**
 * Rebuild `vote_counts` for the given board uuids from the raw `votes` rows.
 * Adapted from `rebuildGymVoteCounts` in dedupe-gym-locations.ts for the
 * 'board' entity type. Loser uuids end up with no votes so their `vote_counts`
 * row is simply deleted (the INSERT re-adds only uuids that still have votes).
 */
async function rebuildBoardVoteCounts(commandDb: ExecuteDb, boardUuids: string[]): Promise<void> {
  const boardUuidList = sqlTextList(boardUuids);
  await commandDb.execute(sql`
    DELETE FROM vote_counts
     WHERE entity_type = 'board'::social_entity_type
       AND entity_id IN (${boardUuidList})
  `);

  await commandDb.execute(sql`
    INSERT INTO vote_counts (entity_type, entity_id, upvotes, downvotes, score, hot_score, created_at)
    SELECT
      vote_totals.entity_type,
      vote_totals.entity_id,
      vote_totals.upvotes,
      vote_totals.downvotes,
      vote_totals.score,
      SIGN(vote_totals.score) * LN(GREATEST(ABS(vote_totals.score), 1))
        + EXTRACT(EPOCH FROM COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())) / 45000.0,
      COALESCE(feed_created_at.created_at, vote_totals.first_vote_created_at, NOW())
    FROM (
      SELECT
        votes.entity_type,
        votes.entity_id,
        SUM(CASE WHEN votes.value = 1 THEN 1 ELSE 0 END)::int AS upvotes,
        SUM(CASE WHEN votes.value = -1 THEN 1 ELSE 0 END)::int AS downvotes,
        SUM(votes.value)::int AS score,
        MIN(votes.created_at) AS first_vote_created_at
      FROM votes
      WHERE votes.entity_type = 'board'::social_entity_type
        AND votes.entity_id IN (${boardUuidList})
      GROUP BY votes.entity_type, votes.entity_id
    ) vote_totals
    LEFT JOIN LATERAL (
      SELECT feed_items.created_at
      FROM feed_items
      WHERE feed_items.entity_type = vote_totals.entity_type
        AND feed_items.entity_id = vote_totals.entity_id
      ORDER BY feed_items.created_at ASC, feed_items.id ASC
      LIMIT 1
    ) feed_created_at ON true
    ON CONFLICT (entity_type, entity_id) DO UPDATE SET
      upvotes = excluded.upvotes,
      downvotes = excluded.downvotes,
      score = excluded.score,
      hot_score = excluded.hot_score,
      created_at = excluded.created_at
  `);
}

export async function mergeSerialCluster(
  commandDb: ExecuteDb,
  cluster: SerialCluster,
  canonicalBoard: SerialBoardRow,
  flattenBoardIds: number[],
): Promise<MergeCounts> {
  const losers = loserBoards(cluster, canonicalBoard);
  const loserIds = losers.map((loser) => loser.id);
  const loserUuids = losers.map((loser) => loser.uuid);
  const loserIdList = sqlNumberList(loserIds);
  const allBoardIdList = sqlNumberList([canonicalBoard.id, ...loserIds]);
  const loserUuidList = sqlTextList(loserUuids);
  const allBoardUuidList = sqlTextList([canonicalBoard.uuid, ...loserUuids]);

  // Public survivors may only backfill from public losers. In an all-private
  // cluster the normal donor ranking applies to every loser.
  const metadataDonor = chooseMetadataDonor(losers, canonicalBoard.isPublic);
  // Privacy flags merge monotonically across the ENTIRE cluster. A public
  // canonical row may still have a private duplicate whose owner hid its
  // location or kept it out of discovery. A merge must never weaken either
  // preference.
  const mergedIsUnlisted = cluster.boards.some((board) => board.isUnlisted);
  const mergedHidesLocation = cluster.boards.some((board) => board.hideLocation);
  // Adopt the donor's name only when the survivor's is a throwaway default and
  // the donor's is a specific (human/gym) name — never clobber a chosen name.
  const shouldAdoptDonorName =
    metadataDonor !== null &&
    isGenericBoardName(canonicalBoard.name, canonicalBoard.boardType) &&
    !isGenericBoardName(metadataDonor.name, canonicalBoard.boardType);
  const survivorName = shouldAdoptDonorName && metadataDonor ? metadataDonor.name : canonicalBoard.name;
  // 1. Metadata backfill on the survivor (never overwrite non-null survivor
  //    fields; adopt the donor's specific name when the survivor's is generic;
  //    preserve the strongest privacy flags from every duplicate).
  const boardsWithMetadataBackfilled = await executeCount(
    commandDb,
    sql`
      WITH updated AS (
        UPDATE user_boards
           SET gym_id = COALESCE(gym_id, ${metadataDonor?.gymId ?? null}),
               latitude = COALESCE(latitude, ${metadataDonor?.latitude ?? null}),
               longitude = COALESCE(longitude, ${metadataDonor?.longitude ?? null}),
               location_name = COALESCE(NULLIF(location_name, ''), ${metadataDonor?.locationName ?? null}),
               hide_location = ${mergedHidesLocation},
               name = ${survivorName},
               is_public = ${canonicalBoard.isPublic},
               is_unlisted = ${mergedIsUnlisted},
               updated_at = NOW()
         WHERE id = ${canonicalBoard.id}
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM updated
    `,
  );

  // 2. board_climb_events — UNIQUE (board_id, seq): move board_id AND seq
  //    together, renumbering losers above both durable history and every
  //    sequence already reserved on a cluster row. The row locks acquired by
  //    refetchClusterForApply serialize this range reservation against the
  //    backend transaction that reserves `presence_seq` and inserts the
  //    matching durable event before releasing the board row.
  const climbEventsMoved = await executeCount(
    commandDb,
    sql`
      WITH survivor_floor AS (
        SELECT GREATEST(
          COALESCE((SELECT max(seq) FROM board_climb_events WHERE board_id = ${canonicalBoard.id}), 0),
          COALESCE((SELECT max(presence_seq) FROM user_boards WHERE id IN (${allBoardIdList})), 0)
        ) AS max_seq
      ),
      renumbered AS (
        SELECT e.id, sf.max_seq + row_number() OVER (ORDER BY e.seq, e.id) AS new_seq
        FROM board_climb_events e
        CROSS JOIN survivor_floor sf
        WHERE e.board_id IN (${loserIdList})
      ),
      moved AS (
        UPDATE board_climb_events e
           SET board_id = ${canonicalBoard.id},
               seq = r.new_seq
          FROM renumbered r
         WHERE e.id = r.id
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );
  const sequenceFloorsAdvanced = await executeCount(
    commandDb,
    sql`
      WITH advanced AS (
        UPDATE user_boards
           SET presence_seq = GREATEST(
                 presence_seq,
                 COALESCE((SELECT max(seq) FROM board_climb_events WHERE board_id = ${canonicalBoard.id}), 0),
                 COALESCE((SELECT max(presence_seq) FROM user_boards WHERE id IN (${allBoardIdList})), 0)
               ),
               updated_at = NOW()
         WHERE id = ${canonicalBoard.id}
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM advanced
    `,
  );

  // 3. board_sessions.board_id — plain repoint (nullable FK, no uniqueness).
  const sessionsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE board_sessions
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 4. session_boards — UNIQUE (session_id, board_id): fold loser rows onto the
  //    survivor. ON CONFLICT DO NOTHING keeps the survivor's existing row (and
  //    its created_at); only sessions with no survivor row get a new one, dated
  //    with the earliest loser created_at. Loser rows are then dropped.
  const sessionBoardsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO session_boards (session_id, board_id, created_at)
        SELECT session_id, ${canonicalBoard.id}, MIN(created_at)
          FROM session_boards
         WHERE board_id IN (${loserIdList})
         GROUP BY session_id
        ON CONFLICT (session_id, board_id) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const sessionBoardsDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM session_boards
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 5. boardsesh_ticks.board_id — plain repoint (nullable FK, no uniqueness).
  const ticksMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE boardsesh_ticks
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 6. board_beta_links.board_id — plain repoint (nullable FK to user_boards(id)
  //    ON DELETE SET NULL, no uniqueness on board_id). Losers are soft-deleted,
  //    not hard-deleted, so that FK never fires; repoint explicitly or the beta
  //    links keep pointing at the merged-away loser.
  const betaLinksMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE board_beta_links
           SET board_id = ${canonicalBoard.id}
         WHERE board_id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 7. board_follows — UNIQUE (user_id, board_uuid): fold loser follows onto the
  //    survivor uuid. ON CONFLICT DO NOTHING keeps the survivor's existing
  //    follow row (and its created_at); only follows with no survivor row are
  //    inserted. Loser rows are then dropped.
  const followsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO board_follows (user_id, board_uuid, created_at)
        SELECT user_id, ${canonicalBoard.uuid}, MIN(created_at)
          FROM board_follows
         WHERE board_uuid IN (${loserUuidList})
         GROUP BY user_id
        ON CONFLICT (user_id, board_uuid) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const followsDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM board_follows
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 8. Each real loser owner should follow the survivor (skip the system
  //    catalog owner and the survivor's own owner). Reads the loser rows before
  //    they are soft-deleted in step 15.
  const ownerFollowsInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO board_follows (user_id, board_uuid, created_at)
        SELECT DISTINCT owner_id, ${canonicalBoard.uuid}, NOW()
          FROM user_boards
         WHERE id IN (${loserIdList})
           AND owner_id <> ${SYSTEM_USER_ID}
           AND owner_id <> ${canonicalBoard.ownerId}
        ON CONFLICT (user_id, board_uuid) DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );

  // 8b. user_board_activity — UNIQUE (user_id, board_uuid): fold each user's
  //    last-used/pin state onto the survivor. Without this a merge silently
  //    unpins the user's pinned board and resets its recency, so it drops to the
  //    bottom of "Your boards" (issue #4884).
  //
  //    MAX(last_used_at) keeps the most recent open across the merged rows.
  //    MIN(pinned_at) keeps the earliest pin, which both preserves pin order and
  //    means "pinned on either row" survives as pinned. ON CONFLICT merges into
  //    the survivor's own row with the same two rules rather than DO NOTHING —
  //    a survivor row that exists but is unpinned must still inherit the
  //    loser's pin.
  const boardActivityInserted = await executeCount(
    commandDb,
    sql`
      WITH inserted AS (
        INSERT INTO user_board_activity (user_id, board_uuid, last_used_at, pinned_at, created_at, updated_at)
        SELECT user_id, ${canonicalBoard.uuid}, MAX(last_used_at), MIN(pinned_at), MIN(created_at), NOW()
          FROM user_board_activity
         WHERE board_uuid IN (${loserUuidList})
         GROUP BY user_id
        ON CONFLICT (user_id, board_uuid) DO UPDATE SET
          last_used_at = GREATEST(user_board_activity.last_used_at, excluded.last_used_at),
          pinned_at = LEAST(user_board_activity.pinned_at, excluded.pinned_at),
          updated_at = NOW()
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM inserted
    `,
  );
  const boardActivityDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM user_board_activity
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );

  // 9. user_board_serials.board_uuid — the actual #3407 fix: converge the sticky
  //    per-user serial pointers onto the survivor. Unique is (user_id,
  //    serial_number), so repointing board_uuid never conflicts.
  const serialPointersRepointed = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE user_board_serials
           SET board_uuid = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 10. comments.entity_id — plain repoint (no per-entity uniqueness).
  const commentsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE comments
           SET entity_id = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 11. votes — UNIQUE (user_id, entity_type, entity_id): latest-wins upsert of
  //     every vote across survivor+losers onto the survivor uuid, then drop the
  //     loser-uuid rows. Vote-count trigger maintenance is suppressed and the
  //     counts are rebuilt in bulk below.
  await setVoteCountMaintenanceSkipped(commandDb, true);
  const votesUpserted = await executeCount(
    commandDb,
    sql`
      WITH latest_votes AS (
        SELECT DISTINCT ON (user_id)
               user_id,
               value,
               created_at
          FROM votes
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${allBoardUuidList})
         ORDER BY user_id, created_at DESC, id DESC
      ),
      upserted AS (
        INSERT INTO votes (user_id, entity_type, entity_id, value, created_at)
        SELECT user_id,
               'board'::social_entity_type,
               ${canonicalBoard.uuid},
               value,
               created_at
          FROM latest_votes
        ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
          SET value = excluded.value,
              created_at = excluded.created_at
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM upserted
    `,
  );
  const votesDeleted = await executeCount(
    commandDb,
    sql`
      WITH deleted AS (
        DELETE FROM votes
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `,
  );
  // 12. Rebuild vote_counts for the survivor (and clear the losers').
  await rebuildBoardVoteCounts(commandDb, [canonicalBoard.uuid, ...loserUuids]);
  await setVoteCountMaintenanceSkipped(commandDb, false);

  // 13. feed_items — both the entity pointer and the denormalised board_uuid.
  const feedItemsEntityMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET entity_id = ${canonicalBoard.uuid}
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );
  const feedItemsBoardUuidMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE feed_items
           SET board_uuid = ${canonicalBoard.uuid}
         WHERE board_uuid IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 14. notifications.entity_id — plain repoint.
  const notificationsMoved = await executeCount(
    commandDb,
    sql`
      WITH moved AS (
        UPDATE notifications
           SET entity_id = ${canonicalBoard.uuid}
         WHERE entity_type = 'board'::social_entity_type
           AND entity_id IN (${loserUuidList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM moved
    `,
  );

  // 15. Flatten any existing tombstone chains: boards merged into one of this
  //     cluster's losers by an EARLIER run now point one hop past their target.
  //     Repointing them straight at the new canonical keeps every chain at
  //     depth 1, so the backend's bounded (≤3 hop) chain walk can never hit
  //     its cap no matter how many times boards re-merge.
  let tombstonesFlattened = 0;
  if (flattenBoardIds.length > 0) {
    const flattenBoardIdList = sqlNumberList(flattenBoardIds);
    tombstonesFlattened = await executeCount(
      commandDb,
      sql`
        WITH flattened AS (
          UPDATE user_boards
             SET merged_into_board_uuid = ${canonicalBoard.uuid},
                 updated_at = NOW()
           WHERE id IN (${flattenBoardIdList})
             AND merged_into_board_uuid IN (${loserUuidList})
           RETURNING 1
        )
        SELECT count(*)::int AS count FROM flattened
      `,
    );
  }

  // 16. Soft-delete the losers with the merge tombstone. Serial number is KEPT
  //     (partial indexes exclude deleted rows; retained for forensics + so
  //     stale links can still resolve through merged_into_board_uuid).
  const losersSoftDeleted = await executeCount(
    commandDb,
    sql`
      WITH soft_deleted AS (
        UPDATE user_boards
           SET deleted_at = NOW(),
               is_public = false,
               merged_into_board_uuid = ${canonicalBoard.uuid},
               updated_at = NOW()
         WHERE id IN (${loserIdList})
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM soft_deleted
    `,
  );

  return {
    boardsWithMetadataBackfilled,
    climbEventsMoved,
    sequenceFloorsAdvanced,
    betaLinksMoved,
    sessionsMoved,
    sessionBoardsInserted,
    sessionBoardsDeleted,
    ticksMoved,
    followsInserted,
    followsDeleted,
    ownerFollowsInserted,
    boardActivityInserted,
    boardActivityDeleted,
    serialPointersRepointed,
    commentsMoved,
    votesUpserted,
    votesDeleted,
    feedItemsEntityMoved,
    feedItemsBoardUuidMoved,
    notificationsMoved,
    tombstonesFlattened,
    losersSoftDeleted,
  };
}

function emptyMergeCounts(): MergeCounts {
  return {
    boardsWithMetadataBackfilled: 0,
    climbEventsMoved: 0,
    sequenceFloorsAdvanced: 0,
    betaLinksMoved: 0,
    sessionsMoved: 0,
    sessionBoardsInserted: 0,
    sessionBoardsDeleted: 0,
    ticksMoved: 0,
    followsInserted: 0,
    followsDeleted: 0,
    ownerFollowsInserted: 0,
    boardActivityInserted: 0,
    boardActivityDeleted: 0,
    serialPointersRepointed: 0,
    commentsMoved: 0,
    votesUpserted: 0,
    votesDeleted: 0,
    feedItemsEntityMoved: 0,
    feedItemsBoardUuidMoved: 0,
    notificationsMoved: 0,
    tombstonesFlattened: 0,
    losersSoftDeleted: 0,
  };
}

function addMergeCounts(firstCounts: MergeCounts, secondCounts: MergeCounts): MergeCounts {
  return {
    boardsWithMetadataBackfilled: firstCounts.boardsWithMetadataBackfilled + secondCounts.boardsWithMetadataBackfilled,
    climbEventsMoved: firstCounts.climbEventsMoved + secondCounts.climbEventsMoved,
    sequenceFloorsAdvanced: firstCounts.sequenceFloorsAdvanced + secondCounts.sequenceFloorsAdvanced,
    betaLinksMoved: firstCounts.betaLinksMoved + secondCounts.betaLinksMoved,
    sessionsMoved: firstCounts.sessionsMoved + secondCounts.sessionsMoved,
    sessionBoardsInserted: firstCounts.sessionBoardsInserted + secondCounts.sessionBoardsInserted,
    sessionBoardsDeleted: firstCounts.sessionBoardsDeleted + secondCounts.sessionBoardsDeleted,
    ticksMoved: firstCounts.ticksMoved + secondCounts.ticksMoved,
    followsInserted: firstCounts.followsInserted + secondCounts.followsInserted,
    followsDeleted: firstCounts.followsDeleted + secondCounts.followsDeleted,
    ownerFollowsInserted: firstCounts.ownerFollowsInserted + secondCounts.ownerFollowsInserted,
    boardActivityInserted: firstCounts.boardActivityInserted + secondCounts.boardActivityInserted,
    boardActivityDeleted: firstCounts.boardActivityDeleted + secondCounts.boardActivityDeleted,
    serialPointersRepointed: firstCounts.serialPointersRepointed + secondCounts.serialPointersRepointed,
    commentsMoved: firstCounts.commentsMoved + secondCounts.commentsMoved,
    votesUpserted: firstCounts.votesUpserted + secondCounts.votesUpserted,
    votesDeleted: firstCounts.votesDeleted + secondCounts.votesDeleted,
    feedItemsEntityMoved: firstCounts.feedItemsEntityMoved + secondCounts.feedItemsEntityMoved,
    feedItemsBoardUuidMoved: firstCounts.feedItemsBoardUuidMoved + secondCounts.feedItemsBoardUuidMoved,
    notificationsMoved: firstCounts.notificationsMoved + secondCounts.notificationsMoved,
    tombstonesFlattened: firstCounts.tombstonesFlattened + secondCounts.tombstonesFlattened,
    losersSoftDeleted: firstCounts.losersSoftDeleted + secondCounts.losersSoftDeleted,
  };
}

function formatBoardLabel(board: SerialBoardRow): string {
  return `${board.name} (#${board.id}, ${board.uuid}, owner ${board.ownerId})`;
}

function printClusterReport(cluster: SerialCluster): void {
  console.info('');
  if (cluster.skipReason) {
    console.info(`[dedupe-serial-boards] serial ${cluster.serial} — SKIPPED (${cluster.skipReason})`);
    for (const board of cluster.boards) {
      console.info(`  board: ${formatBoardLabel(board)} config=${boardConfigKey(board)}`);
    }
    return;
  }

  const canonicalBoard = chooseCanonicalBoard(cluster);
  if (!canonicalBoard) {
    console.info(`[dedupe-serial-boards] serial ${cluster.serial} — SKIPPED (no canonical board)`);
    return;
  }

  console.info(`[dedupe-serial-boards] serial ${cluster.serial} — config ${cluster.configKey}`);
  console.info(`  canonical: ${formatBoardLabel(canonicalBoard)}`);
  console.info(
    `    climbEvents=${canonicalBoard.climbEventCount}, ticks=${canonicalBoard.tickCount}, follows=${canonicalBoard.followCount}`,
  );
  for (const loser of loserBoards(cluster, canonicalBoard)) {
    console.info(`  loser: ${formatBoardLabel(loser)}`);
    console.info(`    climbEvents=${loser.climbEventCount}, ticks=${loser.tickCount}, follows=${loser.followCount}`);
  }
}

function printCandidateReport(clusters: SerialCluster[], apply: boolean): void {
  const mergeableClusters = clusters.filter((cluster) => !cluster.skipReason);
  const skippedClusters = clusters.filter((cluster) => cluster.skipReason);
  const loserRowCount = mergeableClusters.reduce((total, cluster) => total + cluster.boards.length - 1, 0);

  console.info(
    `[dedupe-serial-boards] Found ${clusters.length} duplicate serial cluster(s): ` +
      `${mergeableClusters.length} mergeable (${loserRowCount} loser row(s)), ${skippedClusters.length} skipped.`,
  );

  for (const cluster of clusters) {
    printClusterReport(cluster);
  }

  if (!apply) {
    console.info('');
    console.info('[dedupe-serial-boards] Dry-run only. Re-run with --apply to merge these clusters.');
  }
}

function printMergeCounts(totalCounts: MergeCounts, mergedClusters: number, skippedAtApply: number): void {
  console.info('');
  console.info(
    `[dedupe-serial-boards] Merge complete: ${mergedClusters} cluster(s) merged, ${skippedAtApply} skipped at apply.`,
  );
  console.info(`  survivors with metadata backfilled: ${totalCounts.boardsWithMetadataBackfilled}`);
  console.info(`  climb events moved: ${totalCounts.climbEventsMoved}`);
  console.info(`  sequence floors advanced: ${totalCounts.sequenceFloorsAdvanced}`);
  console.info(`  beta links moved: ${totalCounts.betaLinksMoved}`);
  console.info(`  sessions moved: ${totalCounts.sessionsMoved}`);
  console.info(
    `  session_boards inserted/deleted: ${totalCounts.sessionBoardsInserted}/${totalCounts.sessionBoardsDeleted}`,
  );
  console.info(`  ticks moved: ${totalCounts.ticksMoved}`);
  console.info(`  follows inserted/deleted: ${totalCounts.followsInserted}/${totalCounts.followsDeleted}`);
  console.info(`  owner follows inserted: ${totalCounts.ownerFollowsInserted}`);
  console.info(
    `  board activity folded/deleted: ${totalCounts.boardActivityInserted}/${totalCounts.boardActivityDeleted}`,
  );
  console.info(`  serial pointers repointed: ${totalCounts.serialPointersRepointed}`);
  console.info(`  comments moved: ${totalCounts.commentsMoved}`);
  console.info(`  votes upserted/deleted: ${totalCounts.votesUpserted}/${totalCounts.votesDeleted}`);
  console.info(
    `  feed items moved (entity/board_uuid): ${totalCounts.feedItemsEntityMoved}/${totalCounts.feedItemsBoardUuidMoved}`,
  );
  console.info(`  notifications moved: ${totalCounts.notificationsMoved}`);
  console.info(`  tombstone chains flattened: ${totalCounts.tombstonesFlattened}`);
  console.info(`  losers soft-deleted: ${totalCounts.losersSoftDeleted}`);
}

async function main(): Promise<void> {
  const scriptArgs = parseArgs(process.argv.slice(2));
  if (scriptArgs.help) {
    printHelp();
    return;
  }

  const { db, close } = createScriptDb();

  try {
    const candidates = await fetchCandidates(db, scriptArgs.onlySerial);
    const allClusters = groupSerialClusters(candidates);
    const selectedClusters = scriptArgs.limit ? allClusters.slice(0, scriptArgs.limit) : allClusters;

    printCandidateReport(selectedClusters, scriptArgs.apply);

    const mergeableClusters = selectedClusters.filter((cluster) => !cluster.skipReason);
    if (!scriptArgs.apply || mergeableClusters.length === 0) {
      return;
    }

    // One transaction PER CLUSTER, not one for the whole run: each cluster's
    // merge holds row locks on its boards' events/follows/etc., and holding
    // them across all ~67 prod clusters would block concurrent writes (live
    // sessions, ticks) for the full run. Per-cluster commits also preserve
    // partial progress — a failure mid-run keeps the clusters already merged
    // (the run is re-entrant: merged losers drop out of discovery). The
    // advisory xact lock still serialises concurrent script runs; it releases
    // with each commit and is re-taken for the next cluster. READ COMMITTED is
    // explicit because a follower may commit while this transaction waits for
    // the cluster rows; the later follow migration must see that committed row.
    let totalCounts = emptyMergeCounts();
    let mergedClusters = 0;
    let skippedAtApply = 0;
    for (const cluster of mergeableClusters) {
      const clusterResult = await db.transaction(
        async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boardsesh:serial-board-dedupe'))`);
          const validation = await refetchClusterForApply(transaction, cluster);
          if (!validation.ok) {
            return { skippedReason: validation.reason, counts: null };
          }
          const counts = await mergeSerialCluster(
            transaction,
            validation.cluster,
            validation.canonical,
            validation.flattenBoardIds,
          );
          return { skippedReason: null, counts };
        },
        { isolationLevel: 'read committed' },
      );

      if (clusterResult.counts) {
        totalCounts = addMergeCounts(totalCounts, clusterResult.counts);
        mergedClusters += 1;
      } else {
        console.warn(
          `[dedupe-serial-boards] serial ${cluster.serial} skipped at apply: ${clusterResult.skippedReason}`,
        );
        skippedAtApply += 1;
      }
    }

    printMergeCounts(totalCounts, mergedClusters, skippedAtApply);
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('[dedupe-serial-boards] failed:', error);
    process.exit(1);
  });
}
