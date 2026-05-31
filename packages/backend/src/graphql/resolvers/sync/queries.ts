import { sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext, SyncResult, SyncDeletionsResult, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { rowsFromResult } from '@boardsesh/db/client';
import { requireAuthenticated } from '../shared/helpers';
import { validateInput, SyncCursorInputSchema, SyncLimitSchema } from '../../../validation/schemas';

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

// Start of time for the first pull, when the client sends no cursor.
const EPOCH_TS = 'epoch';
const EPOCH_SEQ = '0';

type RawRow = Record<string, unknown>;

/**
 * Convert a raw postgres-js row into a sync document: timestamp columns come back
 * as JS Date objects, but the mobile SQLite stores ISO-8601 TEXT, so every Date
 * is serialised to an ISO string. int[] columns stay as JS arrays (the mobile
 * upsert JSON-stringifies them); bigint columns stay as-is.
 */
function normalizeRow(row: RawRow): RawRow {
  const out: RawRow = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

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
  selectList: SQL;
  fromClause: SQL;
  scope: SQL;
  updatedAtColumn: SQL;
  seqColumn: SQL;
  cursor: SyncCursorInput | null | undefined;
  limit: number;
}): Promise<SyncResult> {
  const { selectList, fromClause, scope, updatedAtColumn, seqColumn, cursor, limit } = params;
  const { ts, seq } = cursorBounds(cursor);

  const result = await db.execute(sql`
    SELECT ${selectList}, ${updatedAtColumn} AS __updated_at, ${seqColumn} AS __seq
    FROM ${fromClause}
    WHERE ${scope}
      AND (${updatedAtColumn}, ${seqColumn}) > (${ts}::timestamp, ${seq}::bigint)
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
 * the same cursor/limit validation.
 */
function prepareBoardSync(
  ctx: ConnectionContext,
  cursor: SyncCursorInput | null | undefined,
  limit: number,
): { limit: number } {
  requireAuthenticated(ctx);
  validateInput(SyncCursorInputSchema, cursor, 'cursor');
  const validatedLimit = validateInput(SyncLimitSchema, limit, 'limit');
  return { limit: validatedLimit };
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
   * uuid. Seq = sync_seq. Dormant this phase (no board enabled by default).
   */
  syncClimbs: async (
    _: unknown,
    { boardType, cursor, limit }: { boardType: string; cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { limit: lim } = prepareBoardSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`uuid, board_type, layout_id, setter_id, setter_username, name, description,
        hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames,
        is_draft, is_listed, created_at, published_at, user_id, required_set_ids, compatible_size_ids,
        hold_fingerprint, updated_at, sync_seq`,
      fromClause: sql`board_climbs`,
      scope: sql`board_type = ${boardType}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`sync_seq`,
      cursor,
      limit: lim,
    });
  },

  /**
   * Pull board climb stats for a board type (reference data, per-board). Local PK
   * = (board_type, climb_uuid, angle). Seq = sync_seq.
   */
  syncClimbStats: async (
    _: unknown,
    { boardType, cursor, limit }: { boardType: string; cursor?: SyncCursorInput | null; limit: number },
    ctx: ConnectionContext,
  ): Promise<SyncResult> => {
    const { limit: lim } = prepareBoardSync(ctx, cursor, limit);
    return runSyncPage({
      selectList: sql`board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty,
        ascensionist_count, difficulty_average, quality_average, fa_username, fa_at, updated_at, sync_seq`,
      fromClause: sql`board_climb_stats`,
      scope: sql`board_type = ${boardType}`,
      updatedAtColumn: sql`updated_at`,
      seqColumn: sql`sync_seq`,
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
