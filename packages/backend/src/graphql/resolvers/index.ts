import GraphQLJSON from 'graphql-type-json';

// Import domain resolvers
import { boardQueries } from './board/queries';
import { tickQueries } from './ticks/queries';
import { tickMutations } from './ticks/mutations';
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
import { socialNotificationQueries, socialNotificationMutations, socialNotificationSubscriptions } from './social/notifications';
import { socialCommentSubscriptions } from './social/comment-subscriptions';
import { socialProposalQueries, socialProposalMutations } from './social/proposals';
import { socialRoleQueries, socialRoleMutations } from './social/roles';
import { socialCommunitySettingsQueries, socialCommunitySettingsMutations } from './social/community-settings';
import { newClimbSubscriptionResolvers } from './social/new-climb-subscriptions';
import { newClimbFeedSubscription } from './social/new-climb-feed-subscription';

// New board data resolvers
import { climbStatsQuery } from './board/climb-stats';
import { betaLinksQuery } from './board/beta-links';
import { holdHeatmapQuery } from './board/hold-heatmap';
import { resolveSlugQuery } from './board/resolve-slug';
import { climbDetailQuery } from './board/climb-detail';
import { settersQuery } from './board/setters';
import { climbRedirectQuery } from './board/climb-redirect';

// New user management resolvers
import { publicProfileQuery } from './users/public-profile';
import { setPasswordMutation } from './users/set-password';
import { unsyncedCredentialsQuery } from './users/unsynced-credentials';
import { boardMappingsQuery, boardMappingsMutation } from './users/board-mappings';

// New admin resolvers
import { holdClassificationsQuery, holdClassificationsMutation } from './admin/hold-classifications';
import { adminControllerMutation } from './admin/controllers';

// New Aurora proxy resolvers
import { auroraLoginMutation } from './aurora/login';
import { auroraSaveAscentMutation } from './aurora/save-ascent';
import { auroraGetLogbookQuery } from './aurora/get-logbook';
import { auroraUserSyncMutation } from './aurora/user-sync';

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
    // New board data queries
    ...climbStatsQuery,
    ...betaLinksQuery,
    ...holdHeatmapQuery,
    ...resolveSlugQuery,
    ...climbDetailQuery,
    ...settersQuery,
    ...climbRedirectQuery,
    // New Aurora proxy queries
    ...auroraGetLogbookQuery,
    // New user management queries
    ...publicProfileQuery,
    ...unsyncedCredentialsQuery,
    ...boardMappingsQuery,
    // New admin queries
    ...holdClassificationsQuery,
  },

  Mutation: {
    ...sessionMutations,
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
    // New Aurora proxy mutations
    ...auroraLoginMutation,
    ...auroraSaveAscentMutation,
    ...auroraUserSyncMutation,
    // New user management mutations
    ...setPasswordMutation,
    ...boardMappingsMutation,
    // New admin mutations
    ...holdClassificationsMutation,
    ...adminControllerMutation,
  },

  Subscription: {
    ...sessionSubscriptions,
    ...queueSubscriptions,
    ...controllerSubscriptions,
    ...socialNotificationSubscriptions,
    ...socialCommentSubscriptions,
    ...newClimbFeedSubscription,
  },

  // Field-level resolvers
  ClimbSearchResult: climbFieldResolvers,

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
