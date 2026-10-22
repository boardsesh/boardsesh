// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';

const queueState = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  queue: [] as Array<{ uuid: string }>,
  currentClimbQueueItem: null as { uuid: string } | null,
}));
// A queue the card subscribes to like the real context, so a change re-renders it.
const queueListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../../../../providers/queue-provider', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (listener: () => void) => {
    queueListeners.add(listener);
    return () => queueListeners.delete(listener);
  };
  return {
    useQueueSessionId: () => ({ sessionId: queueState.sessionId }),
    useQueueData: () => {
      const queue = useSyncExternalStore(subscribe, () => queueState.queue);
      return { queue, currentClimbQueueItem: queueState.currentClimbQueueItem };
    },
  };
});
function setQueue(uuids: string[]): void {
  queueState.queue = queued(uuids);
  for (const listener of queueListeners) listener();
}

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../Card', () => ({
  Card: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('section', { onClick: onPress }, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: { children?: ReactNode; onPress?: () => void; testID?: string }) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, children),
}));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: 'label', secondaryLabel: 'secondaryLabel', tertiaryLabel: 'tertiaryLabel' },
    brandColors: { primary: 'primary', primaryFill: 'primaryFill' },
  }),
}));
// Plural-free interpolation: enough to read which key and count each row shows.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options && 'count' in options ? `${key.split('.').at(-1)}:${options.count}` : (key.split('.').at(-1) ?? key),
  }),
}));

import { resetWorkoutRunStoreForTests, setWorkoutRun } from '../../../../lib/workout-run-store';
import { WorkoutRunCard } from '../WorkoutRunCard';

const run: WorkoutRun = {
  stages: [
    { id: 'warm', kind: 'warmUp', itemUuids: ['w1', 'w2', 'w3'] },
    { id: 'main', kind: 'volume', itemUuids: ['m1', 'm2'] },
  ],
};
const queued = (uuids: string[]) => uuids.map((uuid) => ({ uuid }));

const rowTexts = () =>
  [...screen.getAllByTestId(/^workout-stage/)].map((row) => `${row.getAttribute('data-testid')}|${row.textContent}`);

beforeEach(() => {
  resetWorkoutRunStoreForTests();
  queueListeners.clear();
  queueState.sessionId = 'session-1';
  queueState.queue = queued(['w1', 'w2', 'w3', 'm1', 'm2']);
  queueState.currentClimbQueueItem = { uuid: 'w1' };
});

describe('WorkoutRunCard', () => {
  it('renders nothing for a session without a workout', () => {
    const { container } = render(createElement(WorkoutRunCard));
    expect(container.textContent).toBe('');
  });

  it('lists the stages, marks the current one and counts what is left in it', () => {
    setWorkoutRun('session-1', run);
    render(createElement(WorkoutRunCard));

    expect(screen.getByText('workoutCardTitle')).toBeTruthy();
    expect(rowTexts()).toEqual([
      'workout-stage-current|preWorkoutSectionWarmUpworkoutStageToGo:2',
      'workout-stage|preGeneratorVolumeworkoutStageClimbs:2',
    ]);
  });

  it('counts only queued climbs, and a removed climb comes back staged after Undo', () => {
    setWorkoutRun('session-1', run);
    render(createElement(WorkoutRunCard));

    // Bulk-remove two warm-up climbs from the queue sheet.
    act(() => setQueue(['w1', 'm1', 'm2']));
    expect(rowTexts()[0]).toBe('workout-stage-current|preWorkoutSectionWarmUpworkoutStageLastClimb');

    // Undo restores the same uuids: they are warm-up climbs again.
    act(() => setQueue(['w1', 'w2', 'w3', 'm1', 'm2']));
    expect(rowTexts()[0]).toBe('workout-stage-current|preWorkoutSectionWarmUpworkoutStageToGo:2');
  });

  it('hides once none of the workout is left in the queue', () => {
    setWorkoutRun('session-1', run);
    queueState.queue = queued(['hand-queued']);
    queueState.currentClimbQueueItem = { uuid: 'hand-queued' };
    const { container } = render(createElement(WorkoutRunCard));
    expect(container.textContent).toBe('');
  });

  describe('Add a block', () => {
    it('sits under the stages and opens the sheet', () => {
      setWorkoutRun('session-1', run);
      const onAddBlock = vi.fn();
      render(createElement(WorkoutRunCard, { onAddBlock }));

      fireEvent.click(screen.getByTestId('workout-add-block'));
      expect(onAddBlock).toHaveBeenCalledTimes(1);
    });

    it('offers to start a workout in a session without one', () => {
      const onAddBlock = vi.fn();
      render(createElement(WorkoutRunCard, { onAddBlock }));

      expect(screen.getByText('addWorkoutPromptTitle')).toBeTruthy();
      fireEvent.click(screen.getByText('addWorkoutPromptTitle'));
      expect(onAddBlock).toHaveBeenCalledTimes(1);
    });

    it('offers a fresh block once the workout has left the queue', () => {
      setWorkoutRun('session-1', run);
      queueState.queue = queued(['hand-queued']);
      queueState.currentClimbQueueItem = { uuid: 'hand-queued' };
      render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));

      expect(screen.getByTestId('workout-add-prompt')).toBeTruthy();
      expect(screen.queryByText('workoutCardTitle')).toBeNull();
    });

    it('renders nothing outside an active session', () => {
      queueState.sessionId = null;
      const { container } = render(createElement(WorkoutRunCard, { onAddBlock: vi.fn() }));
      expect(container.textContent).toBe('');
    });
  });
});
