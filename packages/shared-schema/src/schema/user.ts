export const userTypeDefs = /* GraphQL */ `
  # ============================================
  # User Management Types
  # ============================================

  """
  User profile information.
  """
  type UserProfile {
    "Unique user identifier"
    id: ID!
    "User's email address"
    email: String!
    "Display name shown to other users"
    displayName: String
    "URL to user's avatar image"
    avatarUrl: String
    "Whether this user can reach tester-only developer tooling (has the tester or admin community role)"
    isTester: Boolean!
    "When the account was created (ISO 8601)"
    createdAt: String!
    "Total number of climbs favourited by this user, across all boards"
    favoriteCount: Int!
    "How this climber appears on Boardsesh's own ranked surfaces."
    leaderboardVisibility: BoardLeaderboardVisibility!
    "How this climber appears on gym-operated screens (the kiosk rail, wall feeds). Held separately from leaderboardVisibility on purpose: being named on a screen inside the gym you are standing in is a different decision from being named in an app a stranger can open."
    gymScreenVisibility: BoardLeaderboardVisibility!
  }

  """
  How much of a climber is shown on a ranked surface.
  """
  enum BoardLeaderboardVisibility {
    "Name, avatar and score, tappable through to the profile."
    public
    "Ranked and counted toward the field size, but shown as an unnamed climber."
    anonymous
    "No rank, no row, and not in the denominator. They can still read every list and still see their own numbers."
    off
  }

  """
  Input for updating user profile. Every field is optional; omitted fields are left unchanged.
  """
  input UpdateProfileInput {
    "New display name"
    displayName: String
    "New avatar URL"
    avatarUrl: String
    "How this climber appears on Boardsesh's own ranked surfaces"
    leaderboardVisibility: BoardLeaderboardVisibility
    "How this climber appears on gym-operated screens"
    gymScreenVisibility: BoardLeaderboardVisibility
  }

  """
  Stored credentials for an Aurora Climbing board account.
  """
  type AuroraCredential {
    "Board type ('kilter' or 'tension')"
    boardType: String!
    "Aurora account username"
    username: String!
    "Aurora user ID (after successful sync)"
    userId: Int
    "When credentials were last synced (ISO 8601)"
    syncedAt: String
    "Aurora API token (only returned when needed)"
    token: String
  }

  """
  Status of Aurora credentials without sensitive data.
  """
  type AuroraCredentialStatus {
    "Board type ('kilter' or 'tension')"
    boardType: String!
    "Aurora account username"
    username: String!
    "Aurora user ID (after successful sync)"
    userId: Int
    "When credentials were last synced (ISO 8601)"
    syncedAt: String
    "Whether a valid token is stored"
    hasToken: Boolean!
  }

  """
  Input for saving Aurora board credentials.
  """
  input SaveAuroraCredentialInput {
    "Board type ('kilter' or 'tension')"
    boardType: String!
    "Aurora account username"
    username: String!
    "Aurora account password"
    password: String!
  }

  """
  Information needed before account deletion.
  """
  type DeleteAccountInfo {
    "Number of published (non-draft) climbs the user has created"
    publishedClimbCount: Int!
  }

  """
  Input for the deleteAccount mutation.
  """
  input DeleteAccountInput {
    "Whether to remove the setter name from published climbs"
    removeSetterName: Boolean!
  }
`;
