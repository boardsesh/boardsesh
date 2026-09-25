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
    "Freely-toggleable characteristics to set at creation. Only CLIMB_CHARACTERISTICS.NO_KICKBOARD / .CAMPUS are accepted here — MoonBoard method is creation-time-only via SaveMoonBoardClimbInput, and no_match / any_feet ride noMatch / anyFeet below."
    characteristics: [String!]
    "Matching disallowed. Wins over the legacy 'No match' description prefix; null or omitted falls back to that prefix and otherwise means false."
    noMatch: Boolean
    "Any hold on the wall counts as a foot. Null or omitted means false."
    anyFeet: Boolean
    "Physical board size the climb is set on. Required on Woods (1 = 8x10, 2 = 12x12), where the two walls number their holds from their own origins. Ignored on boards that derive size compatibility from the hold bounding box."
    sizeId: Int
    "The setter's own grade, seeded into board_climb_stats.display_difficulty. REQUIRED to publish on a spray wall, which has no crowd grade to fall back on; ignored elsewhere, where the grade comes from ticks or the Aurora sync."
    userGrade: String
    """
    The spray wall this climb is being set on, as the share link carries it.

    Only meaningful for \`boardType: "spray"\`, and only needed by a caller who is
    neither the wall's owner nor a member of its gym: the wall's \`layoutId\` above
    comes out of a sequence, so it is not a secret and cannot authorize a write on
    its own. The wall's uuid IS the capability an UNLISTED wall's share link hands
    out, so presenting it is what lets the crew somebody shared their home wall
    with set climbs on it. A PRIVATE wall refuses everyone but its owner and its
    gym, uuid or not. Send it on every spray write; it costs nothing when the
    caller is a principal.
    """
    sprayWallUuid: String
    """
    The spray wall climb this one was remixed from.

    Writes a \`spray_climb_lineage\` row alongside the child, which is what the
    child's screen reads to link back to the parent's ticks and grade history.
    Only meaningful for \`boardType: "spray"\`, and the parent has to be a climb
    on the SAME wall. The parent is kept even when it is no longer climbable —
    that is usually why it was remixed.
    """
    remixOfClimbUuid: ID
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
    "Freely-toggleable characteristics: the full desired boolean state of CLIMB_CHARACTERISTICS.NO_KICKBOARD / .CAMPUS. Any other characteristic already on the row (no_match, any_feet, MoonBoard method) is left untouched."
    characteristics: [String!]
    "Matching disallowed. Null or omitted preserves the stored value, so an old client cannot clear it. When set it wins over the legacy 'No match' description prefix in the same call."
    noMatch: Boolean
    "Any hold counts as a foot. Null or omitted preserves the stored value."
    anyFeet: Boolean
    "Physical board size, where it is part of the climb's identity (Woods). Immutable — a size that differs from the stored one is rejected. Null or omitted keeps the stored size."
    sizeId: Int
    """
    The setter's own grade.

    Needed to publish a DRAFT on a spray wall when the draft was created without
    one: that board has no crowd grade to converge on, so a grade has to come from
    either the stats row \`saveClimb\` already seeded or from this field. Ignored
    on every other board, where the grade comes from ticks or the Aurora sync.
    """
    userGrade: String
    """
    The spray wall this climb is being set on, as the share link carries it.

    Only meaningful for \`boardType: "spray"\`, and only needed by a caller who is
    neither the wall's owner nor a member of its gym: the wall's \`layoutId\` above
    comes out of a sequence, so it is not a secret and cannot authorize a write on
    its own. The wall's uuid IS the capability an UNLISTED wall's share link hands
    out, so presenting it is what lets the crew somebody shared their home wall
    with set climbs on it. A PRIVATE wall refuses everyone but its owner and its
    gym, uuid or not. Send it on every spray write; it costs nothing when the
    caller is a principal.
    """
    sprayWallUuid: String
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
    """
    Physical board size to scope candidates to. Load-bearing on Woods, whose two
    walls reuse the same hold-id range for different holds — without it an 8x10
    climb reads as near-identical to an unrelated 12x12 one. On Woods the target
    climb's own compatible sizes fill this in when climbUuid is given; a
    frames-only Woods lookup must send it or the result is empty. Ignored on
    every other board.
    """
    sizeId: Int
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

  "One hold's usage across the climbs a search matches (the hold heatmap)."
  type HoldStat {
    "Renderer/frame hold id (MoonBoard cell ids included)."
    holdId: Int!
    "Climbs that use the hold."
    totalUses: Int!
    startingUses: Int!
    handUses: Int!
    footUses: Int!
    finishUses: Int!
    "Sum of those climbs' ascent counts at the browsed angle."
    totalAscents: Int!
    "Average display difficulty of those climbs; null when none has a grade."
    averageDifficulty: Float
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
    "Average quality at this angle on the canonical 1-5 scale (board_climb_stats.quality_average)."
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
    """
    Structured climb rules ('no_match', 'any_feet', 'campus', 'no_kickboard',
    method_*). Nullable, unlike compatibleSizeIds above: null means the server
    did not record the rules, and an empty array means the climb is set under
    all the defaults. The Woods play drawer states both rules on every problem,
    so it has to be able to tell those two apart (issue #5214).
    """
    characteristics: [String!]
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
