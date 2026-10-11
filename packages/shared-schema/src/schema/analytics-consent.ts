export const analyticsConsentTypeDefs = /* GraphQL */ `
  "The signed-in climber's analytics consent answer, as the account stores it. See docs/analytics-consent.md."
  type AnalyticsConsent {
    "granted or denied."
    analytics: String!
    "The CONSENT_VERSION the answer was given under."
    version: Int!
    "web, ios or android: where the answer was given."
    source: String!
    "ISO 8601, stamped by the server's clock."
    decidedAt: String!
  }

  input SetAnalyticsConsentInput {
    "granted or denied."
    analytics: String!
    "The CONSENT_VERSION the client asked under. A positive integer."
    version: Int!
    "web, ios or android."
    source: String!
    """
    The decidedAt of the account answer this client last saw, or null when it saw
    none. A grant must echo the exact current server stamp; a different stamp
    returns the current answer without writing. With null, an existing grant
    may be recorded again but an existing denial wins. A denial is always written
    unless conditional is true.
    """
    basedOnDecidedAt: String
    """
    True for a write the client recovered rather than one the climber just made:
    it is written, grant or denial, only while the account still holds exactly
    basedOnDecidedAt (no answer when null); otherwise the current answer comes
    back and nothing is written. Omitted or false keeps a denial unconditional.
    """
    conditional: Boolean
  }

  """
  Whether this visitor is asked before analytics runs, from the Cloudflare
  country of the request. See docs/analytics-consent.md.
  """
  type ConsentRegion {
    "The ISO 3166-1 country the edge reported, or null when it is unknown or untrusted."
    countryCode: String
    "True in the EU, EEA, UK, Switzerland and the other prompt regions, and whenever the country is unknown."
    promptRequired: Boolean!
    "True when the request carried Sec-GPC: 1 (Global Privacy Control). The website treats it as a no outside the prompt regions."
    globalPrivacyControl: Boolean!
  }

  "Daily first-party active-user counts for one platform."
  type ActiveUsersPlatformCount {
    "web, ios, android or unknown."
    platform: String!
    dailyActiveUsers: Int!
    weeklyActiveUsers: Int!
    monthlyActiveUsers: Int!
  }

  "What one cron-authenticated active-users snapshot counted and sent."
  type ActiveUsersSnapshotResult {
    "The UTC day the daily count covers (YYYY-MM-DD): the day before the run."
    day: String!
    dailyActiveUsers: Int!
    weeklyActiveUsers: Int!
    monthlyActiveUsers: Int!
    platforms: [ActiveUsersPlatformCount!]!
    "False when PostHog is not configured for this runtime, so nothing was sent."
    captured: Boolean!
    durationMs: Int!
  }

  "What one cron-authenticated user-activity retention run deleted."
  type UserActivityPurgeResult {
    rowsDeleted: Int!
    "Rows dated before this UTC day (YYYY-MM-DD) were deleted."
    cutoffDay: String!
    durationMs: Int!
  }

  extend type Query {
    "The signed-in climber's current analytics consent, or null when they have never answered."
    myAnalyticsConsent: AnalyticsConsent
    "Whether this request comes from a region where the analytics prompt is shown. No sign-in needed."
    consentRegion: ConsentRegion!
  }

  extend type Mutation {
    "Record the signed-in climber's analytics consent answer and return the account's current answer."
    setAnalyticsConsent(input: SetAnalyticsConsentInput!): AnalyticsConsent!
    """
    HTTP cron credentials only. Counts one UTC day's DAU and the trailing WAU and MAU, and sends one aggregate PostHog event.
    day (YYYY-MM-DD) re-runs a missed day, from yesterday back to 30 days ago; without it, yesterday.
    """
    snapshotActiveUsers(day: String): ActiveUsersSnapshotResult!
    "HTTP cron credentials only. Deletes user_activity_days rows older than 60 days."
    purgeExpiredUserActivity: UserActivityPurgeResult!
  }
`;
