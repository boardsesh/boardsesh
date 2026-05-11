export const userPreferencesTypeDefs = /* GraphQL */ `
  # ============================================
  # User Preferences Types
  # ============================================

  """
  A single per-user key/value preference entry.
  Used for any small preference the user can toggle (consent flags,
  onboarding completion markers, feature opt-ins, etc.) that should
  survive across devices when the user is signed in.
  """
  type UserPreference {
    "Stable key identifying the preference (e.g. 'consent:analytics')"
    key: String!
    "Arbitrary JSON-encoded value"
    value: JSON!
    "When this preference was last written (ISO 8601)"
    updatedAt: String!
  }

  """
  Input for setting (creating or updating) a single user preference.
  """
  input SetUserPreferenceInput {
    "Stable key identifying the preference"
    key: String!
    "Arbitrary JSON-encoded value to store"
    value: JSON!
  }
`;
