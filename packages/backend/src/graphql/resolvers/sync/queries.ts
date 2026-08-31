import { sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncDeletionsResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { db } from '../../../db/client';
import { rowsFromResult } from '@boardsesh/db/client';
import { withSerialPlan, type SerialPlanDb } from '@boardsesh/db/queries';
import { requireAuthenticated } from '../shared/helpers';
import { normalizeRow, toIso, type RawRow } from './row-normalize';
import {
  validateInput,
  SyncCursorInputSchema,
  SyncLimitSchema,
  SyncBoardScopeIdSchema,
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
// A non-numeric env value falls back to the default rather than poisoning
// every sync query with a NaN interval.
const parsedStabilityWindow = Number(process.env.SYNC_STABILITY_WINDOW_SECONDS ?? 30);
const STABILITY_WINDOW_SECONDS = Number.isFinite(parsedStabilityWindow) ? parsedStabilityWindow : 30;

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
): { limit: number; boardType: string; layoutId: number | null; sizeId: number | null } {
  requireAuthenticated(ctx);
  validateInput(SyncCursorInputSchema, cursor, 'cursor');
  // Allowlist the board type like the tick/favorite resolvers do — a junk value
  // is only a harmless empty scan (parameterized bind), but rejecting it makes
  // client bugs visible instead of silently syncing nothing.
  const validatedBoardType = validateInput(BoardNameSchema, boardType, 'boardType');
  const validatedLimit = validateInput(SyncLimitSchema, limit, 'limit');
  const validatedLayoutId = validateInput(SyncBoardScopeIdSchema, layoutId, 'layoutId') ?? null;
  const validatedSizeId = validateInput(SyncBoardScopeIdSchema, sizeId, 'sizeId') ?? null;
  return { limit: validatedLimit, boardType: validatedBoardType, layoutId: validatedLayoutId, sizeId: validatedSizeId };
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
 * Run one page of a per-board reference table that has no layout_id of its own
 * (board_climb_stats, board_climb_grades) — building the correlated-EXISTS scope
 * AND running the page under the serial-plan guard, together, in one call.
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
 */
async function runScopedBoardRefSyncPage(params: {
  table: SQL;
  climbUuidColumn: SQL;
  selectList: SQL;
  updatedAtColumn: SQL;
  seqColumn: SQL;
  boardType: string;
  layoutId: number | null;
  sizeId: number | null;
  cursor: SyncCursorInput | null | undefined;
  limit: number;
}): Promise<SyncResult> {
  const { table, climbUuidColumn, selectList, updatedAtColumn, seqColumn, boardType, layoutId, sizeId, cursor, limit } =
    params;

  // The reference row has no layout_id, so scope it to the climbs of that
  // (layout, size) via a correlated EXISTS on board_climbs, reusing the same
  // shared conditions syncClimbs uses (bc.-qualified here). No scope → plain
  // board_type filter.
  const scopeConditions = boardClimbsLayoutSizeConditions(boardType, layoutId, sizeId, sql`bc.`);
  let scope: SQL = sql`board_type = ${boardType}`;
  if (scopeConditions.length > 0) {
    const sub = sql.join(
      [sql`bc.uuid = ${climbUuidColumn}`, sql`bc.board_type = ${boardType}`, ...scopeConditions],
      sql` AND `,
    );
    scope = sql`board_type = ${boardType} AND EXISTS (SELECT 1 FROM board_climbs bc WHERE ${sub})`;
  }

  return withSerialPlan(db, (transactionDb) =>
    runSyncPage({
      executor: transactionDb,
      selectList,
      fromClause: table,
      scope,
      updatedAtColumn,
      seqColumn,
      cursor,
      limit,
    }),
  );
}

export const syncQueries = {
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
      selectList: sql`uuid, user_id, board_type, climb_uuid, angle, is_mirror, status,
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
   * superset (sizeId ignored for moonboard).
   */
  syncClimbs: async (
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
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);
    return runSyncPage({
      selectList: sql`uuid, board_type, layout_id, setter_id, setter_username, name, description,
        hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames,
        controller_route_uuid, is_draft, is_listed, created_at, published_at, user_id, required_set_ids, compatible_size_ids,
        characteristics, hold_fingerprint, updated_at, sync_seq`,
      fromClause: sql`board_climbs`,
      scope: boardClimbsScope(validBoardType, lid, sid),
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
   * are fully qualified to stay unambiguous alongside the subquery.
   */
  syncClimbStats: async (
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
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);

    return runScopedBoardRefSyncPage({
      table: sql`board_climb_stats`,
      climbUuidColumn: sql`board_climb_stats.climb_uuid`,
      selectList: sql`board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
        ascensionist_count, difficulty_average, quality_average, fa_username, fa_at, updated_at, sync_seq`,
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
   */
  syncClimbGrades: async (
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
    const {
      limit: lim,
      boardType: validBoardType,
      layoutId: lid,
      sizeId: sid,
    } = prepareBoardSync(ctx, cursor, limit, boardType, layoutId, sizeId);

    return runScopedBoardRefSyncPage({
      table: sql`board_climb_grades`,
      climbUuidColumn: sql`board_climb_grades.climb_uuid`,
      selectList: sql`board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high,
        confidence, ascensionist_count, computed_at, sync_seq`,
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
   * Pull hard deletions for the client to apply locally. Scoped to the user's own
   * deletions plus reference-data deletions (user_id IS NULL). Cursor on
   * (deleted_at, id).
   */
  syncDeletions: async (
    _: unknown,
    { cursor, limit }: { cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncDeletionsResult> => {
    const { userId, limit: lim } = prepareUserSync(ctx, cursor, limit);
    const { ts, seq } = cursorBounds(cursor);

    const result = await db.execute(sql`
      SELECT table_name, record_id, deleted_at, id AS __seq
      FROM sync_deletions
      WHERE (user_id = ${userId} OR user_id IS NULL)
        AND (deleted_at, id) > (${ts}::timestamp, ${seq}::bigint)
        AND deleted_at < now() - make_interval(secs => ${STABILITY_WINDOW_SECONDS})
      ORDER BY deleted_at ASC, id ASC
      LIMIT ${lim}
    `);

    const rows = rowsFromResult<RawRow>(result);

    const deletions = rows.map((row) => ({
      tableName: String(row.table_name),
      recordId: String(row.record_id),
      deletedAt: toIso(row.deleted_at),
    }));

    const lastRow = rows[rows.length - 1];
    const nextCursor = lastRow
      ? { updatedAt: toIso(lastRow.deleted_at), syncSeq: String(lastRow.__seq) }
      : { updatedAt: ts, syncSeq: seq };

    return {
      deletions,
      cursor: nextCursor,
      hasMore: rows.length === lim,
    };
  },
};
