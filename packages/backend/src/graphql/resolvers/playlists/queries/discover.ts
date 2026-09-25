import { eq, and, or, isNull, inArray, notInArray, desc, sql, isNotNull } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../../shared/helpers';
import { DiscoverPlaylistsInputSchema, GetPlaylistCreatorsInputSchema } from '../../../../validation/schemas';
import { formatPublicPlaylist } from '../helpers/enrichment';
import { escapeLikePattern } from '../../../../utils/like-pattern';

/** Shared select fields for public playlist queries (discover + search). */
const PUBLIC_PLAYLIST_SELECT = {
  id: dbSchema.playlists.id,
  uuid: dbSchema.playlists.uuid,
  boardType: dbSchema.playlists.boardType,
  layoutId: dbSchema.playlists.layoutId,
  name: dbSchema.playlists.name,
  description: dbSchema.playlists.description,
  color: dbSchema.playlists.color,
  icon: dbSchema.playlists.icon,
  createdAt: dbSchema.playlists.createdAt,
  updatedAt: dbSchema.playlists.updatedAt,
  creatorId: dbSchema.playlistOwnership.userId,
  creatorName: sql<string>`COALESCE(${dbSchema.users.name}, 'Anonymous')`,
  climbCount: sql<number>`count(DISTINCT ${dbSchema.playlistClimbs.id})::int`,
  generatedRecommendation: dbSchema.playlists.generatedRecommendation,
} as const;

/** Shared GROUP BY columns for public playlist queries. */
const PUBLIC_PLAYLIST_GROUP_BY = [
  dbSchema.playlists.id,
  dbSchema.playlists.uuid,
  dbSchema.playlists.boardType,
  dbSchema.playlists.layoutId,
  dbSchema.playlists.name,
  dbSchema.playlists.description,
  dbSchema.playlists.color,
  dbSchema.playlists.icon,
  dbSchema.playlists.createdAt,
  dbSchema.playlists.updatedAt,
  dbSchema.playlistOwnership.userId,
  dbSchema.users.name,
  dbSchema.playlists.generatedRecommendation,
] as const;

/** Build the base query for public playlists with owner join + climb join. */
function publicPlaylistBaseQuery() {
  return db
    .select(PUBLIC_PLAYLIST_SELECT)
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.playlistClimbs, eq(dbSchema.playlistClimbs.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.playlistOwnership.userId));
}

/** Build the count query for public playlists. */
function publicPlaylistCountQuery() {
  return db
    .select({ count: sql<number>`count(DISTINCT ${dbSchema.playlists.id})::int` })
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.playlistClimbs, eq(dbSchema.playlistClimbs.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.playlistOwnership.userId));
}

// Re-export for search.ts to reuse
export { PUBLIC_PLAYLIST_SELECT, PUBLIC_PLAYLIST_GROUP_BY, publicPlaylistBaseQuery, publicPlaylistCountQuery };

/**
 * Discover public playlists with at least 1 climb.
 * No authentication required.
 */
