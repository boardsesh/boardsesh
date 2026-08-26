import { eq, and, asc, inArray, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import {
  CreatePlaylistInputSchema,
  UpdatePlaylistInputSchema,
  AddClimbToPlaylistInputSchema,
  RemoveClimbFromPlaylistInputSchema,
  ReorderPlaylistClimbInputSchema,
  FollowPlaylistInputSchema,
  PinPlaylistInputSchema,
  BOARD_ANGLE_VALIDATION_MESSAGE,
  isBoardAngleSupported,
} from '../../../validation/schemas';
import { UNIFIED_TABLES } from '../../../db/queries/util/table-select';
import { getPlaylistFollowStats } from './queries';
import { verifyPlaylistAccess } from './helpers/enrichment';
import { computePlaylistReorderWrites } from './helpers/reorder';
import { logger } from '../../../utils/logger';

type ClimbBoardScope = { boardType: string; layoutId: number };

// Resolves every board + layout a climb uuid can legitimately stand for,
// following the same alias-read convention as the rest of the codebase (see
// packages/db/src/queries/aliases.ts and docs' "Climb alias read-resolution"
// note): board_climb_aliases dedups duplicate Kilter UUIDs onto a single
// canonical board_climbs row, so a climbUuid that isn't itself a board_climbs
// row may still be a non-canonical alias whose canonical row carries the real
// board/layout.
//
// A LIST, not a single row, because the alias table's PK is
// (board_type, alias_uuid): the same alias_uuid can in principle exist under
// more than one board, pointing at different canonical climbs. Picking one of
// those with an unordered LIMIT 1 would make the guard's verdict depend on
// whichever row Postgres happened to return. Callers accept the add when ANY
// resolved scope is compatible, so an ambiguous uuid can never be rejected on
// a coin flip.
//
// Returns an empty list when the uuid resolves to no board_climbs row even
// after alias resolution — callers fail OPEN on empty (see addClimbToPlaylist
// below) rather than reject: the catalog row can legitimately lag behind
// create-climb / offline-sync writes, and hard rejecting here would risk
// breaking those flows for the sake of a guard that is defense-in-depth (the
// mobile picker, per #4268, no longer offers mismatched playlists as add
// targets in the first place).
async function resolveClimbBoardScopes(climbUuid: string): Promise<ClimbBoardScope[]> {
  const direct = await db
    .select({ boardType: dbSchema.boardClimbs.boardType, layoutId: dbSchema.boardClimbs.layoutId })
    .from(dbSchema.boardClimbs)
    .where(eq(dbSchema.boardClimbs.uuid, climbUuid))
    .limit(1);

  if (direct.length > 0) return direct;

  // Not a canonical row — check whether it's a non-canonical alias. We don't
  // know the board up front, so join straight from alias_uuid to the canonical
  // board_climbs row and take the board/layout from there. Bounded by the
  // number of boards a single alias_uuid can appear under (one row per board
  // at most, by the alias PK), so no LIMIT is needed.
  const viaAlias = await db
    .select({ boardType: dbSchema.boardClimbs.boardType, layoutId: dbSchema.boardClimbs.layoutId })
    .from(dbSchema.boardClimbAliases)
    .innerJoin(dbSchema.boardClimbs, eq(dbSchema.boardClimbs.uuid, dbSchema.boardClimbAliases.canonicalUuid))
    .where(eq(dbSchema.boardClimbAliases.aliasUuid, climbUuid));

  if (viaAlias.length > 0) return viaAlias;

  logger.warn(
    'addClimbToPlaylist: climb uuid not found in board_climbs or board_climb_aliases; allowing add (fail-open)',
    {
      climbUuid,
    },
  );
  return [];
}

// The playlist side of the same rule playlistsForClimb / playlistsForClimbs
// use to scope membership: the boards must match, and a playlist pinned to one
// layout only takes climbs from that layout (a null layoutId — how Aurora- and
// Kilter-synced circuits arrive — takes any layout of its own board).
function climbFitsPlaylistBoard(
  climbScope: ClimbBoardScope,
  playlistScope: { boardType: string; layoutId: number | null },
): boolean {
  if (climbScope.boardType !== playlistScope.boardType) return false;
  return playlistScope.layoutId === null || climbScope.layoutId === playlistScope.layoutId;
}

function playlistResult(playlist: dbSchema.Playlist, climbCount: number): Record<string, unknown> {
  return {
    id: playlist.id.toString(),
    uuid: playlist.uuid,
    boardType: playlist.boardType,
    layoutId: playlist.layoutId,
    name: playlist.name,
    description: playlist.description,
    isPublic: playlist.isPublic,
    color: playlist.color,
    icon: playlist.icon,
    createdAt: playlist.createdAt.toISOString(),
    updatedAt: playlist.updatedAt.toISOString(),
    climbCount,
    userRole: 'owner',
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

export const playlistMutations = {
  /**
   * Create a new playlist with the authenticated user as owner
   */
  createPlaylist: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<unknown> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(CreatePlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;
    const uuid = validatedInput.uuid ?? uuidv4();
    const now = new Date();

    if (validatedInput.uuid) {
      const [existingOwnedPlaylist] = await db
        .select({ playlist: dbSchema.playlists })
        .from(dbSchema.playlists)
        .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
        .where(
          and(
            eq(dbSchema.playlists.uuid, validatedInput.uuid),
            eq(dbSchema.playlistOwnership.userId, userId),
            eq(dbSchema.playlistOwnership.role, 'owner'),
          ),
        )
        .limit(1);

      if (existingOwnedPlaylist) {
        const [climbCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(dbSchema.playlistClimbs)
          .where(eq(dbSchema.playlistClimbs.playlistId, existingOwnedPlaylist.playlist.id))
          .limit(1);
        return playlistResult(existingOwnedPlaylist.playlist, climbCount?.count ?? 0);
      }
    }

    // Create playlist + ownership atomically: a playlist row without its
    // ownership row is invisible to every read (all queries join ownership)
    // yet permanently holds the uuid, so an idempotent replay of the same
    // client uuid would recover nothing and throw forever. One transaction
    // makes the crash window disappear.
    const playlist = await db.transaction(async (tx) => {
      const [insertedPlaylist] = await tx
        .insert(dbSchema.playlists)
        .values({
          uuid,
          boardType: validatedInput.boardType,
          layoutId: validatedInput.layoutId,
          name: validatedInput.name,
          description: validatedInput.description || null,
          isPublic: false, // Always private initially
          color: validatedInput.color || null,
          icon: validatedInput.icon || null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: dbSchema.playlists.uuid,
        })
        .returning();

      if (!insertedPlaylist) return undefined;

      await tx.insert(dbSchema.playlistOwnership).values({
        playlistId: insertedPlaylist.id,
        userId,
        role: 'owner',
        createdAt: now,
      });

      return insertedPlaylist;
    });

    if (!playlist) {
      const [existingOwnedPlaylist] = await db
        .select({ playlist: dbSchema.playlists })
        .from(dbSchema.playlists)
        .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
        .where(
          and(
            eq(dbSchema.playlists.uuid, uuid),
            eq(dbSchema.playlistOwnership.userId, userId),
            eq(dbSchema.playlistOwnership.role, 'owner'),
          ),
        )
        .limit(1);

      if (!existingOwnedPlaylist) {
        throw new Error('Playlist UUID is already in use');
      }

      const [climbCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dbSchema.playlistClimbs)
        .where(eq(dbSchema.playlistClimbs.playlistId, existingOwnedPlaylist.playlist.id))
        .limit(1);
      return playlistResult(existingOwnedPlaylist.playlist, climbCount?.count ?? 0);
    }

    return playlistResult(playlist, 0);
  },

  /**
   * Update an existing playlist (requires owner role)
   */
  updatePlaylist: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<unknown> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(UpdatePlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check ownership
    const ownership = await db
      .select()
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    const playlistId = ownership[0].playlists.id;

    // Build update object (only update provided fields)
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    // Normalize the empty-string "clear" signal to NULL so a cleared field is
    // stored as NULL, not '' (matches createPlaylist's `|| null`). `undefined`
    // still means "leave unchanged".
    if (validatedInput.name !== undefined) updateData.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateData.description = validatedInput.description || null;
    if (validatedInput.isPublic !== undefined) updateData.isPublic = validatedInput.isPublic;
    if (validatedInput.color !== undefined) updateData.color = validatedInput.color || null;
    if (validatedInput.icon !== undefined) updateData.icon = validatedInput.icon || null;

    // Update playlist
    const [updated] = await db
      .update(dbSchema.playlists)
      .set(updateData)
      .where(eq(dbSchema.playlists.id, playlistId))
      .returning();

    // Get climb count and follow stats
    const climbCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(dbSchema.playlistClimbs)
      .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
      .limit(1);

    const [followStats, pinRow] = await Promise.all([
      getPlaylistFollowStats([updated.uuid], userId),
      // Single-row pin lookup by composite-unique-index (userId, playlistId)
      // — cheaper than the helper's batched IN-array path for the
      // mutation's one-playlist case.
      db
        .select({ id: dbSchema.userPlaylistPins.id })
        .from(dbSchema.userPlaylistPins)
        .where(and(eq(dbSchema.userPlaylistPins.userId, userId), eq(dbSchema.userPlaylistPins.playlistId, playlistId)))
        .limit(1),
    ]);
    const stats = followStats.get(updated.uuid) ?? { followerCount: 0, isFollowedByMe: false };
    const isPinnedByMe = pinRow.length > 0;

    return {
      id: updated.id.toString(),
      uuid: updated.uuid,
      boardType: updated.boardType,
      layoutId: updated.layoutId,
      name: updated.name,
      description: updated.description,
      isPublic: updated.isPublic,
      color: updated.color,
      icon: updated.icon,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      climbCount: climbCount[0]?.count || 0,
      userRole: 'owner',
      followerCount: stats.followerCount,
      isFollowedByMe: stats.isFollowedByMe,
      isPinnedByMe,
    };
  },

  /**
   * Delete a playlist (requires owner role)
   */
  deletePlaylist: async (
    _: unknown,
    { playlistId }: { playlistId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Check ownership
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to delete it');
    }

    // Delete playlist (cascade will handle ownership and climbs)
    await db.delete(dbSchema.playlists).where(eq(dbSchema.playlists.id, ownership[0].id));

    return true;
  },

  /**
   * Add a climb to a playlist
   */
  addClimbToPlaylist: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<unknown> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(AddClimbToPlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check owner role. Editors/viewers retain private read access, but cannot
    // mutate playlist contents.
    const ownership = await db
      .select({
        id: dbSchema.playlists.id,
        boardType: dbSchema.playlists.boardType,
        layoutId: dbSchema.playlists.layoutId,
      })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    if (!isBoardAngleSupported(ownership[0].boardType, validatedInput.angle)) {
      throw new GraphQLError(BOARD_ANGLE_VALIDATION_MESSAGE, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const playlistId = ownership[0].id;

    // Board-compatibility guard (#4015): reject adds where the climb's own
    // board/layout doesn't match the playlist's. This mirrors the exact rule
    // playlistsForClimb / playlistsForClimbs already use to scope membership
    // (board_type match + layout_id match-or-null) — without it, an add could
    // succeed here while the membership refetch silently excludes it, making
    // the UI checkmark vanish on the next fetch and leaving a row the climber
    // can no longer untick. #4268 already stops the mobile picker from
    // offering a mismatched playlist as a target; this is the server-side
    // backstop for every client that predates it — OTA rollout takes days to
    // reach the whole fleet, and offline queues can replay an add that was
    // composed before the update landed.
    const climbBoardScopes = await resolveClimbBoardScopes(validatedInput.climbUuid);
    if (climbBoardScopes.length > 0 && !climbBoardScopes.some((scope) => climbFitsPlaylistBoard(scope, ownership[0]))) {
      // A GraphQLError with a BAD_USER_INPUT code rather than a bare Error: the
      // rejection is a client-input verdict the app can branch on, and it keeps
      // the guard out of the "unexpected server failure" bucket. The message
      // still reaches clients verbatim (mask-error.ts only sanitizes raw
      // database errors), and the mobile picker turns any rejection into its
      // own translated "couldn't add" line — the wire text is never shown.
      throw new GraphQLError('This playlist is for a different board', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Insert-or-noop + position assignment share one transaction: a plain
    // pre-check SELECT followed by a separate INSERT leaves a window where
    // two concurrent calls for the same (playlistId, climbUuid) both see no
    // existing row and both reach the INSERT, so the second hits the
    // unique_playlist_climb index as a raw 23505 instead of the intended
    // idempotent no-op. onConflictDoNothing lets Postgres's index arbitrate;
    // when our insert loses the race we re-select the winner's row and return
    // it in the same "already in playlist" shape the old pre-check used.
    //
    // The re-select can legitimately come back empty: under READ COMMITTED
    // every statement takes a fresh snapshot, so the row we conflicted with
    // can be removed (a concurrent removeClimbFromPlaylist committing, or the
    // racing inserter rolling back) between our INSERT and our SELECT. The
    // conflicting row is gone by then, so a second insert attempt succeeds.
    // Two attempts is enough for that hand-off; a third would only mean the
    // caller is racing itself in a loop, which is worth failing loudly on.
    // The isolation level is pinned rather than inherited: the retry only
    // works because a re-select sees other transactions' committed deletes,
    // which a stricter level (or a changed server default) would hide. Both
    // attempts share one transaction so the position assignment and the
    // insert stay atomic; the second attempt only runs in the rare
    // vanished-row window.
    // The insert-vs-conflict branch is the only place that knows whether this
    // call actually added the climb, so it rides back to the caller as
    // `wasAlreadyInPlaylist`. Mobile's picker can't tell on its own — it writes
    // its optimistic membership before invoking the mutation — and without this
    // it bumps the cached climbCount on every tap, inflating the count when a
    // climb that was already in the playlist is "added" again (#4014).
    const maxInsertAttempts = 2;
    const { playlistClimb, wasAlreadyInPlaylist } = await db.transaction(
      async (tx) => {
        for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
          const maxPosition = await tx
            .select({ max: sql<number>`coalesce(max(${dbSchema.playlistClimbs.position}), -1)` })
            .from(dbSchema.playlistClimbs)
            .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
            .limit(1);

          const nextPosition = (maxPosition[0]?.max ?? -1) + 1;

          const [insertedClimb] = await tx
            .insert(dbSchema.playlistClimbs)
            .values({
              playlistId,
              climbUuid: validatedInput.climbUuid,
              angle: validatedInput.angle,
              position: nextPosition,
              addedAt: new Date(),
            })
            .onConflictDoNothing({
              target: [dbSchema.playlistClimbs.playlistId, dbSchema.playlistClimbs.climbUuid],
            })
            .returning();

          if (insertedClimb) {
            const now = new Date();
            await tx
              .update(dbSchema.playlists)
              .set({ updatedAt: now, lastAccessedAt: now })
              .where(eq(dbSchema.playlists.id, playlistId));

            return { playlistClimb: insertedClimb, wasAlreadyInPlaylist: false };
          }

          // Conflict hit: a concurrent insert won the race. Re-select the
          // winner's row and hand it back unchanged (no updatedAt bump), which
          // is what the old pre-check branch did for an already-present climb.
          const [existingClimb] = await tx
            .select()
            .from(dbSchema.playlistClimbs)
            .where(
              and(
                eq(dbSchema.playlistClimbs.playlistId, playlistId),
                eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid),
              ),
            )
            .limit(1);

          if (existingClimb) {
            return { playlistClimb: existingClimb, wasAlreadyInPlaylist: true };
          }
        }

        throw new Error('Failed to add climb to playlist: conflicting row kept vanishing between insert and re-select');
      },
      { isolationLevel: 'read committed' },
    );

    return {
      id: playlistClimb.id.toString(),
      playlistId: validatedInput.playlistId,
      climbUuid: playlistClimb.climbUuid,
      angle: playlistClimb.angle,
      position: playlistClimb.position,
      addedAt: playlistClimb.addedAt.toISOString(),
      wasAlreadyInPlaylist,
    };
  },

  /**
   * Remove a climb from a playlist
   */
  removeClimbFromPlaylist: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(RemoveClimbFromPlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check owner role. Editors/viewers retain private read access, but cannot
    // mutate playlist contents.
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    const playlistId = ownership[0].id;

    // Remove climb from playlist
    // Note: Position gaps are acceptable after deletion. The position field is only used
    // for ordering (ORDER BY position), so gaps don't affect functionality. Reordering
    // positions after each deletion would be expensive for large playlists.
    //
    // `.returning()` so the boolean means "a row was actually deleted" rather
    // than the constant `true` it used to be. Removing a climb that isn't in
    // the playlist stays a successful no-op (no error), but the caller can now
    // tell the two apart — mobile skips its optimistic climbCount decrement on
    // a no-op remove (#4014).
    const deletedRows = await db
      .delete(dbSchema.playlistClimbs)
      .where(
        and(
          eq(dbSchema.playlistClimbs.playlistId, playlistId),
          eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid),
        ),
      )
      .returning({ id: dbSchema.playlistClimbs.id });

    const removed = deletedRows.length > 0;

    // Update playlist updatedAt — only when the playlist's contents actually
    // changed, so a no-op remove doesn't bump it.
    if (removed) {
      await db.update(dbSchema.playlists).set({ updatedAt: new Date() }).where(eq(dbSchema.playlists.id, playlistId));
    }

    return removed;
  },

  /**
   * Reorder a climb within a playlist by moving it to a new 0-based index.
   *
   * Single-move semantics: the server derives the climb's current index from the
   * DB (so position gaps left by prior deletions don't matter, and the client
   * never has to send a stale oldIndex), splices it to the clamped target index,
   * then renumbers positions to a dense 0..n-1. Only rows whose position actually
   * changed are written.
   *
   * `newIndex` is read in the client's index space — the rendered list, which
   * excludes playlist rows whose climb_uuid doesn't resolve in board_climbs — and
   * translated back to the full list before splicing (#4012).
   *
   * That index space is specifically the ALL-BOARDS `playlistClimbs` list, the
   * one the only editor renders: the mobile playlist screen deliberately omits
   * `boardName` so off-board climbs stay listed (dimmed) instead of being
   * filtered out. A future editor that reordered from a board-SCOPED list would
   * be numbering against a shorter list again, and this input carries no board
   * argument to infer that from — it would have to start sending one.
   */
  reorderPlaylistClimb: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(ReorderPlaylistClimbInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check owner role (same gate as add/remove climb).
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    const playlistId = ownership[0].id;

    await db.transaction(async (tx) => {
      // Full ordered list — the same order clients see (position, then addedAt).
      // `for('update')` locks these rows for the transaction so two overlapping
      // reorders on the same playlist can't both read the same snapshot and have
      // the second renumber clobber the first (silently losing a move).
      const rows = await tx
        .select({
          id: dbSchema.playlistClimbs.id,
          climbUuid: dbSchema.playlistClimbs.climbUuid,
          position: dbSchema.playlistClimbs.position,
        })
        .from(dbSchema.playlistClimbs)
        .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
        .orderBy(asc(dbSchema.playlistClimbs.position), asc(dbSchema.playlistClimbs.addedAt))
        .for('update');

      // `newIndex` is an index into the list the client RENDERS, and that list
      // comes from the playlistClimbs query, which inner-joins board_climbs — a
      // playlist row whose climb_uuid no longer resolves is dropped there while
      // still holding a position here. Without translating index spaces, one such
      // row ahead of the target silently shifts every move below it by one (#4012).
      //
      // Visibility is resolved with a second statement rather than a LEFT JOIN on
      // the locked select above: Postgres rejects FOR UPDATE on the nullable side
      // of an outer join. Playlists are small and board_climbs.uuid is the primary
      // key, so this is an index scan over a handful of ids.
      const rowClimbUuids = rows.map((row) => row.climbUuid);
      const resolvableRows: Array<{ uuid: string }> =
        rowClimbUuids.length === 0
          ? []
          : await tx
              .select({ uuid: UNIFIED_TABLES.climbs.uuid })
              .from(UNIFIED_TABLES.climbs)
              .where(inArray(UNIFIED_TABLES.climbs.uuid, rowClimbUuids));
      const resolvableClimbUuids = new Set(resolvableRows.map((row) => row.uuid));

      // Throws if the climb isn't in the playlist; returns only the rows whose
      // position actually shifts (dense 0..n-1 renumber).
      const writes = computePlaylistReorderWrites(
        rows,
        validatedInput.climbUuid,
        validatedInput.newIndex,
        resolvableClimbUuids,
      );

      // Persist every shifted row in ONE statement — a `CASE id WHEN … THEN …`
      // update — rather than a write per row. A move to the front of a 100-climb
      // playlist is then a single round-trip, not ~99. The position column has no
      // unique constraint, so the intermediate state never collides.
      if (writes.length > 0) {
        const idColumn = dbSchema.playlistClimbs.id;
        // Cast each THEN so the CASE is typed `integer`: untyped params make
        // Postgres resolve the CASE to `text`, which the integer column rejects (42804).
        const positionCase = sql`case ${idColumn} ${sql.join(
          writes.map((write) => sql`when ${write.id} then ${write.position}::integer`),
          sql` `,
        )} end`;
        await tx
          .update(dbSchema.playlistClimbs)
          .set({ position: positionCase })
          .where(
            inArray(
              idColumn,
              writes.map((write) => write.id),
            ),
          );
      }

      await tx.update(dbSchema.playlists).set({ updatedAt: new Date() }).where(eq(dbSchema.playlists.id, playlistId));
    });

    return true;
  },

  /**
   * Update only lastAccessedAt for a playlist (does not update updatedAt)
   */
  updatePlaylistLastAccessed: async (
    _: unknown,
    { playlistId }: { playlistId: string },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Only owners may move a playlist in their library ordering.
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(
        and(
          eq(dbSchema.playlists.uuid, playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner'),
        ),
      )
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    await db
      .update(dbSchema.playlists)
      .set({ lastAccessedAt: new Date() })
      .where(eq(dbSchema.playlists.id, ownership[0].id));

    return true;
  },

  /**
   * Follow a public playlist. Idempotent (onConflictDoNothing).
   */
  followPlaylist: async (
    _: unknown,
    { input }: { input: { playlistUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(FollowPlaylistInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Verify playlist exists and is public
    const [playlist] = await db
      .select({
        uuid: dbSchema.playlists.uuid,
        isPublic: dbSchema.playlists.isPublic,
      })
      .from(dbSchema.playlists)
      .where(eq(dbSchema.playlists.uuid, validatedInput.playlistUuid))
      .limit(1);

    if (!playlist) {
      throw new Error('Playlist not found');
    }
    if (!playlist.isPublic) {
      throw new Error('Cannot follow a private playlist');
    }

    await db
      .insert(dbSchema.playlistFollows)
      .values({
        followerId: userId,
        playlistUuid: validatedInput.playlistUuid,
      })
      .onConflictDoNothing();

    return true;
  },

  /**
   * Unfollow a playlist.
   */
  unfollowPlaylist: async (
    _: unknown,
    { input }: { input: { playlistUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(FollowPlaylistInputSchema, input, 'input');
    const userId = ctx.userId!;

    await db
      .delete(dbSchema.playlistFollows)
      .where(
        and(
          eq(dbSchema.playlistFollows.followerId, userId),
          eq(dbSchema.playlistFollows.playlistUuid, validatedInput.playlistUuid),
        ),
      );

    return true;
  },

  /**
   * Pin a playlist to the user's library. Idempotent.
   * verifyPlaylistAccess gates: own private/public + others' public are pinnable;
   * others' private playlists throw access-denied.
   */
  pinPlaylist: async (
    _: unknown,
    { input }: { input: { playlistUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(PinPlaylistInputSchema, input, 'input');
    const userId = ctx.userId!;

    const playlistId = await verifyPlaylistAccess(validatedInput.playlistUuid, userId);

    await db.insert(dbSchema.userPlaylistPins).values({ userId, playlistId }).onConflictDoNothing();

    return true;
  },

  /**
   * Unpin a playlist. Idempotent.
   */
  unpinPlaylist: async (
    _: unknown,
    { input }: { input: { playlistUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(PinPlaylistInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Resolve uuid -> id without an access check: unpinning is always safe,
    // and we want to allow users to unpin a playlist that's since been made
    // private or that they no longer own.
    const [row] = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlists)
      .where(eq(dbSchema.playlists.uuid, validatedInput.playlistUuid))
      .limit(1);

    if (!row) return true;

    await db
      .delete(dbSchema.userPlaylistPins)
      .where(and(eq(dbSchema.userPlaylistPins.userId, userId), eq(dbSchema.userPlaylistPins.playlistId, row.id)));

    return true;
  },
};
