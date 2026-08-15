export const favoritesTypeDefs = /* GraphQL */ `
  # ============================================
  # Favorites Types
  # ============================================

  """
  Input for toggling a climb as favorite. Favorites are keyed by climb UUID —
  a climb stays hearted whichever board config or angle you switch to.
  """
  input ToggleFavoriteInput {
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
    boardName: String
    "Climb UUID to favorite/unfavorite"
    climbUuid: String!
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
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
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
    boardName: String
    "Climb UUID to favorite"
    climbUuid: String!
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
    angle: Int
  }

  """
  Input for removing a climb from favorites (idempotent, sync-safe).
  """
  input RemoveFavoriteInput {
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
    boardName: String
    "Climb UUID to unfavorite"
    climbUuid: String!
    "Deprecated, ignored. Kept so binaries that shipped before favorites were re-keyed keep validating."
    angle: Int
  }
`;
