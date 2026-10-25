// What the player's rest card says for each rest (#6291, #5380, #6231): the
// wording rules of `resolveWorkoutRestCard`, built on real runner readouts.
import { describe, expect, it } from 'vitest';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { resolveStageRestPacing, type RestTimerTickStatus } from '../../../lib/rest-timer-pacing';
import { countWorkoutRunTicks, type WorkoutTickLogEntry } from '../../../lib/workout-run-store';
import {
  describeWorkoutRunner,
  type WorkoutRunnerInput,
  type WorkoutRunnerRestSnapshot,
} from '../../../lib/workout-runner-readout';
import { resolveWorkoutRestCard, workoutRestCardKey } from '../workout-runner-cards';

// A 4x4 of two sets (3 reps each, 0:45 between reps, 3:00 between sets), two
// limit climbs, two climbs on the minute, then a cool-down.
const run: WorkoutRun = {
  stages: [
    {
      id: 'four',
      kind: 'fourByFour',
      itemUuids: ['a', 'b'],
      pacing: {
        mode: 'afterTick',
        restSeconds: 45,
        advanceOn: 'set',
        sets: { repsPerSet: 3, restBetweenSetsSeconds: 180 },
      },
    },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
    { id: 'emom', kind: 'onTheMinute', itemUuids: ['o1', 'o2'], pacing: { mode: 'onTheMinute', restSeconds: 60 } },
    { id: 'cool', kind: 'warmUp', itemUuids: ['c1'], coolDown: true },
  ],
};
const queue = ['a', 'b', 'l1', 'l2', 'o1', 'o2', 'c1'];

const item = (uuid: string): ClimbQueueItem =>
  ({ uuid, climb: { uuid: `climb-${uuid}`, name: `Climb ${uuid}` } }) as unknown as ClimbQueueItem;

let tickSecond = 0;
function ticks(uuid: string, ...statuses: RestTimerTickStatus[]): WorkoutTickLogEntry[] {
  return statuses.map((status) => {
    tickSecond += 1;
    return { queueItemUuid: uuid, status, climbedAt: new Date(Date.UTC(2026, 9, 25, 12, 0, tickSecond)).toISOString() };
  });
}

/** The rest after the last of `log`'s ticks on `uuid`, as the store holds it once RestTimerPacingSync caught up. */
function restingOn(uuid: string, log: readonly WorkoutTickLogEntry[], paused = false): WorkoutRunnerRestSnapshot {
  const lastTick = log.filter((entry) => entry.queueItemUuid === uuid).at(-1);
  return {
    armed: true,
    isRunning: !paused,
    anchorMs: 1000,
    lastTick: lastTick ? { status: lastTick.status, queueItemUuid: uuid } : null,
    stagePacing: resolveStageRestPacing({
      sessionId: 'session-1',
      run,
      position: locateInRun(run, uuid, queue),
      queueItemUuid: uuid,
      repsLogged: countWorkoutRunTicks(log, uuid),
    }),
    queueEnded: false,
  };
}

function cardFor({
  currentUuid,
  nextUuid,
  log,
  paused = false,
  canAdvanceQueue = true,
  skipAllowed = true,
  rest,
}: {
  currentUuid: string;
  nextUuid: string | null;
  log: WorkoutTickLogEntry[];
  paused?: boolean;
  canAdvanceQueue?: boolean;
  skipAllowed?: boolean;
  rest?: Partial<WorkoutRunnerInput['rest']>;
}) {
  const readout = describeWorkoutRunner({
    run,
    queueUuids: queue,
    currentUuid,
    nextUuid,
    log,
    rest: { ...restingOn(currentUuid, log, paused), ...rest },
    canAdvanceQueue,
  });
  if (!readout) throw new Error('expected a readout');
  return resolveWorkoutRestCard({
    readout,
    nextItem: nextUuid === null ? null : item(nextUuid),
    skipAllowed,
  });
}

