/**
 * Report a problem with a board or a gym listing, and what happens next
 * (docs/product/directory-reports.md). Enum values are the database values and
 * the `@boardsesh/directory-moderation` ids, so clients pass them straight
 * through.
 */
export const directoryReportsTypeDefs = /* GraphQL */ `
  "Why a climber reported a board. relist_request is filed only by the board's creator, after gym staff removed it."
  enum BoardReportReason {
    wrong_setup
    duplicate
    gone
    wrong_place
    other
    relist_request
  }

  "Why a climber reported a gym listing."
  enum GymReportReason {
    duplicate
    closed
    wrong_details
    not_a_gym
    other
  }

  "Every board and gym report reason."
  enum DirectoryReportReason {
    wrong_setup
    duplicate
    gone
    wrong_place
    other
    relist_request
    closed
    wrong_details
    not_a_gym
  }

  enum DirectoryReportTargetKind {
    board
    gym
  }

  """
  Where a report stands. open and escalated are still waiting (escalated: in the
  Boardsesh admin queue); the rest are outcomes and never change.
  """
  enum DirectoryReportStatus {
    open
    escalated
    fixed
    removed
    deleted
    kept
    merged
  }

  "How a report was closed."
  enum DirectoryReportOutcome {
    fixed
    removed
    deleted
    kept
    merged
  }

  "Who a report goes to. gym_staff is the gym's owner and admins."
  enum DirectoryReportRecipient {
    creator
    gym_staff
    admin
  }

  "Who closed a report. auto is the system (the merge tool, or a sweep that found the board or gym gone)."
  enum DirectoryReportResolverRole {
    creator
    gym_staff
    admin
    auto
  }

  """
  What a report call did: opened a new report, added the reporter to the open
  report on the same target and reason, or found they had already reported it.
  """
  enum DirectoryReportSubmitStatus {
    created
    added
    already_reported
  }

  "Why the viewer can read a report."
  enum DirectoryReportViewerRole {
    creator
    gym_staff
    admin
  }

  input ReportBoardInput {
    boardUuid: ID!
    reason: BoardReportReason!
    "For duplicate: the other board at the same gym that is the same wall."
    duplicateOfBoardUuid: ID
    "Optional, trimmed, at most 500 characters. Required (10 or more characters) for other."
    note: String
  }

  input ReportGymInput {
    gymUuid: ID!
    reason: GymReportReason!
    "For duplicate: the other listing that is the same gym."
    duplicateOfGymUuid: ID
    "Optional, trimmed, at most 500 characters. Required (10 or more characters) for other."
    note: String
  }

  type DirectoryReportSubmitResult {
    status: DirectoryReportSubmitStatus!
    reportUuid: ID!
    "Who the report goes to, as the report sheet's routing line said."
    routedTo: [DirectoryReportRecipient!]!
    "How many other climbers are on the same report, for 'N other climbers flagged this too'."
    otherReporterCount: Int!
  }

  input ResolveDirectoryReportInput {
    reportUuid: ID!
    """
    kept: the creator or gym staff (owner, admins) looked and it is right as it
    is. Global admins may also close a report as fixed, removed, deleted or
    merged once they have taken that action with the existing mutations;
    removed and deleted are checked against the board or gym.
    """
    outcome: DirectoryReportOutcome!
    "Passed on to the reporters. Optional, trimmed, at most 500 characters."
    note: String
  }

  "A reporter, shown to global admins only."
  type DirectoryReportReporter {
    userId: ID!
    displayName: String
    avatarUrl: String
  }

  "One reporter's note. reporter is null for everyone but global admins: reporters stay anonymous."
  type DirectoryReportNote {
    note: String!
    createdAt: String!
    reporter: DirectoryReportReporter
  }

  type DirectoryReport {
    uuid: ID!
    targetKind: DirectoryReportTargetKind!
    reason: DirectoryReportReason!
    status: DirectoryReportStatus!
    routedTo: [DirectoryReportRecipient!]!
    "Board reports: the board."
    boardUuid: ID
    boardName: String
    boardType: String
    "Board reports: the gym the board was at when reported (for relist_request, the gym that removed it). Gym reports: the gym."
    gymUuid: ID
    gymName: String
    "Listed twice: the other board, when the viewer can read it."
    duplicateOfBoardUuid: ID
    duplicateOfBoardName: String
    "Listed twice: the other gym listing."
    duplicateOfGymUuid: ID
    duplicateOfGymName: String
    "How many climbers are on the report."
    reporterCount: Int!
    "What reporters said, oldest first. Reporters without a note are counted but not listed."
    notes: [DirectoryReportNote!]!
    createdAt: String!
    remindedAt: String
    escalatedAt: String
    "When a waiting report goes to the admin queue (14 days after it opened)."
    escalatesAt: String!
    resolvedAt: String
    resolvedByRole: DirectoryReportResolverRole
    resolutionNote: String
    "Why the viewer can read this report."
    viewerRole: DirectoryReportViewerRole!
    "The viewer is one of the reporters."
    viewerIsReporter: Boolean!
    "The viewer may close it as kept (and, as a global admin, with the other outcomes)."
    viewerCanResolve: Boolean!
  }

  type DirectoryReportConnection {
    reports: [DirectoryReport!]!
    "Pass as after for the next page; null on the last page."
    nextCursor: String
  }

  "Who acted on a board in a staff action notice: the gym's staff, or a Boardsesh moderator (a community leader or admin)."
  enum DirectoryNoticeActorRole {
    gym_staff
    moderator
  }

  """
  What a directory notification is about. Set on the board_report_*,
  gym_report_*, board_removed_from_gym, board_deleted_by_staff and
  board_edited_by_staff types.
  """
  type DirectoryNotice {
    targetKind: DirectoryReportTargetKind!
    boardUuid: ID
    boardName: String
    "Spray walls are worded apart from boards."
    boardType: String
    "The gym concerned: the board's gym at report time, or the gym staff removed it from."
    gymUuid: ID
    gymName: String
    reportUuid: ID
    reason: DirectoryReportReason
    "Resolved notices: how the report was closed."
    outcome: DirectoryReportOutcome
    resolvedByRole: DirectoryReportResolverRole
    "Resolved as kept: what the person who closed it said."
    resolutionNote: String
    "board_removed_from_gym / board_deleted_by_staff / board_edited_by_staff: who did it."
    actorRole: DirectoryNoticeActorRole
    "board_report_opened / gym_report_opened: the seven-day reminder rather than the first notice."
    isReminder: Boolean!
    "The recipient created the board (wording: 'your board' rather than '{{board}} at {{gym}}')."
    recipientIsCreator: Boolean!
  }

  extend type Notification {
    directoryNotice: DirectoryNotice
  }

  extend type GroupedNotification {
    directoryNotice: DirectoryNotice
  }

  extend type UserBoard {
    """
    Waiting reports the viewer can act on: all of them for the board's creator
    (but their own relist requests) and global admins, the ones routed to gym
    staff for the gym's owner, admins and editors. Null for anyone else.
    """
    openReportCount: Int
    "The viewer is a reporter on a waiting report about this board. Null when signed out."
    viewerHasOpenReport: Boolean
  }

  extend type Query {
    """
    Reports about one board, waiting and closed in the last 30 days, newest
    first. For its creator, the staff of the gym a report went to, and global
    admins; an empty list for anyone else.
    """
    boardReports(boardUuid: ID!): [DirectoryReport!]!
    """
    Reports the viewer can act on: about boards they created, and routed to the
    staff of gyms they own, administer or edit. Waiting reports first (oldest
    first), then those closed in the last 30 days when includeResolved is true.
    """
    myDirectoryReportsToReview(includeResolved: Boolean, first: Int): [DirectoryReport!]!
    "The admin queue. Global admins only. status defaults to escalated."
    adminDirectoryReports(
      status: DirectoryReportStatus
      targetKind: DirectoryReportTargetKind
      first: Int
      after: String
    ): DirectoryReportConnection!
  }

  extend type Mutation {
    """
    Report a problem with a board. Signed in, 5 per minute, and the board must be
    readable by the reporter. Joins the waiting report on the same board and
    reason when there is one. Refused while the directory-reports flag is off.
    """
    reportBoard(input: ReportBoardInput!): DirectoryReportSubmitResult!
    "Report a problem with a gym listing. Same rules as reportBoard."
    reportGym(input: ReportGymInput!): DirectoryReportSubmitResult!
    "Close a report. See ResolveDirectoryReportInput.outcome for who may close it how."
    resolveDirectoryReport(input: ResolveDirectoryReportInput!): DirectoryReport!
  }
`;
