import { playlistVisibilityCondition } from '../helpers/enrichment';
import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../../shared/helpers';
import { GetMyPinnedPlaylistsInputSchema } from '../../../../validation/schemas';
import { getPlaylistFollowStats } from '../helpers/follow-stats';
import { getClimbCounts, formatOwnedPlaylist, type OwnedPlaylistRow } from '../helpers/enrichment';

/**
 * Server-side cap. The pinned grid is a small surface; pins beyond this cap
 * are not surfaced (overflow is not shown — owned playlists also live in
 * "Jump Back In", but pins on other users' public playlists do not).
 */
const PINNED_LIMIT = 12;

/**
 * Get the authenticated user's pinned playlists. Pins are user-scoped:
 * a user can pin their own private/public playlists or anyone's public
 * playlist. Ordering is most-recently-pinned first.
 *
 * Single-query design: drives off userPlaylistPins (the user-scope of pins),
 * inner-joins playlists, and left-joins playlistOwnership scoped to the
 * current user so we get the user's role on each pinned playlist (or null,
 * mapped to 'viewer'). isPinnedByMe is hardcoded true — every row here is
 * a pin by construction.
 */
export const myPinnedPlaylists = async (
  _: unknown,
  { input }: { input: { boardType?: string; layoutId?: number } },
  ctx: ConnectionContext,
): Promise<unknown[]> => {
  requireAuthenticated(ctx);
  validateInput(GetMyPinnedPlaylistsInputSchema, input, 'input');

  const userId = ctx.userId!;

  const conditions = [eq(dbSchema.userPlaylistPins.userId, userId), playlistVisibilityCondition(userId)];

  if (input.boardType) {
    conditions.push(eq(dbSchema.playlists.boardType, input.boardType));
  }

  if (input.layoutId != null) {
    const layoutCondition = or(eq(dbSchema.playlists.layoutId, input.layoutId), isNull(dbSchema.playlists.layoutId));
    if (layoutCondition) {
      conditions.push(layoutCondition);
    }
  }

  const rows = await db
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
      // playlistOwnership is left-joined and scoped to the current user, so
      // the role column is populated for owned pins and null for pins on
      // other users' public playlists. Default to 'viewer' downstream.
      role: dbSchema.playlistOwnership.role,
      // Driven off userPlaylistPins via INNER JOIN — every row is pinned.
      isPinnedByMe: sql<boolean>`true`,
    })
    .from(dbSchema.userPlaylistPins)
    .innerJoin(dbSchema.playlists, eq(dbSchema.userPlaylistPins.playlistId, dbSchema.playlists.id))
    .leftJoin(
      dbSchema.playlistOwnership,
      and(
        eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id),
        eq(dbSchema.playlistOwnership.userId, userId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(dbSchema.userPlaylistPins.createdAt))
    .limit(PINNED_LIMIT);

  const owned: OwnedPlaylistRow[] = rows.map((row) => ({
    id: row.id,
    uuid: row.uuid,
    boardType: row.boardType,
    layoutId: row.layoutId,
    name: row.name,
    description: row.description,
    isPublic: row.isPublic,
    color: row.color,
    icon: row.icon,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAccessedAt: row.lastAccessedAt,
    role: row.role ?? 'viewer',
    isPinnedByMe: true,
  }));

  const [climbCounts, followStats] = await Promise.all([
    getClimbCounts(owned.map((p) => p.id)),
    getPlaylistFollowStats(
      owned.map((p) => p.uuid),
      userId,
    ),
  ]);
  return owned.map((p) => formatOwnedPlaylist(p, climbCounts, followStats));
};
