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
import { useWorkoutStageLabel } from '../use-workout-stage-label';

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

describe('useWorkoutStageLabel', () => {
  it('counts the try a limit climb is on, from the ticks logged on it', () => {
    const { result } = renderHook(() => useWorkoutStageLabel(run, queueUuids, 'l1'));
    expect(result.current).toBe(
      'positionWithTry(position=workoutStagePosition(stage=preGeneratorLimitBouldering,position=1,total=2),number=1)',
    );

    act(() => logTick('l1', 'attempt', 1));
    act(() => logTick('l1', 'attempt', 2));
    expect(result.current).toContain('number=3');

    // Sent: no try left to count.
    act(() => logTick('l1', 'send', 3));
    expect(result.current).toBe('workoutStagePosition(stage=preGeneratorLimitBouldering,position=1,total=2)');
  });

  it('keeps a stage that moves on after any tick to its position alone', () => {
    const { result } = renderHook(() => useWorkoutStageLabel(run, queueUuids, 'w1'));
    act(() => logTick('w1', 'attempt', 1));
    expect(result.current).toBe('workoutStagePosition(stage=preWorkoutSectionWarmUp,position=1,total=1)');
  });

  it('is null without a run or for a climb in no stage', () => {
    expect(renderHook(() => useWorkoutStageLabel(null, queueUuids, 'l1')).result.current).toBeNull();
    expect(renderHook(() => useWorkoutStageLabel(run, [...queueUuids, 'x'], 'x')).result.current).toBeNull();
  });
});
