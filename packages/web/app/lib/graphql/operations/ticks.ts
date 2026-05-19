import { gql } from 'graphql-request';
import type { Tick, SaveTickInput, GetTicksInput, AttachBetaLinkInput } from '@boardsesh/shared-schema';

export const GET_TICKS = gql`
  query GetTicks($input: GetTicksInput!) {
    ticks(input: $input) {
      uuid
      climbUuid
      angle
      isMirror
      status
      attemptCount
      quality
      difficulty
      isBenchmark
      comment
      climbedAt
      upvotes
      downvotes
      commentCount
    }
  }
`;

export const GET_USER_TICKS = gql`
  query GetUserTicks($userId: ID!, $boardType: String!) {
    userTicks(userId: $userId, boardType: $boardType) {
      climbUuid
      angle
      status
      attemptCount
      difficulty
      effectiveDifficulty
      climbedAt
      layoutId
    }
  }
`;

export const SAVE_TICK = gql`
  mutation SaveTick($input: SaveTickInput!) {
    saveTick(input: $input) {
      uuid
      climbUuid
      angle
      isMirror
      status
      attemptCount
      quality
      difficulty
      comment
      climbedAt
    }
  }
`;

// Partial types matching the fields each query actually requests
type TickFromGetTicks = Pick<
  Tick,
  | 'uuid'
  | 'climbUuid'
  | 'angle'
  | 'isMirror'
  | 'status'
  | 'attemptCount'
  | 'quality'
  | 'difficulty'
  | 'isBenchmark'
  | 'comment'
  | 'climbedAt'
  | 'upvotes'
  | 'downvotes'
  | 'commentCount'
>;
type TickFromGetUserTicks = Pick<
  Tick,
  'climbUuid' | 'angle' | 'status' | 'attemptCount' | 'difficulty' | 'effectiveDifficulty' | 'climbedAt' | 'layoutId'
>;
type TickFromSaveTick = Pick<
  Tick,
  | 'uuid'
  | 'climbUuid'
  | 'angle'
  | 'isMirror'
  | 'status'
  | 'attemptCount'
  | 'quality'
  | 'difficulty'
  | 'comment'
  | 'climbedAt'
>;

export type GetTicksQueryVariables = {
  input: GetTicksInput;
};

export type GetTicksQueryResponse = {
  ticks: TickFromGetTicks[];
};

export type GetUserTicksQueryVariables = {
  userId: string;
  boardType: string;
};

export type GetUserTicksQueryResponse = {
  userTicks: TickFromGetUserTicks[];
};

export type SaveTickMutationVariables = {
  input: SaveTickInput;
};

export type SaveTickMutationResponse = {
  saveTick: TickFromSaveTick;
};

export const ATTACH_BETA_LINK = gql`
  mutation AttachBetaLink($input: AttachBetaLinkInput!) {
    attachBetaLink(input: $input)
  }
`;

export type AttachBetaLinkMutationVariables = {
  input: AttachBetaLinkInput;
};

export type AttachBetaLinkMutationResponse = {
  attachBetaLink: boolean;
};

export const DELETE_TICK = gql`
  mutation DeleteTick($uuid: ID!) {
    deleteTick(uuid: $uuid)
  }
`;

export type DeleteTickMutationVariables = {
  uuid: string;
};

export type DeleteTickMutationResponse = {
  deleteTick: boolean;
};

// ============================================
// Activity Feed Operations
// ============================================