export const discoverPlaylists = async (
  _: unknown,
  {
    input,
  }: {
    input: {
      boardType?: string;
      layoutId?: number;
      sizeId?: number | null;
      angle?: number | null;
      name?: string;
      creatorIds?: string[];
      excludeCreatorIds?: string[];
      minClimbs?: number;
      maxClimbs?: number;
      sortBy?: 'recent' | 'popular';
      generatedRecommendation?: boolean | null;
      page?: number;
      pageSize?: number;
    };
  },
  _ctx: ConnectionContext,
): Promise<{ playlists: unknown[]; totalCount: number; hasMore: boolean }> => {
  validateInput(DiscoverPlaylistsInputSchema, input, 'input');

  const page = input.page ?? 0;
  const pageSize = input.pageSize ?? 20;

  const conditions = [eq(dbSchema.playlists.isPublic, true)];

  if (input.boardType) {
    conditions.push(eq(dbSchema.playlists.boardType, input.boardType));
  }
  if (input.layoutId != null) {
    conditions.push(or(eq(dbSchema.playlists.layoutId, input.layoutId), isNull(dbSchema.playlists.layoutId))!);
  }
  if (input.name) {
    conditions.push(sql`LOWER(${dbSchema.playlists.name}) LIKE LOWER(${'%' + escapeLikePattern(input.name) + '%'})`);
  }
  if (input.creatorIds && input.creatorIds.length > 0) {
    conditions.push(inArray(dbSchema.playlistOwnership.userId, input.creatorIds));
  }
  // The viewer's own playlists on a discovery surface. This used to be filtered
  // CLIENT-side, which meant an owner's playlists still occupied server page
  // slots and silently shrank the grid they were removed from.
  if (input.excludeCreatorIds && input.excludeCreatorIds.length > 0) {
    conditions.push(notInArray(dbSchema.playlistOwnership.userId, input.excludeCreatorIds));
  }
  if (input.generatedRecommendation != null) {
    conditions.push(
      input.generatedRecommendation
        ? isNotNull(dbSchema.playlists.generatedRecommendation)
        : isNull(dbSchema.playlists.generatedRecommendation),
    );
  }
  if (
    input.generatedRecommendation === true &&
    input.boardType &&
    input.layoutId != null &&
    input.sizeId != null &&
    input.angle != null
  ) {
    conditions.push(
      sql`${dbSchema.playlists.generatedRecommendation} LIKE ${`${input.boardType}:${input.layoutId}:${input.sizeId}:${input.angle}:%`}`,
    );
  }

  const whereClause = and(...conditions, eq(dbSchema.playlistOwnership.role, 'owner'));

  // A size band, not just a floor. The floor drops one-climb scratch lists; the
  // ceiling drops the 600-climb "favorites" dumps that are a data export with a
  // playlist's name on it, and which a climb-count sort put at the very top.
  const havingParts = [];
  if (input.minClimbs != null) {
    havingParts.push(sql`count(DISTINCT ${dbSchema.playlistClimbs.id}) >= ${input.minClimbs}`);
  }
  if (input.maxClimbs != null) {
    havingParts.push(sql`count(DISTINCT ${dbSchema.playlistClimbs.id}) <= ${input.maxClimbs}`);
  }
  const havingClause = havingParts.length > 0 ? and(...havingParts) : undefined;

  // How many DISTINCT climbers kept this playlist. Both tables carry a unique
  // (user, playlist) constraint, so a plain count IS a distinct-user count, and
  // both are indexed on the playlist column.
  const engagement = sql`(
    (SELECT count(*) FROM ${dbSchema.userPlaylistPins} WHERE ${dbSchema.userPlaylistPins.playlistId} = ${dbSchema.playlists.id})
    + (SELECT count(*) FROM ${dbSchema.playlistFollows} WHERE ${dbSchema.playlistFollows.playlistUuid} = ${dbSchema.playlists.uuid})
  )`;

  // The count has to see the HAVING too, or the page reports a total it will
  // never show. `count(DISTINCT id)` cannot carry a HAVING on its own — it has no
  // GROUP BY — so when a size band is in play the rows are grouped first and the
  // groups counted.
  const totalCount = havingClause
    ? ((
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(
            db
              .select({ id: dbSchema.playlists.id })
              .from(dbSchema.playlists)
              .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
              .innerJoin(dbSchema.playlistClimbs, eq(dbSchema.playlistClimbs.playlistId, dbSchema.playlists.id))
              .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.playlistOwnership.userId))
              .where(whereClause)
              .groupBy(dbSchema.playlists.id)
              .having(havingClause)
              .as('banded'),
          )
      )[0]?.count ?? 0)
    : ((await publicPlaylistCountQuery().where(whereClause))[0]?.count ?? 0);

  const results = await publicPlaylistBaseQuery()
    .where(whereClause)
    .groupBy(...PUBLIC_PLAYLIST_GROUP_BY)
    .having(havingClause)
    .orderBy(
      // 'popular' used to mean count(climbs) DESC — biggest, not popular. It is
      // now what climbers actually kept, with size as the tiebreak. That tiebreak
      // is load-bearing while pins are scarce: at 106 pins across 829 public
      // playlists most rows tie at zero engagement, and this degrades to exactly
      // the old ordering rather than going arbitrary.
      ...(input.sortBy === 'popular'
        ? [desc(engagement), desc(sql`count(DISTINCT ${dbSchema.playlistClimbs.id})`)]
        : [desc(dbSchema.playlists.createdAt)]),
      desc(dbSchema.playlists.updatedAt),
      desc(dbSchema.playlists.id),
    )
    .limit(pageSize + 1)
    .offset(page * pageSize);

  const hasMore = results.length > pageSize;
  const trimmed = hasMore ? results.slice(0, pageSize) : results;

  return {
    playlists: trimmed.map(formatPublicPlaylist),
    totalCount,
    hasMore,
  };
};

/**
 * Get playlist creators for autocomplete.
 * Returns users who have created public playlists with at least 1 climb.
 */
export const playlistCreators = async (
  _: unknown,
  {
    input,
  }: {
    input: {
      boardType: string;
      layoutId: number;
      searchQuery?: string;
    };
  },
  _ctx: ConnectionContext,
): Promise<unknown[]> => {
  validateInput(GetPlaylistCreatorsInputSchema, input, 'input');

  const conditions = [
    eq(dbSchema.playlists.isPublic, true),
    eq(dbSchema.playlists.boardType, input.boardType),
    or(eq(dbSchema.playlists.layoutId, input.layoutId), isNull(dbSchema.playlists.layoutId)),
    eq(dbSchema.playlistOwnership.role, 'owner'),
  ];

  if (input.searchQuery) {
    conditions.push(sql`LOWER(${dbSchema.users.name}) LIKE LOWER(${'%' + escapeLikePattern(input.searchQuery) + '%'})`);
  }

  const results = await db
    .select({
      userId: dbSchema.playlistOwnership.userId,
      displayName: sql<string>`COALESCE(${dbSchema.users.name}, 'Anonymous')`,
      playlistCount: sql<number>`count(DISTINCT ${dbSchema.playlists.id})::int`,
    })
    .from(dbSchema.playlists)
    .innerJoin(dbSchema.playlistOwnership, eq(dbSchema.playlistOwnership.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.playlistClimbs, eq(dbSchema.playlistClimbs.playlistId, dbSchema.playlists.id))
    .innerJoin(dbSchema.users, eq(dbSchema.users.id, dbSchema.playlistOwnership.userId))
    .where(and(...conditions))
    .groupBy(dbSchema.playlistOwnership.userId, dbSchema.users.name)
    .orderBy(desc(sql`count(DISTINCT ${dbSchema.playlists.id})`))
    .limit(20);

  return results;
};
