import { gql } from 'graphql-request';
import type {
  GymClimbRankingInput,
  GymClimbRankingTargetInput,
  GymClimbRankingTarget,
  GymClimbRankings,
} from '@boardsesh/shared-schema';

export const GET_GYM_CLIMB_RANKINGS = gql`
  query GetGymClimbRankings($input: GymClimbRankingInput!) {
    gymClimbRankings(input: $input) {
      status
      mode
      quietAvailable
      startAt
      asOf
      timeZone
      timeZoneConfigured
      rows {
        rank
        physicalBoardUuid
        boardName
        target {
          logicalBoardUuid
          boardSlug
          boardType
          layoutId
          sizeId
          setIds
          climbUuid
          name
          angle
          isMirror
          referenceDifficulty
          shareable
        }
        sendCount
        senderCount
        qualityMean
        voterCount
        commentCount
        authorCount
        gradeDelta
        firstKnownAvailableAt
        lastSendAt
        lastSendEndAt
        lastSendDate
        knownLifetimeDays
        knownWindowDays
        sendsPerDay
      }
      nextCursor
      truncated
    }
  }
`;

export const GET_GYM_CLIMB_RANKING_TARGET = gql`
  query GetGymClimbRankingTarget($input: GymClimbRankingTargetInput!) {
    gymClimbRankingTarget(input: $input) {
      logicalBoardUuid
      boardSlug
      boardType
      layoutId
      sizeId
      setIds
      climbUuid
      name
      angle
      isMirror
      referenceDifficulty
      shareable
    }
  }
`;

export type GetGymClimbRankingsVariables = { input: GymClimbRankingInput };
export type GetGymClimbRankingsResponse = { gymClimbRankings: GymClimbRankings };
export type GetGymClimbRankingTargetVariables = { input: GymClimbRankingTargetInput };
export type GetGymClimbRankingTargetResponse = { gymClimbRankingTarget: GymClimbRankingTarget };
