import type { GymListingState } from './reasons';

/**
 * A climber's suggested setup on a "Set up wrong" report, and whether it
 * changes the board for everyone straight away or waits for someone to review
 * it (docs/product/directory-reports.md, "Suggested setup"; the founder's
 * decisions of 2026-11-23 in docs/product/gym-board-governance.md).
 *
 * | Board is at…                        | Limits not hit | Any limit hit |
 * |-------------------------------------|----------------|---------------|
 * | an unclaimed or climber-listed gym  | apply          | review        |
 * | a gym run by the gym (RUN_BY_GYM)   | review         | review        |
 * | no gym                              | review         | review        |
 *
 * The limits, checked in this order after the gym:
 * - an undo on this board in the last {@link SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO} days,
 *   or a climber change from that long ago that the board no longer has
 *   (someone put it back by hand, which counts as an undo),
 * - a climber change on this board in the last {@link SETUP_CHANGE_BOARD_COOLDOWN_HOURS} hours,
 * - {@link SETUP_CHANGES_PER_CLIMBER_PER_DAY} changes by this climber, on any
 *   board, in the last {@link SETUP_CHANGE_CLIMBER_WINDOW_HOURS} hours.
 *
 * The backend decides with {@link setupSuggestionDecision}, then may still send
 * an `apply` to review as `CLASHES` (the change would duplicate another board
 * of the same owner, or clash with a serial). The clients word the line above
 * Send with {@link setupSuggestionPreview}, the gym half of the same rule: the
 * limits depend on history a client can't see.
 */

/** Hours after a climber change to a board during which the next climber change to it goes to review. */
export const SETUP_CHANGE_BOARD_COOLDOWN_HOURS = 24;

/** Days after a climber change to a board is undone during which that board's suggestions go to review. */
export const SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO = 90;

/** Climber changes one climber can apply across all boards in {@link SETUP_CHANGE_CLIMBER_WINDOW_HOURS} hours. */
export const SETUP_CHANGES_PER_CLIMBER_PER_DAY = 3;

/** The rolling window the per-climber limit counts over. */
export const SETUP_CHANGE_CLIMBER_WINDOW_HOURS = 24;

/** The report reason a suggested setup rides on. */
export const SETUP_SUGGESTION_REPORT_REASON = 'wrong_setup';

/**
 * Why a suggestion went to review. The values are the GraphQL
 * `BoardSetupReviewReason` values, so a client passes them straight through.
 *
 * - `CLAIMED_GYM`: the gym is run by the gym; its staff review it.
 * - `NO_GYM`: the board has no gym (a home wall); its creator reviews it.
 * - `RECENT_CHANGE`: a climber changed this board in the last 24 hours.
 * - `RECENTLY_UNDONE`: a climber change to this board was undone in the last 90
 *   days, or a climber change from the last 90 days was overridden since (the
 *   board no longer has it).
 * - `DAILY_LIMIT`: this climber applied 3 changes in the last 24 hours.
 * - `CLASHES`: the change would duplicate another board of the same owner, or
 *   clash with a serial number. Only the backend can see this one.
 */
export const SETUP_SUGGESTION_REVIEW_REASONS = [
  'CLAIMED_GYM',
  'NO_GYM',
  'RECENT_CHANGE',
  'RECENTLY_UNDONE',
  'DAILY_LIMIT',
  'CLASHES',
] as const;
export type SetupSuggestionReviewReason = (typeof SETUP_SUGGESTION_REVIEW_REASONS)[number];

export type SetupSuggestionDecision =
  | { outcome: 'apply'; reason: null }
  | { outcome: 'review'; reason: SetupSuggestionReviewReason };

