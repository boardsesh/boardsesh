export { boardHistoryMutations } from './mutations';
export { boardHistoryQueries } from './queries';
export { boardHistorySubscriptions } from './subscriptions';
export { serializeBoardHistoryEntry, dbSourceToGraphql, graphqlSourceToDb } from './serialize';

/**
 * GraphQL union type resolver for BoardHistoryEvent — same pattern as
 * QueueEvent / SessionEvent (look at `__typename` carried on the payload).
 */
export const boardHistoryEventResolver = {
  __resolveType(obj: { __typename: string }) {
    return obj.__typename;
  },
};
