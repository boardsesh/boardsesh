export const climbTypeDefs = /* GraphQL */ `
  """
  A climbing problem/route on an interactive training board.
  Contains all information needed to display and light up the climb on the board.
  """
  type Climb {
    "Unique identifier for the climb"
    uuid: ID!
    "Layout ID the climb belongs to (used to identify cross-layout climbs)"
    layoutId: Int
    "Username of the person who created this climb"
    setter_username: String!
    "Boardsesh user ID of the climb owner (null for Aurora-synced climbs). Used as the stable identity for ownership gates like the post-publish edit window."
    userId: ID
    "Name/title of the climb"
    name: String!
    "Setter-written notes about the climb (nullable). Carried on search results too — the play drawer and the www climb page both render it."
    description: String
    "Encoded hold positions and colors for lighting up the board"
    frames: String!
    "The angle the climber is browsing at. Named for the set angle historically, but every producer stamps the browsed angle here, and ticks, the queue and the BLE spill guard all key on that. See statsAngle for where the numbers below came from."
    angle: Int!
    "The angle the grade, ascents and quality on this climb were actually read from. Equals angle normally; differs when the browsed angle had no stats row and the climb own set angle supplied them: in a search that set ClimbSearchInput.crossAngleStats (issue #5405), in a by-name search on Woods, and on the Woods climb detail read (issue #5642). Null when the climb has no stats at any angle, i.e. a genuine project. Display only: show it beside the grade when it differs, never key on it. Deliberately absent from ClimbInput, so a queued climb carries no set-angle marker, because adding a field there means changing four lists at once (see queue-climb-field-contract.test.ts) and the marker is not worth that."
    statsAngle: Int
    "Number of people who have completed this climb"
    ascensionist_count: Int!
    "Difficulty grade of the climb (e.g., 'V5', '6B+')"
    difficulty: String!
    "Average quality rating from users"
    quality_average: String!
    "Star rating (0-5), rounded from quality_average"
    stars: Float!
    "Difficulty uncertainty/spread"
    difficulty_error: String!
    "Whether the climb should be displayed mirrored"
    mirrored: Boolean
    "Official benchmark difficulty if this is a benchmark climb"
    benchmark_difficulty: String
    "Whether this climb is a draft (unpublished)"
    is_draft: Boolean
    "Hidden by community moderation (still openable directly)"
    is_hidden: Boolean
    "Number of times the current user has sent this climb"
    userAscents: Int
    "Number of times the current user has attempted this climb"
    userAttempts: Int
    "Board type this climb belongs to (e.g. 'kilter', 'tension'). Populated in multi-board contexts."
    boardType: String
    "Whether this climb disallows matching (both hands on the same hold)"
    is_no_match: Boolean
    "Structured climb characteristics (e.g. 'no_match', 'method_footless'). Decode with @boardsesh/shared-schema helpers (isNoMatch / getMoonBoardMethod)."
    characteristics: [String!]
    "ISO timestamp of when this climb was first published (null while still a draft)"
    published_at: String
    "ISO timestamp of when this climb row was created"
    created_at: String
    "Number of animation frames encoded in the frames string. 1 for static climbs; >1 for variable-speed Aurora routes/circuits."
    framesCount: Int
    "Animation pace between frames, in Aurora's native unit (treated as milliseconds). 0 when not set."
    framesPace: Int
    "Boardsesh grade on the shared difficulty scale (COALESCE of the cross-board universal grade and the within-board local grade), for this climb at its angle. Null when no grade row exists (e.g. MoonBoard, or too few ascents) — the UI keeps the Aurora grade."
    boardseshDifficulty: Float
    "Boardsesh grade confidence tier: 'confirmed' | 'provisional' | 'setter_only' | 'cross_angle_estimate' | 'moonboard_angle_estimate' | 'moonboard_wide_angle_estimate'. All three estimate tiers cover an angle with no ascents: cross_angle_estimate is projected from the climb's other angles, moonboard_angle_estimate is a MoonBoard grade transposed from the board's other fixed angle, and moonboard_wide_angle_estimate is a MoonBoard grade borrowed from another board's angle-effect shape (moonboard-wide-angles flag angles). Null when no grade row exists."
    boardseshConfidence: String
    "Board configuration to draw this climb on, resolved against its setter's boards. Populated by userClimbs; null wherever the board is already known from the route."
    renderBoard: RenderBoardConfig
    """
    Product sizes this climb fits on (denormalised from edge bounds). Null when
    the server has no compatibility data for this climb — a legacy row, or a
    fetch path that doesn't project the column — which imposes no constraint.
    On Woods it is load-bearing rather than cosmetic: the 8x10 and the 12x12
    number their holds from their own origins, so an 8x10 climb's hold ids all
    exist on a 12x12 as different holds and only this field can tell the two
    apart (see canAddClimbToBoard rule 5).
    """
    compatibleSizeIds: [Int!]
    """
    How many of this climb's holds are no longer on the wall.

    Spray walls only — null on every catalogue board, where holds do not come off.
    0 is an intact climb; anything higher is a climb that survived a reset minus
    some holds, which stays findable, gets a badge and can be remixed. Materialised
    on \`board_climbs\` rather than joined, because the offline mirror has no
    \`board_climb_holds\` table to join through.
    """
    missingHoldCount: Int
    """
    The holds this climb was set on that are no longer on the wall, carrying the
    geometry they had while they were — so a client can draw ghost rings where
    they used to be and the climber can see what the reset took.

    Spray walls only: null on every catalogue board, where holds do not come off,
    and null on a climb that has lost nothing, so the common case costs no query.
    An empty list means the climb's holds are all still there but the server did
    look.

    Coordinates are the wall's canonical frame — the same frame
    \`SprayWallRenderData.holds\` uses — so the two sets draw on one photo without
    conversion. \`removedVersion\` is the generation that took each hold off.

    Resolved per climb, with its own query. A list must not select it; it is for a
    single-climb surface — the play drawer and the remix editor.
    """
    lostHolds: [SprayWallHold!]
  }

  """
  Whether a climb still has every hold it was set on.

  ANY is the default and adds no filter at all. INTACT keeps climbs that have lost
  nothing; BROKEN keeps only the ones that have. Meaningful on spray walls, where a
  reset takes holds off the wall; on a catalogue board every climb is INTACT, so
  BROKEN there is an empty result rather than an error.
  """
  enum HoldIntegrityFilter {
    ANY
    INTACT
    BROKEN
  }

  """
  Which grade the grade-range filter reads.

  UPSTREAM is the default: the board's own catalogue grade (display_difficulty),
  falling back to the Boardsesh grade only when a climb has no stats row at that
  angle. BOARDSESH reads the model-generated Boardsesh grade first and falls back to
  the upstream grade, so a climber who sees Boardsesh grades on the list gets the
  rows whose label is in range.
  """
  enum ClimbGradeSource {
    UPSTREAM
    BOARDSESH
  }

  """
  Input type for creating or updating a climb.
  """
  input ClimbInput {
    uuid: ID!
    "Board type the climb belongs to (kilter / tension). Round-tripped so a connected board can skip a climb set for another board."
    boardType: String
    "Layout the climb belongs to. Round-tripped so a connected board can skip a climb set for another layout."
    layoutId: Int
    setter_username: String!
    "Boardsesh user ID of the climb owner (null for Aurora-synced climbs)."
    userId: ID
    name: String!
    description: String
    frames: String!
    angle: Int!
    ascensionist_count: Int!
    difficulty: String!
    quality_average: String!
    stars: Float!
    difficulty_error: String!
    mirrored: Boolean
    benchmark_difficulty: String
    is_no_match: Boolean
    "Structured climb characteristics, round-tripped so the queue keeps method/no-match tags."
    characteristics: [String!]
    "Whether this climb is still a draft."
    is_draft: Boolean
    "ISO timestamp of when this climb was first published."
    published_at: String
    userAscents: Int
    userAttempts: Int
    "Number of animation frames encoded in \`frames\`. 1 for static climbs."
    framesCount: Int
    "Native per-frame pace, in milliseconds. 0 when unset."
    framesPace: Int
    "Boardsesh grade on the shared difficulty scale for this climb+angle. Round-tripped through the queue so party peers render the grade without a refetch."
    boardseshDifficulty: Float
    "Boardsesh grade confidence tier ('confirmed' | 'provisional' | 'setter_only' | 'cross_angle_estimate' | 'moonboard_angle_estimate' | 'moonboard_wide_angle_estimate'), round-tripped through the queue. No estimate tier may be treated as ascent-backed."
    boardseshConfidence: String
    "Product sizes this climb fits on. Round-tripped through the queue so a party peer on a different-sized wall can tell the climb doesn't fit theirs — on Woods the two sizes' hold ids overlap, so this is the only signal that separates them."
    compatibleSizeIds: [Int!]
    "How many of this climb's holds are no longer on the wall after a spray-wall reset. Round-tripped through the queue because a broken climb stays queueable and stays playable, and the peer showing it has to be able to say so — a queued row that dropped this would be the one surface pretending the climb was whole. Null on every catalogue board."
    missingHoldCount: Int
  }

  # ============================================
  # Climb Search Types
  # ============================================

  """
  Bounding box defining a board region for filtering climbs.
  Coordinates are in the same grid space as board placements
  (board_holes.x/y) and board_climbs edge columns.
  """
  input ZoneBoxInput {
    "Left edge of the zone (smaller x)"
    edgeLeft: Int!
    "Right edge of the zone (larger x)"
    edgeRight: Int!
    "Bottom edge of the zone (smaller y)"
    edgeBottom: Int!
    "Top edge of the zone (larger y)"
    edgeTop: Int!
  }

  """
  How a drawn zone should match climbs.
  allHolds keeps the existing behavior: every climb hold must fit inside the box.
  anyHold matches climbs that use at least one hold inside the box.
  """
  enum ZoneMatchMode {
    allHolds
    anyHold
  }

  """
  Input parameters for searching climbs.
  Supports filtering, sorting, and pagination.
  """
  input ClimbSearchInput {
    "Board type (e.g., 'kilter', 'tension')"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board angle in degrees"
    angle: Int!
    "A spray wall's uuid, presented as a capability. Only meaningful when boardName is 'spray': an UNLISTED wall's climbs are listable by a caller holding its uuid, the same way saveClimb accepts it as the right to set on one. A private wall does not open for it, and a uuid naming another wall is ignored."
    sprayWallUuid: String
    "Page number for pagination (1-indexed)"
    page: Int
    "Number of results per page"
    pageSize: Int
    "Grade accuracy filter ('tight', 'moderate', 'loose')"
    gradeAccuracy: String
    "Minimum difficulty grade ID"
    minGrade: Int
    "Maximum difficulty grade ID"
    maxGrade: Int
    "Minimum number of ascents"
    minAscents: Int
    "Minimum quality rating"
    minRating: Float
    "Field to sort by ('ascents', 'difficulty', 'name', 'quality', 'popular', 'creation', 'random')"
    sortBy: String
    "Sort direction ('asc' or 'desc')"
    sortOrder: String
    "Seed for the 'random' sort; keeps OFFSET pagination stable across pages for one shuffle"
    sortSeed: String
    "Filter by climb name (partial match)"
    name: String
    "Filter by setter usernames"
    setter: [String!]
    "Only climbs by followed setters or followed users, including linked board accounts. Requires authentication."
    onlyFollowedAuthors: Boolean
    "Filter by setter ID"
    setterId: Int
    "Only show benchmark climbs"
    onlyBenchmarks: Boolean
    "Only show tall/steep climbs"
    onlyTallClimbs: Boolean
    "Only show Kilter Homewall climbs that use the 10x10 side expansion"
    onlyWideClimbs: Boolean
    "Only show climbs that have a beta video"
    onlyWithBetaVideos: Boolean
    "Hold filter object: { holdId: 'ANY' | 'NOT', ... }"
    holdsFilter: JSON
    "Hide climbs the user has attempted (requires auth)"
    hideAttempted: Boolean
    "Hide climbs the user has completed (requires auth)"
    hideCompleted: Boolean
    "Only show climbs the user has attempted (requires auth)"
    showOnlyAttempted: Boolean
    "Only show climbs the user has completed (requires auth)"
    showOnlyCompleted: Boolean
    "Hide climbs whose latest rating from the user, at this angle, is below this many stars. Climbs the user never rated stay visible unless onlyRatedByMe is also set. 0 means no minimum. (requires auth)"
    minUserRating: Int
    "Only show climbs the user has rated at this angle (requires auth)"
    onlyRatedByMe: Boolean
    "Show only the user's draft climbs (requires auth)"
    onlyDrafts: Boolean
    "Show only unclimbed projects (climbs with 0 ascents)"
    projectsOnly: Boolean
    "Keep only intact climbs, only climbs that have lost a hold, or everything (the default)."
    holdIntegrity: HoldIntegrityFilter
    "Resolve each climb's grade and ascents through its own set angle when the browsed angle has no stats row, instead of ranking it below every climb that does have one (issue #5405). Opt-in on every board; omitted means off. On Woods, whose climbs are bound to the angle they were set at, off also narrows the list to the climbs for the browsed angle: set there, with no set angle recorded, or with stats there (issue #5642). A name search on Woods resolves across angles either way, so a climb is findable by name at any angle."
    crossAngleStats: Boolean
    "Which grade minGrade and maxGrade are compared against. Omitted means UPSTREAM, the grade older app builds filter on. Send BOARDSESH when the list shows Boardsesh grades, so the filter matches the labels."
    gradeSource: ClimbGradeSource
    "Include single-frame climbs (boulders). Omitting both boulders and routes matches all climb types; set boulders=true with routes=false (or omit routes) to filter to boulders only."
    boulders: Boolean
    "Include multi-frame climbs (routes). Omitting both boulders and routes matches all climb types; set routes=true with boulders=false (or omit boulders) to filter to routes only."
    routes: Boolean
    "Restrict results using this drawn zone"
    zoneBox: ZoneBoxInput
    "How the zone should match climb holds. Defaults to allHolds when omitted."
    zoneMode: ZoneMatchMode
  }

  """
  Result of a climb search query.
  """
  type ClimbSearchResult {
    "List of climbs matching the search criteria"
    climbs: [Climb!]!
    "Total number of climbs matching (for pagination)"
    totalCount: Int!
    "Whether there are more results available"
    hasMore: Boolean!
  }

  """
  Input for fetching setter usernames with their climb counts.
  Used to power the setter filter autocomplete in the search drawer.
  """
  input SetterStatsInput {
    "Restrict counts and usernames to followed authors. Requires authentication."
    onlyFollowedAuthors: Boolean
    "Board type (e.g., 'kilter', 'tension')"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board angle in degrees. Ignored on every board whose climbs are not bound to one angle: the setter list is the same at every angle there (#5404). On Woods it is the browsed angle, and the counts cover only the climbs for it unless crossAngleStats is set (#5642)."
    angle: Int!
    "Case-insensitive substring filter on setter username (for autocomplete)"
    search: String
    "Count every climb whatever angle it was set at. Mirrors ClimbSearchInput.crossAngleStats, and only changes anything on Woods, whose climbs are bound to the angle they were set at: omitted or false, a setter is counted only for the climbs the default list shows at this angle (set there, with no set angle recorded, or with stats there), so the picker never offers a setter whose climbs the list cannot show (#5642). Send true when the search it filters has the Other angles switch on."
    crossAngleStats: Boolean
  }

  """
  A setter username paired with the number of climbs they've authored
  for a given board configuration. Angle-independent everywhere but Woods,
  where it follows SetterStatsInput.crossAngleStats.
  """
  type SetterStat {
    "Setter's username"
    setterUsername: String!
    "Number of climbs authored by this setter for the board configuration"
    climbCount: Int!
  }

  """
  Complete canonical statistics for one climb and angle. Published after the
  debounced tick recompute. The layout-scoped subscription carries full rows,
  not deltas, so one event repairs a missed optimistic update without a second
  read. syncSeq is decimal text because JavaScript numbers cannot safely carry
  PostgreSQL bigint revisions.
  """
  type ClimbStatsEvent {
    boardType: String!
    layoutId: Int!
    climbUuid: ID!
    angle: Int!
    ascensionistCount: Int!
    qualityAverage: Float
    difficultyAverage: Float
    displayDifficulty: Float
    difficulty: String
    faUsername: String
    faAt: String
    syncSeq: String!
  }
`;
