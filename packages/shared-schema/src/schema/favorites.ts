export const favoritesTypeDefs = /* GraphQL */ `
  # ============================================
  # Favorites Types
  # ============================================

  """
  Input for toggling a climb as favorite.
  """
  input ToggleFavoriteInput {
    "Climb UUID to favorite/unfavorite"
    climbUuid: String!
  }

  """
  Result of toggling favorite status.
  """
  type ToggleFavoriteResult {
    "Whether the climb is now favorited"
    favorited: Boolean!
  }
`;
