// eslint-disable-next-line import/no-named-as-default -- `graphql-type-json` exports both default and named `GraphQLJSON`; default is the canonical scalar.
import GraphQLJSON from 'graphql-type-json';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Import domain resolvers
import { boardQueries } from './board/queries';
import { holdOutlineMutations, holdOutlineQueries } from './board/hold-outline-overrides';
import { sprayWallMutations, sprayWallQueries } from './board/spray-walls';
import { sprayDetectionMutations, sprayDetectionQueries } from './board/spray-detection';
import { sprayWallModerationMutations, sprayWallModerationQueries } from './board/spray-wall-moderation';
import { tickQueries } from './ticks/queries';
import { tickBoardQueries } from './ticks/board-options';
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
import { liveSessionQueries } from './sessions/live-sessions';
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
import { followedAuthorQueries } from './social/followed-authors';
import { crewFeedQueries } from './social/crew-feed';
import { sessionEditMutations } from './social/session-mutations';
import { socialCommentQueries, socialCommentMutations } from './social/comments';
import { socialVoteQueries, socialVoteMutations } from './social/votes';
import { socialBoardQueries, socialBoardMutations } from './social/boards';
import { boardDiscoveryQueries } from './social/board-discovery';
import { communityStatsQueries } from './social/community-stats';
import { socialGymQueries, socialGymMutations } from './social/gyms';
import { placeQueries } from './social/places';
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
import { resolveClimbNoMatch } from './shared/helpers';
import { resolveClimbLostHolds, type ClimbLostHoldsParent } from './climbs/lost-holds';

export const resolvers = {
  // Scalar types
  JSON: GraphQLJSON,

  // Root operation types
  Query: {
    ...sessionQueries,
    ...liveSessionQueries,
    ...boardQueries,
    ...holdOutlineQueries,
    ...sprayWallQueries,
    ...sprayDetectionQueries,
    ...sprayWallModerationQueries,
    ...climbQueries,
    ...tickQueries,
    ...tickBoardQueries,
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
    ...boardDiscoveryQueries,
    ...communityStatsQueries,
    ...socialGymQueries,
    ...placeQueries,
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
    ...followedAuthorQueries,
    ...crewFeedQueries,
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
  },

  Mutation: {
    ...sessionMutations,
    ...holdOutlineMutations,
    ...sprayWallMutations,
    ...sprayDetectionMutations,
    ...sprayWallModerationMutations,
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
    // One definition for every surface — see resolveClimbNoMatch.
    // A parent that doesn't select `characteristics` silently falls back to the
    // description, so every Climb producer must project the column.
    is_no_match: (climb: {
      characteristics?: string[] | null;
      description?: string | null;
      boardType?: string | null;
    }) => resolveClimbNoMatch(climb.boardType, climb.characteristics, climb.description),

    // Spray only, and only for a climb whose materialised `missingHoldCount`
    // says it lost something — see resolveClimbLostHolds. Per-climb by design:
    // a list must not select it.
    //
    // `ctx` is not optional here: these rows are the geometry of somebody's
    // garage, the parent may be a synthetic `ClimbInput` a caller sent back
    // through the queue, and the wall's visibility is decided against the
    // climb's own row with the viewer this request actually has.
    lostHolds: (climb: ClimbLostHoldsParent, _args: unknown, ctx: ConnectionContext) =>
      resolveClimbLostHolds(climb, ctx),
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