export const GET_USER_ASCENTS_FEED = gql`
  query GetUserAscentsFeed($userId: ID!, $input: AscentFeedInput) {
    userAscentsFeed(userId: $userId, input: $input) {
      items {
        uuid
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
        consensusDifficulty
        consensusDifficultyName
        qualityAverage
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

// Type for individual ascent feed item
export type AscentFeedItem = {
  uuid: string;
  climbUuid: string;
  climbName: string;
  setterUsername: string | null;
  boardType: string;
  layoutId: number | null;
  angle: number;
  isMirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  consensusDifficulty: number | null;
  consensusDifficultyName: string | null;
  qualityAverage: number | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames: string | null;
};

// Type for the feed query variables
export type GetUserAscentsFeedQueryVariables = {
  userId: string;
  input?: {
    limit?: number;
    offset?: number;
    boardType?: string;
    boardTypes?: string[];
    layoutIds?: number[];
    status?: 'flash' | 'send' | 'attempt';
    statusMode?: 'both' | 'send' | 'attempt';
    flashOnly?: boolean;
    climbName?: string;
    sortBy?:
      | 'recent'
      | 'hardest'
      | 'easiest'
      | 'mostAttempts'
      | 'climbName'
      | 'loggedGrade'
      | 'consensusGrade'
      | 'date'
      | 'attemptCount';
    sortOrder?: 'asc' | 'desc';
    secondarySortBy?: 'climbName' | 'loggedGrade' | 'consensusGrade' | 'date' | 'attemptCount';
    secondarySortOrder?: 'asc' | 'desc';
    minDifficulty?: number;
    maxDifficulty?: number;
    minAngle?: number;
    maxAngle?: number;
    benchmarkOnly?: boolean;
    fromDate?: string;
    toDate?: string;
  };
};

// Type for the feed query response
export type GetUserAscentsFeedQueryResponse = {
  userAscentsFeed: {
    items: AscentFeedItem[];
    totalCount: number;
    hasMore: boolean;
  };
};

// ============================================
// Grouped Activity Feed Operations
// ============================================

export const GET_USER_GROUPED_ASCENTS_FEED = gql`
  query GetUserGroupedAscentsFeed($userId: ID!, $input: AscentFeedInput) {
    userGroupedAscentsFeed(userId: $userId, input: $input) {
      groups {
        key
        climbUuid
        climbName
        setterUsername
        boardType
        layoutId
        angle
        isMirror
        frames
        difficultyName
        isBenchmark
        isNoMatch
        date
        flashCount
        sendCount
        attemptCount
        bestQuality
        latestComment
        items {
          uuid
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
      }
      totalCount
      hasMore
    }
  }
`;

// Type for grouped ascent feed item
export type GroupedAscentFeedItem = {
  key: string;
  climbUuid: string;
  climbName: string;
  setterUsername: string | null;
  boardType: string;
  layoutId: number | null;
  angle: number;
  isMirror: boolean;
  frames: string | null;
  difficultyName: string | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  date: string;
  flashCount: number;
  sendCount: number;
  attemptCount: number;
  bestQuality: number | null;
  latestComment: string | null;
  items: AscentFeedItem[];
};

// Type for the grouped feed query variables
export type GetUserGroupedAscentsFeedQueryVariables = {
  userId: string;
  input?: {
    limit?: number;
    offset?: number;
  };
};

// Type for the grouped feed query response
export type GetUserGroupedAscentsFeedQueryResponse = {
  userGroupedAscentsFeed: {
    groups: GroupedAscentFeedItem[];
    totalCount: number;
    hasMore: boolean;
  };
};

// ============================================
// Profile Statistics Operations
// ============================================

export const GET_USER_PROFILE_STATS = gql`
  query GetUserProfileStats($userId: ID!) {
    userProfileStats(userId: $userId) {
      totalDistinctClimbs
      layoutStats {
        layoutKey
        boardType
        layoutId
        distinctClimbCount
        gradeCounts {
          grade
          count
        }
      }
    }
  }
`;

// Type for grade count
export type GradeCount = {
  grade: string;
  count: number;
};

// Type for layout stats
export type LayoutStats = {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  distinctClimbCount: number;
  gradeCounts: GradeCount[];
};

// Type for the profile stats query variables
export type GetUserProfileStatsQueryVariables = {
  userId: string;
};

// Type for the profile stats query response
export type GetUserProfileStatsQueryResponse = {
  userProfileStats: {
    totalDistinctClimbs: number;
    layoutStats: LayoutStats[];
  };
};

// ============================================
// Climb Percentile Operations
// ============================================

export const GET_USER_CLIMB_PERCENTILE = gql`
  query GetUserClimbPercentile($userId: ID!) {
    userClimbPercentile(userId: $userId) {
      totalDistinctClimbs
      percentile
      totalActiveUsers
    }
  }
`;

export type GetUserClimbPercentileQueryVariables = {
  userId: string;
};

export type GetUserClimbPercentileQueryResponse = {
  userClimbPercentile: {
    totalDistinctClimbs: number;
    percentile: number;
    totalActiveUsers: number;
  };
};

// ============================================
// Tick Mutation Operations
// ============================================

export const UPDATE_TICK = gql`
  mutation UpdateTick($uuid: ID!, $input: UpdateTickInput!) {
    updateTick(uuid: $uuid, input: $input) {
      uuid
      status
      attemptCount
      quality
      difficulty
      isBenchmark
      comment
      updatedAt
    }
  }
`;

export type DeleteTickVariables = {
  uuid: string;
};

export type UpdateTickInput = {
  status?: 'flash' | 'send' | 'attempt';
  attemptCount?: number;
  quality?: number | null;
  difficulty?: number | null;
  isBenchmark?: boolean;
  comment?: string;
};

export type UpdateTickVariables = {
  uuid: string;
  input: UpdateTickInput;
};

export type UpdateTickResponse = {
  updateTick: {
    uuid: string;
    status: string;
    attemptCount: number;
    quality: number | null;
    difficulty: number | null;
    isBenchmark: boolean;
    comment: string;
    updatedAt: string;
  };
};

// ============================================
// Climb Stats Subscription
// ============================================

export const CLIMB_STATS_UPDATED_SUBSCRIPTION = gql`
  subscription ClimbStatsUpdated($boardType: String!, $climbUuid: ID!, $angle: Int!) {
    climbStatsUpdated(boardType: $boardType, climbUuid: $climbUuid, angle: $angle) {
      boardType
      climbUuid
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
    }
  }
`;

export type ClimbStatsUpdatedSubscriptionVariables = {
  boardType: string;
  climbUuid: string;
  angle: number;
};

export type ClimbStatsUpdatedSubscriptionResponse = {
  climbStatsUpdated: {
    boardType: string;
    climbUuid: string;
    angle: number;
    ascensionistCount: number;
    qualityAverage: number | null;
    difficultyAverage: number | null;
    displayDifficulty: number | null;
  };
};
