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
    none. A grant based on an older answer than the account holds is not written;
    the newer answer is returned instead. A denial is always written.
    """
    basedOnDecidedAt: String
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
  }

  extend type Mutation {
    "Record the signed-in climber's analytics consent answer and return the account's current answer."
    setAnalyticsConsent(input: SetAnalyticsConsentInput!): AnalyticsConsent!
    "HTTP cron credentials only. Counts yesterday's DAU and the trailing WAU and MAU, and sends one aggregate PostHog event."
    snapshotActiveUsers: ActiveUsersSnapshotResult!
    "HTTP cron credentials only. Deletes user_activity_days rows older than 13 months."
    purgeExpiredUserActivity: UserActivityPurgeResult!
  }
`;
