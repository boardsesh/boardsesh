// The #4979 hold (docs/current-climb-outside-queue.md, section 6): when the
// climb on the wall hasn't changed for 4 hours or more, connecting a board
// doesn't light it. The board stays dark until the climber acts, and the player
// says when that climb was last on the wall.
//
// Pure helpers only. The clock itself is owned by the queue provider
// (`useCurrentChangeClock`), and the gate runs in the Bluetooth auto-sender.

/** 4 h matches the Redis session TTL (section 6). */
export const STALE_CURRENT_HOLD_MS = 4 * 60 * 60 * 1000;

/**
 * When the current climb last became a different climb: a different queue-item
 * uuid, or `null`. Edits to Up next, hydrates, regrades and mirror flips never
 * move it. `queueItemUuid` is the uuid the clock was stamped for, so a reader
 * can tell a clock that is about another climb (one that just changed and the
 * clock has not caught up with) from one about the climb in hand.
 */
export type CurrentChangeClock = {
  queueItemUuid: string | null;
  /** Epoch milliseconds. */
  changedAt: number;
};

/** What the player needs while the hold keeps the board dark. */
export type StaleCurrentHold = {
  queueItemUuid: string;
  /** Epoch milliseconds: the same clock the gate read, so the line can't disagree with it. */
  lastCurrentChangeAt: number;
};

/**
 * Why a hold ended, for `Board Stale Current Released`:
 * - `new-current`: the current climb changed (a tap, Next, a crewmate's pick);
 * - `relight`: the climber asked (Put on the wall, the lightbulb's Re-light, a
 *   list pick of the held climb);
 * - `reopen`: the climber opened the held climb again (a re-tap of the current
 *   climb), which restarts its clock. A FullSync never does this: for the same
 *   climb it keeps the older time;
 * - `disconnect`: the board went away while the hold stood;
 * - `kill-switch`: `stale-current-hold-kill` came on.
 */
export type StaleCurrentHoldReleaseReason = 'new-current' | 'relight' | 'reopen' | 'disconnect' | 'kill-switch';

/**
 * Whether the clock says `queueItemUuid` has been the current climb for 4 h or
 * more. A clock stamped for a different uuid (or no clock) is never stale: the
 * current climb has just changed, which is the opposite of stale, and the
 * auto-sender can run before the provider's clock catches up.
 */
export function isStaleCurrentClimb(
  clock: CurrentChangeClock | null | undefined,
  queueItemUuid: string,
  now: number,
): boolean {
  if (!clock || clock.queueItemUuid !== queueItemUuid) return false;
  return now - clock.changedAt >= STALE_CURRENT_HOLD_MS;
}

/**
 * Parses an ISO 8601 instant into epoch ms, or `null` for a missing or
 * unparseable value (an older server, a corrupt snapshot).
 */
export function parseClockInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Hours to one decimal place, for telemetry. */
export function holdAgeHours(lastCurrentChangeAt: number, now: number): number {
  return Math.round(((now - lastCurrentChangeAt) / (60 * 60 * 1000)) * 10) / 10;
}
