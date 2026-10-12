import {
  publicReferenceClimbSql,
  REFERENCE_EXCLUDED_BOARD_TYPES,
  referenceFirstAscentSql,
  sprayClimbVisibilityCondition,
} from '@boardsesh/db/queries';
import { sql, type SQL } from 'drizzle-orm';
import type {
  ConnectionContext,
  SyncAudience,
  SyncResult,
  SyncDeletionsResult,
  SyncCursorInput,
} from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { db } from '../../../db/client';
import { rowsFromResult } from '@boardsesh/db/client';
import { withSerialPlan, aliveHolds, type SerialPlanDb } from '@boardsesh/db/queries';
import { isS3Configured, presignGetObject } from '../../../storage/s3';
import { logger } from '../../../utils/logger';
import { requireAuthenticated } from '../shared/helpers';
import { isSprayBoardType, sprayLayoutIsReadable } from '../climbs/spray-read-access';
import { normalizeRow, toIso, type RawRow } from './row-normalize';
import { syncClimbDocuments } from './saved-climb';
import { resolveSyncStabilityWindowSeconds } from './stability-window';
import {
  validateInput,
  SyncCursorInputSchema,
  SyncLimitSchema,
  SyncBoardScopeIdSchema,
  SyncAudienceSchema,
  BoardNameSchema,
} from '../../../validation/schemas';

/**
 * Offline sync pull resolvers (Phase 2). See docs/sync-table-manifest.md — the
 * contract that binds these resolvers, the mobile SQLite DDL, and the mobile
 * table-config together.
 *
 * Each resolver emits opaque snake_case JSON documents (keys = mobile local
 * columns) using a composite cursor `(updated_at, <seq>) > ($ts, $seq)` so the
 * Aurora bulk-update timestamp-collision bug can never skip rows. `<seq>` is the
 * bigserial `id` for user tables and the new `sync_seq` for board tables.
 *
 * These are the one place in the backend where raw `sql` row-value comparison is
 * justified — Drizzle's query builder can't express `(a, b) > (c, d)` tuple
 * comparison. (The lint ban on importing `sql` is web-only.)
 */

// Start of time for the first pull, when the client sends no cursor. Must be a
// value SyncCursorInputSchema accepts, because an empty first page echoes it
// back as the next cursor and clients replay stored cursors verbatim ('epoch'
// casts fine in Postgres but would be rejected by our own validator).
const EPOCH_TS = '1970-01-01T00:00:00.000Z';
const EPOCH_SEQ = '0';

// Rows younger than this are left for the NEXT pull. `updated_at` is stamped at
// transaction start (or earlier — saveTick computes it before a network-bound
// beta-link enrich; a bulk JSON logbook import stamps thousands of rows at a
// transaction start that commits tens of seconds later), so a row can become
// visible with a timestamp that is already behind another device's cursor and
// be skipped forever. Excluding rows younger than the longest realistic write
// transaction bounds that race: a skip is unrecoverable, a re-pull is a free
// upsert. Tests set SYNC_STABILITY_WINDOW_SECONDS=0 to pull their own writes.
// Deployed document windows retain a minimum delay of two seconds. A membership
// withdrawal is stamped one second before the climb's new row
// (0270_climb_reference_membership),
// which covers every copy a device pulled only while this window stays above
// one second.
// Invalid values use the default; only exact-zero test fixtures bypass it.
const STABILITY_WINDOW_SECONDS = resolveSyncStabilityWindowSeconds(
  process.env.SYNC_STABILITY_WINDOW_SECONDS,
  process.env.NODE_ENV,
);

/**
 * Resolve the incoming cursor into the two bound comparison values. Null/absent
 * components fall back to the epoch boundary so the first pull starts from the
 * beginning.
 */
function cursorBounds(cursor: SyncCursorInput | null | undefined): { ts: string; seq: string } {
  return {
    ts: cursor?.updatedAt ?? EPOCH_TS,
    seq: cursor?.syncSeq ?? EPOCH_SEQ,
  };
}

/**
 * Run a composite-cursor page query and shape it into a SyncResult.
 *
 * Both `updatedAtColumn` and `seqColumn` are caller-controlled SQL fragments
 * (never user input). They are emitted in the cursor predicate AND the ORDER BY,
 * so joins that expose more than one `updated_at` (e.g. syncPlaylistClimbs) must
 * pass fully-qualified column references to avoid an ambiguous-column error.
 */
async function runSyncPage(params: {
  executor?: SerialPlanDb;
  selectList: SQL;
  fromClause: SQL;
  scope: SQL;
  updatedAtColumn: SQL;
  seqColumn: SQL;
  cursor: SyncCursorInput | null | undefined;
  limit: number;
}): Promise<SyncResult> {
  const { executor = db, selectList, fromClause, scope, updatedAtColumn, seqColumn, cursor, limit } = params;
  const { ts, seq } = cursorBounds(cursor);

  const result = await executor.execute(sql`
    SELECT ${selectList}, ${updatedAtColumn} AS __updated_at, ${seqColumn} AS __seq
    FROM ${fromClause}
    WHERE ${scope}
      AND (${updatedAtColumn}, ${seqColumn}) > (${ts}::timestamp, ${seq}::bigint)
      AND ${updatedAtColumn} < now() - make_interval(secs => ${STABILITY_WINDOW_SECONDS})
    ORDER BY ${updatedAtColumn} ASC, ${seqColumn} ASC
    LIMIT ${limit}
  `);

  const rows = rowsFromResult<RawRow>(result);

  const documents = rows.map((row) => {
    const normalized = normalizeRow(row);
    // __updated_at and __seq are cursor scaffolding, never part of the document
    // the client stores. (The real updated_at is still in the document via the
    // selectList.)
    delete normalized.__updated_at;
    delete normalized.__seq;
    return normalized;
  });

  const lastRow = rows[rows.length - 1];
  const nextCursor = lastRow
    ? { updatedAt: toIso(lastRow.__updated_at), syncSeq: String(lastRow.__seq) }
    : { updatedAt: ts, syncSeq: seq };

  return {
    documents,
    cursor: nextCursor,
    hasMore: rows.length === limit,
  };
}