describe('resolveWorkoutRestCard', () => {
  it('shows nothing while the climber is on the climb, before its first go', () => {
    expect(cardFor({ currentUuid: 'a', nextUuid: 'b', log: [] })).toBeNull();
  });

  it('between two reps of a set, leads back to the same climb with the next rep and the set, reps first', () => {
    const card = cardFor({ currentUuid: 'a', nextUuid: 'b', log: ticks('a', 'attempt') });

    expect(card).toEqual({
      key: workoutRestCardKey('a', 1),
      queueItemUuid: 'a',
      heading: { kind: 'rest' },
      caption: { kind: 'nextRep', rep: 2, reps: 3, set: 1, sets: 2 },
      action: 'goNow',
    });
  });

  it("after a set's last rep, says the set is done, names the next climb and offers Skip rest", () => {
    const card = cardFor({ currentUuid: 'a', nextUuid: 'b', log: ticks('a', 'attempt', 'send', 'attempt') });

    expect(card?.heading).toEqual({ kind: 'setDone', set: 1 });
    expect(card?.caption).toEqual({ kind: 'nextClimb', item: item('b') });
    expect(card?.action).toBe('skipRest');
    expect(card?.key).toBe(workoutRestCardKey('a', 3));
  });

  it("after the block's last set, says the block is done and names the next block", () => {
    const card = cardFor({ currentUuid: 'b', nextUuid: 'l1', log: ticks('b', 'send', 'send', 'send') });

    expect(card?.heading).toEqual({ kind: 'stageDone', stage: 'fourByFour', isCoolDown: false });
    expect(card?.caption).toEqual({ kind: 'nextStage', stage: 'limitBouldering', isCoolDown: false });
    expect(card?.action).toBe('skipRest');
  });

  it('after a fall on a limit climb, says the next try comes back to it, and Go now only hides the card', () => {
    const card = cardFor({ currentUuid: 'l1', nextUuid: 'l2', log: ticks('l1', 'attempt', 'attempt') });

    expect(card?.heading).toEqual({ kind: 'rest' });
    expect(card?.caption).toEqual({ kind: 'tryAgain', tryNumber: 3 });
    expect(card?.action).toBe('goNow');
  });

  it('after a send on a limit climb, rests and then moves on to the next climb', () => {
    const card = cardFor({ currentUuid: 'l1', nextUuid: 'l2', log: ticks('l1', 'attempt', 'send') });

    expect(card?.heading).toEqual({ kind: 'rest' });
    expect(card?.caption).toEqual({ kind: 'nextClimb', item: item('l2') });
    expect(card?.action).toBe('skipRest');
  });

  it('never offers Skip rest on the minute: the beat is the block', () => {
    const card = cardFor({ currentUuid: 'o1', nextUuid: 'o2', log: ticks('o1', 'send') });

    expect(card?.heading).toEqual({ kind: 'nextBeat' });
    expect(card?.caption).toEqual({ kind: 'nextClimb', item: item('o2') });
    expect(card?.action).toBeNull();
  });

  it('names a warm-up after the workout "Cool-down" when the block hands over to it', () => {
    const card = cardFor({ currentUuid: 'o2', nextUuid: 'c1', log: ticks('o2', 'send') });

    expect(card?.heading).toEqual({ kind: 'stageDone', stage: 'onTheMinute', isCoolDown: false });
    expect(card?.caption).toEqual({ kind: 'nextStage', stage: 'warmUp', isCoolDown: true });
  });

  describe('a crew phone that does not hold the wall', () => {
    it('says another phone moves the wall, and offers no Skip rest', () => {
      const card = cardFor({
        currentUuid: 'a',
        nextUuid: 'b',
        log: ticks('a', 'send', 'send', 'send'),
        canAdvanceQueue: false,
      });

      expect(card?.heading).toEqual({ kind: 'setDone', set: 1 });
      expect(card?.caption).toEqual({ kind: 'movedByHolder' });
      expect(card?.action).toBeNull();
    });

    it('still says what comes back to the climb between reps, and Go now still hides the card', () => {
      const card = cardFor({ currentUuid: 'a', nextUuid: 'b', log: ticks('a', 'send'), canAdvanceQueue: false });

      expect(card?.caption).toEqual({ kind: 'nextRep', rep: 2, reps: 3, set: 1, sets: 2 });
      expect(card?.action).toBe('goNow');
    });
  });

  it('offers no Skip rest where the tap would not move the wall (a crew clock on the minute, or one this app cannot run)', () => {
    const card = cardFor({
      currentUuid: 'l1',
      nextUuid: 'l2',
      log: ticks('l1', 'send'),
      skipAllowed: false,
    });

    // Still says where the rest leads: the scheduler decides when, not the card.
    expect(card?.caption).toEqual({ kind: 'nextClimb', item: item('l2') });
    expect(card?.action).toBeNull();
  });

  it('says the timer is paused, whatever rest it froze', () => {
    const card = cardFor({ currentUuid: 'a', nextUuid: 'b', log: ticks('a', 'send', 'send', 'send'), paused: true });

    expect(card?.heading).toEqual({ kind: 'paused' });
    expect(card?.caption).toEqual({ kind: 'nextClimb', item: item('b') });
  });

  it('names nothing and offers no Skip rest when Next lands nowhere', () => {
    const card = cardFor({ currentUuid: 'l1', nextUuid: null, log: ticks('l1', 'send') });

    expect(card?.caption).toBeNull();
    expect(card?.action).toBeNull();
  });

  it('shows nothing with the timer off', () => {
    expect(cardFor({ currentUuid: 'a', nextUuid: 'b', log: ticks('a', 'send'), rest: { armed: false } })).toBeNull();
  });

  it('shows nothing once the last climb finished the workout: that has its own card', () => {
    // The 4x4's last set, with nothing queued after it.
    const lastSetLog = ticks('b', 'send', 'send', 'send');
    const readout = describeWorkoutRunner({
      run,
      queueUuids: ['a', 'b'],
      currentUuid: 'b',
      nextUuid: null,
      log: lastSetLog,
      rest: { ...restingOn('b', lastSetLog) },
      canAdvanceQueue: true,
    });
    if (!readout) throw new Error('expected a readout');

    expect(readout.phase).toBe('done');
    expect(resolveWorkoutRestCard({ readout, nextItem: null, skipAllowed: true })).toBeNull();
  });
});
