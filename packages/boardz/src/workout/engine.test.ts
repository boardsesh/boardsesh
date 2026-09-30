import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  msRemaining,
  startRunner,
  summarizeRunner,
  workoutSteps,
  type RunnerEvent,
  type RunnerLog,
  type RunnerState,
  type WorkoutTiming,
} from './engine';

const T0 = 1_000_000;
const seconds = (count: number) => count * 1000;

function run(plan: { timing: WorkoutTiming; climbCount: number }, events: RunnerEvent[]) {
  let state = startRunner(plan, T0);
  const logs: RunnerLog[] = [];
  for (const event of events) {
    const result = applyEvent(plan, state, event);
    state = result.state;
    if (result.log) logs.push(result.log);
  }
  return { state, logs };
}

describe('rest workouts (pyramid, volume, …)', () => {
  const plan = { timing: { kind: 'rest', restSeconds: 90 } as const, climbCount: 3 };

  it('starts on the first climb without a countdown', () => {
    expect(startRunner(plan, T0).phase).toEqual({ kind: 'climbing', stepIndex: 0, endsAt: null, logged: false });
  });

  it('rests after a send, then moves to the next climb', () => {
    const { state, logs } = run(plan, [{ type: 'sent', at: T0 + seconds(30) }]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'sent', attempts: 1 }]);
    expect(state.phase).toEqual({ kind: 'resting', nextStepIndex: 1, endsAt: T0 + seconds(120), getReady: false });
    expect(msRemaining(state, T0 + seconds(60))).toBe(seconds(60));

    const after = applyEvent(plan, state, { type: 'tick', at: T0 + seconds(121) }).state;
    expect(after.phase).toMatchObject({ kind: 'climbing', stepIndex: 1 });
  });

  it('retries the same climb after a fall and counts every try', () => {
    const { state, logs } = run(plan, [
      { type: 'fell', at: T0 + seconds(10) },
      { type: 'skipRest', at: T0 + seconds(20) },
      { type: 'fell', at: T0 + seconds(30) },
      { type: 'tick', at: T0 + seconds(200) },
      { type: 'sent', at: T0 + seconds(210) },
    ]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'sent', attempts: 3 }]);
    expect(state.outcomes[0]).toBe('sent');
  });

  it('logs the falls when the climber moves on without sending', () => {
    const { logs, state } = run(plan, [
      { type: 'fell', at: T0 + seconds(10) },
      { type: 'skipRest', at: T0 + seconds(11) },
      { type: 'moveOn', at: T0 + seconds(12) },
    ]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'attempted', attempts: 1 }]);
    expect(state.outcomes[0]).toBe('attempted');
  });

  it('skips a climb without logging when it was never tried', () => {
    const { logs, state } = run(plan, [{ type: 'moveOn', at: T0 }]);
    expect(logs).toEqual([]);
    expect(state.outcomes[0]).toBe('skipped');
  });

  it('finishes after the last climb', () => {
    const { state } = run(plan, [
      { type: 'sent', at: T0 + 1 },
      { type: 'skipRest', at: T0 + 2 },
      { type: 'sent', at: T0 + 3 },
      { type: 'skipRest', at: T0 + 4 },
      { type: 'sent', at: T0 + 5 },
    ]);
    expect(state.phase).toEqual({ kind: 'done' });
    expect(state.finishedAt).toBe(T0 + 5);
    expect(summarizeRunner(state)).toEqual({ sent: 3, attempted: 0, skipped: 0, total: 3 });
  });

  it('goes straight on when rest is switched off', () => {
    const noRest = { timing: { kind: 'rest', restSeconds: 0 } as const, climbCount: 2 };
    const { state } = run(noRest, [{ type: 'sent', at: T0 + 1 }]);
    expect(state.phase).toMatchObject({ kind: 'climbing', stepIndex: 1 });
  });
});

