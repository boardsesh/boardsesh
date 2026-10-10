export const appleAdsAttributionTypeDefs = /* GraphQL */ `
  input AppleAdsConsentInput {
    analytics: String!
    version: Int!
    source: String!
    decidedAt: String!
  }

  enum AppleAdsAttributionStatus {
    ATTRIBUTED
    UNATTRIBUTED
    TEST
    INVALID_TOKEN
    RETRYABLE
    CONSENT_REQUIRED
  }

  "Campaign identifiers verified against Apple's AdServices API, never its raw response."
  type AppleAdsAttribution {
    orgId: String!
    campaignId: String!
    adGroupId: String!
    keywordId: String
    adId: String
    conversionType: String!
    claimType: String
    countryOrRegion: String
    supplyPlacement: String
  }

  type AppleAdsAttributionResult {
    status: AppleAdsAttributionStatus!
    attribution: AppleAdsAttribution
    retryAfterSeconds: Int
    "not_ready, unavailable or rate_limited; null for terminal outcomes."
    retryReason: String
  }

  extend type Mutation {
    """
    Exchange an opaque iOS AdServices token only while analytics consent is
    granted. Anonymous HTTP callers supply their device answer; signed-in
    callers also respect the account's current answer. Nothing is persisted
    or published by this mutation. UNATTRIBUTED means Apple found no matching
    ad record, not that the install is organic.
    """
    exchangeAppleAdsAttribution(token: String!, consent: AppleAdsConsentInput!): AppleAdsAttributionResult!
  }
`;
