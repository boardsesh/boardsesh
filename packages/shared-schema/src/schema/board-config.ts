export const boardConfigTypeDefs = /* GraphQL */ `
  # ============================================
  # Board Configuration Types
  # ============================================

  """
  A difficulty grade for a board type.
  """
  type Grade {
    "Numeric difficulty identifier"
    difficultyId: Int!
    "Human-readable grade name (e.g., 'V5', '6B+')"
    name: String!
  }

  """
  A supported board angle.
  """
  type Angle {
    "Angle in degrees"
    angle: Int!
  }

  """
  A single snapshot of climb statistics from the history table.
  Captured during shared sync to track trends over time.
  """
  type ClimbStatsHistoryEntry {
    "Board angle in degrees"
    angle: Int!
    "Number of people who have completed this climb at this angle"
    ascensionistCount: Int
    "Average quality rating"
    qualityAverage: Float
    "Average difficulty rating"
    difficultyAverage: Float
    "Display difficulty value"
    displayDifficulty: Float
    "When this snapshot was recorded"
    createdAt: String!
  }

  """
  Current statistics for a climb at one angle, read from the live stats table.
  One entry per angle the climb has been logged at.
  """
  type ClimbStatsForAngle {
    "Board angle in degrees"
    angle: Int!
    "Number of people who have completed this climb at this angle"
    ascensionistCount: Int
    "Average quality rating"
    qualityAverage: Float
    "Average difficulty rating"
    difficultyAverage: Float
    "Display difficulty value"
    displayDifficulty: Float
    "Human-readable grade label derived from displayDifficulty (e.g., 'V5', '6B+')"
    difficulty: String
    "Username of the first ascensionist"
    faUsername: String
    "When the first ascent was logged (ISO timestamp)"
    faAt: String
  }
`;
