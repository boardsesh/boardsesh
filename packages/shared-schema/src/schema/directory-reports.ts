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

  """
  Who closed a report. auto is the system (the merge tool, or a sweep that found
  the board or gym gone). climber is a climber whose suggested setup changed the
  board at a gym nobody runs.
  """
  enum DirectoryReportResolverRole {
    creator
    gym_staff
    admin
    auto
    climber
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

  """
  A board's setup within its own board type: what a "Set up wrong" report can
  suggest. There is no board type: it is always the board's own.
  """
  input BoardSetupInput {
    "A layout of the board's type."
    layoutId: Int!
    "A size of that layout."
    sizeId: Int!
    "Hold set ids of that layout and size, comma-separated. At least one."
    setIds: String!
    """
    Only for a board that doesn't tilt (isAngleAdjustable false). Leave it out to
    keep the angle. An angle other than the board's own must be one the board
    type's Angle row offers (the MoonBoard wide range included).
    """
    angle: Int
  }

  "A board's setup, as a suggestion or a recorded change carries it."
  type BoardSetup {
    layoutId: Int!
    sizeId: Int!
    "Hold set ids, comma-separated, in ascending order."
    setIds: String!
    "Set only when the angle is part of the setup (a board that doesn't tilt)."
    angle: Int
  }

  "What a suggested setup did."
  enum BoardSetupOutcome {
    "The board changed for everyone straight away."
    APPLIED
    "The suggestion waits on the report for someone who can change the board."
    SENT_FOR_REVIEW
  }

  "Why a suggested setup went to review instead of changing the board."
  enum BoardSetupReviewReason {
    "The gym is run by the gym. Its staff check suggestions first."
    CLAIMED_GYM
    "The board has no gym. Whoever added it checks suggestions first."
    NO_GYM
    "A climber changed this board's setup in the last 24 hours."
    RECENT_CHANGE
    "A climber's change to this board was undone, or put back by hand, in the last 90 days."
    RECENTLY_UNDONE
    "The reporter already changed 3 boards in the last 24 hours."
    DAILY_LIMIT
    "The change would make this board a copy of another board with the same owner, or clash with a serial number."
    CLASHES
  }

  """
  Where a climber's setup change stands. LIVE: the board still has it.
  UNDONE: someone put the old setup back. CHANGED_SINCE: the board changed
  again since, so it can't be undone.
  """
  enum BoardSetupChangeState {
    LIVE
    UNDONE
    CHANGED_SINCE
  }

  input ReportBoardInput {
    boardUuid: ID!
    reason: BoardReportReason!
    "For duplicate: the other board at the same gym that is the same wall."
    duplicateOfBoardUuid: ID
    "Optional, trimmed, at most 500 characters. Required (10 or more characters) for other."
    note: String
    """
    The setup the reporter says is right. Only with wrong_setup, and never on a
    spray wall. It must be a real setup of the board's type (a known layout,
    size and sets, and an angle the board type offers) and differ from the
    board's setup now; otherwise the report is refused with BAD_USER_INPUT and
    nothing is filed. The setup the board has now is refused with
    extensions.reason SETUP_UNCHANGED (isBoardSetupUnchangedError): the board
    may have been fixed since the client read it, so read it again. At a gym
    nobody runs (not RUN_BY_GYM) it changes the board for everyone straight away
    unless a limit sends it to review; see setupOutcome on the result.
    """
    suggestedSetup: BoardSetupInput
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
    "What the suggested setup did. Null when the report carried none (and always for reportGym)."
    setupOutcome: BoardSetupOutcome
    """
    Why the suggested setup went to review. Null when it applied, and when no
    suggestion can apply right now (the directory-setup-suggestions flag is off).
    """
    setupReviewReason: BoardSetupReviewReason
    """
    The board with its new setup, for 'Climb it now'. Set only when setupOutcome
    is APPLIED, and even then it can be null: the change has committed but the
    board could not be read back. Then refetch the board by its uuid; the
    change still applied.
    """
    board: UserBoard
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
    "What the reporter wrote. Empty when they suggested a setup and wrote nothing."
    note: String!
    createdAt: String!
    reporter: DirectoryReportReporter
    "The setup this reporter suggested on a wrong_setup report, if any."
    suggestedSetup: BoardSetup
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
    "What reporters said, oldest first. Reporters with neither a note nor a suggested setup are counted but not listed."
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
  gym_report_*, board_removed_from_gym, board_deleted_by_staff,
  board_edited_by_staff and board_setup_changed_by_climber types.
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
    "board_setup_changed_by_climber: the change, to pass to undoBoardSetupChange."
    setupChangeEventId: ID
    "board_setup_changed_by_climber: the setup before the change."
    setupBefore: BoardSetup
    "board_setup_changed_by_climber: the setup the climber changed it to."
    setupAfter: BoardSetup
    "board_setup_changed_by_climber: where the change stands now. Offer Undo only while it is LIVE."
    setupChangeState: BoardSetupChangeState
  }

  "The board a climber changed, in the admin list of setup changes."
  type BoardSetupChangeBoard {
    uuid: ID!
    name: String!
    slug: String!
    boardType: String!
  }

  "The gym a board was at when a climber changed it."
  type BoardSetupChangeGym {
    uuid: ID!
    name: String!
    slug: String
  }

  "One climber's change to a board's setup, made by a suggestion on a report."
  type BoardSetupChange {
    "Pass to undoBoardSetupChange."
    eventId: ID!
    board: BoardSetupChangeBoard!
    "Null when the gym has been deleted since."
    gym: BoardSetupChangeGym
    before: BoardSetup!
    after: BoardSetup!
    "The climber who suggested it. Null once their account is deleted."
    climberDisplayName: String
    "When the change was made."
    createdAt: String!
    state: BoardSetupChangeState!
  }

  type BoardSetupChangeConnection {
    "Newest first."
    changes: [BoardSetupChange!]!
    "Pass as after for the next page; null on the last page."
    nextCursor: String
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
    """
    Every change a climber's suggested setup made to a board, newest first, with
    where each one stands. Global admins only. first defaults to 50 (at most 100).
    """
    adminBoardSetupChanges(first: Int, after: String): BoardSetupChangeConnection!
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
    """
    Put back the setup a climber's change replaced. For global admins, the
    board's creator (not for a synced board) and the owner and admins of the
    board's gym. Only while the board still has the climber's setup: a change
    someone undid first is refused with BOARD_SETUP_ALREADY_UNDONE
    (isBoardSetupAlreadyUndoneError; the old setup is back already), and one the
    board changed again since with BOARD_SETUP_CHANGED_SINCE
    (isBoardSetupChangedSinceError). Returns the board with its old setup back,
    and the sync freeze the change replaced while nobody edited the board since.
    The report the change closed stays closed, and for 90 days the board's
    suggestions go to review.
    """
    undoBoardSetupChange(eventId: ID!): UserBoard!
  }
`;
