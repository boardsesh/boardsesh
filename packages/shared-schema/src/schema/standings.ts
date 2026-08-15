export const standingsTypeDefs = /* GraphQL */ `
  # ============================================
  # Standings (ranked leaderboards)
  # ============================================

  """
  Which slice of climbers a ranking covers.

  Every kind is keyed the same way — \`{ kind, key }\` — so adding a new
  granularity later (city, serial, crew, event) is a registry entry rather than
  a new query. The kinds differ sharply in how much of the data they can
  attribute; see \`coverage\` on the result.
  """
  enum StandingsScopeKind {
    "Every climber, every board. Key must be empty."
    global
    "One board type. Key is 'kilter' | 'tension' | 'moonboard'."
    boardType
    "One board type + layout, e.g. Kilter Board Original. Key is 'boardType:layoutId'."
    layout
    "One physical wall. Key is a user_boards uuid."
    board
    "Every wall at one gym. Key is a gym uuid."
    gym
  }

  input StandingsScopeInput {
    kind: StandingsScopeKind!
    "Empty for global; required for every other kind."
    key: String
  }

  type StandingsScope {
    kind: StandingsScopeKind!
    key: String!
    "Human label for this specific scope — a board's name, a layout's name, or the localized 'Everyone'. Resolved server-side because only the server can turn a key into a name."
    label: String!
    "Distinct climbers with at least one qualifying send in the window."
    climberCount: Int!
  }

  """
  A climber's row in a ranking.
  """
  type StandingsEntry {
    "Opaque stable pseudonym rather than a real user id when isAnonymous. Safe as a list key either way."
    userId: ID!
    "Null when the climber is anonymous on this surface, or simply never set a name."
    displayName: String
    "Null when the climber is anonymous on this surface."
    avatarUrl: String
    "Counted but not named. Render an unnamed climber rather than hiding the row, which would leave a hole in the ranking."
    isAnonymous: Boolean!
    "RANK(): tied climbers SHARE a rank and the next rank skips (1, 2, 2, 4). Neither dense nor unique."
    rank: Int!
    "How many climbers hold this exact rank, including this one."
    tieSize: Int!
    "Distinct climbs topped in the window. Repeats of one climb count once."
    score: Int!
    "Hardest grade sent in the window, on the shared 1-39 scale. Null on mixed-board-type scopes, where grades are not comparable, and on MoonBoard, which has no universal grade."
    hardestGrade: Int
    "True when this row is the requesting climber."
    isViewer: Boolean!
  }

  """
  Where the requesting climber sits, resolved with a window function so the
  client never has to page until it finds itself.
  """
  type ViewerStanding {
    rank: Int!
    score: Int!
    tieSize: Int!
    "Share of the scope at or below this score, 0-1. Suppress in the UI inside a big tie — most climbers are in one."
    percentile: Float!
    "Distinct scores immediately above, nearest first. Feeds the 'two more and you're 81st' line without naming a person."
    scoresAbove: [Int!]!
  }

  """
  A ranking for one scope and one window.
  """
  type Standings {
    "The scope that was asked for."
    requestedScope: StandingsScope!
    """
    The scope actually ranked. Differs from requestedScope when the requested
    one had nobody in it and the server walked up the fallback ladder. Never
    silent — pair it with demotionReason and say so.
    """
    resolvedScope: StandingsScope!
    "Set when resolvedScope differs from requestedScope. A stable machine-readable reason, not display copy."
    demotionReason: StandingsDemotionReason
    entries: [StandingsEntry!]!
    "Distinct climbers in the resolved scope, i.e. the denominator behind every rank."
    totalCount: Int!
    hasMore: Boolean!
    "Where the requesting climber sits. Null when they are signed out, opted out, or logged nothing in this window."
    viewer: ViewerStanding
    """
    Share of recent sends this scope kind can attribute at all, 0-1. Below 1 the
    surface should say why — sends synced from the Kilter or Aurora app carry no
    wall, so a per-wall ranking cannot see them.
    """
    coverage: Float!
  }

  enum StandingsDemotionReason {
    "Nobody has logged a qualifying send in the requested scope during the window."
    empty
    "The requested scope key does not resolve to a board, gym or layout that exists."
    unknownScope
  }

  """
  Rolling windows only. There is deliberately no all-time option: 69.4% of the
  tick history is a frozen one-off logbook import, so an all-time ranking ranks
  whoever uploaded a file. A rolling window also cannot reach that corpus, whose
  newest entry is 2026-03-26.
  """
  enum StandingsWindow {
    "Rolling last 7 days."
    week
    "Rolling last 30 days. The default."
    month
  }

  input StandingsInput {
    scope: StandingsScopeInput!
    window: StandingsWindow
    limit: Int
    offset: Int
  }
`;
