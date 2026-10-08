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
    climb
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
    privacyOnboardingVersion: Int!
    defaultSessionAudience: PrivacyResourceAudience!
    enabled: Boolean!
  }
  input UpdatePrivacySettingsInput {
    isPrivate: Boolean
    defaultSessionAudience: PrivacyResourceAudience
    privacyOnboardingVersion: Int
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
    resourceAccessRequests(kind: PrivacyResourceKind!, resourceId: ID!): [PrivacyResourceGrant!]!
  }
  extend type Mutation {
    updatePrivacySettings(input: UpdatePrivacySettingsInput!): PrivacySettings!
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
  }
`;
