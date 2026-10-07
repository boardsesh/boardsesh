export const sprayDetectionTypeDefs = /* GraphQL */ `
  type SprayDetectionCandidate {
    cx: Float!
    cy: Float!
    r: Float!
    confidence: Float!
    outline: [Float!]
  }
  type SprayDetectionResult {
    width: Int!
    height: Int!
    candidates: [SprayDetectionCandidate!]!
  }
  type SprayWallDetection {
    id: ID!
    wallUuid: ID!
    versionId: ID!
    status: String!
    modelVersion: String!
    result: SprayDetectionResult
    error: String
    createdAt: String!
    queuePosition: Int
    retryAt: String
    finishedAt: String
  }
  type SprayWallImportProgress {
    wallUuid: ID!
    versionId: ID
    detectionId: ID
    stage: String!
    queuePosition: Int
    retryAt: String
    "The wall this unpublished reset clone replaces; null for a plain new wall."
    resetOfWallUuid: String
  }
  input RequestSprayWallDetectionInput {
    wallUuid: ID!
    versionId: ID!
  }
  extend type Query {
    sprayWallImportProgress(wallUuids: [ID!]!): [SprayWallImportProgress!]!
    sprayWallDetection(id: ID!): SprayWallDetection
    sprayWallDetectionForVersion(wallUuid: ID!, versionId: ID!): SprayWallDetection
  }
  extend type Mutation {
    requestSprayWallDetection(input: RequestSprayWallDetectionInput!): SprayWallDetection!
    retrySprayWallDetection(id: ID!): SprayWallDetection!
  }
`;
