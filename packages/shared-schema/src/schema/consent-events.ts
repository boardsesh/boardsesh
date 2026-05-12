export const consentEventsTypeDefs = /* GraphQL */ `
  # ============================================
  # Consent Events
  # ============================================

  """
  Input for recording an anonymous consent-rejection event.
  Fired when a user picks (or flips to) a state that denies both
  analytics and error monitoring. Carries no PII — server records only
  the source surface and a timestamp.
  """
  input RecordConsentRejectionInput {
    "Which surface the rejection came from: 'banner', 'dialog', or 'settings'."
    source: String!
  }
`;
