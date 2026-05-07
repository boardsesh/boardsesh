// GraphQL Queue - New graphql-ws based queue management
export { createGraphQLClient, execute, subscribe } from './graphql-client';
export type { Client } from './graphql-client';

export {
  GraphQLQueueProvider,
  useGraphQLQueueContext,
  useQueueContext,
  useOptionalQueueContext,
  useQueueActions,
  useOptionalQueueActions,
  useQueueData,
  useOptionalQueueData,
  QueueContext,
  QueueActionsContext,
  QueueDataContext,
  // Fine-grained hooks for targeted subscriptions
  useCurrentClimb,
  useOptionalCurrentClimb,
  useCurrentClimbUuid,
  useRemoteClimbChangeCount,
  useQueueList,
  useSearchData,
  useSessionData,
  useOptionalSessionData,
  // Fine-grained context objects
  CurrentClimbContext,
  CurrentClimbUuidContext,
  RemoteClimbChangeCountContext,
  QueueListContext,
  SearchContext,
  SessionContext,
} from './QueueContext';
export type { GraphQLQueueContextType, GraphQLQueueActionsType, GraphQLQueueDataType } from './types';
export type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from './types';
