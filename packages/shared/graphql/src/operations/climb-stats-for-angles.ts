// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { gql } from 'graphql-request';

export const CLIMB_STATS_FOR_ANGLES = gql`
  query ClimbStatsForAngles($boardName: String!, $climbUuid: ID!) {
    climbStatsForAngles(boardName: $boardName, climbUuid: $climbUuid) {
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      difficulty
      faUsername
      faAt
      syncSeq
    }
  }
`;

export type ClimbStatsForAnglesEntry = {
  angle: number;
  ascensionistCount: number | null;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  difficulty: string | null;
  faUsername: string | null;
  faAt: string | null;
  syncSeq: string;
};

export const CLIMB_STATS_UPDATED_SUBSCRIPTION = gql`
  subscription ClimbStatsUpdated($boardType: String!, $layoutId: Int!) {
    climbStatsUpdated(boardType: $boardType, layoutId: $layoutId) {
      boardType
      layoutId
      climbUuid
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      difficulty
      faUsername
      faAt
      syncSeq
    }
  }
`;

export type ClimbStatsUpdatedSubscriptionVariables = {
  boardType: string;
  layoutId: number;
};

export type ClimbStatsUpdatedSubscriptionResponse = {
  climbStatsUpdated: import('@boardsesh/shared-schema').ClimbStatsEvent;
};

export type ClimbStatsForAnglesResponse = {
  climbStatsForAngles: ClimbStatsForAnglesEntry[];
};

export const CLIMB_STATS_FOR_CLIMBS = gql`
  query ClimbStatsForClimbs($boardName: String!, $climbUuids: [ID!]!) {
    climbStatsForClimbs(boardName: $boardName, climbUuids: $climbUuids) {
      climbUuid
      angle
      ascensionistCount
      qualityAverage
      difficultyAverage
      displayDifficulty
      difficulty
      faUsername
      faAt
      syncSeq
    }
  }
`;

export type ClimbStatsForClimbEntry = ClimbStatsForAnglesEntry & {
  climbUuid: string;
};

export type ClimbStatsForClimbsResponse = {
  climbStatsForClimbs: ClimbStatsForClimbEntry[];
};
