// eslint-disable-next-line import/no-named-as-default -- `graphql-type-json` exports both default and named `GraphQLJSON`; default is the canonical scalar.
import GraphQLJSON from 'graphql-type-json';

// Import domain resolvers
import { boardQueries } from './board/queries';
import { holdOutlineMutations, holdOutlineQueries } from './board/hold-outline-overrides';
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
import { gymActivityStatsMutations } from './social/gym-activity-stats';
import { socialGymMatchQueries } from './social/gym-matching';
import { socialGymStrayBoardQueries, socialGymStrayBoardMutations } from './social/gym-stray-boards';
import { socialGymKioskQueries, socialGymKioskMutations } from './social/gym-kiosks';
import { socialGymInsightsQueries } from './social/gym-insights';
import { socialGymClaimQueries, socialGymClaimMutations, gymClaimFieldResolvers } from './social/gym-claims';
import { socialGymDuplicateQueries, socialGymDuplicateMutations } from './social/gym-duplicates';
import { socialLocationSyncFreezeQueries, socialLocationSyncFreezeMutations } from './social/location-sync-freezes';
import { socialGymOwnerReassignQueries, socialGymOwnerReassignMutations } from './social/gym-owner-reassign';
import { socialGymReportMutations } from './social/gym-reports';
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
import { boardPresenceResolvers } from './board-presence';
import { feedbackMutations } from './feedback/mutations';
import { feedbackQueries } from './feedback/queries';
import { qaMutations } from './qa/mutations';
import { qaQueries } from './qa/queries';
import { integrationQueries } from './integrations/queries';
import { integrationMutations } from './integrations/mutations';
import { betaLinkQueries } from './beta-videos/queries';
import { instagramBetaImportQueries } from './beta-videos/instagram-beta-import';
import { syncQueries } from './sync/queries';
import { cncPackQueries } from './cnc-packs/queries';
import { cncPackMutations } from './cnc-packs/mutations';
import { isNoMatchClimb, isNoMatch } from './shared/helpers';

export const resolvers = {
  // Scalar types
  JSON: GraphQLJSON,

  // Root operation types
  Query: {
    ...sessionQueries,
    ...boardQueries,
    ...holdOutlineQueries,
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
    ...socialGymMatchQueries,
    ...socialGymStrayBoardQueries,
    ...socialGymKioskQueries,
    ...socialGymInsightsQueries,
    ...socialGymClaimQueries,
    ...socialGymDuplicateQueries,
    ...socialLocationSyncFreezeQueries,
    ...socialGymOwnerReassignQueries,
    ...activityFeedQueries,
    ...sessionFeedQueries,
    ...socialNotificationQueries,
    ...socialProposalQueries,
    ...socialRoleQueries,
    ...socialCommunitySettingsQueries,
    ...newClimbSubscriptionResolvers.Query,
    ...betaLinkQueries,
    ...instagramBetaImportQueries,
    ...boardPresenceResolvers.Query,
    ...integrationQueries,
    ...syncQueries,
    ...feedbackQueries,
    ...qaQueries,
    ...cncPackQueries,
  },

  Mutation: {
    ...sessionMutations,
    ...holdOutlineMutations,
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
    ...gymActivityStatsMutations,
    ...socialGymStrayBoardMutations,
    ...socialGymKioskMutations,
    ...socialGymClaimMutations,
    ...socialGymDuplicateMutations,
    ...socialLocationSyncFreezeMutations,
    ...socialGymOwnerReassignMutations,
    ...socialGymReportMutations,
    ...socialNotificationMutations,
    ...socialProposalMutations,
    ...socialRoleMutations,
    ...socialCommunitySettingsMutations,
    ...newClimbSubscriptionResolvers.Mutation,
    ...sessionEditMutations,
    ...feedbackMutations,
    ...qaMutations,
    ...boardPresenceResolvers.Mutation,
    ...integrationMutations,
    ...cncPackMutations,
  },

  Subscription: {
    ...sessionSubscriptions,
    ...queueSubscriptions,
    ...controllerSubscriptions,
    ...socialNotificationSubscriptions,
    ...socialCommentSubscriptions,
    ...newClimbFeedSubscription,
    ...boardPresenceResolvers.Subscription,
    ...climbStatsSubscriptions,
  },

  // Field-level resolvers
  ClimbSearchResult: climbFieldResolvers,

  // `Gym.myPendingClaim` only — every other Gym field comes off the enriched
  // object the queries return, via the default resolver.
  Gym: gymClaimFieldResolvers,

  // Climb type resolvers (derived fields)
  Climb: {
    // Prefer the structured characteristic; fall back to the Aurora description
    // convention for any parent that didn't select the characteristics array
    // (or for rows synced before the column was backfilled — the prefix persists).
    is_no_match: (climb: { characteristics?: string[] | null; description?: string | null }) =>
      climb.characteristics != null ? isNoMatch(climb.characteristics) : isNoMatchClimb(climb.description),
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
  BoardPresenceEvent: boardPresenceResolvers.BoardPresenceEvent,
};
