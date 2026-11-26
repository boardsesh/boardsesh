import { gql } from 'graphql-request';
import type { PublicClimbRelatedContent, PublicClimbRelatedContentInput } from '@boardsesh/shared-schema';

export const PUBLIC_CLIMB_RELATED_CONTENT = gql`
  query PublicClimbRelatedContent($input: PublicClimbRelatedContentInput!) {
    publicClimbRelatedContent(input: $input) {
      similarStatus
      nearbyStatus
      nearbyGrade
      betaStatus
      betaHasMore
      similarClimbs {
        uuid
        name
        setterUsername
        angle
        layoutId
        frames
        difficultyName
        qualityAverage
        ascensionistCount
        compatibleSizeIds
        requiredSetIds
        characteristics
        similarity
        sharedHoldCount
        candidateHoldCount
        targetHoldCount
      }
      nearbyClimbs {
        uuid
        name
        setterUsername
        angle
        layoutId
        frames
        difficultyName
        qualityAverage
        ascensionistCount
        compatibleSizeIds
        requiredSetIds
        characteristics
        similarity
        sharedHoldCount
        candidateHoldCount
        targetHoldCount
      }
      betaLinks {
        climbUuid
        link
        foreignUsername
        angle
        thumbnail
        isListed
        createdAt
        tickUuid
        boardId
      }
    }
  }
`;

export type PublicClimbRelatedContentQueryVariables = { input: PublicClimbRelatedContentInput };
export type PublicClimbRelatedContentQueryResponse = { publicClimbRelatedContent: PublicClimbRelatedContent };
