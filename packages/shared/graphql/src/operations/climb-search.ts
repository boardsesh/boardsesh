// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';
import type { Climb, HoldsFilter, ZoneMatchMode } from '@boardsesh/shared-schema';

// Slim fragment for search/list views.
//
// It used to omit `description` on the premise that no list UI renders it.
// #4494 overturned that premise: opening a climb from the list lands in the
// play drawer, which renders the setter's notes, so a search result that drops
// the field leaves the drawer blank for every climb reached through the list.
// Both copies of this selection — this one and mobile's hand-maintained twin in
// packages/mobile/src/lib/graphql/operations.ts — now carry it, and
// packages/backend/src/__tests__/operations-schema-validation.test.ts guards
// both against being re-slimmed. Cost is small: mean description length in the
// catalog is 18 characters (max 254) against a `frames` string already on the
// wire.
// published_at/created_at are used by the create form to enforce the 24h
// post-publish edit window.
const CLIMB_SEARCH_FIELDS = `
  uuid
  setter_username
  name
  frames
  boardType
  layoutId
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  benchmark_difficulty
  is_draft
  is_no_match
  characteristics
  published_at
  created_at
  framesCount
  framesPace
  boardseshDifficulty
  boardseshConfidence
  description
  compatibleSizeIds
`;

// Full fragment for single-climb views that need all fields
const CLIMB_DETAIL_FIELDS = `
  uuid
  setter_username
  userId
  name
  description
  frames
  boardType
  layoutId
  angle
  ascensionist_count
  difficulty
  quality_average
  stars
  difficulty_error
  mirrored
  benchmark_difficulty
  characteristics
  userAscents
  userAttempts
  is_draft
  created_at
  published_at
  framesCount
  framesPace
  boardseshDifficulty
  boardseshConfidence
  compatibleSizeIds
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

// Used by the drafts drawer only — a separately-named operation so drafts can
// be traced apart from ordinary search in logs and caches. It selects the same
// fields as SEARCH_CLIMBS; `description` (which the create form needs to
// repopulate a draft without a second round-trip) used to be the one addition,
// and is now in the shared list.
export const SEARCH_DRAFT_CLIMBS = gql`
  query SearchDraftClimbs($input: ClimbSearchInput!) {
    searchClimbs(input: $input) {
      climbs {
        ${CLIMB_SEARCH_FIELDS}
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
    sortSeed?: string;
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
    minUserRating?: number;
    onlyRatedByMe?: boolean;
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