describe('on the minute', () => {
  const plan = { timing: { kind: 'interval', intervalSeconds: 60 } as const, climbCount: 3 };

  it('counts the climber in, then gives each climb a minute', () => {
    const start = startRunner(plan, T0);
    expect(start.phase).toEqual({ kind: 'resting', nextStepIndex: 0, endsAt: T0 + seconds(10), getReady: true });
    const first = applyEvent(plan, start, { type: 'tick', at: T0 + seconds(11) }).state;
    // The minute starts when the countdown ended, not when the app noticed.
    expect(first.phase).toEqual({ kind: 'climbing', stepIndex: 0, endsAt: T0 + seconds(70), logged: false });
  });

  it('waits out the minute after a send, then moves on by itself', () => {
    const { state, logs } = run(plan, [
      { type: 'tick', at: T0 + seconds(10) },
      { type: 'sent', at: T0 + seconds(40) },
      { type: 'sent', at: T0 + seconds(41) },
    ]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'sent', attempts: 1 }]);
    expect(state.phase).toMatchObject({ kind: 'climbing', stepIndex: 0, logged: true });

    const next = applyEvent(plan, state, { type: 'tick', at: T0 + seconds(70) }).state;
    expect(next.phase).toEqual({ kind: 'climbing', stepIndex: 1, endsAt: T0 + seconds(130), logged: false });
  });

  it('marks unlogged minutes as skipped and catches up after the phone slept', () => {
    const { state } = run(plan, [
      { type: 'tick', at: T0 + seconds(10) },
      // Minutes run 10–70 s, 70–130 s and 130–190 s. Waking at 150 s: the first
      // two ran out while the app was asleep, and the third is under way.
      { type: 'tick', at: T0 + seconds(150) },
    ]);
    expect(state.outcomes).toEqual(['skipped', 'skipped', null]);
    expect(state.phase).toEqual({ kind: 'climbing', stepIndex: 2, endsAt: T0 + seconds(190), logged: false });

    const over = applyEvent(plan, state, { type: 'tick', at: T0 + seconds(200) }).state;
    expect(over.phase).toEqual({ kind: 'done' });
    expect(over.finishedAt).toBe(T0 + seconds(190));
  });

  it('logs a fall straight away, since there is no retry', () => {
    const { logs } = run(plan, [
      { type: 'tick', at: T0 + seconds(10) },
      { type: 'fell', at: T0 + seconds(30) },
    ]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'attempted', attempts: 1 }]);
  });
});

describe('4x4', () => {
  const plan = {
    timing: { kind: 'rounds', rounds: 4, restBetweenClimbsSeconds: 0, restBetweenRoundsSeconds: 240 } as const,
    climbCount: 4,
  };

  it('repeats the same four climbs for four rounds', () => {
    const steps = workoutSteps(plan);
    expect(steps).toHaveLength(16);
    expect(steps[4]).toEqual({ climbIndex: 0, round: 2 });
  });

  it('goes climb to climb, then rests between rounds', () => {
    let state: RunnerState = applyEvent(plan, startRunner(plan, T0), { type: 'skipRest', at: T0 }).state;
    for (let climb = 0; climb < 3; climb++) {
      state = applyEvent(plan, state, { type: 'sent', at: T0 + climb }).state;
      expect(state.phase).toMatchObject({ kind: 'climbing', stepIndex: climb + 1 });
    }
    const afterRound = applyEvent(plan, state, { type: 'fell', at: T0 + seconds(60) });
    expect(afterRound.log).toEqual({ stepIndex: 3, outcome: 'attempted', attempts: 1 });
    expect(afterRound.state.phase).toEqual({
      kind: 'resting',
      nextStepIndex: 4,
      endsAt: T0 + seconds(300),
      getReady: false,
    });
  });
});

describe('limit bouldering', () => {
  const plan = { timing: { kind: 'limit', restSeconds: 180 } as const, climbCount: 2 };

  it('rests after every attempt on the same problem until it goes', () => {
    const { state, logs } = run(plan, [
      { type: 'fell', at: T0 },
      { type: 'tick', at: T0 + seconds(180) },
      { type: 'fell', at: T0 + seconds(200) },
      { type: 'tick', at: T0 + seconds(380) },
      { type: 'sent', at: T0 + seconds(400) },
    ]);
    expect(logs).toEqual([{ stepIndex: 0, outcome: 'sent', attempts: 3 }]);
    // A full rest before the next problem too.
    expect(state.phase).toEqual({ kind: 'resting', nextStepIndex: 1, endsAt: T0 + seconds(580), getReady: false });
  });
});

describe('finishing early', () => {
  it('ends the workout from any phase', () => {
    const plan = { timing: { kind: 'rest', restSeconds: 60 } as const, climbCount: 5 };
    const { state } = run(plan, [
      { type: 'sent', at: T0 },
      { type: 'finish', at: T0 + 5 },
    ]);
    expect(state.phase).toEqual({ kind: 'done' });
    expect(summarizeRunner(state)).toEqual({ sent: 1, attempted: 0, skipped: 0, total: 5 });
    // Nothing moves once done.
    expect(applyEvent(plan, state, { type: 'sent', at: T0 + 6 }).state).toBe(state);
  });
});
