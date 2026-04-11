import { eq, and, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../db/client';
import { withTransaction } from '../../../db/client';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import {
  CreatePlaylistInputSchema,
  UpdatePlaylistInputSchema,
  AddClimbToPlaylistInputSchema,
  RemoveClimbFromPlaylistInputSchema,
  FollowPlaylistInputSchema,
} from '../../../validation/schemas';
import { getPlaylistFollowStats } from './queries';

export const playlistMutations = {
  /**
   * Create a new playlist with the authenticated user as owner
   */
  createPlaylist: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext
  ): Promise<unknown> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validatedInput = validateInput(CreatePlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;
    const uuid = uuidv4();
    const now = new Date();

    // Create playlist
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
      .returning();

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
    };
  },

  /**
   * Update an existing playlist (requires owner role)
   */
  updatePlaylist: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext
  ): Promise<unknown> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validatedInput = validateInput(UpdatePlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check ownership
    const ownership = await db
      .select()
      .from(dbSchema.playlistOwnership)
      .innerJoin(
        dbSchema.playlists,
        eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId)
      )
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner')
        )
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

    const followStats = await getPlaylistFollowStats(db, [updated.uuid], userId);
    const stats = followStats.get(updated.uuid) ?? { followerCount: 0, isFollowedByMe: false };

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
    };
  },

  /**
   * Delete a playlist (requires owner role)
   */
  deletePlaylist: async (
    _: unknown,
    { playlistId }: { playlistId: string },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Check ownership
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(
        dbSchema.playlists,
        eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId)
      )
      .where(
        and(
          eq(dbSchema.playlists.uuid, playlistId),
          eq(dbSchema.playlistOwnership.userId, userId),
          eq(dbSchema.playlistOwnership.role, 'owner')
        )
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
  addClimbToPlaylist: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext
  ): Promise<unknown> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validatedInput = validateInput(AddClimbToPlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check ownership/access
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(
        dbSchema.playlists,
        eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId)
      )
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId)
        )
      )
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
          eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid)
        )
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
    const playlistClimb = await withTransaction(async (tx) => {
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
    ctx: ConnectionContext
  ): Promise<boolean> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validatedInput = validateInput(RemoveClimbFromPlaylistInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Check ownership/access
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(
        dbSchema.playlists,
        eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId)
      )
      .where(
        and(
          eq(dbSchema.playlists.uuid, validatedInput.playlistId),
          eq(dbSchema.playlistOwnership.userId, userId)
        )
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
    await db
      .delete(dbSchema.playlistClimbs)
      .where(
        and(
          eq(dbSchema.playlistClimbs.playlistId, playlistId),
          eq(dbSchema.playlistClimbs.climbUuid, validatedInput.climbUuid)
        )
      );

    // Update playlist updatedAt
    await db
      .update(dbSchema.playlists)
      .set({ updatedAt: new Date() })
      .where(eq(dbSchema.playlists.id, playlistId));

    return true;
  },

  /**
   * Update only lastAccessedAt for a playlist (does not update updatedAt)
   */
  updatePlaylistLastAccessed: async (
    _: unknown,
    { playlistId }: { playlistId: string },
    ctx: ConnectionContext
  ): Promise<boolean> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Verify ownership
    const ownership = await db
      .select({ id: dbSchema.playlists.id })
      .from(dbSchema.playlistOwnership)
      .innerJoin(
        dbSchema.playlists,
        eq(dbSchema.playlists.id, dbSchema.playlistOwnership.playlistId)
      )
      .where(
        and(
          eq(dbSchema.playlists.uuid, playlistId),
          eq(dbSchema.playlistOwnership.userId, userId)
        )
      )
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
    const db = ctx.db as RequestDbInstance;
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
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    const validatedInput = validateInput(FollowPlaylistInputSchema, input, 'input');
    const userId = ctx.userId!;

    await db
      .delete(dbSchema.playlistFollows)
      .where(
        and(
          eq(dbSchema.playlistFollows.followerId, userId),
          eq(dbSchema.playlistFollows.playlistUuid, validatedInput.playlistUuid)
        )
      );

    return true;
  },
};
