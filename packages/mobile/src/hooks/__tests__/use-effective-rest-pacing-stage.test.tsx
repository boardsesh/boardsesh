// @vitest-environment jsdom
//
// The stage input of the effective pacing (#5380): what `RestTimerPacingSync`
// stores for the climb on the wall wins over the climber's settings, for every
// reader at once, and only a real change re-renders them.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const settingsValues = vi.hoisted(() => ({
  current: { restTimerTargetSeconds: 90, restTimerMode: 'afterTick', restTimerAutoAdvance: false } as Record<
    string,
    unknown
  >,
}));

vi.mock('../../settings', () => ({
  useSetting: (key: string) => [settingsValues.current[key], vi.fn()],
  getSetting: (key: string) => settingsValues.current[key],
}));

import {
  getEffectiveRestPacing,
  getOwnRestPacing,
  useEffectiveRestPacing,
  useRestTimerStagePacing,
} from '../use-effective-rest-pacing';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
} from '../../lib/rest-timer-store';
import type { RestTimerStagePacing } from '../../lib/rest-timer-pacing';

const LIMIT: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-limit',
  kind: 'limitBouldering',
  queueItemUuid: 'l1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
};

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('useEffectiveRestPacing with a workout stage', () => {
  it('runs on the stage’s rest and advance rule, always hands-free, and back on the settings after', () => {
    const { result } = renderHook(() => useEffectiveRestPacing());
    expect(result.current).toMatchObject({ source: 'settings', targetSeconds: 90, autoAdvance: false });

    act(() => applyRestTimerStagePacing(LIMIT, 0, 'none'));
    expect(result.current).toEqual({
      targetSeconds: 180,
      mode: 'afterTick',
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
      stage: LIMIT,
    });
    expect(getEffectiveRestPacing()).toEqual(result.current);

    act(() => applyRestTimerStagePacing(null, 0, 'none'));
    expect(result.current).toMatchObject({ source: 'settings', targetSeconds: 90, advanceOn: 'deadline' });
  });

  it('hands back the same object through ticks, so the scheduler does not reschedule on them', () => {
    act(() => applyRestTimerStagePacing(LIMIT, 0, 'none'));
    armRestTimer('afterTick', 0, 'session-1');
    const { result } = renderHook(() => useEffectiveRestPacing());
    const first = result.current;

    act(() =>
      noteRestTimerTick(new Date(1_000).toISOString(), 'afterTick', 1_000, { status: 'attempt', queueItemUuid: 'l1' }),
    );

    expect(result.current).toBe(first);
  });
});

/** A 4x4 set of 4 reps on the wall with `logged` of them logged: no rest between reps, 3:00 after the set. */
const fourByFourSet = (logged: number): RestTimerStagePacing => ({
  sessionId: 'session-1',
  stageId: 'stage-4x4',
  kind: 'fourByFour',
  queueItemUuid: 'a',
  mode: 'afterTick',
  targetSeconds: logged >= 4 ? 180 : null,
  advanceOn: 'tick',
  closesSet: logged >= 4,
  reps: { logged, perSet: 4 },
  stagePacing: {
    mode: 'afterTick',
    restSeconds: 0,
    advanceOn: 'set',
    sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
  },
});

describe('a 4x4 set on the wall', () => {
  it('moves nothing until its last rep, then rests the set rest hands-free', () => {
    act(() => applyRestTimerStagePacing(fourByFourSet(1), 0, 'none'));
    expect(getEffectiveRestPacing()).toMatchObject({
      source: 'stage',
      targetSeconds: null,
      autoAdvance: false,
      advanceOn: 'tick',
    });

    act(() => applyRestTimerStagePacing(fourByFourSet(4), 0, 'none'));
    expect(getEffectiveRestPacing()).toMatchObject({ targetSeconds: 180, autoAdvance: true, advanceOn: 'tick' });
  });

  it('hands the crew clock a rule the server knows, with auto-advance off until the set is done', () => {
    // The crew clock counts no reps: what keeps it from moving the wall after
    // the first rep is this phone's own pacing saying so.
    act(() => applyRestTimerStagePacing(fourByFourSet(3), 0, 'none'));
    expect(getOwnRestPacing()).toEqual({
      mode: 'afterTick',
      targetSeconds: null,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });

    // The set rest moves the wall once, then the clock waits for the next set.
    act(() => applyRestTimerStagePacing(fourByFourSet(4), 0, 'none'));
    expect(getOwnRestPacing()).toEqual({
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'stage',
    });
  });

  it('never hands the next set, another block or the climber’s settings a once-only advance', () => {
    act(() => applyRestTimerStagePacing(fourByFourSet(4), 0, 'none'));
    expect(getOwnRestPacing()).toMatchObject({ autoAdvanceOnce: true });

    // The next set on the wall, before its first rep: no advance at all.
    act(() => applyRestTimerStagePacing({ ...fourByFourSet(0), queueItemUuid: 'b' }, 0, 'waitForTick'));
    expect(getOwnRestPacing()).not.toHaveProperty('autoAdvanceOnce');
    expect(getOwnRestPacing()).toMatchObject({ autoAdvance: false });

    // A limit block after the 4x4: it moves on after every send.
    act(() => applyRestTimerStagePacing(LIMIT, 0, 'waitForTick'));
    expect(getOwnRestPacing()).toEqual({
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
    });

    // Past the workout: the climber's own settings.
    act(() => applyRestTimerStagePacing(null, 0, 'none'));
    expect(getOwnRestPacing()).toEqual({
      mode: 'afterTick',
      targetSeconds: 90,
      autoAdvance: false,
      advanceOn: 'deadline',
      source: 'settings',
    });
  });
});

describe('useRestTimerStagePacing', () => {
  it('re-renders only when the stage pacing itself changes', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRestTimerStagePacing();
    });
    expect(result.current).toBeNull();

    act(() => armRestTimer('afterTick', 0, 'session-1'));
    act(() => noteRestTimerTick(new Date(1_000).toISOString(), 'afterTick', 1_000));
    const rendersBeforeStage = renders;

    act(() => applyRestTimerStagePacing(LIMIT, 2_000, 'waitForTick'));
    expect(result.current).toBe(LIMIT);
    expect(renders).toBe(rendersBeforeStage + 1);
  });
});
