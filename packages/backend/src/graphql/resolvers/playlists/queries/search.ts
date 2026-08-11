import { eq, and, desc, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../../shared/helpers';
import { SearchPlaylistsInputSchema } from '../../../../validation/schemas';
import { formatPublicPlaylist } from '../helpers/enrichment';
import { PUBLIC_PLAYLIST_GROUP_BY, publicPlaylistBaseQuery, publicPlaylistCountQuery } from './discover';
import { escapeLikePattern } from '../../../../utils/like-pattern';

/**
 * Search public playlists globally by name.
 * No authentication required.
 */
export const searchPlaylists = async (
  _: unknown,
  { input }: { input: unknown },
  _ctx: ConnectionContext,
): Promise<{ playlists: unknown[]; totalCount: number; hasMore: boolean }> => {
  const validatedInput = validateInput(SearchPlaylistsInputSchema, input, 'input');

  const limit = validatedInput.limit ?? 20;
  const offset = validatedInput.offset ?? 0;

  const conditions = [eq(dbSchema.playlists.isPublic, true)];

  // Name filter (required, ILIKE partial match)
  const escapedQuery = escapeLikePattern(validatedInput.query);
  conditions.push(sql`LOWER(${dbSchema.playlists.name}) LIKE LOWER(${'%' + escapedQuery + '%'})`);

  if (validatedInput.boardType) {
    conditions.push(eq(dbSchema.playlists.boardType, validatedInput.boardType));
  }

  const whereClause = and(...conditions, eq(dbSchema.playlistOwnership.role, 'owner'));

  const countResult = await publicPlaylistCountQuery().where(whereClause);
  const totalCount = countResult[0]?.count || 0;

  const results = await publicPlaylistBaseQuery()
    .where(whereClause)
    .groupBy(...PUBLIC_PLAYLIST_GROUP_BY)
    .orderBy(
      desc(sql`count(DISTINCT ${dbSchema.playlistClimbs.id})`),
      desc(dbSchema.playlists.createdAt),
      desc(dbSchema.playlists.id),
    )
    .limit(limit + 1)
    .offset(offset);

  const hasMore = results.length > limit;
  const trimmed = hasMore ? results.slice(0, limit) : results;

  return {
    playlists: trimmed.map(formatPublicPlaylist),
    totalCount,
    hasMore,
  };
};
