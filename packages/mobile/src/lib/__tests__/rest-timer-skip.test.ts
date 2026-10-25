// Skip rest on the player's rest card (#6291): it moves the wall exactly once,
// only when the rest running out would have, and claims the cycle so the
// scheduler's pending advance can never move it a second time.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import type { CrewRestCadence } from '../crew-rest-cadence';
import { resolveStageRestPacing, type RestTimerTickStatus } from '../rest-timer-pacing';
import {
  adoptCrewCadence,
  applyRestTimerStagePacing,
  armRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  subscribeLocalRestTimerActions,
  type LocalRestTimerAction,
} from '../rest-timer-store';
import { restSkipAllowed, skipRestOnWall } from '../rest-timer-skip';

const SESSION = 'session-1';
const T0 = Date.parse('2026-10-25T10:00:00.000Z');

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
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 180 },
      },
    },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
    { id: 'emom', kind: 'onTheMinute', itemUuids: ['o1', 'o2'], pacing: { mode: 'onTheMinute', restSeconds: 60 } },
  ],
};
const queue = ['a', 'b', 'l1', 'l2', 'o1', 'o2'];

/** The climb on the wall, with the stage pacing RestTimerPacingSync would store for it after `repsLogged` reps. */
function onTheWall(uuid: string, repsLogged = 0): void {
  applyRestTimerStagePacing(
    resolveStageRestPacing({
      sessionId: SESSION,
      run,
      position: locateInRun(run, uuid, queue),
      queueItemUuid: uuid,
      repsLogged,
    }),
    T0,
    'none',
  );
}

/** A fresh go on `uuid`, logged now, as the tick path hands it to the timer. */
function logGo(uuid: string, status: RestTimerTickStatus, atMs = T0 + 1000): void {
  noteRestTimerTick(new Date(atMs).toISOString(), 'afterTick', atMs, { status, queueItemUuid: uuid });
}

/** A tap on Skip rest, with the stage's own pacing (what `getEffectiveRestPacing` reads with no crew clock). */
function skip(uuid: string, wallQueueItemUuid: string | null = uuid, moveWall = vi.fn()) {
  const { stagePacing } = getRestTimerState();
  const moved = skipRestOnWall({
    queueItemUuid: uuid,
    wallQueueItemUuid,
    pacing: { mode: stagePacing?.mode ?? 'afterTick', advanceOn: stagePacing?.advanceOn ?? 'deadline' },
    nowMs: T0 + 5000,
    moveWall,
  });
  return { moved, moveWall };
}

beforeEach(() => {
  resetRestTimerStoreForTests();
  armRestTimer('afterTick', T0, SESSION);
});