/**
 * An empty page that still advances nothing — what a sync resolver returns when the
 * caller may not read the scope it asked for.
 *
 * Deliberately a normal empty page rather than an error: the offline engine drains
 * these in a loop and an error would retry forever, and a distinguishable response
 * would tell a caller which layout ids are private spray walls.
 */
function emptySyncPage(cursor: SyncCursorInput | null | undefined): SyncResult {
  const { ts, seq } = cursorBounds(cursor);
  return { documents: [], cursor: { updatedAt: ts, syncSeq: seq }, hasMore: false };
}

/**
 * Shared guard + validation for every user-scoped sync resolver. Returns the
 * authenticated userId and the validated limit.
 */
function prepareUserSync(
  ctx: ConnectionContext,
  cursor: SyncCursorInput | null | undefined,
  limit: number,
): { userId: string; limit: number } {
  requireAuthenticated(ctx);
  validateInput(SyncCursorInputSchema, cursor, 'cursor');
  const validatedLimit = validateInput(SyncLimitSchema, limit, 'limit');
  return { userId: ctx.userId!, limit: validatedLimit };
}

/**
 * Board-data sync resolvers don't carry a user scope but still require auth and
 * the same cursor/limit validation. Also validates the optional layout/size scope
 * ids (positive ints, or null for "whole board type").
 */
function prepareBoardSync(
  ctx: ConnectionContext,
  cursor: SyncCursorInput | null | undefined,
  limit: number,
  boardType: string,
  layoutId?: number | null,
  sizeId?: number | null,
): { limit: number; boardType: string; layoutId: number | null; sizeId: number | null; viewerUserId: string } {
  requireAuthenticated(ctx);
  validateInput(SyncCursorInputSchema, cursor, 'cursor');
  // Allowlist the board type like the tick/favorite resolvers do — a junk value
  // is only a harmless empty scan (parameterized bind), but rejecting it makes
  // client bugs visible instead of silently syncing nothing.
  const validatedBoardType = validateInput(BoardNameSchema, boardType, 'boardType');
  const validatedLimit = validateInput(SyncLimitSchema, limit, 'limit');
  const validatedLayoutId = validateInput(SyncBoardScopeIdSchema, layoutId, 'layoutId') ?? null;
  const validatedSizeId = validateInput(SyncBoardScopeIdSchema, sizeId, 'sizeId') ?? null;
  return {
    limit: validatedLimit,
    boardType: validatedBoardType,
    layoutId: validatedLayoutId,
    sizeId: validatedSizeId,
    viewerUserId: ctx.userId!,
  };
}

/**
 * The validated `audience` of a per-board pull, or null for the single-stream
 * pull every client older than the split sends. Called after `prepareBoardSync`
 * so an unauthenticated request is still refused before anything is validated.
 */
function validateSyncAudience(audience: SyncAudience | null | undefined): SyncAudience | null {
  return validateInput(SyncAudienceSchema, audience, 'audience') ?? null;
}

/**
 * The optional layout/size scope conditions on board_climbs, `prefix`-qualified so
 * they work both directly (empty prefix) and inside the syncClimbStats EXISTS
 * subquery (`bc.`). sizeId is ignored for moonboard via the shared
 * `isSizeScopedBoard` predicate (single source of truth for that guard).
 */
function boardClimbsLayoutSizeConditions(
  boardType: string,
  layoutId: number | null,
  sizeId: number | null,
  prefix: SQL = sql``,
): SQL[] {
  const conditions: SQL[] = [];
  if (layoutId !== null) {
    conditions.push(sql`${prefix}layout_id = ${layoutId}`);
  }
  if (sizeId !== null && isSizeScopedBoard(boardType)) {
    conditions.push(sql`${prefix}compatible_size_ids @> ARRAY[${sizeId}]::int[]`);
  }
  return conditions;
}

/**
 * Build the board_climbs scope for a per-board pull. Optional layout/size narrow
 * it to a single (layout, size) — all sets — matching the search-side filter.
 */
function boardClimbsScope(boardType: string, layoutId: number | null, sizeId: number | null): SQL {
  return sql.join(
    [sql`board_type = ${boardType}`, ...boardClimbsLayoutSizeConditions(boardType, layoutId, sizeId)],
    sql` AND `,
  );
}

