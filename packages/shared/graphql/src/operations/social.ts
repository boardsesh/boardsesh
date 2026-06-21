import { gql } from 'graphql-request';
import type {
  PublicUserProfile,
  FollowConnection,
  UserSearchConnection,
  UnifiedSearchConnection,
  FollowingAscentFeedItem,
  FollowingAscentsFeedResult,
  SetterProfile,
  Climb,
} from '@boardsesh/shared-schema';

// ============================================
// Follow Mutations
// ============================================

export const FOLLOW_USER = gql`
  mutation FollowUser($input: FollowInput!) {
    followUser(input: $input)
  }
`;

export const UNFOLLOW_USER = gql`
  mutation UnfollowUser($input: FollowInput!) {
    unfollowUser(input: $input)
  }
`;

// ============================================
// Follow Queries
// ============================================

export const GET_PUBLIC_PROFILE = gql`
  query GetPublicProfile($userId: ID!) {
    publicProfile(userId: $userId) {
      id
      displayName
      avatarUrl
      instagramUrl
      followerCount
      followingCount
      isFollowedByMe
    }
  }
`;

export const GET_FOLLOWERS = gql`
  query GetFollowers($input: FollowListInput!) {
    followers(input: $input) {
      users {
        id
        displayName
        avatarUrl
        followerCount
        followingCount
        isFollowedByMe
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_FOLLOWING = gql`
  query GetFollowing($input: FollowListInput!) {
    following(input: $input) {
      users {
        id
        displayName
        avatarUrl
        followerCount
        followingCount
        isFollowedByMe
      }
      totalCount
      hasMore
    }
  }
`;

export const IS_FOLLOWING = gql`
  query IsFollowing($userId: ID!) {
    isFollowing(userId: $userId)
  }
