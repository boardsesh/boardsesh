import { gql } from 'graphql-request';
import type { Climb, HoldsFilter, ZoneMatchMode } from '@boardsesh/shared-schema';

// Slim fragment for search/list views. Intentionally omits `description` to
// keep the list payload small — descriptions can be long and no list UI
// renders them. The drafts drawer uses `SEARCH_DRAFT_CLIMBS` below, which
// extends this fragment with `description` so a draft can be loaded back
// into the create form in a single round-trip.
// published_at/created_at are used by the create form to enforce the 24h
// post-publish edit window.
const CLIMB_SEARCH_FIELDS = `
  uuid
  setter_username
  name
  frames
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  benchmark_difficulty
  is_draft
  is_no_match
  published_at
  created_at
  framesCount
  framesPace
`;

const CLIMB_DRAFT_FIELDS = `
  ${CLIMB_SEARCH_FIELDS}
  description
`;

// Full fragment for single-climb views that need all fields
const CLIMB_DETAIL_FIELDS = `
  uuid
  setter_username
  userId
  name
  description
  frames
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  mirrored
  benchmark_difficulty
  userAscents
  userAttempts
  is_draft
  created_at
  published_at
  framesCount
  framesPace
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

// Used by the drafts drawer only — fetches `description` alongside the
// usual fields so tapping a draft can populate the create form without a
// second round-trip. Kept separate so list and search queries don't pay
// for the extra payload.
export const SEARCH_DRAFT_CLIMBS = gql`
  query SearchDraftClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        ${CLIMB_DRAFT_FIELDS}
      }
      hasMore
    }
  }
`;

export const SEARCH_CLIMBS_COUNT = gql`
  query SearchClimbsCount($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      totalCount
    }
  }
`;

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

// Type for the search input
export type ClimbSearchInputVariables = {
  input: {
    boardName: string;
    layoutId: number;
    sizeId: number;
    setIds: string;
    angle: number;
    page?: number;
    pageSize?: number;
    gradeAccuracy?: string;
    minGrade?: number;
    maxGrade?: number;
    minAscents?: number;
    minRating?: number;
    sortBy?: string;
    sortOrder?: string;
    name?: string;
    setter?: string[];
    onlyTallClimbs?: boolean;
    onlyWideClimbs?: boolean;
    onlyWithBetaVideos?: boolean;
    holdsFilter?: HoldsFilter;
    hideAttempted?: boolean;
    hideCompleted?: boolean;
    showOnlyAttempted?: boolean;
    showOnlyCompleted?: boolean;
    onlyDrafts?: boolean;
    projectsOnly?: boolean;
    boulders?: boolean;
    routes?: boolean;
    zoneBox?: {
      edgeLeft: number;
      edgeRight: number;
      edgeBottom: number;
      edgeTop: number;
    };
    zoneMode?: ZoneMatchMode;
  };
};

// Type for the search response - uses the Climb type from the app
export type ClimbSearchResponse = {
  searchClimbs: {
    climbs: Climb[];
    totalCount?: number;
    hasMore: boolean;
  };
};

export type ClimbSearchCountResponse = {
  searchClimbs: {
    totalCount: number;
  };
};
