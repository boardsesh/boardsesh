import { gql } from 'graphql-request';
import type {
  UserBoard,
  UserBoardConnection,
  BoardLeaderboard,
  CreateBoardInput,
  UpdateBoardInput,
  BoardLeaderboardInput,
  MyBoardsInput,
  FollowBoardInput,
  SearchBoardsInput,
  PopularBoardConfigConnection,
  PopularBoardConfigsInput,
} from '@boardsesh/shared-schema';

// ============================================
// Board Queries
// ============================================

const BOARD_FIELDS = `
  uuid
  slug
  ownerId
  ownerDisplayName
  ownerAvatarUrl
  boardType
  layoutId
  sizeId
  setIds
  name
  description
  locationName
  latitude
  longitude
  isPublic
  isUnlisted
  hideLocation
  isOwned
  angle
  isAngleAdjustable
  createdAt
  layoutName
  sizeName
  sizeDescription
  setNames
  totalAscents
  uniqueClimbers
  followerCount
  commentCount
  isFollowedByMe
  gymId
  gymUuid
  gymName
  distanceMeters
  serialNumber
`;

export const GET_BOARD = gql`
  query GetBoard($boardUuid: ID!) {
    board(boardUuid: $boardUuid) {
      ${BOARD_FIELDS}
    }
  }
`;

export const GET_BOARD_BY_SLUG = gql`
  query GetBoardBySlug($slug: String!) {
    boardBySlug(slug: $slug) {
      ${BOARD_FIELDS}
    }
  }
`;

export const GET_MY_BOARDS = gql`
  query GetMyBoards($input: MyBoardsInput) {
    myBoards(input: $input) {
      boards {
        ${BOARD_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_DEFAULT_BOARD = gql`
  query GetDefaultBoard {
    defaultBoard {
      ${BOARD_FIELDS}
    }
  }
