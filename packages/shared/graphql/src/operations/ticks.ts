// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type { Tick, SaveTickInput, GetTicksInput, RenderBoardConfig } from '@boardsesh/shared-schema';
import type { UpdateTickInput as GeneratedUpdateTickInput } from '../generated/graphql';

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
      effectiveQuality
      difficulty
      boardseshDifficulty
      boardseshConfidence
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
      boardseshDifficulty
      boardseshConfidence
      climbedAt
      layoutId
    }
  }
`;

// Lightweight per-board tick counts — one grouped aggregate instead of a full
// GET_USER_TICKS list per board type. Used to infer the home feed's default
// board without pulling every tick on cold load.
export const GET_USER_TICK_COUNTS_BY_BOARD = gql`
  query GetUserTickCountsByBoard($userId: ID!) {
    userTickCountsByBoard(userId: $userId) {
      boardType
      count
    }
  }
`;

export type GetUserTickCountsByBoardQueryVariables = {
  userId: string;
};

export type GetUserTickCountsByBoardQueryResponse = {
  userTickCountsByBoard: Array<{ boardType: string; count: number }>;
};

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
  | 'effectiveQuality'
  | 'difficulty'
  | 'boardseshDifficulty'
  | 'boardseshConfidence'
  | 'isBenchmark'
  | 'comment'
  | 'climbedAt'
  | 'upvotes'
  | 'downvotes'
  | 'commentCount'
>;
type TickFromGetUserTicks = Pick<
  Tick,
  | 'climbUuid'
  | 'angle'
  | 'status'
  | 'attemptCount'
  | 'difficulty'
  | 'effectiveDifficulty'
  | 'boardseshDifficulty'
  | 'boardseshConfidence'
  | 'climbedAt'
  | 'layoutId'
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

// ATTACH_BETA_LINK and its types now live in ./beta-links — kept colocated
// with the beta-video-specific operations.

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
        boardId
        boardDisplayName
        layoutId
        renderBoard {
          layoutId
          sizeId
          setIds
        }
        angle
        isMirror
        status
        attemptCount
        quality
        effectiveQuality
        difficulty
        difficultyName
        consensusDifficulty
        consensusDifficultyName
        boardseshDifficulty
        boardseshConfidence
        qualityAverage
        isBenchmark
        isNoMatch
        comment
        climbedAt
        frames
        hasBetaVideo
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
  boardId: number | null;
  boardDisplayName: string | null;
  layoutId: number | null;
  /**
   * Board to draw this ascent on — the one it was climbed on, or the closest of
   * the climber's own. Optional so fixtures and non-feed producers of this shape
   * stay valid; consumers fall back to the layout default when it's absent.
   */
  renderBoard?: RenderBoardConfig | null;
  angle: number;
  isMirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  attemptCount: number;
  quality: number | null;
  // COALESCE(quality, the climber's own synced star rating from
  // board_climb_ratings). What the "user stars" column should read — falls back
  // to the Kilter-synced rating when a pulled tick has no per-tick quality.
  // 1-5 native (no rescaling); null when neither exists. Optional (like
  // hasBetaVideo) so fixtures and non-feed producers of this shape stay valid;
  // UI reads `effectiveQuality ?? quality`.
  effectiveQuality?: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  consensusDifficulty: number | null;
  consensusDifficultyName: string | null;
  // Boardsesh grade (COALESCE(universal, local)) + confidence tier for this
  // ascent's climb at its angle. Null when no grade row exists; UI keeps the
  // legacy consensus when null or confidence is 'setter_only'.
  boardseshDifficulty: number | null;
  boardseshConfidence: string | null;
  qualityAverage: number | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames: string | null;
  /**
   * Beta video attached to this ascent (board_beta_links.tick_uuid). Kept
   * optional so fixtures and non-feed producers of this shape stay valid; UI
   * guards on `=== true`.
   */
  hasBetaVideo?: boolean | null;
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

// Caption → ascent matches for the share-beta picker. Returns full ascent rows
// (same shape/board art as the feed) for the climbs whose names appear in the
// shared reel's caption, matched across the user's whole logbook.
export const GET_USER_ASCENT_CAPTION_MATCHES = gql`
  query GetUserAscentCaptionMatches($userId: ID!, $caption: String!) {
    userAscentCaptionMatches(userId: $userId, caption: $caption) {
      uuid
      climbUuid
      climbName
      setterUsername
      boardType
      boardId
      boardDisplayName
      layoutId
      angle
      isMirror
      status
      attemptCount
      quality
      effectiveQuality
      difficulty
      difficultyName
      consensusDifficulty
      consensusDifficultyName
      boardseshDifficulty
      boardseshConfidence
      qualityAverage
      isBenchmark
      isNoMatch
      comment
      climbedAt
      frames
      hasBetaVideo
    }
  }
