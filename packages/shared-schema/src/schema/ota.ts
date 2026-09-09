export const otaTypeDefs = /* GraphQL */ `
  # ============================================
  # OTA Preview Channel Types (compatibility)
  # ============================================

  """
  A per-PR OTA preview channel. Retired in favour of xprem Branch Surfing
  (#4792) — nothing produces these any more and \`otaPreviewChannels\` always
  answers with an empty list. The type survives only so the
  \`GetOtaPreviewChannels\` document embedded in pre-#4792 store binaries keeps
  validating; those builds sit behind a native fingerprint change and cannot be
  updated by OTA. See docs/mobile-ota-updates.md.
  """
  type OtaPreviewChannel {
    "The OTA channel name to switch onto, e.g. \\"pr-3253\\"."
    channel: String!
    "The pull request number."
    prNumber: Int!
    "The pull request title, for display."
    title: String!
    "The pull request web URL."
    url: String!
  }
`;