`;

export const SEARCH_BOARDS = gql`
  query SearchBoards($input: SearchBoardsInput!) {
    searchBoards(input: $input) {
      boards {
        ${BOARD_FIELDS}
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_BOARD_LEADERBOARD = gql`
  query GetBoardLeaderboard($input: BoardLeaderboardInput!) {
    boardLeaderboard(input: $input) {
      boardUuid
      entries {
        userId
        userDisplayName
        userAvatarUrl
        rank
        totalSends
        totalFlashes
        hardestGrade
        hardestGradeName
        totalSessions
      }
      totalCount
      hasMore
      periodLabel
    }
  }
`;

export const GET_POPULAR_BOARD_CONFIGS = gql`
  query GetPopularBoardConfigs($input: PopularBoardConfigsInput) {
    popularBoardConfigs(input: $input) {
      configs {
        boardType
        layoutId
        layoutName
        sizeId
        sizeName
        sizeDescription
        setIds
        setNames
        climbCount
        totalAscents
        boardCount
        displayName
      }
      totalCount
      hasMore
    }
  }
`;

export const GET_BOARDS_BY_SERIAL_NUMBERS = gql`
  query GetBoardsBySerialNumbers($serialNumbers: [String!]!) {
    boardsBySerialNumbers(serialNumbers: $serialNumbers) {
      ${BOARD_FIELDS}
    }
  }
`;

export const GET_MY_BOARD_SERIAL_CONFIGS = gql`
  query GetMyBoardSerialConfigs($serialNumbers: [String!]!) {
    myBoardSerialConfigs(serialNumbers: $serialNumbers) {
      serialNumber
      boardName
      layoutId
      sizeId
      setIds
      apiLevel
      updatedAt
      boardUuid
      boardSlug
    }
  }
`;

// ============================================
// Board Mutations
// ============================================

export const CREATE_BOARD = gql`
  mutation CreateBoard($input: CreateBoardInput!) {
    createBoard(input: $input) {
      ${BOARD_FIELDS}
    }
  }
`;

export const UPDATE_BOARD = gql`
  mutation UpdateBoard($input: UpdateBoardInput!) {
    updateBoard(input: $input) {
      ${BOARD_FIELDS}
    }
  }
`;

export const DELETE_BOARD = gql`
  mutation DeleteBoard($boardUuid: ID!) {
    deleteBoard(boardUuid: $boardUuid)
  }
`;

export const FOLLOW_BOARD = gql`
  mutation FollowBoard($input: FollowBoardInput!) {
    followBoard(input: $input)
  }
`;

export const UNFOLLOW_BOARD = gql`
  mutation UnfollowBoard($input: FollowBoardInput!) {
    unfollowBoard(input: $input)
  }
`;

export const RECORD_BOARD_SERIAL = gql`
  mutation RecordBoardSerial($input: RecordBoardSerialInput!) {
    recordBoardSerial(input: $input) {
      serialNumber
      boardName
      layoutId
      sizeId
      setIds
      apiLevel
      updatedAt
      boardUuid
      boardSlug
    }
  }
`;

// ============================================
// Query/Mutation Variable Types
// ============================================

export type GetBoardQueryVariables = {
  boardUuid: string;
};

export type GetBoardQueryResponse = {
  board: UserBoard | null;
};

export type GetBoardBySlugQueryVariables = {
  slug: string;
};

export type GetBoardBySlugQueryResponse = {
  boardBySlug: UserBoard | null;
};

export type GetMyBoardsQueryVariables = {
  input?: MyBoardsInput;
};

export type GetMyBoardsQueryResponse = {
  myBoards: UserBoardConnection;
};

export type GetDefaultBoardQueryResponse = {
  defaultBoard: UserBoard | null;
};

export type SearchBoardsQueryVariables = {
  input: SearchBoardsInput;
};

export type SearchBoardsQueryResponse = {
  searchBoards: UserBoardConnection;
};

export type GetBoardLeaderboardQueryVariables = {
  input: BoardLeaderboardInput;
};

export type GetBoardLeaderboardQueryResponse = {
  boardLeaderboard: BoardLeaderboard;
};

export type CreateBoardMutationVariables = {
  input: CreateBoardInput;
};

export type CreateBoardMutationResponse = {
  createBoard: UserBoard;
};

export type UpdateBoardMutationVariables = {
  input: UpdateBoardInput;
};

export type UpdateBoardMutationResponse = {
  updateBoard: UserBoard;
};

export type DeleteBoardMutationVariables = {
  boardUuid: string;
};

export type DeleteBoardMutationResponse = {
  deleteBoard: boolean;
};

export type FollowBoardMutationVariables = {
  input: FollowBoardInput;
};

export type FollowBoardMutationResponse = {
  followBoard: boolean;
};

export type UnfollowBoardMutationVariables = {
  input: FollowBoardInput;
};

export type UnfollowBoardMutationResponse = {
  unfollowBoard: boolean;
};

export type GetPopularBoardConfigsQueryVariables = {
  input?: PopularBoardConfigsInput;
};

export type GetPopularBoardConfigsQueryResponse = {
  popularBoardConfigs: PopularBoardConfigConnection;
};

export type GetBoardsBySerialNumbersQueryVariables = {
  serialNumbers: string[];
};

export type GetBoardsBySerialNumbersQueryResponse = {
  boardsBySerialNumbers: UserBoard[];
};

export type BoardSerialConfig = {
  serialNumber: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  apiLevel: number | null;
  updatedAt: string;
  boardUuid: string | null;
  boardSlug: string | null;
};

export type GetMyBoardSerialConfigsQueryVariables = {
  serialNumbers: string[];
};

export type GetMyBoardSerialConfigsQueryResponse = {
  myBoardSerialConfigs: BoardSerialConfig[];
};

export type RecordBoardSerialInput = {
  serialNumber: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  apiLevel?: number | null;
  boardUuid?: string | null;
};

export type RecordBoardSerialMutationVariables = {
  input: RecordBoardSerialInput;
};

export type RecordBoardSerialMutationResponse = {
  recordBoardSerial: BoardSerialConfig | null;
};
