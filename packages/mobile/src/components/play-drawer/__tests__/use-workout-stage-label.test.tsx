// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

const queueSession = vi.hoisted(() => ({ sessionId: 'session-1' as string | null }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: queueSession.sessionId }),
}));

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

// Echoes the key and its options so the assertions read the inputs directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options
        ? `${key.split('.').at(-1)}(${Object.entries(options)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')})`
        : (key.split('.').at(-1) ?? key),
  }),
}));

import { noteWorkoutRunTick, resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../lib/workout-run-store';
import { useWorkoutStageParts } from '../use-workout-stage-label';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
    {
      id: 'limit',
      kind: 'limitBouldering',
      itemUuids: ['l1', 'l2'],
      pacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
    },
  ],
};
const queueUuids = ['w1', 'l1', 'l2'];

function logTick(queueItemUuid: string, status: 'flash' | 'send' | 'attempt', minute: number): void {
  noteWorkoutRunTick('session-1', { queueItemUuid, status, climbedAt: `2026-10-24T12:0${minute}:00.000Z` });
}

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  queueSession.sessionId = 'session-1';
  setWorkoutRun('session-1', run);
});

// The player's top bar (#6745): the stage name and its numbers apart, with a
// limit climb's try counted among the numbers so a cut name never hides it.
describe('useWorkoutStageParts', () => {
  it('counts the try a limit climb is on, from the ticks logged on it', () => {
    const { result } = renderHook(() => useWorkoutStageParts(run, queueUuids, 'l1'));
    expect(result.current).toMatchObject({
      name: 'preGeneratorLimitBouldering',
      count: 'positionWithTry(position=position(position=1,total=2),number=1)',
    });

    act(() => logTick('l1', 'attempt', 1));
    act(() => logTick('l1', 'attempt', 2));
    expect(result.current?.count).toContain('number=3');
    expect(result.current?.accessibilityLabel).toContain('number=3');

    // Sent: no try left to count.
    act(() => logTick('l1', 'send', 3));
    expect(result.current?.count).toBe('position(position=1,total=2)');
  });

  it('keeps a stage that moves on after any tick to its position alone', () => {
    const { result } = renderHook(() => useWorkoutStageParts(run, queueUuids, 'w1'));
    act(() => logTick('w1', 'attempt', 1));
    expect(result.current).toEqual({
      name: 'preWorkoutSectionWarmUp',
      count: 'position(position=1,total=1)',
      accessibilityLabel: 'workoutStageTopBarAria(stage=preWorkoutSectionWarmUp,position=1,total=1)',
    });
  });

  it('is null without a run, for a climb in no stage, or with nothing on screen', () => {
    expect(renderHook(() => useWorkoutStageParts(null, queueUuids, 'l1')).result.current).toBeNull();
    expect(renderHook(() => useWorkoutStageParts(run, [...queueUuids, 'x'], 'x')).result.current).toBeNull();
    expect(renderHook(() => useWorkoutStageParts(run, queueUuids, null)).result.current).toBeNull();
  });
});
