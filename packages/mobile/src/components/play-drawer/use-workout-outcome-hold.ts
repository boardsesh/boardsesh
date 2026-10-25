// Keeps one-tap Fell / Sent on screen for a moment after the wall leaves a timed
// block (#6231).
//
// An on-the-minute beat moves the wall whether the climber logged or not. When
// the next climb is outside the timed block, the player's gate for Fell / Sent
// turns false at the beat, and without this hold the small row (heart, angle,
// share) would be under a finger already on its way to Fell: the tap would open
// Choose Angle or add a favorite. So the row stays for `WALL_MOVED_GRACE_MS`,
// still logging for the climb it was shown for, which is what a tap that soon
// after the wall moved means anyway (`use-workout-one-tap.ts`). Then the row
// swaps, once.
//
// The player reads the held row for everything the row decides (the bar layout,
// ⋯, the connect pill, the opening layout key), so the swap is one change, at
// the end of the hold, never one at the beat and another after it.
import { useEffect, useMemo, useState } from 'react';
import { WALL_MOVED_GRACE_MS, type WorkoutOutcomeTarget } from './workout-outcome';

/** What the Fell / Sent row shows, and whether it is held for the climb the wall left. */
export type WorkoutOutcomeShown = {
  target: WorkoutOutcomeTarget;
  /**
   * Null while `target` is the climb on the wall. Set while the row is held for
   * the climb the wall just left: when it left, so a tap past the grace is dropped.
   */
  wallLeftAtMs: number | null;
};

export type WorkoutOutcomeHoldInput = {
  /** The row the player's gate asks for right now (`shouldShowWorkoutOutcome`), or null. */
  live: WorkoutOutcomeTarget | null;
  /** The committed current queue item: the climb on the wall. */
  committedQueueItemUuid: string | null;
  /** The queue item the player shows. */
  displayedQueueItemUuid: string | null;
  /** The session on screen. */
  sessionId: string | null;
  /** The climber can log from here: signed in, and no switch-board gate up. */
  canLog: boolean;
};

type Hold = { target: WorkoutOutcomeTarget; wallLeftAtMs: number };

/**
 * The row to draw: the live one, or the one held for the climb the wall just
 * left. A hold starts only when the wall moved (the committed item changed)
 * with the climber still looking at the wall, and ends early when they swipe to
 * browse, the gate comes back, or they can no longer log here.
 */
export function useWorkoutOutcomeHold({
  live,
  committedQueueItemUuid,
  displayedQueueItemUuid,
  sessionId,
  canLog,
}: WorkoutOutcomeHoldInput): WorkoutOutcomeShown | null {
  // The live row the last render saw, kept in state: React's pattern for
  // reacting to a prop change in the render that brings it, so the hold starts
  // before anything commits and the row never unmounts for a frame. React re-runs
  // the render at once with the new state and throws this pass away.
  const [previousLive, setPreviousLive] = useState(live);
  const [hold, setHold] = useState<Hold | null>(null);

  const isHeldFor = (target: WorkoutOutcomeTarget) =>
    canLog &&
    sessionId === target.sessionId &&
    displayedQueueItemUuid === committedQueueItemUuid &&
    committedQueueItemUuid !== target.queueItemUuid;

  if (live !== previousLive) {
    setPreviousLive(live);
    if (live === null && previousLive !== null && isHeldFor(previousLive)) {
      const left = previousLive;
      // Keeps a hold already made for this climb, so Strict Mode's second run
      // of this render (and of the updater) leaves the same single hold.
      // Wall-clock, not `nowMs()`: this times the grace against the taps'
      // `Date.now()` and the swap's timer, and screenshot mode freezes `nowMs()`,
      // which would end every hold the moment it starts.
      setHold((current) => (current?.target === left ? current : { target: left, wallLeftAtMs: Date.now() }));
    }
  }
  const held = live === null && hold !== null && isHeldFor(hold.target) ? hold : null;

  // The grace runs out, or something else took the row first.
  useEffect(() => {
    if (hold === null) return undefined;
    if (held !== hold) {
      setHold(null);
      return undefined;
    }
    const timeout = setTimeout(() => setHold(null), Math.max(0, hold.wallLeftAtMs + WALL_MOVED_GRACE_MS - Date.now()));
    return () => clearTimeout(timeout);
  }, [hold, held]);

  return useMemo<WorkoutOutcomeShown | null>(() => {
    if (live !== null) return { target: live, wallLeftAtMs: null };
    return held !== null ? { target: held.target, wallLeftAtMs: held.wallLeftAtMs } : null;
  }, [live, held]);
}