describe('skipRestOnWall', () => {
  it('ends the rest after a send and moves the wall once, claiming the cycle first', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    const { cycleId } = getRestTimerState();

    const { moved, moveWall } = skip('l1');

    expect(moved).toBe(true);
    expect(moveWall).toHaveBeenCalledTimes(1);
    const state = getRestTimerState();
    // A send rule: the next climb rests only once it is logged.
    expect(state.anchorMs).toBeNull();
    expect(state.lastTick).toBeNull();
    expect(state.cycleId).toBe(cycleId + 1);
    expect(state.lastFiredDeadlineMs).toBe(T0 + 5000);
    expect(state.advancedFromQueueItemUuid).toBe('l1');
    // The scheduler's timeout, armed on the old cycle, can no longer advance.
    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 6000, T0 + 181_000, 'clear')).toBe(false);
  });

  it('moves nothing on a second tap, before the wall has caught up', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    const moveWall = vi.fn();

    skip('l1', 'l1', moveWall);
    // The queue snapshot still reads l1 (the move has not landed yet).
    skip('l1', 'l1', moveWall);

    expect(moveWall).toHaveBeenCalledTimes(1);
  });

  it('tells the crew publisher, so the shared clock waits for the next tick too', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    const actions: LocalRestTimerAction[] = [];
    const unsubscribe = subscribeLocalRestTimerActions((action) => actions.push(action));

    skip('l1');
    unsubscribe();

    expect(actions).toEqual([{ type: 'fired', sessionId: SESSION, anchorAfter: 'clear' }]);
  });

  it('ends a paused rest too: the timer runs again, the crew hears RESUME before the fire, and the next climb starts clean', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    pauseRestTimer(T0 + 3000);
    expect(getRestTimerState()).toMatchObject({ isRunning: false, pausedElapsedSeconds: 2 });
    const actions: LocalRestTimerAction[] = [];
    const unsubscribe = subscribeLocalRestTimerActions((action) => actions.push(action));

    const { moved, moveWall } = skip('l1');
    unsubscribe();

    expect(moved).toBe(true);
    expect(moveWall).toHaveBeenCalledTimes(1);
    // Nothing frozen from the old rest: the next climb waits for its first log.
    expect(getRestTimerState()).toMatchObject({
      isRunning: true,
      pausedElapsedSeconds: 0,
      anchorMs: null,
      lastTick: null,
      advancedFromQueueItemUuid: 'l1',
    });
    // In this order, so the crew clock is running again before its CLEAR (which keeps a pause).
    expect(actions).toEqual([
      { type: 'resume', sessionId: SESSION },
      { type: 'fired', sessionId: SESSION, anchorAfter: 'clear' },
    ]);
  });

  it('leaves a paused timer paused when the tap moves nothing', () => {
    onTheWall('l1');
    logGo('l1', 'attempt');
    pauseRestTimer(T0 + 3000);

    expect(skip('l1').moved).toBe(false);
    expect(getRestTimerState()).toMatchObject({ isRunning: false, pausedElapsedSeconds: 2 });
  });

  it('moves nothing when the wall moved since the card showed', () => {
    onTheWall('l1');
    logGo('l1', 'send');

    expect(skip('l1', 'l2').moved).toBe(false);
    expect(skip('l1', null).moved).toBe(false);
    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'l1' });
  });

  it('never moves off a limit climb after a fall: the next try is on it', () => {
    onTheWall('l1');
    logGo('l1', 'attempt');

    const { moved, moveWall } = skip('l1');

    expect(moved).toBe(false);
    expect(moveWall).not.toHaveBeenCalled();
  });

  it('never moves off a 4x4 set with reps left, and does once its last rep is logged', () => {
    onTheWall('a');
    logGo('a', 'send');
    onTheWall('a', 1);
    expect(skip('a').moved).toBe(false);

    logGo('a', 'attempt', T0 + 2000);
    onTheWall('a', 2);
    expect(skip('a').moved).toBe(true);
  });

  it('never skips a beat on the minute', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    onTheWall('o1');
    noteRestTimerTick(new Date(T0 + 1000).toISOString(), 'onTheMinute', T0 + 1000, {
      status: 'send',
      queueItemUuid: 'o1',
    });

    const moveWall = vi.fn();
    const moved = skipRestOnWall({
      queueItemUuid: 'o1',
      wallQueueItemUuid: 'o1',
      pacing: { mode: 'onTheMinute', advanceOn: 'deadline' },
      nowMs: T0 + 5000,
      moveWall,
    });

    expect(moved).toBe(false);
    expect(moveWall).not.toHaveBeenCalled();
  });

  it('moves nothing with the timer off', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    resetRestTimerStoreForTests();

    expect(skip('l1').moved).toBe(false);
  });

  it('moves nothing under a crew clock this app cannot run, as the scheduler never fires on it', () => {
    onTheWall('l1');
    const unsupported: CrewRestCadence = {
      sessionId: SESSION,
      revision: 3,
      config: null,
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: null,
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    };
    adoptCrewCadence(unsupported);
    logGo('l1', 'send');

    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'l1' });
    expect(skip('l1').moved).toBe(false);
  });
});

describe('restSkipAllowed', () => {
  it('answers what a tap would do, from the state the card already reads, and claims nothing', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    const before = getRestTimerState();
    const query = { queueItemUuid: 'l1', wallQueueItemUuid: 'l1' };

    expect(restSkipAllowed({ ...query, pacing: { mode: 'afterTick', advanceOn: 'send' } }, before)).toBe(true);
    // A crew clock on the minute, or one whose rule this go does not meet, wins
    // over the stage: the tap would move nothing, so the card must not offer it.
    expect(restSkipAllowed({ ...query, pacing: { mode: 'onTheMinute', advanceOn: 'deadline' } }, before)).toBe(false);
    expect(getRestTimerState()).toBe(before);
  });

  it('says no once the tap moved the wall off the climb', () => {
    onTheWall('l1');
    logGo('l1', 'send');
    skip('l1');

    expect(
      restSkipAllowed(
        { queueItemUuid: 'l1', wallQueueItemUuid: 'l1', pacing: { mode: 'afterTick', advanceOn: 'send' } },
        getRestTimerState(),
      ),
    ).toBe(false);
  });
});
