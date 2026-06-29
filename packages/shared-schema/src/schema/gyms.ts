export const gymsTypeDefs = /* GraphQL */ `
  # ============================================
  # Gym Entity Types
  # ============================================

  enum GymMemberRole {
    admin
    member
  }

  """
  A physical gym location that can contain multiple boards.
  """
  type Gym {
    "Unique identifier"
    uuid: ID!
    "URL slug for this gym"
    slug: String
    "Owner user ID"
    ownerId: ID!
    "Owner display name"
    ownerDisplayName: String
    "Owner avatar URL"
    ownerAvatarUrl: String
    "Gym name"
    name: String!
    "Optional description"
    description: String
    "Physical address"
    address: String
    "Contact email"
    contactEmail: String
    "Contact phone"
    contactPhone: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible"
    isPublic: Boolean!
    "Image URL"
    imageUrl: String
    "When created"
    createdAt: String!
    "Number of linked boards"
    boardCount: Int!
    "Distinct board types at this gym (kilter, tension, ...) — for filtering and badges"
    boardTypes: [String!]!
    "Number of members"
    memberCount: Int!
    "Number of followers"
    followerCount: Int!
    "Number of comments"
    commentCount: Int!
    "Whether the current user follows this gym"
    isFollowedByMe: Boolean!
    "Whether the current user is a member"
    isMember: Boolean!
    "Current user's role (null if not a member/owner)"
    myRole: GymMemberRole
  }

  """
  Paginated list of gyms.
  """
  type GymConnection {
    "List of gyms"
    gyms: [Gym!]!
    "Total number of gyms"
    totalCount: Int!
    "Whether more gyms are available"
    hasMore: Boolean!
  }

  """
  A member of a gym.
  """
  type GymMember {
    "User ID"
    userId: ID!
    "Display name"
    displayName: String
    "Avatar URL"
    avatarUrl: String
    "Role in the gym"
    role: GymMemberRole!
    "When the member joined"
    createdAt: String!
  }

  """
  Paginated list of gym members.
  """
  type GymMemberConnection {
    "List of members"
    members: [GymMember!]!
    "Total number of members"
    totalCount: Int!
    "Whether more members are available"
    hasMore: Boolean!
  }

  """
  Input for creating a gym.
  """
  input CreateGymInput {
    "Gym name"
    name: String!
    "Optional description"
    description: String
    "Physical address"
    address: String
    "Contact email"
    contactEmail: String
    "Contact phone"
    contactPhone: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible (default true)"
    isPublic: Boolean
    "Image URL"
    imageUrl: String
    "Optional board UUID to link on creation"
    boardUuid: String
  }

  """
  Input for updating a gym.
  """
  input UpdateGymInput {
    "Gym UUID to update"
    gymUuid: ID!
    "New name"
    name: String
    "New slug"
    slug: String
    "New description"
    description: String
    "New address"
    address: String
    "New contact email"
    contactEmail: String
    "New contact phone"
    contactPhone: String
    "New GPS latitude"
    latitude: Float
    "New GPS longitude"
    longitude: Float
    "New visibility"
    isPublic: Boolean
    "New image URL"
    imageUrl: String
  }

  """
  Input for adding a member to a gym.
  """
  input AddGymMemberInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to add"
    userId: ID!
    "Role for the new member"
    role: GymMemberRole!
  }

  """
  Input for removing a member from a gym.
  """
  input RemoveGymMemberInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to remove"
    userId: ID!
  }

  """
  Input for following/unfollowing a gym.
  """
  input FollowGymInput {
    "Gym UUID"
    gymUuid: ID!
  }

  """
  Input for listing current user's gyms.
  """
  input MyGymsInput {
    "Include gyms the user follows"
    includeFollowed: Boolean
    "Max gyms to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for searching gyms.
  """
  input SearchGymsInput {
    "Search query"
    query: String
    "Filter to gyms that have a board of one of these types (OR)"
    boardTypes: [String!]
    "Filter to gyms that have a board with one of these layout ids (OR). Combined with boardTypes/sizeIds, all must match the same board."
    layoutIds: [Int!]
    "Filter to gyms that have a board with one of these size ids (OR). Combined with boardTypes/layoutIds, all must match the same board."
    sizeIds: [Int!]
    "Only gyms with two or more distinct board types"
    multiBoardTypeOnly: Boolean
    "Latitude for proximity search"
    latitude: Float
    "Longitude for proximity search"
    longitude: Float
    "Radius in km for proximity search (default 50)"
    radiusKm: Float
    "Max results to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for listing gym members.
  """
  input GymMembersInput {
    "Gym UUID"
    gymUuid: ID!
    "Max members to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for linking a board to a gym.
  """
  input LinkBoardToGymInput {
    "Board UUID"
    boardUuid: ID!
    "Gym UUID (null to unlink)"
    gymUuid: String
  }
`;
