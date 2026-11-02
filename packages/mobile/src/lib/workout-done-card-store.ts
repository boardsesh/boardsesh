// Whether "Workout done" is up over the board (#6291), one answer for the whole
// app. A module singleton read through `useSyncExternalStore`, like
// `workout-run-store`.
//
// Not per player: on a tablet every tab can keep its own persistent play pane
// mounted, and each pane runs its own `WorkoutRunnerOverlay`. With the state in
// each pane, every pane that saw the workout finish opened its own card, so a
// card the climber closed came back on the next tab. Here the first pane to see
// the finish opens it, every pane shows that one card, and Done (or See your
// workout) closes it everywhere.
//
// Once per run, by object identity: adding a block makes a new run, whose end
// gets its own card. The run objects are the workout-run store's, so the same
// workout reads as the same run on every pane.
//
// The players hold the card while they are mounted. When the last one goes (the
// phone's player closing), an open card closes with it, so a player opened
// later on a finished workout never finds the card still up: it opens only on
// the finish itself.

import { useCallback, useSyncExternalStore } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

/** The run whose finish already opened the card: never again for it. */
let announcedRun: WorkoutRun | null = null;
/** The run the card is up for, or null when it is closed. */
let openRun: WorkoutRun | null = null;
/** Players with a run mounted now (`holdWorkoutDoneCard`). */
let holders = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeWorkoutDoneCard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The workout `run` just finished in front of a player: open the card, once per run. */
export function announceWorkoutDone(run: WorkoutRun): void {
  if (announcedRun === run) return;
  announcedRun = run;
  openRun = run;
  emit();
}

/** Done, the scrim, Android back, or See your workout: closed on every player. */
export function closeWorkoutDoneCard(): void {
  if (openRun === null) return;
  openRun = null;
  emit();
}

/**
 * A player with a run mounted. Returns its release, safe to call twice. The
 * last release closes an open card.
 */
export function holdWorkoutDoneCard(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) closeWorkoutDoneCard();
  };
}

export function isWorkoutDoneCardOpenFor(run: WorkoutRun): boolean {
  return openRun === run;
}

/** Whether the card is up for `run`. Re-renders only when that answer changes. */
export function useWorkoutDoneCardOpen(run: WorkoutRun): boolean {
  const isOpenForRun = useCallback(() => isWorkoutDoneCardOpenFor(run), [run]);
  return useSyncExternalStore(subscribeWorkoutDoneCard, isOpenForRun, isOpenForRun);
}

export function resetWorkoutDoneCardStoreForTests(): void {
  announcedRun = null;
  openRun = null;
  holders = 0;
}