`;

export type GetUserAscentCaptionMatchesQueryVariables = {
  userId: string;
  caption: string;
};

export type GetUserAscentCaptionMatchesQueryResponse = {
  userAscentCaptionMatches: AscentFeedItem[];
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
        renderBoard {
          layoutId
          sizeId
          setIds
        }
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
          boardId
          boardDisplayName
          layoutId
          renderBoard {
            layoutId
            sizeId
            setIds
          }
          angle
          isMirror
          status
          attemptCount
          quality
          effectiveQuality
          difficulty
          difficultyName
          consensusDifficulty
          consensusDifficultyName
          boardseshDifficulty
          boardseshConfidence
          qualityAverage
          isBenchmark
          isNoMatch
          comment
          climbedAt
          frames
          hasBetaVideo
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
  /** Board to draw this group's climb on — see `AscentFeedItem.renderBoard`. */
  renderBoard?: RenderBoardConfig | null;
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
      climbedAt
      angle
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
  climbedAt?: string;
  angle?: number;
};

// Compile-time drift guard: this hand-written UpdateTickInput must stay in step
// with the codegen-generated input (which the `codegen-drift` CI job keeps
// locked to the GraphQL SDL + its Zod validation gate). A field added to the
// SDL but forgotten here would otherwise type-check fine and silently never be
// sent on an edit. Mirrors the offline-sync UPDATE_TICK_INPUT_FIELDS guard
// (handlers.test.ts). Three checks:
//   1. no field the generated input has is missing here (the silent-drop risk);
//   2. no field here is unknown to the generated input (would fail GraphQL
//      validation at runtime);
//   3. every hand-written field is assignable INTO the generated field, which
//      key-set equality alone can't see — it catches an Int→String or an
//      optional→required drift.
// Only ONE direction of assignability is asserted. The reverse (generated →
// hand-written) is intentionally NOT: the generated type marks every field
// `T | null` (InputMaybe), while this type keeps the tighter, Zod-aligned shape
// (only quality/difficulty nullable), so the two are deliberately not mutually
// assignable. Residual gap this can't catch: a hand-written field widened
// toward the generated shape (e.g. adding `| null`) — the Zod schema stays the
// runtime gate for that.
type _NoMissingUpdateTickField = [Exclude<keyof GeneratedUpdateTickInput, keyof UpdateTickInput>] extends [never]
  ? true
  : never;
type _NoExtraUpdateTickField = [Exclude<keyof UpdateTickInput, keyof GeneratedUpdateTickInput>] extends [never]
  ? true
  : never;
type _UpdateTickValueCompat = [UpdateTickInput] extends [GeneratedUpdateTickInput] ? true : never;
const _noMissingUpdateTickField: _NoMissingUpdateTickField = true;
const _noExtraUpdateTickField: _NoExtraUpdateTickField = true;
const _updateTickValueCompat: _UpdateTickValueCompat = true;
void _noMissingUpdateTickField;
void _noExtraUpdateTickField;
void _updateTickValueCompat;

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
    climbedAt: string;
    angle: number;
    updatedAt: string;
  };
};
