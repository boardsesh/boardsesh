/**
 * Stop driving after (2.7, preview-first lighting): how long a drive that Put
 * on board started keeps lighting. Settings › Board holds one choice for every
 * board, MoonBoards included, plus whether it applies in a crew session.
 * The setting key keeps its first name (`putOnBoardKeepsLighting`) so stored
 * choices carry over.
 *
 * - `off` — Right away: the press lights that one climb and starts no drive.
 *   The next pick is a preview.
 * - `30` / `45` / `60` / `120` / `300` — a timed drive: every pick lights for
 *   that many seconds, and each climb that lights restarts the clock.
 * - `until_stopped` — Until I stop: an open-ended drive. Every pick lights
 *   until the climber taps the button or the link drops.
 *
 * Only Put on board's drive is timed: a swipe or Light every climb always
 * starts an open-ended one. With Always drive the wall on (`alwaysDrive`), none
 * of these apply: this phone drives with no end whenever it holds the board
 * (`alwaysDriveApplies`).
 *
 * Pure, so the Settings model, the board control and the drive store read the
 * same rule.
 */

export const KEEP_LIGHTING_CHOICES = ['off', '30', '45', '60', '120', '300', 'until_stopped'] as const;

export type KeepLightingChoice = (typeof KEEP_LIGHTING_CHOICES)[number];

/**
 * Settings › Board's Stop driving after key. A drive's `windowSetting` names it
 * so turning the choice to Right away ends a timed drive it started.
 */
export type KeepLightingSettingKey = 'putOnBoardKeepsLighting';

export const DEFAULT_KEEP_LIGHTING: KeepLightingChoice = '45';

/** A stored value this build doesn't know (an older or newer bundle wrote it) reads as the default. */
export function sanitiseKeepLighting(value: unknown, fallback: KeepLightingChoice): KeepLightingChoice {
  return typeof value === 'string' && (KEEP_LIGHTING_CHOICES as readonly string[]).includes(value)
    ? (value as KeepLightingChoice)
    : fallback;
}

/**
 * How long a timed drive lasts after each lit climb: milliseconds for a timed
 * choice, `null` for Until I stop (no end), `undefined` for Right away (no
 * drive at all).
 */
export function keepLightingWindowMs(choice: KeepLightingChoice): number | null | undefined {
  switch (choice) {
    case 'off':
      return undefined;
    case 'until_stopped':
      return null;
    case '30':
      return 30_000;
    case '45':
      return 45_000;
    case '60':
      return 60_000;
    case '120':
      return 120_000;
    case '300':
      return 300_000;
  }
}

/**
 * What Put on board keeps lighting once its climb is up: a window of
 * `windowMs`, or (`windowMs` null) an open-ended drive. `setting` names the
 * choice it came from, so the drive store can end the window when that choice
 * is turned off.
 */
export type KeepLightingPlan = { windowMs: number | null; setting: KeepLightingSettingKey };

/**
 * The plan for one press, or null for one-climb lighting. Every board takes
 * the one choice, MoonBoards included, and in a crew session only while "In a
 * session too" is on.
 */
export function resolveKeepLightingPlan({
  keepLighting,
  drivesInSession,
  inSession,
}: {
  keepLighting: KeepLightingChoice;
  /** Settings › Board's "In a session too". */
  drivesInSession: boolean;
  /**
   * A crew is in this session (the roster's `useIsCrewSession`). The press and
   * `DriveModeWatcher` both read it, so a window never starts where the watcher
   * would end it.
   */
  inSession: boolean;
}): KeepLightingPlan | null {
  if (inSession && !drivesInSession) return null;
  const windowMs = keepLightingWindowMs(keepLighting);
  return windowMs === undefined ? null : { windowMs, setting: 'putOnBoardKeepsLighting' };
}

