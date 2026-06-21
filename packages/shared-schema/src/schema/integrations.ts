export const integrationsTypeDefs = /* GraphQL */ `
  # ============================================
  # External Platform Integration Types
  # ============================================

  """
  Server-side external platform integrations. Device-local integrations
  (Apple Health, Health Connect) are intentionally absent — they never hold
  server-side credentials and are managed entirely on the device.
  """
  enum IntegrationProvider {
    STRAVA
  }

  """
  Connection state of one external platform integration for the current user.
  """
  type IntegrationStatus {
    provider: IntegrationProvider!
    "Whether the user has linked an account for this provider"
    connected: Boolean!
    "Display name of the linked external account (e.g. Strava athlete name)"
    externalAccountName: String
    "Whether finished sessions upload automatically"
    autoSyncEnabled: Boolean!
    "Credential health: 'active' | 'expired' | 'error' | 'revoked'. Null when not connected."
    status: String
    "ISO 8601 timestamp of the last successful upload"
    lastSyncAt: String
    "Most recent sync or token error, if any"
    lastError: String
  }

  """
  Result of exporting a session to an external platform.
  """
  type IntegrationExportResult {
    provider: IntegrationProvider!
    sessionId: ID!
    "Activity ID on the external platform; null when the export failed"
    externalActivityId: String
    "Web URL of the activity on the external platform"
    externalActivityUrl: String
    "ISO 8601 timestamp of the export"
    syncedAt: String
    "Error message when the export failed"
    error: String
  }
`;
