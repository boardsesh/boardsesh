import { eq, asc } from 'drizzle-orm';
import type { ConnectionContext, FollowedAuthors } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { setterFollows, userFollows, userBoardMappings } from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit } from '../shared/helpers';

export const followedAuthorQueries = {
  followedAuthors: async (_: unknown, _args: unknown, ctx: ConnectionContext): Promise<FollowedAuthors> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'followedAuthors');
    // One repeatable-read snapshot: an empty accounts list is complete, not an
    // indication that another page or a second profile request is needed.
    return db.transaction(
      async (tx) => {
        const setters = await tx
          .select({ setterUsername: setterFollows.setterUsername })
          .from(setterFollows)
          .where(eq(setterFollows.followerId, ctx.userId!))
          .orderBy(asc(setterFollows.setterUsername));
        const accounts = await tx
          .select({
            userId: userFollows.followingId,
            boardType: userBoardMappings.boardType,
            username: userBoardMappings.boardUsername,
          })
          .from(userFollows)
          .leftJoin(userBoardMappings, eq(userBoardMappings.userId, userFollows.followingId))
          .where(eq(userFollows.followerId, ctx.userId!))
          .orderBy(asc(userFollows.followingId), asc(userBoardMappings.boardType));
        const users = new Map<string, FollowedAuthors['users'][number]>();
        for (const account of accounts) {
          const followedUser = users.get(account.userId) ?? { userId: account.userId, boardAccounts: [] };
          if (account.boardType && account.username) {
            followedUser.boardAccounts.push({ boardType: account.boardType, username: account.username });
          }
          users.set(account.userId, followedUser);
        }
        return { setterUsernames: setters.map((setter) => setter.setterUsername), users: [...users.values()] };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  },
};
