import { eq, and, sql } from 'drizzle-orm';
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
  FollowPlaylistInputSchema,
  PinPlaylistInputSchema,
} from '../../../validation/schemas';
import { getPlaylistFollowStats } from './queries';
import { verifyPlaylistAccess } from './helpers/enrichment';

export const playlistMutations = {
  /**
   * Create a new playlist with the authenticated user as owner
   */
  createPlaylist: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext): Promise<unknown> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(CreatePlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;
    // Use the client-supplied UUID (offline idempotency key) when present,
    // otherwise generate one. On replay the unique uuid collides, the insert is
    // a no-op, and we return the existing playlist without re-inserting ownership.
    const uuid = validatedInput.uuid ?? uuidv4();
    const now = new Date();

    // Create playlist. ON CONFLICT (uuid) DO NOTHING makes offline replay safe.
    const [playlist] = await db
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
      .onConflictDoNothing({ target: dbSchema.playlists.uuid })
      .returning();

    // Conflict no-op: the playlist already exists from a prior save of this same
    // idempotency key. Return it as-is and skip the ownership insert (it already
    // exists too). Climb count and follow/pin stats are re-derived for accuracy.
    if (!playlist) {
      const [existing] = await db.select().from(dbSchema.playlists).where(eq(dbSchema.playlists.uuid, uuid)).limit(1);

      if (!existing) {
        throw new Error('Playlist conflict resolved to a missing row');
      }

      const [climbCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dbSchema.playlistClimbs)
        .where(eq(dbSchema.playlistClimbs.playlistId, existing.id));

      const [ownerRow] = await db
        .select({ role: dbSchema.playlistOwnership.role })
        .from(dbSchema.playlistOwnership)
        .where(
          and(eq(dbSchema.playlistOwnership.playlistId, existing.id), eq(dbSchema.playlistOwnership.userId, userId)),
        )
        .limit(1);

      return {
        id: existing.id.toString(),
        uuid: existing.uuid,
        boardType: existing.boardType,
        layoutId: existing.layoutId,
        name: existing.name,
        description: existing.description,
        isPublic: existing.isPublic,
        color: existing.color,
        icon: existing.icon,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
        climbCount: climbCount?.count ?? 0,
        userRole: ownerRow?.role ?? null,
        followerCount: 0,
        isFollowedByMe: false,
        isPinnedByMe: false,
      };
    }

    // Create ownership
    await db.insert(dbSchema.playlistOwnership).values({
      playlistId: playlist.id,
      userId,
      role: 'owner',
      createdAt: now,
    });

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
      climbCount: 0,
      userRole: 'owner',
      followerCount: 0,
      isFollowedByMe: false,
      isPinnedByMe: false,
    };
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

    if (validatedInput.name !== undefined) updateData.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateData.description = validatedInput.description;
    if (validatedInput.isPublic !== undefined) updateData.isPublic = validatedInput.isPublic;
    if (validatedInput.color !== undefined) updateData.color = validatedInput.color;
    if (validatedInput.icon !== undefined) updateData.icon = validatedInput.icon;

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

    // Check ownership/access
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(and(eq(dbSchema.playlists.uuid, validatedInput.playlistId), eq(dbSchema.playlistOwnership.userId, userId)))
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    const playlistId = ownership[0].id;

    // Check if climb already exists in playlist
    const existing = await db
      .select()
      .from(dbSchema.playlistClimbs)
      .where(
        and(
          eq(dbSchema.playlistClimbs.playlistId, playlistId),
          eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Already in playlist - return existing
      return {
        id: existing[0].id.toString(),
        playlistId: validatedInput.playlistId,
        climbUuid: existing[0].climbUuid,
        angle: existing[0].angle,
        position: existing[0].position,
        addedAt: existing[0].addedAt.toISOString(),
      };
    }

    // Use transaction to prevent race condition in position assignment
    const playlistClimb = await db.transaction(async (tx) => {
      // Get max position within transaction
      const maxPosition = await tx
        .select({ max: sql<number>`coalesce(max(${dbSchema.playlistClimbs.position}), -1)` })
        .from(dbSchema.playlistClimbs)
        .where(eq(dbSchema.playlistClimbs.playlistId, playlistId))
        .limit(1);

      const nextPosition = (maxPosition[0]?.max ?? -1) + 1;

      // Add climb to playlist
      const [newClimb] = await tx
        .insert(dbSchema.playlistClimbs)
        .values({
          playlistId,
          climbUuid: validatedInput.climbUuid,
          angle: validatedInput.angle,
          position: nextPosition,
          addedAt: new Date(),
        })
        .returning();

      // Update playlist updatedAt and lastAccessedAt
      const now = new Date();
      await tx
        .update(dbSchema.playlists)
        .set({ updatedAt: now, lastAccessedAt: now })
        .where(eq(dbSchema.playlists.id, playlistId));

      return newClimb;
    });

    return {
      id: playlistClimb.id.toString(),
      playlistId: validatedInput.playlistId,
      climbUuid: playlistClimb.climbUuid,
      angle: playlistClimb.angle,
      position: playlistClimb.position,
      addedAt: playlistClimb.addedAt.toISOString(),
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

    // Check ownership/access
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(and(eq(dbSchema.playlists.uuid, validatedInput.playlistId), eq(dbSchema.playlistOwnership.userId, userId)))
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or you do not have permission to edit it');
    }

    const playlistId = ownership[0].id;

    // Remove climb from playlist
    // Note: Position gaps are acceptable after deletion. The position field is only used
    // for ordering (ORDER BY position), so gaps don't affect functionality. Reordering
    // positions after each deletion would be expensive for large playlists.
    await db
      .delete(dbSchema.playlistClimbs)
      .where(
        and(
          eq(dbSchema.playlistClimbs.playlistId, playlistId),
          eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid),
        ),
      );

    // Update playlist updatedAt
    await db.update(dbSchema.playlists).set({ updatedAt: new Date() }).where(eq(dbSchema.playlists.id, playlistId));

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

    // Verify ownership
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(dbSchema.playlists, eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId))
      .where(and(eq(dbSchema.playlists.uuid, playlistId), eq(dbSchema.playlistOwnership.userId, userId)))
      .limit(1);

    if (ownership.length === 0) {
      throw new Error('Playlist not found or access denied');
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