/**
 * Which of a board's climbs one per-board pull reads (#6306).
 *
 * The publication rule decides all three. A climb that is published and listed
 * is public: every caller gets it, whoever set it and whatever that account's
 * privacy settings are. A draft or an unlisted climb goes to its owner alone,
 * and one with no owner goes to no one.
 *
 *  - `reference`: the published, listed climbs. The same rows for every caller,
 *    and exactly the rows a snapshot artifact carries, so a phone that imported
 *    an artifact resumes this stream from the artifact's watermark.
 *  - `protected`: the caller's own climbs that are not reference climbs, which
 *    is their own drafts and their own unlisted climbs. A handful of rows.
 *  - `union`: both in one stream. What a request with no `audience` gets, and
 *    so what every client older than the split pulls.
 *
 * `reference` and `protected` are disjoint and together equal `union` by
 * construction: with R the reference test and O "the caller owns it",
 * `protected` is `O AND NOT R` and `union` is `R OR O`. R is never NULL (see
 * `publicReferenceClimbSql`), and a NULL O (a row with no owner) is not selected
 * by either side.
 *
 * No stream looks at an account's privacy settings, an item audience or a
 * follow. A privacy change therefore moves no climb between streams.
 */
type ClimbAccess = { stream: 'reference' } | { stream: 'union' | 'protected'; viewerUserId: string };

/**
 * The stream a request reads, or null when it has no rows whatever the caller is.
 *
 * A board type with no reference set (spray) has an empty `REFERENCE`, so its
 * `PROTECTED` has to be the whole union for the two to still add up to it. Both
 * answers hang off the one set the snapshot exports use, so adding a board type
 * there moves all three readers together.
 */
function climbStreamFor(audience: SyncAudience | null, boardType: string): ClimbAccess['stream'] | null {
  if (audience === null) return 'union';
  const hasReferenceSet = !REFERENCE_EXCLUDED_BOARD_TYPES.has(boardType);
  if (audience === 'REFERENCE') return hasReferenceSet ? 'reference' : null;
  return hasReferenceSet ? 'protected' : 'union';
}

/**
 * Which climbs a caller is entitled to beyond the public ones: today, the
 * climbs they own. NULL for a climb nobody owns, which no stream then selects.
 *
 * The one place that says so. `protected` and `union` both ask here, so a
 * further entitlement is one more `OR` arm in this function and no caller
 * changes. Keep the owner as the leading arm: it is what finds a caller's few
 * rows among a board's hundreds of thousands (`board_climbs_user_export_idx` is
 * keyed on `user_id, board_type`), and the `protected` pages are written to
 * start from it.
 */
function viewerEntitlementCondition(alias: 'board_climbs' | 'bc', viewerUserId: string): SQL {
  return sql`${sql.raw(`${alias}.user_id`)} = ${viewerUserId}`;
}

/**
 * The condition that selects one stream's climbs, on the `board_climbs` row
 * named by `alias`. `reference` carries no viewer: the snapshot exports run the
 * same text with no caller at all.
 */
function climbAccessCondition(access: ClimbAccess, alias: 'board_climbs' | 'bc'): SQL {
  const reference = sql.raw(publicReferenceClimbSql(alias));
  if (access.stream === 'reference') return reference;
  const entitled = viewerEntitlementCondition(alias, access.viewerUserId);
  if (access.stream === 'union') return sql`(${reference} OR ${entitled})`;
  return sql`(${entitled} AND NOT ${reference})`;
}

/** The union a supported board's sync can deliver, including the spray wall gate. */
function currentlyReadableSyncClimbCondition(viewerUserId: string): SQL {
  return sql`(
    bc.board_type IN (${sql.join(
      SUPPORTED_BOARDS.map((boardType) => sql`${boardType}`),
      sql`, `,
    )})
    AND ${climbAccessCondition({ stream: 'union', viewerUserId }, 'bc')}
    AND ${sprayClimbVisibilityCondition({ boardType: sql`bc.board_type`, layoutId: sql`bc.layout_id` }, viewerUserId)}
  )`;
}

/**
 * Run one page of a per-board reference table that has no layout_id of its own
 * (board_climb_stats, board_climb_grades) — building the scope AND running the
 * page under the serial-plan guard, together, in one call.
 *
 * Both belong to the same function on purpose. Such a pull walks the reference
 * table in cursor order and probes 375k-row board_climbs through the EXISTS
 * filter; production chooses a Gather Merge for that shape, which has exhausted
 * Postgres's DSM during sync bursts (Sentry BOARDSESH-AK, pgCode 53100). The
 * guard's load-bearing part is `executor: transactionDb` — `runSyncPage`
 * silently defaults to the bare pool, so a caller that builds the scope itself
 * and forgets the executor gets no guard and no error. That is exactly how
 * syncClimbGrades shipped unguarded (#4528) after the scope was copy-pasted from
 * syncClimbStats (#4468). Keeping them in one helper makes the omission
 * unrepresentable; `SET LOCAL` and the page SELECT stay on the same transaction
 * handle.
 *
 * The guard is unconditional, including for the unscoped `board_type`-only pull:
 * a full-table walk of either reference table can pick a parallel plan too, and
 * a serial plan can only change latency, never results.
 *
 * ## The `protected` stream is driven from the caller's own climbs
 *
 * The walk stops early only when matching rows are dense, and the protected
 * rows are the opposite: a caller's own drafts and unlisted climbs, a handful
 * among a board's hundreds of thousands of stats rows. Walked in cursor order,
 * a page would pass the whole board to return them, and it would do so on every
 * pull, because an empty page echoes its cursor and this stream's cursor
 * therefore does not follow the table.
 *
 * So the page starts from the climbs instead: collect the caller's own
 * non-reference climbs (an index lookup on the owner), probe the reference
 * table by its `(board_type, climb_uuid, angle)` primary key once per climb,
 * then sort and limit. The planner is not asked to find that order: `ORDER BY …
 * LIMIT` makes an ordered index look cheap whenever it overestimates how dense
 * the matches are. Both subqueries below end in `OFFSET 0`, which Postgres will
 * not flatten: the first is planned on its own, and the second is LATERAL to the
 * first, so the only legal join is a nested loop with the climbs outside.
 *
 * On a spray wall `PROTECTED` is the whole union (see `climbStreamFor`), which
 * is dense on that wall, and takes the walk like the other streams.
 */
