export const profileStatsTypeDefs = /* GraphQL */ `
  # ============================================
  # Profile Statistics Types
  # ============================================

  """
  Grade format for profile statistics.
  """
  enum GradeFormat {
    "Font/Fontainebleau grade (e.g. 6c, 7a+)"
    FONT
    "V-grade (e.g. V5, V8)"
    V_GRADE
  }

  """
  Count of distinct climbs at a specific grade.
  """
  type GradeCount {
    "Grade name"
    grade: String!
    "Number of distinct climbs sent at this grade"
    count: Int!
  }

  """
  Statistics for a specific board layout.
  """
  type LayoutStats {
    "Unique key for this layout configuration"
    layoutKey: String!
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int
    "Total distinct climbs sent"
    distinctClimbCount: Int!
    "Breakdown by grade"
    gradeCounts: [GradeCount!]!
  }

  """
  Aggregated profile statistics across all boards.
  """
  type ProfileStats {
    "Total distinct climbs sent across all boards"
    totalDistinctClimbs: Int!
    "Per-layout statistics"
    layoutStats: [LayoutStats!]!
  }
`;
