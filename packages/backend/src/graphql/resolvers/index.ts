// eslint-disable-next-line import/no-named-as-default -- `graphql-type-json` exports both default and named `GraphQLJSON`; default is the canonical scalar.
import GraphQLJSON from 'graphql-type-json';

// Import domain resolvers
import { boardQueries } from './board/queries';
import { tickQueries } from './ticks/queries';
import { tickMutations } from './ticks/mutations';
import { climbStatsSubscriptions } from './ticks/climb-stats-subscriptions';
import { userQueries } from './users/queries';
import { userMutations } from './users/mutations';
import { climbQueries } from './climbs/queries';
import { climbMutations } from './climbs/mutations';
import { climbFieldResolvers } from './climbs/field-resolvers';
import { favoriteQueries } from './favorites/queries';
import { favoriteClimbsQuery } from './favorites/favorite-climbs-query';
import { favoriteMutations } from './favorites/mutations';
import { playlistQueries } from './playlists/queries';
import { playlistMutations } from './playlists/mutations';
import { sessionQueries } from './sessions/queries';
import { sessionMutations } from './sessions/mutations';
import { pushTokenMutations } from './sessions/push-tokens';
import { sessionSubscriptions } from './sessions/subscriptions';
import { sessionEventResolver } from './sessions/type-resolvers';
import { queueMutations } from './queue/mutations';
import { queueSubscriptions } from './queue/subscriptions';
import { queueEventResolver } from './queue/type-resolvers';
import { controllerQueries } from './controller/queries';
import { controllerMutations } from './controller/mutations';
import { controllerSubscriptions, controllerEventResolver } from './controller/subscriptions';
import { socialFollowQueries, socialFollowMutations } from './social/follows';
import { socialSearchQueries } from './social/search';
import { setterFollowQueries, setterFollowMutations } from './social/setter-follows';
import { socialFeedQueries } from './social/feed';
import { activityFeedQueries } from './social/activity-feed';
import { sessionFeedQueries } from './social/session-feed';
import { sessionEditMutations } from './social/session-mutations';
import { socialCommentQueries, socialCommentMutations } from './social/comments';
import { socialVoteQueries, socialVoteMutations } from './social/votes';
import { socialBoardQueries, socialBoardMutations } from './social/boards';
import { socialGymQueries, socialGymMutations } from './social/gyms';
import {
  socialNotificationQueries,
  socialNotificationMutations,
  socialNotificationSubscriptions,
} from './social/notifications';
import { socialCommentSubscriptions } from './social/comment-subscriptions';
import { socialProposalQueries, socialProposalMutations } from './social/proposals';
import { socialRoleQueries, socialRoleMutations } from './social/roles';
import { socialCommunitySettingsQueries, socialCommunitySettingsMutations } from './social/community-settings';
import { newClimbSubscriptionResolvers } from './social/new-climb-subscriptions';
import { newClimbFeedSubscription } from './social/new-climb-feed-subscription';
import { feedbackMutations } from './feedback/mutations';
import { betaLinkQueries } from './beta-videos/queries';
import { isNoMatchClimb } from './shared/helpers';

export const resolvers = {
  // Scalar types
  JSON: GraphQLJSON,

  // Root operation types
  Query: {
    ...sessionQueries,
    ...boardQueries,
    ...climbQueries,
    ...tickQueries,
    ...userQueries,
    ...favoriteQueries,
    ...favoriteClimbsQuery,
    ...playlistQueries,
    ...controllerQueries,
    ...socialFollowQueries,
    ...socialSearchQueries,
    ...setterFollowQueries,
    ...socialFeedQueries,
    ...socialCommentQueries,
    ...socialVoteQueries,
    ...socialBoardQueries,
    ...socialGymQueries,
    ...activityFeedQueries,
    ...sessionFeedQueries,
    ...socialNotificationQueries,
    ...socialProposalQueries,
    ...socialRoleQueries,
    ...socialCommunitySettingsQueries,
    ...newClimbSubscriptionResolvers.Query,
    ...betaLinkQueries,
  },

  Mutation: {
    ...sessionMutations,
    ...pushTokenMutations,
    ...queueMutations,
    ...tickMutations,
    ...climbMutations,
    ...userMutations,
    ...favoriteMutations,
    ...playlistMutations,
    ...controllerMutations,
    ...socialFollowMutations,
    ...setterFollowMutations,
    ...socialCommentMutations,
    ...socialVoteMutations,
    ...socialBoardMutations,
    ...socialGymMutations,
    ...socialNotificationMutations,
    ...socialProposalMutations,
    ...socialRoleMutations,
    ...socialCommunitySettingsMutations,
    ...newClimbSubscriptionResolvers.Mutation,
    ...sessionEditMutations,
    ...feedbackMutations,
  },

  Subscription: {
    ...sessionSubscriptions,
    ...queueSubscriptions,
    ...controllerSubscriptions,
    ...socialNotificationSubscriptions,
    ...socialCommentSubscriptions,
    ...newClimbFeedSubscription,
    ...climbStatsSubscriptions,
  },

  // Field-level resolvers
  ClimbSearchResult: climbFieldResolvers,

  // Climb type resolvers (derived fields)
  Climb: {
    is_no_match: (climb: { description?: string | null }) => isNoMatchClimb(climb.description),
  },

  // Union type resolvers
  QueueEvent: queueEventResolver,
  SessionEvent: sessionEventResolver,
  ControllerEvent: controllerEventResolver,
  CommentEvent: {
    __resolveType(obj: { __typename: string }) {
      return obj.__typename;
    },
  },
};
