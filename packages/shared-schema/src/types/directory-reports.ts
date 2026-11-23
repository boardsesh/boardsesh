// Directory reports: report a problem with a board or a gym listing
// (docs/product/directory-reports.md). Mirrors schema/directory-reports.ts.

export type BoardReportReason = 'wrong_setup' | 'duplicate' | 'gone' | 'wrong_place' | 'other' | 'relist_request';

export type GymReportReason = 'duplicate' | 'closed' | 'wrong_details' | 'not_a_gym' | 'other';

export type DirectoryReportReason = BoardReportReason | GymReportReason;

export type DirectoryReportTargetKind = 'board' | 'gym';

export type DirectoryReportStatus = 'open' | 'escalated' | 'fixed' | 'removed' | 'deleted' | 'kept' | 'merged';

export type DirectoryReportOutcome = 'fixed' | 'removed' | 'deleted' | 'kept' | 'merged';

export type DirectoryReportRecipient = 'creator' | 'gym_staff' | 'admin';

export type DirectoryReportResolverRole = 'creator' | 'gym_staff' | 'admin' | 'auto';

export type DirectoryReportSubmitStatus = 'created' | 'added' | 'already_reported';

export type DirectoryReportViewerRole = 'creator' | 'gym_staff' | 'admin';

export type DirectoryNoticeActorRole = 'gym_staff' | 'moderator';

export type ReportBoardInput = {
  boardUuid: string;
  reason: BoardReportReason;
  duplicateOfBoardUuid?: string | null;
  note?: string | null;
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
  note: string;
  createdAt: string;
  /** Global admins only; null for everyone else. */
  reporter?: DirectoryReportReporter | null;
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
};
