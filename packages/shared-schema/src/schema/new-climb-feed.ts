export const newClimbFeedTypeDefs = /* GraphQL */ `
  # ============================================
  # New Climb Feed & Subscriptions
  # ============================================

  type NewClimbSubscription {
    id: ID!
    boardType: String!
    layoutId: Int!
    createdAt: String!
  }

  input NewClimbSubscriptionInput {
    boardType: String!
    layoutId: Int!
  }

  type NewClimbFeedItem {
    uuid: ID!
    name: String
    boardType: String!
    layoutId: Int!
    setterDisplayName: String
    setterAvatarUrl: String
    angle: Int
    frames: String
    difficultyName: String
    "Whether matching is disallowed on this climb"
    isNoMatch: Boolean!
    createdAt: String!
  }

  type NewClimbFeedResult {
    items: [NewClimbFeedItem!]!
    totalCount: Int!
    hasMore: Boolean!
  }

  input NewClimbFeedInput {
    boardType: String!
    layoutId: Int!
    limit: Int
    offset: Int
  }

  input MoonBoardHoldsInput {
    start: [String!]!
    hand: [String!]!
    finish: [String!]!
  }

  input MoonBoardClimbDuplicateCandidateInput {
    clientKey: String!
    holds: MoonBoardHoldsInput!
  }

  input CheckMoonBoardClimbDuplicatesInput {
    layoutId: Int!
    angle: Int!
    climbs: [MoonBoardClimbDuplicateCandidateInput!]!
  }

  type MoonBoardClimbDuplicateMatch {
    clientKey: String!
    exists: Boolean!
    existingClimbUuid: ID
    existingClimbName: String
  }

  type NewClimbCreatedEvent {
    climb: NewClimbFeedItem!
  }

  input SaveClimbInput {
    boardType: String!
    layoutId: Int!
    name: String!
    description: String
    isDraft: Boolean!
    frames: String!
    framesCount: Int
    framesPace: Int
    angle: Int!
  }

  """
  MoonBoard problem method, stored as a mutually-exclusive climb-characteristic
  token. Omit for the "feet follow hands" default. Source of truth for the token
  set: CLIMB_CHARACTERISTICS in @boardsesh/shared-schema.
  """
  enum MoonBoardMethod {
    "No foot holds; the kickboard is not used."
    method_footless
    "No foot holds; the kickboard may be used."
    method_footless_kickboard
    "Feet follow hands, but the kickboard is off-limits."
    method_no_kickboard
  }

  input SaveMoonBoardClimbInput {
    boardType: String!
    layoutId: Int!
    name: String!
    description: String
    holds: MoonBoardHoldsInput!
    angle: Int!
    isDraft: Boolean
    userGrade: String
    isBenchmark: Boolean
    "MoonBoard method as a characteristic token. Omit for the 'feet follow hands' default."
    method: MoonBoardMethod
    setter: String
  }

  type SaveClimbResult {
    uuid: ID!
    synced: Boolean!
    "ISO timestamp of when the row was created"
    createdAt: String
    "ISO timestamp of when the row was first published (null while still a draft)"
    publishedAt: String
  }

  """
  Input for updating an existing climb. Only the climb's owner can update
  the row, and only while it is still a draft OR within 24 hours of its
  first publish.
  """
  input UpdateClimbInput {
    uuid: ID!
    boardType: String!
    name: String
    description: String
    frames: String
    angle: Int
    "When set, flips the draft state. A climb can go from draft→published but not the other way around."
    isDraft: Boolean
    framesCount: Int
    framesPace: Int
  }

  type UpdateClimbResult {
    uuid: ID!
    createdAt: String
    publishedAt: String
    isDraft: Boolean!
  }

  """
  Input for finding climbs similar to a target on the same board+layout.
  Provide either climbUuid (compare against an existing climb's holds) or
  frames (compare against a not-yet-saved hold set).
  """
  input SimilarClimbsInput {
    boardType: String!
    layoutId: Int!
    "Jaccard threshold (0..1). Returns climbs at or above this similarity."
    threshold: Float
    "Max number of results to return. Defaults to 25, capped at 200 server-side."
    limit: Int
    "Exclude this climb's uuid from results (e.g. when looking up similars for an existing climb)."
    excludeClimbUuid: ID
    """
    Viewer angle. When provided, grade/quality/ascent stats and the displayed
    difficulty name are resolved against this angle on each candidate climb.
    When omitted, falls back to each candidate's own saved angle — useful for
    contexts that don't have a viewer angle (e.g. the create-climb duplicate
    drawer where the candidate's angle is the right reference).
    """
    angle: Int
    "Existing climb to compare against. Reads its holds from the database."
    climbUuid: ID
    "Raw frames string for an in-progress climb that hasn't been saved yet."
    frames: String
  }

  type SimilarClimb {
    uuid: ID!
    name: String
    setterUsername: String
    angle: Int
    layoutId: Int!
    "Aurora-style frame string for rendering the climb thumbnail."
    frames: String
    "Difficulty grade name at this climb's angle (e.g. 6c+, V5)."
    difficultyName: String
    "Average quality (0..3 in MoonBoard convention, 0..5 elsewhere) at this angle."
    qualityAverage: Float
    "Number of recorded ascents at this angle."
    ascensionistCount: Int
    """
    Product sizes this climb fits on (denormalised from edge bounds). Callers
    on a smaller wall can use this to grey out climbs that extend beyond
    their physical board — those climbs are still navigable in the actions
    menu but can't be set as the active climb. Empty array means the
    server has no compatibility data for this climb (legacy row).
    """
    compatibleSizeIds: [Int!]!
    "Jaccard similarity (0..1) over hold positions."
    similarity: Float!
    "Number of hold positions present in both climbs."
    sharedHoldCount: Int!
    "Number of hold positions on the candidate climb."
    candidateHoldCount: Int!
    "Number of hold positions on the target climb (input)."
    targetHoldCount: Int!
  }
`;
