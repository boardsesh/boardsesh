// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type AppFeedbackPlatform = 'ios' | 'android' | 'web';
export type AppFeedbackSource = 'prompt' | 'drawer-feedback' | 'shake-bug' | 'drawer-bug';
/**
 * Free-form identifier of the board the user is climbing on. Capped to 100
 * chars by the backend zod validator so future board names work without a
 * server change.
 */
export type AppFeedbackBoardName = string;

/**
 * Free-form context attached to feedback for debugging. Stored as jsonb on the
 * server. Every field is optional — anonymous submissions from outside a board
 * route may have only `url` and `userAgent`.
 */
export type FeedbackContextInput = {
  climbUuid?: string | null;
  climbName?: string | null;
  difficulty?: string | null;
  sessionId?: string | null;
  sessionName?: string | null;
  url?: string | null;
  userAgent?: string | null;
};

export type SubmitAppFeedbackInput = {
  rating?: number | null;
  comment?: string | null;
  platform: AppFeedbackPlatform;
  appVersion?: string | null;
  source: AppFeedbackSource;
  /**
   * Identifier of the board the user is climbing on at submission time.
   * Captured from the queue bridge so reports can be filtered/reproduced per
   * board. Null for anonymous submissions made outside any board context.
   */
  boardName?: AppFeedbackBoardName | null;
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: number[] | null;
  angle?: number | null;
  context?: FeedbackContextInput | null;
  /**
   * Whether the reporter opted in to follow-up contact about a bug report.
   * Only set for bug-report sources; null/false means "do not contact".
   */
  contactConsent?: boolean | null;
};

// ---------------------------------------------------------------------------
// Admin feedback dashboard (adminAppFeedback query + updateAppFeedbackStatus
// mutation). Hand-written to mirror the SDL in `schema/feedback.ts` — the
// shared-schema public API re-exports these types (not the codegen output), so
// web/mobile import them from `@boardsesh/shared-schema`.
// ---------------------------------------------------------------------------

/** Admin triage state. `new` is the default; `resolved`/`wont_fix` are done. */
export type AppFeedbackStatus = 'new' | 'in_progress' | 'resolved' | 'wont_fix';

/** Type filter for the admin list. */
export type AppFeedbackTypeFilter = 'bugs' | 'ratings' | 'all';

/** The reporter, resolved from `user_id`. All null for anonymous rows. */
export type AppFeedbackReporter = {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
};

/** Debug context (jsonb) as returned to the admin dashboard. */
export type AppFeedbackContext = {
  climbUuid?: string | null;
  climbName?: string | null;
  difficulty?: string | null;
  sessionId?: string | null;
  sessionName?: string | null;
  url?: string | null;
  userAgent?: string | null;
};

/** A feedback row enriched for the admin dashboard. */
export type AppFeedbackReport = {
  id: string;
  source: AppFeedbackSource;
  rating?: number | null;
  comment?: string | null;
  platform: AppFeedbackPlatform;
  appVersion?: string | null;
  boardName?: AppFeedbackBoardName | null;
  angle?: number | null;
  contactConsent?: boolean | null;
  createdAt: string;
  status: AppFeedbackStatus;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  githubIssueNumber?: number | null;
  githubIssueUrl?: string | null;
  reporter?: AppFeedbackReporter | null;
  context?: AppFeedbackContext | null;
};

export type AdminAppFeedbackInput = {
  type?: AppFeedbackTypeFilter | null;
  status?: AppFeedbackStatus | null;
  platform?: string | null;
  search?: string | null;
  limit?: number | null;
  offset?: number | null;
};

export type AppFeedbackStatusCounts = {
  new: number;
  inProgress: number;
  resolved: number;
  wontFix: number;
};

export type AdminAppFeedbackResult = {
  reports: AppFeedbackReport[];
  totalCount: number;
  hasMore: boolean;
  statusCounts: AppFeedbackStatusCounts;
};

export type UpdateAppFeedbackStatusInput = {
  id: string;
  status: AppFeedbackStatus;
};