/**
 * Whether Always drive the wall (Settings › Board, `alwaysDrive`) drives here:
 * the switch is on and, in a crew session, In a session too is on too. Every
 * board follows that rule, MoonBoards included.
 *
 * Never with the `wall-swipe-to-drive` flag off: it is driving's kill switch
 * (docs/feature-flags.md), and Always drive the wall's drive is a drive like any
 * other, so turned off nothing drives the wall and every pick is a preview.
 *
 * Whether this phone holds the board (its own Bluetooth link, never a relay)
 * is the caller's to add: `DriveModeWatcher` starts the drive only then.
 * While this is true Put on board starts no drive of its own: it resumes this
 * one after a stop (the wall control's `tapDrive: 'resume'`).
 */
export function alwaysDriveApplies({
  alwaysDrive,
  swipeToDriveEnabled,
  drivesInSession,
  inSession,
}: {
  /** Settings › Board's Always drive the wall. */
  alwaysDrive: boolean;
  /** The `wall-swipe-to-drive` flag (`useWallSwipeToDriveEnabled`), driving's kill switch. */
  swipeToDriveEnabled: boolean;
  /** Settings › Board's In a session too. */
  drivesInSession: boolean;
  /** A crew is in this session (the roster's `useIsCrewSession`). */
  inSession: boolean;
}): boolean {
  if (!alwaysDrive || !swipeToDriveEnabled) return false;
  return !inSession || drivesInSession;
}

/**
 * Whether a Lock Screen, Dynamic Island or Android notification Next /
 * Previous keeps lighting the way Put on board would (2.7). Not with the swipe
 * flag (keep-lighting's kill switch) off, and not where Always drive the wall
 * drives (`alwaysDriveApplies`): every pick lights there already, a stop holds
 * until the next Put on board, and Stop driving after doesn't apply.
 */
export function lockScreenPressKeepsLighting({
  swipeToDriveEnabled,
  alwaysDrive,
}: {
  swipeToDriveEnabled: boolean;
  /** `alwaysDriveApplies` for this board and session. */
  alwaysDrive: boolean;
}): boolean {
  return swipeToDriveEnabled && !alwaysDrive;
}

/**
 * What a press on Put on board keeps lighting, as the climber will see it, for
 * the copy that promises it (the first-connect confirmation, the player's
 * preview-first card). It reads the plan against one setting the plan does not
 * take: where Always drive the wall drives (`alwaysDriveApplies`), this phone
 * drives with no end once it holds the board, whatever Stop driving after
 * says, so every pick lights until the climber stops.
 *
 * - `one_climb` — the press lights that climb and nothing after it.
 * - `window` — every pick lights for `seconds`.
 * - `until_stop` — every pick lights until the climber taps the button.
 */
export type KeepLightingReach = { kind: 'one_climb' } | { kind: 'window'; seconds: number } | { kind: 'until_stop' };

export function resolveKeepLightingReach({
  plan,
  alwaysDrive,
}: {
  /** `resolveKeepLightingPlan`'s plan, or null where the press lights one climb. */
  plan: KeepLightingPlan | null;
  /** `alwaysDriveApplies` for this board and session. */
  alwaysDrive: boolean;
}): KeepLightingReach {
  if (alwaysDrive) return { kind: 'until_stop' };
  if (plan === null) return { kind: 'one_climb' };
  if (plan.windowMs === null) return { kind: 'until_stop' };
  return { kind: 'window', seconds: Math.round(plan.windowMs / 1000) };
}

/**
 * A timed drive's length as words take it: whole minutes from one minute up
 * (`minutes`), seconds below that. The copy that names the length (the
 * first-connect confirmation, the preview-first card, the drive's start
 * announcement) reads it, so "2 minutes" is never "120 seconds".
 */
export type DriveLengthWords = { unit: 'seconds'; count: number } | { unit: 'minutes'; count: number };

export function driveLengthWords(seconds: number): DriveLengthWords {
  if (seconds >= 60 && seconds % 60 === 0) return { unit: 'minutes', count: seconds / 60 };
  return { unit: 'seconds', count: seconds };
}
