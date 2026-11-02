export const adminBoardsTypeDefs = /* GraphQL */ `
  "Stored board metadata for global admins; separate from public UserBoard projections."
  type AdminBoard {
    uuid: ID!
    slug: String!
    ownerId: ID
    ownerDisplayName: String
    boardType: String!
    layoutId: Int!
    sizeId: Int!
    setIds: String!
    name: String!
    description: String
    locationName: String
    latitude: Float
    longitude: Float
    isPublic: Boolean!
    isUnlisted: Boolean!
    hideLocation: Boolean!
    isOwned: Boolean!
    angle: Int!
    isAngleAdjustable: Boolean!
    hasLeds: Boolean!
    "Owner-only, including in the admin registry."
    serialNumber: String
    "Owner-only, including in the admin registry."
    timerName: String
    createdAt: String!
    updatedAt: String!
    gymUuid: ID
    gymName: String
    gymSlug: String
    canEdit: Boolean!
  }

  type AdminBoardConnection {
    boards: [AdminBoard!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  input AdminBoardsInput {
    "Case-insensitive board name, UUID, slug, gym name, or gym slug search."
    query: String
    boardType: String
    limit: Int
    offset: Int
  }
`;
