import { gql } from 'graphql-request';

const fields = gql`
  fragment SprayDetectionFields on SprayWallDetection {
    id
    wallUuid
    versionId
    status
    modelVersion
    error
    createdAt
    finishedAt
    result {
      width
      height
      candidates {
        cx
        cy
        r
        confidence
        outline
      }
    }
  }
`;

export const GET_SPRAY_DETECTION = gql`
  ${fields}
  query SprayDetection($wallUuid: ID!, $versionId: ID!) {
    sprayWallDetectionForVersion(wallUuid: $wallUuid, versionId: $versionId) {
      ...SprayDetectionFields
    }
  }
`;
export const REQUEST_SPRAY_DETECTION = gql`
  ${fields}
  mutation RequestSprayDetection($input: RequestSprayWallDetectionInput!) {
    requestSprayWallDetection(input: $input) {
      ...SprayDetectionFields
    }
  }
`;
export const RETRY_SPRAY_DETECTION = gql`
  ${fields}
  mutation RetrySprayDetection($id: ID!) {
    retrySprayWallDetection(id: $id) {
      ...SprayDetectionFields
    }
  }
`;
