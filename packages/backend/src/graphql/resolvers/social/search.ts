import { eq, and, or, ilike, sql, count, desc, asc } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { SearchUsersInputSchema } from '../../../validation/schemas';

export const socialSearchQueries = {
  /**
   * Search for users by name
   */
  searchUsers: async (
    _: unknown,
    { input }: { input: { query: string; boardType?: string; limit?: number; offset?: number } },
    ctx: ConnectionContext,
  ) => {
    await applyRateLimit(ctx, 20, 'searchUsers');

    const validatedInput = validateInput(SearchUsersInputSchema, input, 'input');
    const query = validatedInput.query;
    const boardType = validatedInput.boardType;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    // Escape LIKE wildcards (%, _) in user input to prevent pattern injection
    const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
    const searchPattern = `%${escapedQuery}%`;
    const prefixPattern = `${escapedQuery}%`;

    const searchConditions = or(
      ilike(dbSchema.userProfiles.displayName, searchPattern),
      ilike(dbSchema.users.name, searchPattern),
    );

    // Count total matches
    let countQuery = db
      .select({ count: count() })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(searchConditions);

    if (boardType) {
      countQuery = db
        .select({ count: count() })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .innerJoin(
          dbSchema.userBoardMappings,
          and(
            eq(dbSchema.users.id, dbSchema.userBoardMappings.userId),
            eq(dbSchema.userBoardMappings.boardType, boardType),
          ),
        )
        .where(searchConditions);
    }

    const countResult = await countQuery;
    const totalCount = Number(countResult[0]?.count || 0);

    // Compute a date threshold for recent ascent counts
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

    // Build select fields with SQL subqueries to avoid N+1
    const selectFields = {
      id: dbSchema.users.id,
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
      followerCount: sql<number>`(select count(*)::int from user_follows where following_id = ${dbSchema.users.id})`,
      followingCount: sql<number>`(select count(*)::int from user_follows where follower_id = ${dbSchema.users.id})`,
      recentAscentCount: sql<number>`(select count(*)::int from boardsesh_ticks where user_id = ${dbSchema.users.id} and created_at > ${thirtyDaysAgoIso})`,
      isFollowedByMe:
        ctx.isAuthenticated && ctx.userId
          ? sql<boolean>`exists(select 1 from user_follows where follower_id = ${ctx.userId} and following_id = ${dbSchema.users.id})`
          : sql<boolean>`false`,
    };

    // Sort in SQL: prefix matches first, then by recent ascent count DESC
    const orderByExpressions = [
      asc(
        sql`case when ${dbSchema.userProfiles.displayName} ilike ${prefixPattern} or ${dbSchema.users.name} ilike ${prefixPattern} then 0 else 1 end`,
      ),
      desc(
        sql`(select count(*)::int from boardsesh_ticks where user_id = ${dbSchema.users.id} and created_at > ${thirtyDaysAgoIso})`,
      ),
    ];

    // Build query with appropriate joins
    let resultsQuery;
    if (boardType) {
      resultsQuery = db
        .select(selectFields)
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .innerJoin(
          dbSchema.userBoardMappings,
          and(
            eq(dbSchema.users.id, dbSchema.userBoardMappings.userId),
            eq(dbSchema.userBoardMappings.boardType, boardType),
          ),
        )
        .where(searchConditions)
        .orderBy(...orderByExpressions)
        .limit(limit)
        .offset(offset);
    } else {
      resultsQuery = db
        .select(selectFields)
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .where(searchConditions)
        .orderBy(...orderByExpressions)
        .limit(limit)
        .offset(offset);
    }

    const results = await resultsQuery;

    // Map to response (no additional queries needed)
    const searchResults = results.map((row) => {
      const lowerQuery = query.toLowerCase();
      let matchReason: string | undefined;
      if (row.displayName?.toLowerCase().includes(lowerQuery) || row.name?.toLowerCase().includes(lowerQuery)) {
        matchReason = 'name match';
      }

      return {
        user: {
          id: row.id,
          displayName: row.displayName || row.name || undefined,
          avatarUrl: row.avatarUrl || row.image || undefined,
          followerCount: Number(row.followerCount ?? 0),
          followingCount: Number(row.followingCount ?? 0),
          isFollowedByMe: Boolean(row.isFollowedByMe),
        },
        recentAscentCount: Number(row.recentAscentCount ?? 0),
        matchReason,
      };
    });

    return {
      results: searchResults,
      totalCount,
      hasMore: offset + searchResults.length < totalCount,
    };
  },
};
