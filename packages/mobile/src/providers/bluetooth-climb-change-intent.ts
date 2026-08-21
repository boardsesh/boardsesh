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

export type ClimbChangeIntentArmer = {
  /** Arm the one-shot tag. `now` is the caller's clock reading (ms). */
  mark: (intent: ClimbChangeIntent, now: number) => void;
  /**
   * Consume (and clear) the armed tag. Returns `null` for an unarmed or
   * expired tag — expiry is checked lazily here against `now`, not by a live
   * timer, so there is nothing to clean up on unmount.
   */
  consume: (now: number) => ClimbChangeIntent | null;
};

/**
 * One-shot arm/consume state machine with a TTL, backing
 * `markClimbChangeIntent` / `BluetoothAutoSender`'s ref. Takes an explicit
 * `now` on every call instead of reading the clock itself, so it's
 * deterministic to unit test without fake timers or rendering the component.
 */
export function createClimbChangeIntentArmer(ttlMs: number): ClimbChangeIntentArmer {
  let armed: { intent: ClimbChangeIntent; expiresAt: number } | null = null;
  return {
    mark(intent, now) {
      armed = { intent, expiresAt: now + ttlMs };
    },
    consume(now) {
      if (!armed) return null;
      const { intent, expiresAt } = armed;
      armed = null;
      return now <= expiresAt ? intent : null;
    },
  };
}
