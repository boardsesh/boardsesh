export const setterSitemapTypeDefs = /* GraphQL */ `
  "The persisted setters sitemap summary, or the previous summary when skipped."
  type SetterSitemapSummaryRefreshResult {
    refreshed: Boolean!
    itemCount: Int
    lastModified: String
    computedAt: String
    "fresh or locked; null when the summary was refreshed."
    skipped: String
  }

  extend type Mutation {
    "HTTP cron credentials only. Force bypasses freshness, never validation or locking."
    refreshSetterSitemapSummary(force: Boolean = false): SetterSitemapSummaryRefreshResult!
  }
`;