async function runScopedBoardRefSyncPage(params: {
  table: SQL;
  climbUuidColumn: SQL;
  climbs: ClimbAccess;
  selectList: SQL;
  updatedAtColumn: SQL;
  seqColumn: SQL;
  boardType: string;
  layoutId: number | null;
  sizeId: number | null;
  cursor: SyncCursorInput | null | undefined;
  limit: number;
}): Promise<SyncResult> {
  const { table, climbUuidColumn, climbs, selectList, updatedAtColumn, seqColumn } = params;
  const { boardType, layoutId, sizeId, cursor, limit } = params;

  // The reference row has no layout_id, so it is scoped to the climbs of that
  // (layout, size) through board_climbs, reusing the same shared conditions
  // syncClimbs uses (bc.-qualified here).
  const climbScope = sql.join(
    [
      sql`bc.board_type = ${boardType}`,
      ...boardClimbsLayoutSizeConditions(boardType, layoutId, sizeId, sql`bc.`),
      climbAccessCondition(climbs, 'bc'),
    ],
    sql` AND `,
  );

  return withSerialPlan(db, async (transactionDb) => {
    if (climbs.stream === 'protected') {
      return runSyncPage({
        executor: transactionDb,
        selectList,
        // The lateral subquery takes the table's own name, so the select list
        // and cursor columns written for the walk resolve here unchanged.
        fromClause: sql`(SELECT bc.uuid FROM board_climbs bc WHERE ${climbScope} OFFSET 0) own_climbs
          CROSS JOIN LATERAL (
            SELECT own_ref.* FROM ${table} own_ref
            WHERE own_ref.board_type = ${boardType} AND own_ref.climb_uuid = own_climbs.uuid
            OFFSET 0
          ) ${table}`,
        // Nothing left to scope: which climbs, and so which rows, was decided
        // inside the first subquery. `runSyncPage` still adds the cursor and
        // stability-window conditions on the outer query. A condition on the
        // climbs belongs in `climbScope`, which both shapes read.
        scope: sql`TRUE`,
        updatedAtColumn,
        seqColumn,
        cursor,
        limit,
      });
    }

    return runSyncPage({
      executor: transactionDb,
      selectList,
      fromClause: table,
      scope: sql`board_type = ${boardType} AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = ${climbUuidColumn} AND ${climbScope})`,
      updatedAtColumn,
      seqColumn,
      cursor,
      limit,
    });
  });
}

// One column list for every stream of `syncClimbs`: the document is the same
// whichever stream delivers the row.
const BOARD_CLIMBS_SELECT_LIST = sql`uuid, board_type, layout_id, setter_id, setter_username, name, description,
        hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames,
        is_draft, is_listed, is_hidden, created_at, published_at, user_id, required_set_ids, compatible_size_ids,
        characteristics, hold_fingerprint, missing_hold_count, retired_by_reset, revision_number, holds_revision_number,
        updated_at, sync_seq`;

/**
 * The `board_climb_stats` column list. Only the first-ascent pair is not the
 * stored column:
 *
 *  - `REFERENCE` and the pull with no audience ship the stored credit of a
 *    manufacturer climb and NULL for a climb that has, or had, a Boardsesh
 *    author (`referenceFirstAscentSql`). The same rule the snapshot artifact
 *    applies, so an artifact and a `REFERENCE` pull agree column for column,
 *    and no page depends on who is asking;
 *  - `PROTECTED` ships neither field, on every board type. Its rows are the
 *    caller's own climbs, where that rule answers NULL anyway; on a spray wall,
 *    where the stream is the whole union, saying so outright keeps one answer.
 *
 * No offline reader selects either column.
 */
const REFERENCE_FIRST_ASCENT_COLUMNS = sql.raw(
  `${referenceFirstAscentSql('board_climb_stats', 'fa_username')}, ${referenceFirstAscentSql('board_climb_stats', 'fa_at')}`,
);
const NO_FIRST_ASCENT_COLUMNS = sql`NULL AS fa_username, NULL AS fa_at`;

function boardClimbStatsSelectList(firstAscent: SQL): SQL {
  return sql`board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
        ascensionist_count, difficulty_average, quality_average, ${firstAscent}, updated_at, sync_seq`;
}

const BOARD_CLIMB_GRADES_SELECT_LIST = sql`board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high,
        confidence, ascensionist_count, computed_at, sync_seq`;

