export const feedbackTypeDefs = /* GraphQL */ `
  """
  Free-form debug context attached to a feedback submission. Stored as jsonb.
  Every field is optional — anonymous submissions made outside a board route
  may carry only \`url\` / \`userAgent\`.
  """
  input FeedbackContextInput {
    climbUuid: String
    climbName: String
    difficulty: String
    sessionId: String
    sessionName: String
    url: String
    userAgent: String
  }

  """
  Input for submitAppFeedback mutation.
  """
  input SubmitAppFeedbackInput {
    """
    1–5 star rating. Null for bug reports.
    """
    rating: Int

    """
    Optional free-text comment. Required for bug-report sources; typically
    present for rating sources when rating is below 3.
    """
    comment: String

    """
    'ios' | 'android' | 'web'.
    """
    platform: String!

    """
    App build version (native) or deployed web version. Optional.
    """
    appVersion: String

    """
    Where the feedback originated: 'prompt' | 'drawer-feedback' (rating flows)
    or 'shake-bug' | 'drawer-bug' (bug reports).
    """
    source: String!

    """
    Identifier of the board the user is climbing on. Free-form, capped at
    100 characters by the backend so future board names work without a
    schema change. Null when submission happens outside a board context.
    """
    boardName: String
    layoutId: Int
    sizeId: Int
    setIds: [Int!]
    angle: Int

    """
    Optional debug context (current climb, party session, URL, user agent).
    """
    context: FeedbackContextInput

    """
    Whether the reporter opted in to follow-up contact about a bug report.
    When true and the reporter is signed in, the backend emails them the
    GitHub issue link. Only meaningful for bug-report sources.
    """
    contactConsent: Boolean

    """
    Object keys returned by \`POST /api/feedback-screenshots\`, at most
    FEEDBACK_SCREENSHOT_MAX_COUNT of them. Bug reports only — they become
    \`<img>\` tags in the GitHub issue, so a key that isn't one we minted is
    dropped rather than rendered.
    """
    screenshotKeys: [String!]
  }

  """
  Admin triage state of a feedback row. \`new\` is the untouched default;
  \`resolved\` and \`wont_fix\` are the terminal ("done") states.
  """
  enum AppFeedbackStatus {
    new
    in_progress
    resolved
    wont_fix
  }

  """
  Type filter for the admin feedback list. \`bugs\` = shake-bug/drawer-bug
  sources, \`ratings\` = prompt/drawer-feedback sources, \`all\` = everything.
  """
  enum AppFeedbackTypeFilter {
    bugs
    ratings
    all
  }

  """
  The person who submitted a feedback row, resolved from \`user_id\`. All fields
  are null for anonymous submissions (no signed-in user at submit time).
  """
  type AppFeedbackReporter {
    userId: ID
    email: String
    name: String
  }

  """
  Debug context captured with a feedback row (the jsonb \`context\` column).
  """
  type AppFeedbackContext {
    climbUuid: String
    climbName: String
    difficulty: String
    sessionId: String
    sessionName: String
    url: String
    userAgent: String
  }

  """
  A single feedback row as seen by the admin dashboard, enriched with the
  reporter's identity and triage state.
  """
  type AppFeedbackReport {
    id: ID!
    source: String!
    rating: Int
    comment: String
    platform: String!
    appVersion: String
    boardName: String
    angle: Int
    contactConsent: Boolean
    createdAt: String!
    status: AppFeedbackStatus!
    resolvedAt: String
    resolvedBy: String
    githubIssueNumber: Int
    githubIssueUrl: String
    reporter: AppFeedbackReporter
    context: AppFeedbackContext
    """
    Public URLs of the screenshots the reporter attached, in the order they
    attached them. Empty when none were attached, and also when the media
    bucket has no public base URL configured (the keys are still on the row).
    """
    screenshotUrls: [String!]!
  }

  """
  Filters for the admin feedback list. All fields optional; omitted filters
  match everything. \`limit\`/\`offset\` drive offset pagination.
  """
  input AdminAppFeedbackInput {
    type: AppFeedbackTypeFilter
    status: AppFeedbackStatus
    platform: String
    search: String
    limit: Int
    offset: Int
  }

  """
  Per-status row counts for the current type filter, so the dashboard can show
  totals on the status tabs independent of the active status filter.
  """
  type AppFeedbackStatusCounts {
    new: Int!
    inProgress: Int!
    resolved: Int!
    wontFix: Int!
  }

  """
  A page of admin feedback rows plus counts for the dashboard.
  """
  type AdminAppFeedbackResult {
    reports: [AppFeedbackReport!]!
    totalCount: Int!
    hasMore: Boolean!
    statusCounts: AppFeedbackStatusCounts!
  }

  """
  Input for updateAppFeedbackStatus. Moving to \`resolved\`/\`wont_fix\` stamps
  the resolver + timestamp; moving back to \`new\`/\`in_progress\` clears them.
  """
  input UpdateAppFeedbackStatusInput {
    id: ID!
    status: AppFeedbackStatus!
  }
`;
