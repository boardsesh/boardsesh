import { gql } from 'graphql-request';
import type { Tick, SaveTickInput, GetTicksInput } from '@boardsesh/shared-schema';

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
      climbedAt
      layoutId
    }
  }
`;

export const SAVE_TICK = gql`
  mutation SaveTick($input: SaveTickInput!) {
    saveTick(input: $input) {
      uuid
    }
  }
`;

// Partial types matching the fields each query actually requests
type TickFromGetTicks = Pick<Tick, 'uuid' | 'climbUuid' | 'angle' | 'isMirror' | 'status' | 'attemptCount' | 'quality' | 'difficulty' | 'isBenchmark' | 'comment' | 'climbedAt'>;
type TickFromGetUserTicks = Pick<Tick, 'climbUuid' | 'angle' | 'status' | 'attemptCount' | 'difficulty' | 'climbedAt' | 'layoutId'>;
type TickFromSaveTick = Pick<Tick, 'uuid'>;

export interface GetTicksQueryVariables {
  input: GetTicksInput;
}

export interface GetTicksQueryResponse {
  ticks: TickFromGetTicks[];
}

export interface GetUserTicksQueryVariables {
  userId: string;
  boardType: string;
}

export interface GetUserTicksQueryResponse {
  userTicks: TickFromGetUserTicks[];
}

export interface SaveTickMutationVariables {
  input: SaveTickInput;
}

export interface SaveTickMutationResponse {
  saveTick: TickFromSaveTick;
}

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
        isBenchmark
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
export interface AscentFeedItem {
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
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  frames: string | null;
}

// Type for the feed query variables
export interface GetUserAscentsFeedQueryVariables {
  userId: string;
  input?: {
    limit?: number;
    offset?: number;
  };
}

// Type for the feed query response
export interface GetUserAscentsFeedQueryResponse {
  userAscentsFeed: {
    items: AscentFeedItem[];
    totalCount: number;
    hasMore: boolean;
  };
}

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
export interface GroupedAscentFeedItem {
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
  date: string;
  flashCount: number;
  sendCount: number;
  attemptCount: number;
  bestQuality: number | null;
  latestComment: string | null;
  items: AscentFeedItem[];
}

// Type for the grouped feed query variables
export interface GetUserGroupedAscentsFeedQueryVariables {
  userId: string;
  input?: {
    limit?: number;
    offset?: number;
  };
}

// Type for the grouped feed query response
export interface GetUserGroupedAscentsFeedQueryResponse {
  userGroupedAscentsFeed: {
    groups: GroupedAscentFeedItem[];
    totalCount: number;
    hasMore: boolean;
  };
}

// ============================================
// Profile Statistics Operations
// ============================================

export const GET_USER_PROFILE_STATS = gql`
  query GetUserProfileStats($userId: ID!, $gradeFormat: GradeFormat) {
    userProfileStats(userId: $userId, gradeFormat: $gradeFormat) {
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
export interface GradeCount {
  grade: string;
  count: number;
}

// Type for layout stats
export interface LayoutStats {
  layoutKey: string;
  boardType: string;
  layoutId: number | null;
  distinctClimbCount: number;
  gradeCounts: GradeCount[];
}

// Type for the profile stats query variables
export interface GetUserProfileStatsQueryVariables {
  userId: string;
  gradeFormat?: 'FONT' | 'V_GRADE';
}

// Type for the profile stats query response
export interface GetUserProfileStatsQueryResponse {
  userProfileStats: {
    totalDistinctClimbs: number;
    layoutStats: LayoutStats[];
  };
}
