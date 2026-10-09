import { gql } from 'graphql-request';
import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';

// The field ORDER in both lists below is load-bearing: `SearchClimbs` and
// `GetClimb` are replayed from recorded fixtures keyed on the query text
// (docs/mobile-screenshot-fixtures.md), and that set cannot be re-recorded.
// Reorder, add or drop a field and the screenshot drift test tells you the
// recorded document no longer matches.

// Selection for search/list views.
//
// It used to omit `description` on the premise that no list UI renders it.
// #4494 overturned that premise: opening a climb from the list lands in the
// play drawer, which renders the setter's notes, so a search result that drops
// the field leaves the drawer blank for every climb reached through the list.
// packages/backend/src/__tests__/operations-schema-validation.test.ts guards
// it against being re-slimmed. Cost is small: mean description length in the
// catalog is 18 characters (max 254) against a `frames` string already on the
// wire.
// published_at/created_at are used by the create form to enforce the 24h
// post-publish edit window.
const CLIMB_SEARCH_FIELDS = `
  uuid
  boardType
  layoutId
  setter_username
  userId
  name
  description
  frames
  angle
  statsAngle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  benchmark_difficulty
  is_draft
  is_hidden
  is_no_match
  characteristics
  published_at
  created_at
  userAscents
  userAttempts
  framesCount
  framesPace
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
  missingHoldCount
`;

// Full selection for single-climb views.
const CLIMB_DETAIL_FIELDS = `
  uuid
  boardType
  layoutId
  setter_username
  userId
  name
  description
  frames
  angle
  statsAngle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  mirrored
  benchmark_difficulty
  is_no_match
  characteristics
  userAscents
  userAttempts
  is_draft
  is_hidden
  created_at
  published_at
  framesCount
  framesPace
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
  missingHoldCount
`;

export const SEARCH_CLIMBS = gql`
  query SearchClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        ${CLIMB_SEARCH_FIELDS}
      }
      hasMore
    }
  }
`;

export type SearchClimbsQueryVariables = {
  input: ClimbSearchInput;
};

export type SearchClimbsQueryResponse = {
  searchClimbs: {
    climbs: Climb[];
    hasMore: boolean;
  };
};

export const SEARCH_CLIMBS_COUNT = gql`
  query SearchClimbsCount($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      totalCount
    }
  }
`;

export type SearchClimbsCountQueryResponse = {
  searchClimbs: {
    totalCount: number;
  };
};

export const GET_CLIMB = gql`
  query GetClimb(
    $boardName: String!
    $layoutId: Int!
    $sizeId: Int!
    $setIds: String!
    $angle: Int!
    $climbUuid: ID!
  ) {
    climb(
      boardName: $boardName
      layoutId: $layoutId
      sizeId: $sizeId
      setIds: $setIds
      angle: $angle
      climbUuid: $climbUuid
    ) {
      ${CLIMB_DETAIL_FIELDS}
    }
  }
`;

export type GetClimbQueryVariables = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  climbUuid: string;
};

export type GetClimbQueryResponse = {
  climb: Climb | null;
};
