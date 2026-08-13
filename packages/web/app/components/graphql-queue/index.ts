// GraphQL Queue - New graphql-ws based queue management
export { createGraphQLClient, execute, subscribe } from '@/app/lib/realtime/graphql-client';
export type { Client } from '@/app/lib/realtime/graphql-client';

export {
  GraphQLQueueProvider,
  useGraphQLQueueContext,
  useQueueContext,
  useOptionalQueueContext,
  useQueueActions,
  useOptionalQueueActions,
  QueueContext,
  QueueActionsContext,
  // Fine-grained hooks for targeted subscriptions
  useCurrentClimb,
  useOptionalCurrentClimb,
  useCurrentClimbUuid,
  useQueueList,
  useSearchData,
  useSessionData,
  useOptionalSessionData,
  // Fine-grained context objects
  CurrentClimbContext,
  CurrentClimbUuidContext,
  QueueListContext,
  SearchContext,
  SessionContext,
} from './QueueContext';
export type { GraphQLQueueContextType, GraphQLQueueActionsType } from './types';
export type { CurrentClimbDataType, QueueListDataType, SearchDataType, SessionDataType } from './types';
