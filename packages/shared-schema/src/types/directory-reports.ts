// Directory reports: report a problem with a board or a gym listing
// (docs/product/directory-reports.md). Mirrors schema/directory-reports.ts.

import type { UserBoard } from './board-entities';

export type BoardReportReason = 'wrong_setup' | 'duplicate' | 'gone' | 'wrong_place' | 'other' | 'relist_request';

export type GymReportReason = 'duplicate' | 'closed' | 'wrong_details' | 'not_a_gym' | 'other';

export type DirectoryReportReason = BoardReportReason | GymReportReason;

export type DirectoryReportTargetKind = 'board' | 'gym';

export type DirectoryReportStatus = 'open' | 'escalated' | 'fixed' | 'removed' | 'deleted' | 'kept' | 'merged';

export type DirectoryReportOutcome = 'fixed' | 'removed' | 'deleted' | 'kept' | 'merged';

export type DirectoryReportRecipient = 'creator' | 'gym_staff' | 'admin';

export type DirectoryReportResolverRole = 'creator' | 'gym_staff' | 'admin' | 'auto' | 'climber';

export type DirectoryReportSubmitStatus = 'created' | 'added' | 'already_reported';

export type DirectoryReportViewerRole = 'creator' | 'gym_staff' | 'admin';

export type DirectoryNoticeActorRole = 'gym_staff' | 'moderator';

/**
 * A board's setup within its own board type: what a "Set up wrong" report can
 * suggest (docs/product/directory-reports.md, "Suggested setup"). `setIds` is
 * comma-separated and in canonical order (`normaliseSetIds`). `angle` is set
 * only for a board that doesn't tilt; null leaves the angle alone.
 */
export type BoardSetupInput = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number | null;
};

/** A board's setup, as a suggestion or a recorded change carries it. Same fields as {@link BoardSetupInput}. */
export type BoardSetup = {
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle?: number | null;
};

/** What a suggested setup did: changed the board for everyone, or went to review. */
export type BoardSetupOutcome = 'APPLIED' | 'SENT_FOR_REVIEW';

/** Why a suggested setup went to review. The `@boardsesh/directory-moderation` reasons. */
export type BoardSetupReviewReason =
  | 'CLAIMED_GYM'
  | 'NO_GYM'
  | 'RECENT_CHANGE'
  | 'RECENTLY_UNDONE'
  | 'DAILY_LIMIT'
  | 'CLASHES';

/**
 * Where a climber's setup change stands: `LIVE` (the board still has it),
 * `UNDONE` (someone undid it), `CHANGED_SINCE` (the board changed again since,
 * so it can't be undone).
 */
export type BoardSetupChangeState = 'LIVE' | 'UNDONE' | 'CHANGED_SINCE';

export type ReportBoardInput = {
  boardUuid: string;
  reason: BoardReportReason;
  duplicateOfBoardUuid?: string | null;
  note?: string | null;
  /** `wrong_setup` on a board that isn't a spray wall only: the setup the reporter says is right. */
  suggestedSetup?: BoardSetupInput | null;
};

export type ReportGymInput = {
  gymUuid: string;
  reason: GymReportReason;
  duplicateOfGymUuid?: string | null;
  note?: string | null;
};

export type DirectoryReportSubmitResult = {
  status: DirectoryReportSubmitStatus;
  reportUuid: string;
  routedTo: DirectoryReportRecipient[];
  otherReporterCount: number;
  /** Set when the report carried a suggested setup; null otherwise. */
  setupOutcome?: BoardSetupOutcome | null;
  /** Why it went to review. Null when it applied, and while the `directory-setup-suggestions` flag is off. */
  setupReviewReason?: BoardSetupReviewReason | null;
  /** The board with its new setup, when `setupOutcome` is `APPLIED`. */
  board?: UserBoard | null;
};

export type ResolveDirectoryReportInput = {
  reportUuid: string;
  outcome: DirectoryReportOutcome;
  note?: string | null;
};

export type DirectoryReportReporter = {
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
};

export type DirectoryReportNote = {
  /** Empty when the reporter suggested a setup and wrote nothing. */
  note: string;
  createdAt: string;
  /** Global admins only; null for everyone else. */
  reporter?: DirectoryReportReporter | null;
  /** The setup this reporter suggested, if any. */
  suggestedSetup?: BoardSetup | null;
};

export type DirectoryReport = {
  uuid: string;
  targetKind: DirectoryReportTargetKind;
  reason: DirectoryReportReason;
  status: DirectoryReportStatus;
  routedTo: DirectoryReportRecipient[];
  boardUuid?: string | null;
  boardName?: string | null;
  boardType?: string | null;
  gymUuid?: string | null;
  gymName?: string | null;
  duplicateOfBoardUuid?: string | null;
  duplicateOfBoardName?: string | null;
  duplicateOfGymUuid?: string | null;
  duplicateOfGymName?: string | null;
  reporterCount: number;
  notes: DirectoryReportNote[];
  createdAt: string;
  remindedAt?: string | null;
  escalatedAt?: string | null;
  escalatesAt: string;
  resolvedAt?: string | null;
  resolvedByRole?: DirectoryReportResolverRole | null;
  resolutionNote?: string | null;
  viewerRole: DirectoryReportViewerRole;
  viewerIsReporter: boolean;
  viewerCanResolve: boolean;
};

export type DirectoryReportConnection = {
  reports: DirectoryReport[];
  nextCursor?: string | null;
};

/** What a directory notification is about. See `DirectoryNotice` in the SDL. */
export type DirectoryNotice = {
  targetKind: DirectoryReportTargetKind;
  boardUuid?: string | null;
  boardName?: string | null;
  boardType?: string | null;
  gymUuid?: string | null;
  gymName?: string | null;
  reportUuid?: string | null;
  reason?: DirectoryReportReason | null;
  outcome?: DirectoryReportOutcome | null;
  resolvedByRole?: DirectoryReportResolverRole | null;
  resolutionNote?: string | null;
  actorRole?: DirectoryNoticeActorRole | null;
  isReminder: boolean;
  recipientIsCreator: boolean;
  /** `board_setup_changed_by_climber`: the change, to pass to `undoBoardSetupChange`. */
  setupChangeEventId?: string | null;
  /** `board_setup_changed_by_climber`: the setup before the change. */
  setupBefore?: BoardSetup | null;
  /** `board_setup_changed_by_climber`: the setup the climber changed it to. */
  setupAfter?: BoardSetup | null;
  /** `board_setup_changed_by_climber`: whether the change can still be undone (`LIVE`). */
  setupChangeState?: BoardSetupChangeState | null;
};

/** The board a climber changed, in the admin list of setup changes. */
export type BoardSetupChangeBoard = {
  uuid: string;
  name: string;
  slug: string;
  boardType: string;
};

/** The gym the board was at when the climber changed it. */
export type BoardSetupChangeGym = {
  uuid: string;
  name: string;
  slug?: string | null;
};

/** One climber's setup change, for the admin list (`adminBoardSetupChanges`). */
export type BoardSetupChange = {
  eventId: string;
  board: BoardSetupChangeBoard;
  gym?: BoardSetupChangeGym | null;
  before: BoardSetup;
  after: BoardSetup;
  /** Null once the climber's account is deleted. */
  climberDisplayName?: string | null;
  createdAt: string;
  state: BoardSetupChangeState;
};

export type BoardSetupChangeConnection = {
  changes: BoardSetupChange[];
  nextCursor?: string | null;
};
