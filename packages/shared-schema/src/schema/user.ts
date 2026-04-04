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
  }

  """
  Input for updating user profile.
  """
  input UpdateProfileInput {
    "New display name"
    displayName: String
    "New avatar URL"
    avatarUrl: String
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
