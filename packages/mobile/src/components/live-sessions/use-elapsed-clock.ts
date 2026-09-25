import { useEffect, useState } from 'react';
import { nowMs } from '../../lib/clock';

const MINUTE_MS = 60_000;
/** Land just past the boundary so the floor in `elapsedParts` has moved. */
const BOUNDARY_SLACK_MS = 50;

/**
 * Milliseconds until any session's elapsed minute next ticks over.
 *
 * Each session crosses a minute at its own second offset, so waking on the
 * wall-clock minute (and flooring "now" to it) left a card up to two minutes
 * behind: a session started at 10:01:05 still read "0m" at 10:02:59. Waking at
 * the soonest per-session boundary keeps every label exact, at most one render
 * per session per minute.
 */
export function nextElapsedChangeDelay(now: number, startedAtMsList: readonly number[]): number {
  let soonest = MINUTE_MS;
  for (const startedAtMs of startedAtMsList) {
    const elapsed = now - startedAtMs;
    // A start stamped ahead of this clock reads "Just started" until a minute past it.
    const delay = elapsed < 0 ? MINUTE_MS - elapsed : MINUTE_MS - (elapsed % MINUTE_MS);
    if (delay < soonest) soonest = delay;
  }
  return soonest;
}

/**
 * "Now" for elapsed labels, re-read whenever a listed session's elapsed minute
 * changes and immediately when the list changes. One timer for a whole rail.
 *
 * @param startedAtKey - the sessions' `startedAtMs` joined with commas. A string
 *   so a poll that returns the same sessions keeps the effect (and its timer).
 */
export function useElapsedClock(active: boolean, startedAtKey: string): number {
  const [now, setNow] = useState(nowMs);

  useEffect(() => {
    if (!active) return;
    const startedAtMsList = startedAtKey === '' ? [] : startedAtKey.split(',').map(Number);
    setNow(nowMs());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(nowMs());
          schedule();
        },
        nextElapsedChangeDelay(nowMs(), startedAtMsList) + BOUNDARY_SLACK_MS,
      );
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active, startedAtKey]);

  return now;
}

/** The comma-joined key `useElapsedClock` takes. */
export function startedAtKeyFor(cards: ReadonlyArray<{ startedAtMs: number }>): string {
  return cards.map((card) => card.startedAtMs).join(',');
}
