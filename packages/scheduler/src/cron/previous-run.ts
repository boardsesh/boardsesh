import { matchesCronExpression, type CronExpression } from './expression';
import { getZonedMinuteKey, getZonedTimeFields } from './zoned-time';

const MINUTE_MS = 60_000;

/**
 * How far back {@link previousScheduledRun} looks: 8 days, in minutes.
 *
 * The longest schedule in the registry is weekly (`profile-percentiles`,
 * `0 6 * * 0`), whose previous occurrence is at most 7 days back; the extra day
 * is slack. A monthly job would need this raised to ~32 days (46,080 minutes)
 * or it would read as "no previous run" and never be reported overdue.
 */
export const PREVIOUS_RUN_SEARCH_MINUTES = 8 * 24 * 60;

/**
 * A wall-clock minute repeats at most once, inside a DST "fall back" hour. Three
 * hours covers every real zone's repeated span (one hour almost everywhere, 30
 * minutes on Lord Howe Island).
 */
const REPEATED_MINUTE_LOOKBACK_MINUTES = 3 * 60;

/**
 * The most recent instant at or before `now` (truncated to the minute) at
 * which `expression` fires in `timeZone`, or null when nothing matches within
 * {@link PREVIOUS_RUN_SEARCH_MINUTES}.
 *
 * Walks back one UTC minute at a time and resolves each into the zone, so it
 * agrees with the minute ticker in `scheduler.ts` on both DST edges:
 *
 * - Spring forward: a wall-clock minute inside the gap never exists, so it
 *   never matches — the ticker skips it too, and the answer is the day before.
 * - Fall back: a repeated wall-clock minute matches twice, but the ticker only
 *   fires the first one (its `lastFiredMinuteKey` guard). Returning the second
 *   would call that job overdue, so a match is moved back to the earliest
 *   instant carrying the same wall-clock minute.
 *
 * Cost is one `Intl` format per minute walked: ~10,000 for a weekly job checked
 * mid-week. Cheap enough for a health probe polled every few tens of seconds.
 */
export function previousScheduledRun(expression: CronExpression, timeZone: string, now: Date): Date | null {
  const startMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;

  for (let minutesBack = 0; minutesBack <= PREVIOUS_RUN_SEARCH_MINUTES; minutesBack += 1) {
    const candidate = new Date(startMs - minutesBack * MINUTE_MS);
    if (matchesCronExpression(expression, getZonedTimeFields(candidate, timeZone))) {
      return earliestInstantWithSameWallMinute(candidate, timeZone);
    }
  }

  return null;
}

function earliestInstantWithSameWallMinute(instant: Date, timeZone: string): Date {
  const wallMinuteKey = getZonedMinuteKey(instant, timeZone);
  let earliest = instant;
  for (let minutesBack = 1; minutesBack <= REPEATED_MINUTE_LOOKBACK_MINUTES; minutesBack += 1) {
    const earlier = new Date(instant.getTime() - minutesBack * MINUTE_MS);
    if (getZonedMinuteKey(earlier, timeZone) === wallMinuteKey) {
      earliest = earlier;
    }
  }
  return earliest;
}