/**
 * A wall's alive holds, in the shape the offline mirror stores and the mobile
 * render path reads back: canonical centre, radius and silhouette.
 *
 * Internal ids stay on the server. `installed_version_id` / `removed_version_id`
 * are the wall's own history bookkeeping and a device that holds only the
 * published generation has nothing to do with them; `moved_from_hold_id` belongs
 * to remix, which is a network operation.
 */
type CanonicalSprayHold = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
};

/**
 * Fill in the two fields a single SELECT cannot produce: the wall's holds and a
 * presigned URL for its photo.
 *
 * `holds` is fetched through `aliveHolds` rather than re-expressed as a JSON
 * aggregate in the page query on purpose. "Which holds are on the wall right
 * now" is a three-way range test over version status that took a long docblock
 * to get right (an abandoned draft's additions AND its removals both have to be
 * ignored), and a second copy of it in SQL would be a second chance to get it
 * wrong — a wall whose offline copy disagreed with the server would draw holds
 * that are not there. One extra round trip is the right price: a readable page
 * carries at most one wall, because the visibility gate below answers an empty
 * page unless the caller named a layout, and a layout is exactly one wall.
 *
 * `photo_url` is a TRANSIENT field — it is not a local column, the device hands
 * it to its photo store and drops it (`TableSyncConfig.transientColumns`). The
 * bucket is private and the signature lapses in fifteen minutes, so nothing may
 * persist it; `photo_key` is the identity that survives.
 */
async function enrichSprayWallDocument(document: RawRow): Promise<RawRow> {
  // `spray_walls.id` is both the cursor's seq component and the wall id
  // `aliveHolds` takes — the page selects it once, as `sync_seq`.
  const wallId = Number(document.sync_seq);
  const versionNumber = document.current_version_number == null ? undefined : Number(document.current_version_number);

  // No published version means no generation to be alive at. `aliveHolds` would
  // answer [] for it anyway; skipping the query says so without asking.
  const holds: CanonicalSprayHold[] =
    versionNumber === undefined
      ? []
      : (await aliveHolds(db, wallId, versionNumber)).map((hold) => ({
          id: hold.holdId,
          cx: hold.cx,
          cy: hold.cy,
          r: hold.r,
          outline: hold.outline ?? null,
        }));

  let photoUrl: string | null = null;
  const photoKey = typeof document.photo_key === 'string' ? document.photo_key : null;
  if (photoKey && isS3Configured('private')) {
    try {
      photoUrl = (await presignGetObject('private', photoKey)).url;
    } catch (error) {
      // A wall that syncs its holds and not its photo still renders a board with
      // an empty background, and the renderer re-asks for a signature on demand.
      // Failing the page would cost the holds too.
      logger.warn('Failed to presign a spray wall photo for sync', { photoKey }, error);
    }
  }

  return { ...document, holds, photo_url: photoUrl };
}

