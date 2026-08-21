/**
 * Pure decision logic for the board-lighting settings, split out of
 * bluetooth-provider.tsx so it stays importable (and testable) with none of
 * that file's React Native / BLE dependency weight — see
 * bluetooth-auto-sender.test.ts, which recreates the auto-sender's algorithm
 * without React for the same reason.
 */

/** See `markClimbChangeIntent` on `BluetoothContextValue` in bluetooth-provider.tsx. */
export type ClimbChangeIntent = 'swipe' | 'tap';

/**
 * Whether a tagged climb change should skip the board-lighting auto-send, per
 * the `lightOnSwipe` / `lightOnClimbTap` settings. An untagged change (`null`
 * — remote sync, undo, initial load) never suppresses, matching the settings'
 * default-on behavior.
 */
export function shouldSuppressClimbChangeIntent(
  intent: ClimbChangeIntent | null,
  settings: { lightOnSwipe: boolean; lightOnClimbTap: boolean },
): boolean {
  if (intent === 'swipe') return !settings.lightOnSwipe;
  if (intent === 'tap') return !settings.lightOnClimbTap;
  return false;
}
