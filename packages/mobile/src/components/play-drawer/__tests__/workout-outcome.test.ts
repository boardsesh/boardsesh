import { describe, it, expect } from 'vitest';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import {
  findWorkoutRunStage,
  shouldShowWorkoutOutcome,
  workoutOutcomeAvailable,
  type WorkoutOutcomeGate,
} from '../workout-outcome';

// When the player's small row is Fell / Sent (#6231). The taps are
// use-workout-one-tap.test.tsx's.

const QUEUE_ITEM_UUID = 'item-1';

const LIMIT_RUN: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['warm-1'] },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: [QUEUE_ITEM_UUID, 'item-2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};

describe('workoutOutcomeAvailable', () => {
  it('is any stage that paces the rest timer, whatever its kind', () => {
    expect(workoutOutcomeAvailable({ pacing: { mode: 'onTheMinute', restSeconds: 60 } })).toBe(true);
    expect(workoutOutcomeAvailable({ pacing: { mode: 'afterTick', restSeconds: 0, advanceOn: 'tick' } })).toBe(true);
    expect(workoutOutcomeAvailable({})).toBe(false);
    expect(workoutOutcomeAvailable(null)).toBe(false);
  });
});

describe('findWorkoutRunStage', () => {
  it('finds the stage holding the queue item', () => {
    expect(findWorkoutRunStage(LIMIT_RUN, 'item-2')?.id).toBe('limit');
    expect(findWorkoutRunStage(LIMIT_RUN, 'warm-1')?.id).toBe('warm');
    expect(findWorkoutRunStage(LIMIT_RUN, 'hand-queued')).toBeNull();
    expect(findWorkoutRunStage(null, QUEUE_ITEM_UUID)).toBeNull();
    expect(findWorkoutRunStage(LIMIT_RUN, null)).toBeNull();
  });
});

describe('shouldShowWorkoutOutcome', () => {
  const ON_THE_WALL: WorkoutOutcomeGate = {
    run: LIMIT_RUN,
    displayedQueueItemUuid: QUEUE_ITEM_UUID,
    committedQueueItemUuid: QUEUE_ITEM_UUID,
    signedIn: true,
    boardMismatch: false,
    isDraft: false,
  };

  it('shows for the climb on the wall in a paced stage', () => {
    expect(shouldShowWorkoutOutcome(ON_THE_WALL)).toBe(true);
  });

  it('stays down for a climb the climber swiped to or previews', () => {
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, displayedQueueItemUuid: 'item-2' })).toBe(false);
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, displayedQueueItemUuid: null })).toBe(false);
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, committedQueueItemUuid: null })).toBe(false);
  });

  it('stays down in a stage the climber’s own rest settings run, and outside the workout', () => {
    expect(
      shouldShowWorkoutOutcome({ ...ON_THE_WALL, displayedQueueItemUuid: 'warm-1', committedQueueItemUuid: 'warm-1' }),
    ).toBe(false);
    expect(
      shouldShowWorkoutOutcome({ ...ON_THE_WALL, displayedQueueItemUuid: 'loose', committedQueueItemUuid: 'loose' }),
    ).toBe(false);
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, run: null })).toBe(false);
  });

  it('stays down signed out, on another board’s climb, and on a draft', () => {
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, signedIn: false })).toBe(false);
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, boardMismatch: true })).toBe(false);
    expect(shouldShowWorkoutOutcome({ ...ON_THE_WALL, isDraft: true })).toBe(false);
  });
});
