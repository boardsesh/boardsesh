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
  /**
   * Opt-in Bluetooth diagnostics for bug reports: a compact text dump of boards
   * found and recent connection issues this session. Present only when the
   * reporter ticks the toggle.
   */
  bleDiagnostics?: string | null;
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
};
