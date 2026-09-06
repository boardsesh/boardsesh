export const proposalsTypeDefs = /* GraphQL */ `
  # ============================================
  # Community Proposals + Admin Roles
  # ============================================

  enum ProposalType {
    grade
    classic
    benchmark
    hide
  }

  enum ProposalStatus {
    open
    approved
    rejected
    superseded
  }

  enum CommunityRoleType {
    admin
    community_leader
    tester
  }

  """
  A community proposal for changing a climb's grade, classic status, or benchmark status.
  """
  type Proposal {
    uuid: ID!
    climbUuid: String!
    boardType: String!
    angle: Int
    proposerId: ID!
    proposerDisplayName: String
    proposerAvatarUrl: String
    type: ProposalType!
    proposedValue: String!
    currentValue: String!
    status: ProposalStatus!
    reason: String
    resolvedAt: String
    resolvedBy: String
    createdAt: String!
    weightedUpvotes: Int!
    weightedDownvotes: Int!
    requiredUpvotes: Int!
    userVote: Int!
    climbName: String
    frames: String
    layoutId: Int
    climbSetterUsername: String
    climbDifficulty: String
    climbQualityAverage: String
    climbAscensionistCount: Int
    climbDifficultyError: String
    climbBenchmarkDifficulty: String
    "Whether matching is disallowed on this climb"
    climbIsNoMatch: Boolean
    "Distinct users who upvoted (unweighted)"
    upvoterCount: Int!
    "Comments on this proposal (the reporters' reasons)"
    commentCount: Int!
    "Whether the climb is currently hidden by the community"
    climbIsHidden: Boolean
  }

  """
  Paginated list of proposals.
  """
  type ProposalConnection {
    proposals: [Proposal!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  """
  Vote tally for a proposal.
  """
  type ProposalVoteSummary {
    weightedUpvotes: Int!
    weightedDownvotes: Int!
    requiredUpvotes: Int!
    isApproved: Boolean!
  }

  """
  Analysis of whether a climb's grade is an outlier compared to adjacent angles.
  """
  type OutlierAnalysis {
    isOutlier: Boolean!
    currentGrade: Float!
    neighborAverage: Float!
    neighborCount: Int!
    gradeDifference: Float!
  }

  """
  Community status for a climb at a specific angle.
  """
  type ClimbCommunityStatus {
    climbUuid: String!
    boardType: String!
    angle: Int!
    communityGrade: String
    isBenchmark: Boolean!
    isClassic: Boolean!
    isFrozen: Boolean!
    freezeReason: String
    openProposalCount: Int!
    outlierAnalysis: OutlierAnalysis
    updatedAt: String
  }

  """
  Classic status for a climb (angle-independent).
  """
  type ClimbClassicStatus {
    climbUuid: String!
    boardType: String!
    isClassic: Boolean!
    updatedAt: String
  }

  """
  A community role assignment for a user.
  """
  type CommunityRoleAssignment {
    id: Int!
    userId: ID!
    userDisplayName: String
    userAvatarUrl: String
    role: CommunityRoleType!
    boardType: String
    grantedBy: String
    grantedByDisplayName: String
    createdAt: String!
  }

  """
  A community setting key-value pair.
  """
  type CommunitySetting {
    id: Int!
    scope: String!
    scopeKey: String!
    key: String!
    value: String!
    setBy: String
    createdAt: String!
    updatedAt: String!
  }

  input CreateProposalInput {
    climbUuid: String!
    boardType: String!
    angle: Int
    type: ProposalType!
    proposedValue: String!
    reason: String
  }

  input VoteOnProposalInput {
    proposalUuid: ID!
    value: Int!
  }

  input ResolveProposalInput {
    proposalUuid: ID!
    status: ProposalStatus!
    reason: String
  }

  input DeleteProposalInput {
    proposalUuid: ID!
  }

  input SetterOverrideInput {
    climbUuid: String!
    boardType: String!
    angle: Int!
    communityGrade: String
    isBenchmark: Boolean
  }

  input FreezeClimbInput {
    climbUuid: String!
    boardType: String!
    frozen: Boolean!
    reason: String
  }

  input GrantRoleInput {
    userId: ID!
    role: CommunityRoleType!
    boardType: String
  }

  input RevokeRoleInput {
    userId: ID!
    role: CommunityRoleType!
    boardType: String
  }

  input SetCommunitySettingInput {
    scope: String!
    scopeKey: String!
    key: String!
    value: String!
  }

  input GetClimbProposalsInput {
    climbUuid: String!
    boardType: String!
    angle: Int
    type: ProposalType
    status: ProposalStatus
    limit: Int
    offset: Int
  }

  input BrowseProposalsInput {
    boardType: String
    "Filter by board UUID (resolves to boardType internally)"
    boardUuid: String
    type: ProposalType
    "Filter by several proposal types"
    types: [ProposalType!]
    status: ProposalStatus
    limit: Int
    offset: Int
  }

  """
  What a report asks for: hide the climb outright, or change its grade.
  """
  enum ReportClimbKind {
    hide
    grade
  }

  """
  What happened to the report: a new proposal was opened, the reporter joined an
  existing one, or they had already reported this climb.
  """
  enum ReportClimbStatus {
    created
    added
    already_reported
  }

  input ReportClimbInput {
    climbUuid: String!
    boardType: String!
    "Required for grade reports; ignored for hide"
    angle: Int
    kind: ReportClimbKind!
    "Grade label as returned by the grades query (e.g. 6b+/V4); required for grade reports"
    proposedGrade: String
    "Why you are reporting (10..500 chars)"
    reason: String!
  }

  type ReportClimbResult {
    status: ReportClimbStatus!
    proposal: Proposal!
  }
`;
