export const gymsTypeDefs = /* GraphQL */ `
  # ============================================
  # Gym Entity Types
  # ============================================

  enum GymMemberRole {
    "Full gym admin: edit details, manage members/boards."
    admin
    "Write access: edit gym details only. No membership/board management, no delete."
    editor
    "Plain member (social membership; no edit access)."
    member
  }

  enum GymClaimMethod {
    "Verified control of an email at the gym's website domain."
    domain
    "Awaiting a Boardsesh admin's review."
    admin
  }

  enum GymClaimStatus {
    pending
    approved
    denied
    expired
  }

  "Outcome of a requestGymClaim call, so clients can show the right next step."
  enum GymClaimRequestStatus {
    "A verification email was sent to the claimant's work address."
    email_sent
    "The claim was queued for admin review and our team was notified."
    admin_review
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
    "Website URL (used for domain-verified ownership claims)"
    website: String
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
    "Whether the current viewer may edit this gym (owner, gym admin, gym editor, or community admin/leader for one of its board types)"
    canEdit: Boolean!
    "Whether the current viewer may grant/revoke write access to other users (owner, gym admin, or community admin/leader for one of its board types)"
    canGrantAccess: Boolean!
    "Whether the current viewer may start an ownership claim for this gym (signed-in and not already the owner/gym admin)"
    canClaim: Boolean!
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
    "Website URL"
    website: String
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
    "New website URL"
    website: String
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

  """
  Input for granting a user write (editor) access to a gym.
  """
  input GrantGymWriteAccessInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to grant write access to"
    userId: ID!
  }

  """
  Input for revoking a user's write (editor) access to a gym.
  """
  input RevokeGymWriteAccessInput {
    "Gym UUID"
    gymUuid: ID!
    "User ID to revoke write access from"
    userId: ID!
  }

  """
  Input for requesting ownership of a gym.
  """
  input RequestGymClaimInput {
    "Gym UUID to claim"
    gymUuid: ID!
    "Work email at the gym's website domain (domain-verified path). Omit to request admin review."
    claimEmail: String
    "Optional note to the reviewer (admin-review path)."
    message: String
  }

  """
  Result of requesting a gym claim.
  """
  type RequestGymClaimResult {
    "Which path the claim took."
    status: GymClaimRequestStatus!
    "The address a verification email was sent to (domain path only)."
    email: String
  }

  """
  A pending or resolved gym ownership claim (admin queue).
  """
  type GymClaim {
    "Claim ID"
    id: ID!
    "The gym being claimed"
    gymUuid: ID!
    "Gym name (denormalized for the admin queue)"
    gymName: String!
    "Claimant user ID"
    claimantUserId: ID!
    "Claimant display name"
    claimantDisplayName: String
    "Claimant avatar URL"
    claimantAvatarUrl: String
    "How the claim was made"
    method: GymClaimMethod!
    "Current status"
    status: GymClaimStatus!
    "Email address (domain path)"
    claimEmail: String
    "Note to reviewer (admin path)"
    message: String
    "When the claim was created"
    createdAt: String!
  }

  """
  Paginated list of gym claims.
  """
  type GymClaimConnection {
    "List of claims"
    claims: [GymClaim!]!
    "Total number of claims"
    totalCount: Int!
    "Whether more claims are available"
    hasMore: Boolean!
  }

  """
  Decision for reviewing a gym claim.
  """
  enum GymClaimDecision {
    approve
    deny
  }

  """
  Input for an admin reviewing a pending gym claim.
  """
  input ReviewGymClaimInput {
    "Claim ID to review"
    claimId: ID!
    "Whether to approve (transfer ownership) or deny"
    decision: GymClaimDecision!
  }

  """
  Input for listing pending gym claims (admin only).
  """
  input PendingGymClaimsInput {
    "Max claims to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }
`;