`;

// ============================================
// User Search
// ============================================

export const SEARCH_USERS = gql`
  query SearchUsers($input: SearchUsersInput!) {
    searchUsers(input: $input) {
      results {
        user {
          id
          displayName
          avatarUrl
          followerCount
          followingCount
          isFollowedByMe
        }
        recentAscentCount
        matchReason
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Following Ascents Feed
// ============================================

export const GET_FOLLOWING_ASCENTS_FEED = gql`
  query GetFollowingAscentsFeed($input: FollowingAscentsFeedInput) {
    followingAscentsFeed(input: $input) {
      items {
        uuid
        userId
        userDisplayName
        userAvatarUrl
        climbUuid
        climbName
        setterUsername
        boardType
        layoutId
        angle
        isMirror
        status
        attemptCount
        quality
        difficulty
        difficultyName
        isBenchmark
        isNoMatch
        comment
        climbedAt
        frames
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Global Ascents Feed
// ============================================

export const GET_GLOBAL_ASCENTS_FEED = gql`
  query GetGlobalAscentsFeed($input: FollowingAscentsFeedInput) {
    globalAscentsFeed(input: $input) {
      items {
        uuid
        userId
        userDisplayName
        userAvatarUrl
        climbUuid
        climbName
        setterUsername
        boardType
        layoutId
        angle
        isMirror
        status
        attemptCount
        quality
        difficulty
        difficultyName
        isBenchmark
        isNoMatch
        comment
        climbedAt
        frames
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type FollowUserMutationVariables = {
  input: { userId: string };
};

export type FollowUserMutationResponse = {
  followUser: boolean;
};

export type UnfollowUserMutationVariables = {
  input: { userId: string };
};

export type UnfollowUserMutationResponse = {
  unfollowUser: boolean;
};

export type GetPublicProfileQueryVariables = {
  userId: string;
};

export type GetPublicProfileQueryResponse = {
  publicProfile: PublicUserProfile | null;
};

export type GetFollowersQueryVariables = {
  input: { userId: string; limit?: number; offset?: number };
};

export type GetFollowersQueryResponse = {
  followers: FollowConnection;
};

export type GetFollowingQueryVariables = {
  input: { userId: string; limit?: number; offset?: number };
};

export type GetFollowingQueryResponse = {
  following: FollowConnection;
};

export type IsFollowingQueryVariables = {
  userId: string;
};

export type IsFollowingQueryResponse = {
  isFollowing: boolean;
};

export type SearchUsersQueryVariables = {
  input: { query: string; boardType?: string; limit?: number; offset?: number };
};

export type SearchUsersQueryResponse = {
  searchUsers: UserSearchConnection;
};

export type GetFollowingAscentsFeedQueryVariables = {
  input?: { limit?: number; offset?: number };
};

export type GetFollowingAscentsFeedQueryResponse = {
  followingAscentsFeed: FollowingAscentsFeedResult;
};

export type GetGlobalAscentsFeedQueryVariables = {
  input?: { limit?: number; offset?: number };
};

export type GetGlobalAscentsFeedQueryResponse = {
  globalAscentsFeed: FollowingAscentsFeedResult;
};

// ============================================
// Following Climb Ascents (ticks on a specific climb from followed users)
// ============================================

export const GET_FOLLOWING_CLIMB_ASCENTS = gql`
  query GetFollowingClimbAscents($input: FollowingClimbAscentsInput!) {
    followingClimbAscents(input: $input) {
      items {
        uuid
        userId
        userDisplayName
        userAvatarUrl
        climbUuid
        angle
        isMirror
        status
        attemptCount
        quality
        comment
        climbedAt
        upvotes
        downvotes
        commentCount
      }
    }
  }
`;

export type GetFollowingClimbAscentsQueryVariables = {
  input: { boardType: string; climbUuid: string };
};

/**
 * Narrow subset of FollowingAscentFeedItem matching exactly the fields
 * selected by GET_FOLLOWING_CLIMB_ASCENTS. Keeps the type truthful about
 * what the server returns for this query.
 */
export type FollowingClimbAscentItem = Pick<
  FollowingAscentFeedItem,
  | 'uuid'
  | 'userId'
  | 'userDisplayName'
  | 'userAvatarUrl'
  | 'climbUuid'
  | 'angle'
  | 'isMirror'
  | 'status'
  | 'attemptCount'
  | 'quality'
  | 'comment'
  | 'climbedAt'
  | 'upvotes'
  | 'downvotes'
  | 'commentCount'
>;

export type GetFollowingClimbAscentsQueryResponse = {
  followingClimbAscents: { items: FollowingClimbAscentItem[] };
};

// ============================================
// Setter Follow Mutations
// ============================================

export const FOLLOW_SETTER = gql`
  mutation FollowSetter($input: FollowSetterInput!) {
    followSetter(input: $input)
  }
`;

export const UNFOLLOW_SETTER = gql`
  mutation UnfollowSetter($input: FollowSetterInput!) {
    unfollowSetter(input: $input)
  }
`;

// ============================================
// Setter Queries
// ============================================

export const GET_SETTER_PROFILE = gql`
  query GetSetterProfile($input: SetterProfileInput!) {
    setterProfile(input: $input) {
      username
      climbCount
      boardTypes
      followerCount
      isFollowedByMe
      linkedUserId
      linkedUserDisplayName
      linkedUserAvatarUrl
    }
  }
`;

// ============================================
// Setter Climbs Full (with full Climb data for thumbnails)
// ============================================

export const GET_SETTER_CLIMBS_FULL = gql`
  query GetSetterClimbsFull($input: SetterClimbsFullInput!) {
    setterClimbsFull(input: $input) {
      climbs {
        uuid
        layoutId
        boardType
        setter_username
        name
        description
        frames
        framesCount
        framesPace
        angle
        ascensionist_count
        difficulty
        quality_average
        stars
        difficulty_error
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`;

export type GetSetterClimbsFullQueryVariables = {
  input: {
    username: string;
    boardType?: string;
    layoutId?: number;
    sizeId?: number;
    setIds?: string;
    angle?: number;
    sortBy?: string;
    limit?: number;
    offset?: number;
  };
};

export type GetSetterClimbsFullQueryResponse = {
  setterClimbsFull: {
    climbs: Climb[];
    totalCount: number;
    hasMore: boolean;
  };
};

// ============================================
// User Climbs (climbs created by a user, across all linked setters)
// ============================================

export const GET_USER_CLIMBS = gql`
  query GetUserClimbs($input: UserClimbsInput!) {
    userClimbs(input: $input) {
      climbs {
        uuid
        layoutId
        boardType
        setter_username
        name
        description
        frames
        framesCount
        framesPace
        angle
        ascensionist_count
        difficulty
        quality_average
        stars
        difficulty_error
        benchmark_difficulty
      }
      totalCount
      hasMore
    }
  }
`;

export type GetUserClimbsQueryVariables = {
  input: {
    userId: string;
    sortBy?: string;
    limit?: number;
    offset?: number;
  };
};

export type GetUserClimbsQueryResponse = {
  userClimbs: {
    climbs: Climb[];
    totalCount: number;
    hasMore: boolean;
  };
};

// ============================================
// Unified Search
// ============================================

export const SEARCH_USERS_AND_SETTERS = gql`
  query SearchUsersAndSetters($input: SearchUsersInput!) {
    searchUsersAndSetters(input: $input) {
      results {
        user {
          id
          displayName
          avatarUrl
          followerCount
          followingCount
          isFollowedByMe
        }
        setter {
          username
          climbCount
          boardTypes
          isFollowedByMe
        }
        recentAscentCount
        matchReason
      }
      totalCount
      hasMore
    }
  }
`;

// ============================================
// Setter Query/Mutation Variable Types
// ============================================

export type FollowSetterMutationVariables = {
  input: { setterUsername: string };
};

export type FollowSetterMutationResponse = {
  followSetter: boolean;
};

export type UnfollowSetterMutationVariables = {
  input: { setterUsername: string };
};

export type UnfollowSetterMutationResponse = {
  unfollowSetter: boolean;
};

export type GetSetterProfileQueryVariables = {
  input: { username: string };
};

export type GetSetterProfileQueryResponse = {
  setterProfile: SetterProfile | null;
};

export type SearchUsersAndSettersQueryVariables = {
  input: { query: string; boardType?: string; limit?: number; offset?: number };
};

export type SearchUsersAndSettersQueryResponse = {
  searchUsersAndSetters: UnifiedSearchConnection;
};
