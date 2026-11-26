export const publicClimbRelatedContentTypeDefs = /* GraphQL */ `
  input PublicClimbRelatedContentInput {
    boardType: String!
    layoutId: Int!
    sizeId: Int!
    setIds: [Int!]!
    angle: Int!
    climbUuid: String!
    includeNearby: Boolean = true
  }

  type PublicClimbRelatedContent {
    similarStatus: String!
    similarClimbs: [SimilarClimb!]!
    nearbyStatus: String
    nearbyClimbs: [SimilarClimb!]!
    nearbyGrade: String
    betaStatus: String!
    betaHasMore: Boolean!
    betaLinks: [BetaLink!]!
  }
`;