export type SetupSuggestionDecisionInput = {
  /** The board is linked to a live gym. */
  hasGym: boolean;
  /** That gym's listing state; ignored without a gym. A gym with no known state is treated as no gym. */
  gymListingState: GymListingState | null;
  /** When the latest climber change (`setup_changed_by_climber`) to this board was made, or null. */
  lastClimberChangeAt: Date | null;
  /** When a climber change to this board was last undone (`setup_change_undone`), or null. */
  lastUndoAt: Date | null;
  /**
   * When the board's latest climber change was made, if the board no longer
   * has that change's setup (someone edited it back by hand, or undid it);
   * null when the board still has it, or has no climber change. A change
   * overridden by hand counts as an undo, from the time the change was made.
   */
  lastClimberChangeOverriddenAt: Date | null;
  /** Climber changes this climber made on any board in the last {@link SETUP_CHANGE_CLIMBER_WINDOW_HOURS} hours. */
  climberChangesInWindow: number;
  now: Date;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The start of each limit's window at `now`. The backend reads events newer
 * than these, so its queries and this rule agree on the cut-off.
 */
export function setupSuggestionWindowStarts(now: Date): {
  boardChangeSince: Date;
  undoSince: Date;
  climberChangesSince: Date;
} {
  return {
    boardChangeSince: new Date(now.getTime() - SETUP_CHANGE_BOARD_COOLDOWN_HOURS * HOUR_MS),
    undoSince: new Date(now.getTime() - SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO * DAY_MS),
    climberChangesSince: new Date(now.getTime() - SETUP_CHANGE_CLIMBER_WINDOW_HOURS * HOUR_MS),
  };
}

/** The gym half of the rule: null when the gym lets a suggestion apply straight away. */
function gymReviewReason(input: {
  hasGym: boolean;
  gymListingState: GymListingState | null;
}): 'NO_GYM' | 'CLAIMED_GYM' | null {
  if (!input.hasGym || input.gymListingState === null) return 'NO_GYM';
  if (input.gymListingState === 'RUN_BY_GYM') return 'CLAIMED_GYM';
  return null;
}

/** Whether `at` falls inside the window that starts at `since`. */
function isSince(at: Date | null, since: Date): boolean {
  return at !== null && at.getTime() > since.getTime();
}

/**
 * Whether a valid suggestion changes the board now (`apply`) or waits for
 * review, and why. "Valid" is the caller's job: the suggestion passed the
 * catalogue and angle checks and differs from the current setup. An invalid
 * one is refused and never reaches here.
 */
export function setupSuggestionDecision(input: SetupSuggestionDecisionInput): SetupSuggestionDecision {
  const gymReason = gymReviewReason(input);
  if (gymReason) return { outcome: 'review', reason: gymReason };

  const windows = setupSuggestionWindowStarts(input.now);
  if (isSince(input.lastUndoAt, windows.undoSince) || isSince(input.lastClimberChangeOverriddenAt, windows.undoSince)) {
    return { outcome: 'review', reason: 'RECENTLY_UNDONE' };
  }
  if (isSince(input.lastClimberChangeAt, windows.boardChangeSince)) {
    return { outcome: 'review', reason: 'RECENT_CHANGE' };
  }
  if (input.climberChangesInWindow >= SETUP_CHANGES_PER_CLIMBER_PER_DAY) {
    return { outcome: 'review', reason: 'DAILY_LIMIT' };
  }
  return { outcome: 'apply', reason: null };
}

/**
 * The line above Send, before the climber sends:
 * - `applies_for_everyone`: "This changes it for everyone at {gym}".
 * - `staff_review`: "{gym}'s staff check it first".
 * - `creator_review`: the board has no gym, so whoever added it checks it first.
 *
 * Returns an id, not a translation key: each client switches over it and calls
 * `t()` with a literal. A limit can still send an `applies_for_everyone`
 * suggestion to review; the result's `setupOutcome` says what happened.
 */
export type SetupSuggestionPreview = 'applies_for_everyone' | 'staff_review' | 'creator_review';

export function setupSuggestionPreview(input: {
  hasGym: boolean;
  gymListingState: GymListingState | null;
}): SetupSuggestionPreview {
  const gymReason = gymReviewReason(input);
  if (gymReason === 'NO_GYM') return 'creator_review';
  if (gymReason === 'CLAIMED_GYM') return 'staff_review';
  return 'applies_for_everyone';
}

/**
 * Whether a report may carry a suggested setup: only "Set up wrong", and never
 * on a spray wall, which has no layout, size or hold sets to pick. The report
 * sheet shows the setup fields only when this is true, and the server refuses
 * a suggestion when it is false.
 */
export function isSetupSuggestionAllowed(reason: string, boardType: string): boolean {
  return reason === SETUP_SUGGESTION_REPORT_REASON && boardType !== 'spray';
}
