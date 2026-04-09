import { eq, and, or, isNull, inArray, sql } from 'drizzle-orm';

import type { RequestDbInstance } from '../../../../db/client';import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../../shared/helpers';
import {
  GetPlaylistsForClimbInputSchema,
  GetPlaylistsForClimbsInputSchema,
} from '../../../../validation/schemas';
import { getPlaylistFollowStats } from '../helpers/follow-stats';

/**
 * Get a specific playlist by ID.
 * Public playlists are viewable by anyone; private playlists require ownership.
 */
export const playlist = async (
  _: unknown,
  { playlistId }: { playlistId: string },
  ctx: ConnectionContext,
): Promise<unknown | null> => {
  const userId = ctx.userId;

  const playlistResult = await db
    .select({
      id: dbSchema.playlists.id,
      uuid: dbSchema.playlists.uuid,
      boardType: dbSchema.playlists.boardType,
      layoutId: dbSchema.playlists.layoutId,
      name: dbSchema.playlists.name,
      description: dbSchema.playlists.description,
      isPublic: dbSchema.playlists.isPublic,
      color: dbSchema.playlists.color,
      icon: dbSchema.playlists.icon,
      createdAt: dbSchema.playlists.createdAt,
      updatedAt: dbSchema.playlists.updatedAt,
      lastAccessedAt: dbSchema.playlists.lastAccessedAt,
    })
    .from(dbSchema.playlists)
    .where(eq(dbSchema.playlists.uuid, playlistId))
    .limit(1);

  if (playlistResult.length === 0) return null;

  const p = playlistResult[0];

  // Check user's role if authenticated
  let userRole: string | null = null;
  if (userId) {
    const ownershipResult = await db
      .select({ role: dbSchema.playlistOwnership.role })
      .from(dbSchema.playlistOwnership)
      .where(
        and(
          eq(dbSchema.playlistOwnership.playlistId, p.id),
          eq(dbSchema.playlistOwnership.userId, userId),
        ),
      )
      .limit(1);

    if (ownershipResult.length > 0) {
      userRole = ownershipResult[0].role;
    }
  }

  // If playlist is private and user is not an owner/member, deny access
  if (!p.isPublic && !userRole) {
    return null;
  }

  // Get climb count
  const climbCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dbSchema.playlistClimbs)
    .where(eq(dbSchema.playlistClimbs.playlistId, p.id))
    .limit(1);

  // Get follow stats
  const followStats = await getPlaylistFollowStats([p.uuid], userId ?? null);
  const stats = followStats.get(p.uuid) ?? { followerCount: 0, isFollowedByMe: false };

  return {
    id: p.id.toString(),
    uuid: p.uuid,
    boardType: p.boardType,
    layoutId: p.layoutId,
    name: p.name,
    description: p.description,
    isPublic: p.isPublic,
    color: p.color,
    icon: p.icon,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lastAccessedAt: p.lastAccessedAt?.toISOString() ?? null,
    climbCount: climbCount[0]?.count || 0,
    userRole,
    followerCount: stats.followerCount,
    isFollowedByMe: stats.isFollowedByMe,
  };
};

/**
 * Get all playlist UUIDs that contain a specific climb for the authenticated user.
 */
export const playlistsForClimb = async (
  _: unknown,
  { input }: { input: { boardType: string; layoutId: number; climbUuid: string } },
  ctx: ConnectionContext,
): Promise<string[]> => {
  requireAuthenticated(ctx);
  validateInput(GetPlaylistsForClimbInputSchema, input, 'input');

  const userId = ctx.userId!;

  const results = await db
    .select({ playlistUuid: dbSchema.playlists.uuid })
    .from(dbSchema.playlistClimbs)
    .innerJoin(
      dbSchema.playlists,
      eq(dbSchema.playlists.id, dbSchema.playlistClimbs.playlistId),
    )
    .innerJoin(
      dbSchema.playlistOwnership,
      eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id),
    )
    .where(
      and(
        eq(dbSchema.playlistClimbs.climbUuid, input.climbUuid),
        eq(dbSchema.playlists.boardType, input.boardType),
        or(
          eq(dbSchema.playlists.layoutId, input.layoutId),
          isNull(dbSchema.playlists.layoutId),
        ),
        eq(dbSchema.playlistOwnership.userId, userId),
      ),
    );

  return results.map(r => r.playlistUuid);
};

/**
 * Get playlist memberships for multiple climbs in a single query.
 * Returns a list of { climbUuid, playlistUuids } for each climb that has memberships.
 */
export const playlistsForClimbs = async (
  _: unknown,
  { input }: { input: { boardType: string; layoutId: number; climbUuids: string[] } },
  ctx: ConnectionContext,
): Promise<Array<{ climbUuid: string; playlistUuids: string[] }>> => {
  requireAuthenticated(ctx);
  validateInput(GetPlaylistsForClimbsInputSchema, input, 'input');

  const userId = ctx.userId!;

  const results = await db
    .select({
      climbUuid: dbSchema.playlistClimbs.climbUuid,
      playlistUuid: dbSchema.playlists.uuid,
    })
    .from(dbSchema.playlistClimbs)
    .innerJoin(
      dbSchema.playlists,
      eq(dbSchema.playlists.id, dbSchema.playlistClimbs.playlistId),
    )
    .innerJoin(
      dbSchema.playlistOwnership,
      eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id),
    )
    .where(
      and(
        inArray(dbSchema.playlistClimbs.climbUuid, input.climbUuids),
        eq(dbSchema.playlists.boardType, input.boardType),
        or(
          eq(dbSchema.playlists.layoutId, input.layoutId),
          isNull(dbSchema.playlists.layoutId),
        ),
        eq(dbSchema.playlistOwnership.userId, userId),
      ),
    );

  // Group results by climbUuid
  const grouped = new Map<string, string[]>();
  for (const row of results) {
    const existing = grouped.get(row.climbUuid);
    if (existing) {
      existing.push(row.playlistUuid);
    } else {
      grouped.set(row.climbUuid, [row.playlistUuid]);
    }
  }

  return Array.from(grouped.entries()).map(([climbUuid, playlistUuids]) => ({
    climbUuid,
    playlistUuids,
  }));
};