export const syncQueries = {
  syncClimbDocuments,
  /**
   * Pull the authenticated user's ticks. Local PK = uuid (the idempotency key).
   * Seq = id. Skips aurora_/kilter_ sync bookkeeping, board_id, inferred_session_id.
   */
  syncTicks: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`uuid, user_id, board_type, climb_uuid, climb_revision, angle, is_mirror, status,
        attempt_count, quality, difficulty, is_benchmark, comment, climbed_at, session_id,
        created_at, updated_at`,
      fromClause: sql`boardsesh_ticks`,
      scope: sql`user_id = ${userId}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull playlists owned by the authenticated user (join playlist_ownership).
   * Local PK = uuid. Seq = playlists.id.
   */
  syncPlaylists: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`playlists.uuid, playlists.board_type, playlists.layout_id, playlists.name,
        playlists.description, playlists.is_public, playlists.color, playlists.icon,
        playlists.created_at, playlists.updated_at, playlists.last_accessed_at`,
      fromClause: sql`playlists
        JOIN playlist_ownership po ON po.playlist_id = playlists.id
          AND po.user_id = ${userId} AND po.role = 'owner'`,
      scope: sql`TRUE`,
      updatedAtColumn: sql`playlists.updated_at`,
      seqColumn: sql`playlists.id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull playlist-climb rows for the user's owned playlists. Local PK =
   * (playlist_uuid, climb_uuid) — the resolver emits playlist_uuid, NOT the
   * bigint playlist_id. Seq = playlist_climbs.id.
   */
  syncPlaylistClimbs: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`p.uuid AS playlist_uuid, pc.climb_uuid, pc.angle, pc.position,
        pc.added_at, pc.updated_at`,
      fromClause: sql`playlist_climbs pc
        JOIN playlists p ON p.id = pc.playlist_id
        JOIN playlist_ownership po ON po.playlist_id = pc.playlist_id
          AND po.user_id = ${userId} AND po.role = 'owner'`,
      scope: sql`TRUE`,
      updatedAtColumn: sql`pc.updated_at`,
      seqColumn: sql`pc.id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull the authenticated user's favorites. Local PK =
   * (board_name, climb_uuid, angle). Seq = id.
   */
  syncFavorites: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`board_name, climb_uuid, angle, user_id, created_at, updated_at`,
      fromClause: sql`user_favorites`,
      scope: sql`user_id = ${userId}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull the authenticated user's user-follows. Local PK = (following_id).
   * Scope = follower_id = userId. Seq = id.
   */
  syncUserFollows: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`following_id, follower_id, created_at, updated_at`,
      fromClause: sql`user_follows`,
      scope: sql`follower_id = ${userId}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull the authenticated user's setter-follows. Local PK = (setter_username).
   * Scope = follower_id = userId. Seq = id.
   */
  syncSetterFollows: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`setter_username, follower_id, created_at, updated_at`,
      fromClause: sql`setter_follows`,
      scope: sql`follower_id = ${userId}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull the authenticated user's playlist-follows. Local PK = (playlist_uuid).
   * Scope = follower_id = userId. Seq = id.
   */
  syncPlaylistFollows: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`playlist_uuid, follower_id, created_at, updated_at`,
      fromClause: sql`playlist_follows`,
      scope: sql`follower_id = ${userId}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`id`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull board climbs for a board type (reference data, per-board). Local PK =
   * uuid. Seq = sync_seq. Optional layoutId/sizeId scope the pull to one
   * (layout, size) — all sets — so a downloaded board is a fixed, cacheable
   * superset (sizeId ignored for moonboard). Optional audience picks one of the
   * two streams the pull splits into (see `ClimbAccess`); each has its own
   * cursor.
   */
  syncClimbs: async (
    _: unknown,
    {
      boardType,
      layoutId,
      sizeId,
      audience,
      cursor,
      limit,
    }: {
      boardType: string;
      layoutId?: number | null;
      sizeId?: number | null;
      audience?: SyncAudience | null;
      cursor?: SyncCursorInput | null;
      limit: number;
    },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
      viewerUserId,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);
    const stream = climbStreamFor(validateSyncAudience(audience), validBoardType);

    // Before the spray gate below, and without it: a board type with no
    // reference set answers the same empty page for every layout id and every
    // caller, so the reference stream cannot tell anyone which walls exist.
    if (stream === null) return emptySyncPage(cursor);

    // The board scope here is `board_type` + an optional `layout_id`, and the
    // stream's own condition (`climbAccessCondition`) decides the rest: the
    // published, listed climbs, the caller's own others, or both. On the eight
    // catalogue boards that is the whole rule; on spray it is not enough, because
    // one authenticated account could walk `layoutId` 1..N and pull every column
    // of every private wall's published climbs. An unreadable scope returns an
    // ordinary empty page. The gate does not look at the stream: `reference`
    // returned above for spray, and if spray ever gained a reference set this
    // would still stand in front of it.
    if (isSprayBoardType(validBoardType) && !(await sprayLayoutIsReadable(validBoardType, lid, ctx.userId))) {
      return emptySyncPage(cursor);
    }

    const climbs: ClimbAccess = stream === 'reference' ? { stream } : { stream, viewerUserId };
    const climbScope = sql`(${boardClimbsScope(validBoardType, lid, sid)}) AND ${climbAccessCondition(climbs, 'board_climbs')}`;
    if (stream === 'protected') {
      // The caller's own drafts and unlisted climbs: a handful of rows among the
      // board's hundreds of thousands. Collected first, through the owner, and
      // only then ordered and limited. Left as one flat query, `ORDER BY … LIMIT`
      // can make a walk of the board's whole cursor index look cheaper than it
      // is; `OFFSET 0` keeps Postgres from flattening the subquery into one. The
      // subquery takes the table's name, so the column list and the cursor
      // columns resolve unchanged.
      return runSyncPage({
        selectList: BOARD_CLIMBS_SELECT_LIST,
        fromClause: sql`(SELECT * FROM board_climbs WHERE ${climbScope} OFFSET 0) board_climbs`,
        scope: sql`TRUE`,
        updatedAtColumn: sql`updated_at`,
        seqColumn: sql`sync_seq`,
        cursor,
        limit: lim,
      });
    }
    return runSyncPage({
      selectList: BOARD_CLIMBS_SELECT_LIST,
      fromClause: sql`board_climbs`,
      scope: climbScope,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`sync_seq`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull board climb stats for a board type (reference data, per-board). Local PK
   * = (board_type, climb_uuid, angle). Seq = sync_seq. Optional layoutId/sizeId
   * scope the stats to the climbs of that (layout, size) via a correlated EXISTS
   * on board_climbs (board_climb_stats has no layout_id column). Cursor columns
   * are fully qualified to stay unambiguous alongside the subquery. Optional
   * audience returns the stats of that stream's climbs.
   */
  syncClimbStats: async (
    _: unknown,
    {
      boardType,
      layoutId,
      sizeId,
      audience,
      cursor,
      limit,
    }: {
      boardType: string;
      layoutId?: number | null;
      sizeId?: number | null;
      audience?: SyncAudience | null;
      cursor?: SyncCursorInput | null;
      limit: number;
    },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
      viewerUserId,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);
    const syncAudience = validateSyncAudience(audience);
    const stream = climbStreamFor(syncAudience, validBoardType);
    if (stream === null) return emptySyncPage(cursor);

    // Same enumeration as `syncClimbs`: this scope reaches `board_climbs` by
    // layout to decide which rows belong to the pull, so a private spray wall
    // would hand over its climbs' stats (and grades) to any account that guessed
    // the layout id.
    if (isSprayBoardType(validBoardType) && !(await sprayLayoutIsReadable(validBoardType, lid, ctx.userId))) {
      return emptySyncPage(cursor);
    }

    return runScopedBoardRefSyncPage({
      climbs: stream === 'reference' ? { stream } : { stream, viewerUserId },
      table: sql`board_climb_stats`,
      climbUuidColumn: sql`board_climb_stats.climb_uuid`,
      // Keyed on the audience the caller asked for, not the stream it resolved
      // to: PROTECTED on a spray wall reads the union's rows and still ships no
      // name. See `boardClimbStatsSelectList`.
      selectList: boardClimbStatsSelectList(
        syncAudience === 'PROTECTED' ? NO_FIRST_ASCENT_COLUMNS : REFERENCE_FIRST_ASCENT_COLUMNS,
      ),
      updatedAtColumn: sql`board_climb_stats.updated_at`,
      seqColumn: sql`board_climb_stats.sync_seq`,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull Boardsesh grades for a board type (reference data, per-board). Local PK =
   * (board_type, climb_uuid, angle). Seq = sync_seq, cursor timestamp = computed_at.
   * Optional layoutId/sizeId scope the grades to the climbs of that (layout, size)
   * via a correlated EXISTS on board_climbs (board_climb_grades has no layout_id
   * column, exactly like board_climb_stats). Cursor columns are fully qualified to
   * stay unambiguous alongside the subquery. model_version/coeff_version/
   * content_prior are dropped — the device only needs the surfaced grade + band.
   * Optional audience returns the grades of that stream's climbs.
   */
  syncClimbGrades: async (
    _: unknown,
    {
      boardType,
      layoutId,
      sizeId,
      audience,
      cursor,
      limit,
    }: {
      boardType: string;
      layoutId?: number | null;
      sizeId?: number | null;
      audience?: SyncAudience | null;
      cursor?: SyncCursorInput | null;
      limit: number;
    },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
      viewerUserId,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);
    const stream = climbStreamFor(validateSyncAudience(audience), validBoardType);
    if (stream === null) return emptySyncPage(cursor);

    // Same enumeration as `syncClimbs`: this scope reaches `board_climbs` by
    // layout to decide which rows belong to the pull, so a private spray wall
    // would hand over its climbs' stats (and grades) to any account that guessed
    // the layout id.
    if (isSprayBoardType(validBoardType) && !(await sprayLayoutIsReadable(validBoardType, lid, ctx.userId))) {
      return emptySyncPage(cursor);
    }

    return runScopedBoardRefSyncPage({
      climbs: stream === 'reference' ? { stream } : { stream, viewerUserId },
      table: sql`board_climb_grades`,
      climbUuidColumn: sql`board_climb_grades.climb_uuid`,
      selectList: BOARD_CLIMB_GRADES_SELECT_LIST,
      updatedAtColumn: sql`board_climb_grades.computed_at`,
      seqColumn: sql`board_climb_grades.sync_seq`,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull the spray wall at a layout (board data, per-board). Local PK =
   * `layout_id`. Seq = `spray_walls.id`.
   *
   * ## What it carries
   *
   * Everything the mobile render path needs to draw a wall with no signal: the
   * wall's name and canonical frame, the published version number, the holds
   * alive at that version, that version's homography, and the private-bucket
   * `photo_key` plus a short-lived presigned URL the device turns into bytes on
   * disk. The photo is the one piece that is not a row.
   *
   * ## Visibility
   *
   * The by-layout rule — owner, gym member, or a PUBLIC wall — through the same
   * `sprayLayoutIsReadable` gate `syncClimbs`, `syncClimbStats` and
   * `syncClimbGrades` carry, and the decision is deliberately the same in all
   * four: **unlisted is not an exemption here.** Unlisted means "reachable by
   * uuid", and a layout id is not a uuid — it comes out of
   * `spray_wall_catalog_id_seq`, i.e. 1, 2, 3 — so honouring unlisted on this key
   * would let one authenticated account walk the sequence and collect a live
   * presigned photograph of every unlisted home wall in the database. A client
   * that "already knows the layout" knows nothing: the id is the guess. The uuid
   * path that DOES honour unlisted is `sprayWall(uuid:)` / `sprayWallRenderData`,
   * where the capability is the uuid itself. Keep this in step with
   * `viewerCanSeeSprayWallByLayout`.
   *
   * An unreadable (or unscoped, or non-spray) request is an ordinary empty page,
   * never an error and never a different shape, so nothing here tells a caller
   * which layout ids are private walls.
   *
   * Soft-deleted walls are excluded; migration 0228's tombstone trigger is what
   * removes them from a device that already has one.
   */
  syncSprayWalls: async (
    _: unknown,
    {
      boardType,
      layoutId,
      sizeId,
      cursor,
      limit,
    }: {
      boardType: string;
      layoutId?: number | null;
      sizeId?: number | null;
      cursor?: SyncCursorInput | null;
      limit: number;
    },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    // `sizeId` is validated and then deliberately unused: a wall IS its own size
    // (`spraySizeIdForLayout`), so `layout_id` already identifies it and there is
    // no size dimension to filter on. Clients still send it because the scope key
    // carries it for every board type; a wrong value here changes nothing rather
    // than silently narrowing the page. Said in the SDL too, so a caller can tell
    // without reading this.
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);

    // Only spray has walls, and `sprayLayoutIsReadable` answers false without a
    // layout id — there is no wall an unscoped pull could be checked against.
    // Both land on the same empty page.
    if (!isSprayBoardType(validBoardType) || !(await sprayLayoutIsReadable(validBoardType, lid, ctx.userId))) {
      return emptySyncPage(cursor);
    }

    // NO `withSerialPlan` here, unlike syncClimbStats / syncClimbGrades. Their
    // guard exists because those pages walk a reference table in cursor order and
    // probe 375k-row board_climbs through a correlated EXISTS — a shape production
    // plans as a Gather Merge, which has exhausted Postgres's DSM during sync
    // bursts (Sentry BOARDSESH-AK). This page is a unique-index lookup on
    // `spray_walls.layout_id` joined to two rows, returning at most one; there is
    // no plan a parallel worker would be chosen for. If this query ever grows a
    // scan — every wall for a board type, a join onto climbs — wrap it, because
    // `runSyncPage` silently defaults to the bare pool and the omission is
    // invisible.
    const page = await runSyncPage({
      // `ub.name` is the wall's name: a wall's name, angle, visibility and gym
      // all live on the user_boards row, so nothing about a wall is stored twice.
      selectList: sql`sw.layout_id, sw.board_uuid, ub.name, sw.reference_width, sw.reference_height,
        cv.version_number AS current_version_number, cv.photo_key, cv.homography,
        sw.updated_at, sw.id AS sync_seq`,
      fromClause: sql`spray_walls sw
        JOIN user_boards ub ON ub.uuid = sw.board_uuid
        LEFT JOIN spray_wall_versions cv ON cv.id = sw.current_version_id`,
      scope: sql`sw.layout_id = ${lid} AND sw.deleted_at IS NULL AND ub.deleted_at IS NULL`,
      updatedAtColumn: sql`sw.updated_at`,
      seqColumn: sql`sw.id`,
      cursor,
      limit: lim,
    });

    // `SyncResult.documents` is `unknown[]` on the wire (opaque JSON), but every
    // element here came out of `runSyncPage`, which builds them as RawRow.
    const documents = await Promise.all(page.documents.map((document) => enrichSprayWallDocument(document as RawRow)));
    return { ...page, documents };
  },

  /**
   * Pull hard deletions for the client to apply locally. Scoped to the user's own
   * deletions plus reference-data deletions (user_id IS NULL). Cursor on
   * (COALESCE(stream_at, deleted_at), id). deleted_at remains the client's
   * resurrection guard, while the DB-owned stream timestamp orders new markers.
   */
  syncDeletions: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncDeletionsResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    const { ts, seq } = cursorBounds(cursor);

    let safeCutoff: string | null = null;
    try {
      // This MUST be a separate primary query before the page query. The page
      // then gets a fresh READ COMMITTED snapshot after the activity sample:
      // a writer committing between the two is visible, and an older remaining
      // writer caps the cursor below its DB-stamped marker. Sampling inside the
      // page statement could miss a commit after that statement's snapshot.
      const [cutoffRow] = rowsFromResult<{ safe_cutoff: string | null }>(
        await db.execute(sql`
          SELECT public.sync_deletions_safe_cutoff(${STABILITY_WINDOW_SECONDS}::double precision)::text AS safe_cutoff
        `),
      );
      safeCutoff = cutoffRow?.safe_cutoff ?? null;
    } catch {
      safeCutoff = null;
    }
    // Prepared writers, unknown stats visibility, and missing helper privilege
    // all pause this poll without advancing the installed client's cursor.
    if (safeCutoff === null) {
      logger.warn('Deletion sync paused: transaction metadata could not establish a safe cutoff');
      return { deletions: [], cursor: { updatedAt: ts, syncSeq: seq }, hasMore: false };
    }

    const result = await db.execute(sql`
      SELECT table_name, record_id, deleted_at, COALESCE(stream_at, deleted_at) AS __stream_at, id AS __seq
      FROM sync_deletions
      WHERE (user_id = ${userId} OR user_id IS NULL)
        AND (COALESCE(stream_at, deleted_at), id) > (${ts}::timestamp, ${seq}::bigint)
        AND COALESCE(stream_at, deleted_at) < ${safeCutoff}::timestamp
        AND NOT (is_membership_withdrawal AND table_name = 'board_climbs' AND EXISTS (
          SELECT 1 FROM board_climbs bc
          WHERE bc.uuid = sync_deletions.record_id AND ${currentlyReadableSyncClimbCondition(userId)}
        ))
      ORDER BY COALESCE(stream_at, deleted_at) ASC, id ASC
      LIMIT ${lim}
    `);

    const rows = rowsFromResult<RawRow>(result);

    // Filter before LIMIT: installed clients stop on an empty deletion array,
    // even when hasMore is true, so an authorized marker must not consume a slot.
    // Visibility uses this statement's snapshot; a later hide writes a new marker.
    const deletions = rows.map((row) => ({
      tableName: String(row.table_name),
      recordId: String(row.record_id),
      deletedAt: toIso(row.deleted_at),
    }));

    const lastRow = rows[rows.length - 1];
    const nextCursor = lastRow
      ? { updatedAt: toIso(lastRow.__stream_at), syncSeq: String(lastRow.__seq) }
      : { updatedAt: ts, syncSeq: seq };

    return {
      deletions,
      cursor: nextCursor,
      hasMore: rows.length === lim,
    };
  },
};
