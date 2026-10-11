export const privacyTypeDefs = /* GraphQL */ `
  enum PrivacyAudience {
    public
    followers
    only_me
  }
  enum PrivacyResourceAudience {
    public
    unlisted
    followers
    invite_only
    only_me
  }
  enum PrivacyLocationAudience {
    public
    followers
    members
    only_me
  }
  enum PrivacyResourceKind {
    board
    session
  }
  enum PrivacyContentType {
    tick
    session
    comment
    "Retired: climbs have no audience. contentAudience answers public; setContentAudience rejects it."
    climb @deprecated(reason: "A published climb is public to everyone, so a climb has no audience.")
    playlist
    beta
  }
  enum PrivacyGrantStatus {
    pending
    approved
    revoked
  }
  input PrivacyPublicationInput {
    audience: PrivacyAudience!
    privacyRevision: Int!
  }
  type PrivacySettings {
    isPrivate: Boolean!
    privacyRevision: Int!
    "Always 1. Apps that still ship the retired setup screen open it below 1."
    privacyOnboardingVersion: Int! @deprecated(reason: "Retired with the privacy setup screen. Always 1.")
    defaultSessionAudience: PrivacyResourceAudience!
    """
    Show as an anonymous climber on board feeds, leaderboards and live rosters
    of boards this climber doesn't own. Their sends still count.
    """
    anonymousOnForeignBoards: Boolean!
    enabled: Boolean!
  }
  input UpdatePrivacySettingsInput {
    isPrivate: Boolean
    defaultSessionAudience: PrivacyResourceAudience
    "Accepted and ignored."
    privacyOnboardingVersion: Int @deprecated(reason: "Retired with the privacy setup screen. Accepted and ignored.")
  }
  type PrivacyFollowRequest {
    requesterId: ID!
    recipientId: ID!
    createdAt: String!
    displayName: String
    avatarUrl: String
  }
  type PrivacyRelationship {
    userId: ID!
    isPrivate: Boolean!
    isFollowing: Boolean!
    requestPending: Boolean!
  }
  type PrivacyContentAudience {
    audience: PrivacyAudience!
    isExplicit: Boolean!
    canEdit: Boolean!
  }
  input SetContentAudienceInput {
    entityType: PrivacyContentType!
    entityId: ID!
    audience: PrivacyAudience!
    privacyRevision: Int!
  }
  type ResourcePrivacySettings {
    kind: PrivacyResourceKind!
    resourceId: ID!
    ownerId: ID
    audience: PrivacyResourceAudience!
    locationAudience: PrivacyLocationAudience!
    inheritFollowers: Boolean!
    revision: Int!
  }
  input UpdateResourcePrivacyInput {
    kind: PrivacyResourceKind!
    resourceId: ID!
    audience: PrivacyResourceAudience!
    locationAudience: PrivacyLocationAudience
    inheritFollowers: Boolean
  }
  type PrivacyResourceGrant {
    displayName: String
    avatarUrl: String
    userId: ID!
    status: PrivacyGrantStatus!
    invitedBy: ID
  }
  """
  A home board's share link. A signed-in climber who opens it and chooses Join
  becomes an approved member of the board; opening it alone grants nothing.
  """
  type BoardShareLink {
    boardUuid: ID!
    "The link's capability. Treat it like a password: never log it."
    token: String!
    "The path on the web host: /b/{slug}?invite={token}"
    path: String!
    createdAt: String!
  }
  "Where a redeemed share link points, so the client can open the board."
  type BoardShareLinkRedemption {
    boardUuid: ID!
    slug: String!
  }
  "What a signed-out visitor holding a share link may see: the board's name only."
  type BoardShareLinkPreview {
    name: String!
  }
  extend type PublicUserProfile {
    isPrivate: Boolean!
    canViewActivity: Boolean!
  }
  extend type Subscription {
    privacyChanged: Boolean!
  }
  extend type Query {
    privacySettings: PrivacySettings!
    incomingFollowRequests: [PrivacyFollowRequest!]!
    privacyRelationship(userId: ID!): PrivacyRelationship!
    contentAudience(entityType: PrivacyContentType!, entityId: ID!): PrivacyContentAudience!
    resourcePrivacy(kind: PrivacyResourceKind!, resourceId: ID!): ResourcePrivacySettings
    """
    The people with a grant on a board or session the viewer owns. Without
    userIds: pending requests first, then members, newest first, 100 from
    offset; removed people are left out. With userIds (up to 100): those
    people's grants, whatever their status.
    """
    resourceAccessRequests(
      kind: PrivacyResourceKind!
      resourceId: ID!
      offset: Int
      userIds: [ID!]
    ): [PrivacyResourceGrant!]!
    """
    The owner's share link for a Followers or Invite-only home board, minted on
    first read. Null for a Public, Unlisted or Only-me board, and for a spray wall.
    """
    boardShareLink(boardUuid: ID!): BoardShareLink
    "The board name behind an active share link, for a signed-out visitor. Null when the link does not open anything."
    boardShareLinkPreview(token: String!): BoardShareLinkPreview
  }
  extend type Mutation {
    updatePrivacySettings(input: UpdatePrivacySettingsInput!): PrivacySettings!
    """
    Stay anonymous on boards you don't own. A plain preference: available
    whether or not account privacy controls are enabled.
    """
    setAnonymousOnForeignBoards(enabled: Boolean!): PrivacySettings!
    requestFollow(userId: ID!): PrivacyRelationship!
    cancelFollowRequest(userId: ID!): Boolean!
    approveFollowRequest(userId: ID!): Boolean!
    declineFollowRequest(userId: ID!): Boolean!
    removeFollower(userId: ID!): Boolean!
    setContentAudience(input: SetContentAudienceInput!): Boolean!
    updateResourcePrivacy(input: UpdateResourcePrivacyInput!): ResourcePrivacySettings!
    requestResourceAccess(kind: PrivacyResourceKind!, resourceId: ID!): Boolean!
    approveResourceAccess(kind: PrivacyResourceKind!, resourceId: ID!, userId: ID!): Boolean!
    revokeResourceAccess(kind: PrivacyResourceKind!, resourceId: ID!, userId: ID!): Boolean!
    inviteResourceMember(kind: PrivacyResourceKind!, resourceId: ID!, userId: ID!): Boolean!
    "Revoke the board's share link and mint a new one. Owner only; null when the board has no share link."
    resetBoardShareLink(boardUuid: ID!): BoardShareLink
    "Join the board a share link names as an approved member. NOT_FOUND for a revoked or unknown link."
    redeemBoardShareLink(token: String!): BoardShareLinkRedemption!
  }
`;
