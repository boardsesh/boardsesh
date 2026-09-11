// Pure derivation + formatting for the rest timer (#5378). No React, no I/O.
//
// Revived from the abandoned PR #2770 (`fix/2569-mobile-rep-timer`), renamed
// from "rep timer" to match the copy that branch already shipped ("Rest timer").
// The one behavioural change: callers pass `nowMs` in, so the display can ride
// `nowMs()` from ./clock (frozen in screenshot mode) instead of a raw clock.

import { tickTimeMs } from '@boardsesh/profile-stats';

/** How the countdown is anchored. See the two modes in the #5378 plan. */
export type RestTimerMode =
  /** Anchor on your last tick: every send buys you the full interval. */
  | 'afterTick'
  /** Anchor on arming and never move: the cadence holds against the clock. */
  | 'onTheMinute';

/**
 * Milliseconds for a backend tick timestamp, or null when there is none / it is
 * unparseable. `tickTimeMs` treats a naive backend timestamp as UTC.
 */
export function getRestTimerStartMs(lastTickAt: string | null): number | null {
  if (!lastTickAt) return null;
  const tickMs = tickTimeMs(lastTickAt);
  return Number.isFinite(tickMs) ? tickMs : null;
}

export function getRestTimerElapsedSecondsFromStart(startMs: number | null, nowMs: number): number {
  if (startMs === null) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

export function getRestTimerElapsedSeconds(lastTickAt: string | null, nowMs: number): number {
  return getRestTimerElapsedSecondsFromStart(getRestTimerStartMs(lastTickAt), nowMs);
}

export function isRestTimerTargetReached(elapsedSeconds: number, targetSeconds: number): boolean {
  return elapsedSeconds >= targetSeconds;
}

export function isRestTimerTargetExceeded(elapsedSeconds: number, targetSeconds: number): boolean {
  return elapsedSeconds > targetSeconds;
}

/** Compact target label for the pill's "Rest · 1m" line. */
export function formatRestTimerTarget(targetSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(targetSeconds));
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60}m`;
  return formatRestTimerElapsed(totalSeconds);
}

/** `m:ss`, widening to `h:mm:ss` only once an hour has passed. */
export function formatRestTimerElapsed(elapsedSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = seconds.toString().padStart(2, '0');

  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`;
  }

  return `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`;
}
