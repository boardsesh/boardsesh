export const favoritesTypeDefs = /* GraphQL */ `
  # ============================================
  # Favorites Types
  # ============================================

  """
  Input for toggling a climb as favorite. Favorites are keyed by climb UUID —
  a climb stays hearted whichever board config or angle you switch to.
  """
  input ToggleFavoriteInput {
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    boardName: String
    "Climb UUID to favorite/unfavorite"
    climbUuid: String!
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    angle: Int
  }

  """
  Result of toggling favorite status.
  """
  type ToggleFavoriteResult {
    "Whether the climb is now favorited"
    favorited: Boolean!
  }

  """
  Input for adding a climb to favorites (idempotent, sync-safe).
  """
  input AddFavoriteInput {
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    boardName: String
    "Climb UUID to favorite"
    climbUuid: String!
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    angle: Int
  }

  """
  Input for removing a climb from favorites (idempotent, sync-safe).
  """
  input RemoveFavoriteInput {
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    boardName: String
    "Climb UUID to unfavorite"
    climbUuid: String!
    "Legacy storage hint; ignored for favorite identity. Kept for shipped clients."
    angle: Int
  }
`;
