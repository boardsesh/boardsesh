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
    "Whether this user holds any admin community role (global or board-scoped), unlocking the admin-only tooling"
    isAdmin: Boolean!
    "When the account was created (ISO 8601)"
    createdAt: String!
    "Total number of climbs favourited by this user, across all boards"
    favoriteCount: Int!
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
    "Sync state of the stored credential: pending, active, error, expired, or linked (no credential)"
    syncStatus: String
    "Machine code or message from the last failed sync, when there is one"
    syncError: String
    "The queued or running sync this account is waiting on, if any"
    pendingRunId: ID
    "Whether Sync now can queue a run for this account (its board's sync is switched on)"
    syncAvailable: Boolean
  }

  """
  A "Sync now" request for one linked board account.
  """
  type ProviderSyncRequest {
    "The background run that will sync the account"
    runId: ID!
    "That run's status: queued, running or retrying"
    status: String!
    "True when the request joined a run that was already waiting, instead of queueing a new one"
    coalesced: Boolean!
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
    "Whether account deletion will schedule a linked Stripe subscription to end"
    hasActiveStripeSubscription: Boolean!
  }

  """
  Input for the deleteAccount mutation.
  """
  input DeleteAccountInput {
    "Whether to remove the setter name from published climbs"
    removeSetterName: Boolean!
  }
`;
