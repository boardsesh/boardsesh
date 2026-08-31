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
  One canonical QuantumBoard hold position from the signed catalogue.
  """
  type QuantumGeometryPlacement {
    placementId: Int!
    holeId: Int!
    "Canonical horizontal coordinate, scaled by 1000."
    x: Int!
    "Canonical vertical coordinate, scaled by 1000."
    y: Int!
    "Controller LED position (unsigned 16-bit autocad id)."
    ledPosition: Int!
  }

  """
  Revisioned geometry for one exact QuantumBoard model.
  """
  type QuantumGeometry {
    layoutId: Int!
    sizeId: Int!
    revision: String!
    edgeLeft: Int!
    edgeRight: Int!
    edgeBottom: Int!
    edgeTop: Int!
    placements: [QuantumGeometryPlacement!]!
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
    "Monotonic database revision, encoded as decimal text to preserve bigint precision"
    syncSeq: String!
  }

  """
  Current statistics for one climb at one angle in a batched primary read.
  The climb UUID is repeated on every row so clients can route a flat response
  without relying on request order. Requested climbs with no stats have no row.
  """
  type ClimbStatsForClimb {
    "Climb whose statistics this row describes"
    climbUuid: ID!
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
    "Monotonic database revision, encoded as decimal text to preserve bigint precision"
    syncSeq: String!
  }

  """
  The Boardsesh grade for a climb at one angle: the data-science-backed grade
  produced by the nightly refresh job, or — for an angle nobody has climbed yet
  — a cross_angle_estimate projected from the same climb's other angles. Null
  query result means neither exists (e.g. MoonBoard, too few ascents, or fewer
  than two other ascent-backed angles to project from).
  """
  type BoardseshGrade {
    "Within-board shrunk grade on the shared difficulty scale (null when unavailable)"
    localGrade: Float
    "Cross-board standardized grade (Tension-anchored); null when unanchorable"
    universalGrade: Float
    "Geometry (Climb2Vec) grade estimate from the hold layout alone, independent of crowd data; null when unscored"
    contentGrade: Float
    "Low end of the 95% band on the surfaced grade"
    gradeLow: Float
    "High end of the 95% band on the surfaced grade"
    gradeHigh: Float
    "Confidence tier: confirmed | provisional | setter_only | cross_angle_estimate (projected from the climb's other angles, no ascents here)"
    confidence: String!
    "Ascent count that produced this row"
    ascensionistCount: Int!
    "Model version that produced this row"
    modelVersion: String!
    "When this grade was computed (ISO timestamp)"
    computedAt: String!
  }

  """
  The Boardsesh grade for a climb at one specific angle, carried in the
  per-angle list. Same shape as BoardseshGrade with the angle attached, so a
  climb's grade at every angle — computed from ascents or projected across
  angles — can be fetched in one go.
  """
  type BoardseshGradeForAngle {
    "Board angle in degrees"
    angle: Int!
    "Within-board shrunk grade on the shared difficulty scale (null when unavailable)"
    localGrade: Float
    "Cross-board standardized grade (Tension-anchored); null when unanchorable"
    universalGrade: Float
    "Geometry (Climb2Vec) grade estimate from the hold layout alone, independent of crowd data; null when unscored"
    contentGrade: Float
    "Low end of the 95% band on the surfaced grade"
    gradeLow: Float
    "High end of the 95% band on the surfaced grade"
    gradeHigh: Float
    "Confidence tier: confirmed | provisional | setter_only | cross_angle_estimate (projected from the climb's other angles, no ascents here)"
    confidence: String!
    "Ascent count that produced this row"
    ascensionistCount: Int!
    "Model version that produced this row"
    modelVersion: String!
    "When this grade was computed (ISO timestamp)"
    computedAt: String!
  }
`;
