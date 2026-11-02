// "Workout done" is one card for the whole app (#6291): every player that shows
// it reads the same answer, it opens once per run, and it closes with the last
// player, so a player opened later on a finished workout never finds it up.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import {
  announceWorkoutDone,
  closeWorkoutDoneCard,
  holdWorkoutDoneCard,
  isWorkoutDoneCardOpenFor,
  resetWorkoutDoneCardStoreForTests,
  subscribeWorkoutDoneCard,
} from '../workout-done-card-store';

const firstRun: WorkoutRun = { stages: [{ id: 'warm', kind: 'warmUp', itemUuids: ['w1'] }] };
// Adding a block makes a new run object.
const runWithAddedBlock: WorkoutRun = {
  stages: [...firstRun.stages, { id: 'volume', kind: 'volume', itemUuids: ['v1'] }],
};

beforeEach(() => {
  resetWorkoutDoneCardStoreForTests();
});

describe('workout-done-card-store', () => {
  it('opens once per run, whichever player saw the finish, and tells every reader', () => {
    const release = holdWorkoutDoneCard();
    const listener = vi.fn();
    const unsubscribe = subscribeWorkoutDoneCard(listener);

    announceWorkoutDone(firstRun);
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    closeWorkoutDoneCard();
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(false);

    // A second pane catching up on the same finish opens nothing.
    announceWorkoutDone(firstRun);
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    // The new run's end gets its own card, and the old run reads closed.
    announceWorkoutDone(runWithAddedBlock);
    expect(isWorkoutDoneCardOpenFor(runWithAddedBlock)).toBe(true);
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(false);

    unsubscribe();
    release();
  });

  it('stays up while any player holds it, and closes with the last one', () => {
    const releasePane = holdWorkoutDoneCard();
    const releaseOtherPane = holdWorkoutDoneCard();
    announceWorkoutDone(firstRun);

    releasePane();
    // Released twice (a strict-mode re-run): still one release.
    releasePane();
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(true);

    releaseOtherPane();
    expect(isWorkoutDoneCardOpenFor(firstRun)).toBe(false);
  });
});
