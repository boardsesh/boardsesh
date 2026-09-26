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
 * - Fall back: a repeated wall-clock minute matches twice. A job that fires
 *   nowhere else inside the repeated hour runs only the first time (the
 *   ticker's `lastFiredMinuteKey` guard), so returning the second would call it
 *   overdue; a match is therefore moved back to the earliest instant carrying
 *   the same wall-clock minute. A job that also fires in between (every 15
 *   minutes, say) runs both times, and the earlier answer only makes it
 *   slightly less strict.
 *
 * Cost is one `Intl` format per minute walked: ~10,000 for a weekly job checked
 * mid-week, which measured 28 ms for the whole five-job registry on a laptop.
 * Callers that ask repeatedly (the health endpoint) go through {@link createPreviousRunFinder}, which walks only the
 * minutes since its last answer.
 */
export function previousScheduledRun(expression: CronExpression, timeZone: string, now: Date): Date | null {
  const startMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;

  const matchMs = findLatestMatchMs(expression, timeZone, startMs, PREVIOUS_RUN_SEARCH_MINUTES);
  return matchMs === null ? null : earliestInstantWithSameWallMinute(new Date(matchMs), timeZone);
}

/**
 * {@link previousScheduledRun} with a memo, for one schedule asked about over
 * and over (`/health` is polled every few seconds). Same answers, but a call
 * only walks the minutes since the previous call's minute: nothing within the
 * same minute, one minute per minute of wall time after that. A clock that
 * moves backwards, or a gap longer than the search bound, falls back to the
 * full walk.
 */
export function createPreviousRunFinder(expression: CronExpression, timeZone: string): (now: Date) => Date | null {
  let memo: { startMs: number; matchMs: number | null; answer: Date | null } | null = null;

  return (now) => {
    const startMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
    if (memo !== null && memo.startMs === startMs) {
      return memo.answer;
    }

    const minutesSinceMemo = memo === null ? -1 : (startMs - memo.startMs) / MINUTE_MS;
    let matchMs: number | null;
    if (memo !== null && minutesSinceMemo > 0 && minutesSinceMemo <= PREVIOUS_RUN_SEARCH_MINUTES) {
      // Only the minutes after the memo's are new; if none matches, the memo's
      // match still stands unless it has aged out of the search bound.
      const newMatchMs = findLatestMatchMs(expression, timeZone, startMs, minutesSinceMemo - 1);
      const oldestAllowedMs = startMs - PREVIOUS_RUN_SEARCH_MINUTES * MINUTE_MS;
      matchMs = newMatchMs ?? (memo.matchMs !== null && memo.matchMs >= oldestAllowedMs ? memo.matchMs : null);
    } else {
      matchMs = findLatestMatchMs(expression, timeZone, startMs, PREVIOUS_RUN_SEARCH_MINUTES);
    }

    const answer =
      matchMs === null
        ? null
        : matchMs === memo?.matchMs
          ? memo.answer
          : earliestInstantWithSameWallMinute(new Date(matchMs), timeZone);
    memo = { startMs, matchMs, answer };
    return answer;
  };
}

/** Latest minute in `[startMs - maxMinutesBack, startMs]` that matches, or null. */
function findLatestMatchMs(
  expression: CronExpression,
  timeZone: string,
  startMs: number,
  maxMinutesBack: number,
): number | null {
  for (let minutesBack = 0; minutesBack <= maxMinutesBack; minutesBack += 1) {
    const candidateMs = startMs - minutesBack * MINUTE_MS;
    if (matchesCronExpression(expression, getZonedTimeFields(new Date(candidateMs), timeZone))) {
      return candidateMs;
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
