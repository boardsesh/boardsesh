export const favoritesTypeDefs = /* GraphQL */ `
  # ============================================
  # Favorites Types
  # ============================================

  """
  Input for toggling a climb as favorite.
  """
  input ToggleFavoriteInput {
    "Board type"
    boardName: String!
    "Climb UUID to favorite/unfavorite"
    climbUuid: String!
    "Board angle"
    angle: Int!
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
    "Board type"
    boardName: String!
    "Climb UUID to favorite"
    climbUuid: String!
    "Board angle"
    angle: Int!
  }

  """
  Input for removing a climb from favorites (idempotent, sync-safe).
  """
  input RemoveFavoriteInput {
    "Board type"
    boardName: String!
    "Climb UUID to unfavorite"
    climbUuid: String!
    "Board angle"
    angle: Int!
  }
`;
