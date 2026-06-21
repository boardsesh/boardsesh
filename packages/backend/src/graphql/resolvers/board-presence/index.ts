import { boardPresenceMutations } from './mutations';
import { boardPresenceQueries } from './queries';
import { boardPresenceSubscriptions } from './subscription';

/**
 * Union resolver for `BoardPresenceEvent` (BoardClimbSet | BoardClimbCleared |
 * BoardStatsUpdated). Every event shape carries a literal `__typename`, so
 * resolve straight off it — matches the CommentEvent pattern in resolvers/index.ts.
 */
const boardPresenceEventResolver = {
  __resolveType(obj: { __typename: string }) {
    return obj.__typename;
  },
};

export const boardPresenceResolvers = {
  Query: boardPresenceQueries,
  Mutation: boardPresenceMutations,
  Subscription: boardPresenceSubscriptions,
  BoardPresenceEvent: boardPresenceEventResolver,
};
