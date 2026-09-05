export const gymActivityStatsTypeDefs = /* GraphQL */ `
  "The result of a completed, cron-authenticated gym activity refresh."
  type GymActivityStatsRefreshResult {
    gymCount: Int!
    previousGymCount: Int!
    forced: Boolean!
    "Time spent counting gyms after acquiring the refresh lock."
    scanDurationMs: Float!
    "Time spent rebuilding the cache, excluding transaction commit."
    writeDurationMs: Float!
    "Total operation time, including lock acquisition and transaction commit."
    durationMs: Float!
    timestamp: String!
  }

  extend type Mutation {
    "HTTP cron credentials only. Refused refreshes report HTTP 409 and a CONFLICT error."
    refreshGymActivityStats(force: Boolean = false): GymActivityStatsRefreshResult!
  }
`;
