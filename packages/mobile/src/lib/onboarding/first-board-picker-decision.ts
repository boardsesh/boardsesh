// Whether the launch gate opens the board picker for a newcomer (#5654), as one
// pure function so the eligibility matrix is testable without a renderer.
//
// The gate has already ruled out everything that is about THIS launch: a bound
// board, a deep-link landing, a launch URL, the login screen. What is left here
// is about the ACCOUNT: is it new, is it known, has it already been asked twice,
// and can the picker do anything useful right now.

const MS_PER_DAY = 86_400_000;

/**
 * How old an account can be and still get the picker. Existing climbers without
 * a board never do: the gate that would have asked them sat dead from 2.2.0 to
 * #5654, and waking it for everyone would have dropped a flow on people who had
 * been using the app for months.
 */
export const NEW_ACCOUNT_MAX_AGE_MS = 7 * MS_PER_DAY;

/**
 * At most two showings per account. Closing it once is an answer for this
 * launch; closing it twice is an answer, full stop.
 */
export const FIRST_BOARD_PICKER_MAX_SHOWS = 2;

/**
 * Why the picker stayed shut for a climber with no board. The gate logs it on
 * `Onboarding Gate Evaluated` as `picker_verdict`, next to `presented`.
 */
export type FirstBoardPickerBlock =
  /** No profile id or creation time: signed out, or the profile read failed or ran out of time. */
  | 'profile_unavailable'
  /** Older than seven days. */
  | 'not_new_account'
  /** `first-board-picker-kill` is on. */
  | 'kill_switch'
  /** No usable connection: the picker's lists and the gym search all need one. */
  | 'offline'
  /** Already shown twice to this account on this device. */
  | 'shown_twice'
  /** The show counter could not be read or written, so it could not be capped. */
  | 'storage_error';

export type FirstBoardPickerVerdict = 'presented' | FirstBoardPickerBlock;

export type FirstBoardPickerInput = {
  /** The signed-in account. `undefined` until the profile has an id. */
  userId: string | undefined;
  /** The profile's ISO `createdAt`. */
  accountCreatedAt: string | null | undefined;
  nowMs: number;
  /** False when `first-board-picker-kill` is on. */
  enabled: boolean;
  offline: boolean;
  /**
   * How many times this account has already been shown the picker on this
   * device. `null` when the counter could not be read: a store that cannot be
   * read cannot cap anything either, so it reads as "do not show".
   */
  timesShown: number | null;
};

/**
 * Whether the account is at most seven days old. A creation time in the future
 * (a phone clock behind the server) is as new as an account gets.
 */
export function isNewAccount(accountCreatedAt: string | null | undefined, nowMs: number): boolean {
  if (!accountCreatedAt) return false;
  const createdMs = Date.parse(accountCreatedAt);
  if (Number.isNaN(createdMs)) return false;
  return nowMs - createdMs <= NEW_ACCOUNT_MAX_AGE_MS;
}

/**
 * Order matters. The checks that only read what the gate already holds come
 * first, so the gate can run this once with `timesShown: 0` as a preflight and
 * only read the counter for an account that could actually be shown the picker.
 * The account's own facts come before the kill switch and the connection, so a
 * killed or offline launch still says whether the account was eligible at all.
 */
export function decideFirstBoardPicker(input: FirstBoardPickerInput): FirstBoardPickerVerdict {
  if (!input.userId || !input.accountCreatedAt || Number.isNaN(Date.parse(input.accountCreatedAt))) {
    return 'profile_unavailable';
  }
  if (!isNewAccount(input.accountCreatedAt, input.nowMs)) return 'not_new_account';
  if (!input.enabled) return 'kill_switch';
  if (input.offline) return 'offline';
  if (input.timesShown === null) return 'storage_error';
  if (input.timesShown >= FIRST_BOARD_PICKER_MAX_SHOWS) return 'shown_twice';
  return 'presented';
}
