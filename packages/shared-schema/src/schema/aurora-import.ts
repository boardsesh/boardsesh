export const auroraImportTypeDefs = /* GraphQL */ `
  # ============================================
  # Aurora JSON Import Types
  # ============================================

  """
  Counts for a single import category (ascents, attempts, circuits).
  """
  type ImportCounts {
    "Number of items successfully imported"
    imported: Int!
    "Number of items skipped (already exist)"
    skipped: Int!
    "Number of items that failed (e.g., unresolved climb name)"
    failed: Int!
  }

  """
  Result of an Aurora JSON import operation.
  """
  type AuroraImportResult {
    "Ascent import counts"
    ascents: ImportCounts!
    "Attempt import counts"
    attempts: ImportCounts!
    "Circuit/playlist import counts"
    circuits: ImportCounts!
    "Climb names that could not be resolved to UUIDs"
    unresolvedClimbs: [String!]!
    "The Aurora username that was claimed during this import"
    claimedUsername: String
  }

  """
  Input for the Aurora JSON import mutation.
  """
  input AuroraImportInput {
    "Board type ('kilter' or 'tension')"
    boardType: String!
    "The Aurora JSON export data"
    data: JSON!
  }
`;
