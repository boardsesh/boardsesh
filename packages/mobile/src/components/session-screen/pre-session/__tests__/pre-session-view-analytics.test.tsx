// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeOptions } from '@boardsesh/playlist-generator';
import type { GeneratorSelection } from '../GeneratorPickerCard';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));

const queue = vi.hoisted(() => ({
  startSession: vi.fn(async () => 'session-1' as string | null),
  addToQueue: vi.fn(),
}));

const activeBoard = vi.hoisted(() => ({
  data: { boardType: 'kilter', angle: 40 } as { boardType: string; angle: number } | null,
}));

const plan = vi.hoisted(() => ({ generated: [{ grade: 10 }, { grade: 11 }, { grade: 12 }] }));
const selected = vi.hoisted(() => ({ items: [{ uuid: 'c1' }, { uuid: 'c2' }] }));

// Surfaces GeneratorPickerCard's onChange so the test can flip the generator on.
const picker = vi.hoisted(() => ({ onChange: null as ((selection: GeneratorSelection) => void) | null }));
// Surfaces the Start button's onPress.
const startButton = vi.hoisted(() => ({ onPress: null as (() => void) | null }));

vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({
  getGradesForBoard: () => [{ difficulty_id: 10, difficulty_name: '5a' }],
  toBoardName: (boardType: string) => boardType,
}));
vi.mock('@boardsesh/playlist-generator', () => ({
  generateWorkoutPlan: () => plan.generated,
}));
vi.mock('../../../Button', () => ({
  Button: ({ onPress }: { onPress?: () => void }) => {
    startButton.onPress = onPress ?? null;
    return createElement('button');
  },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => activeBoard }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueue: () => ({ startSession: queue.startSession, addToQueue: queue.addToQueue }),
}));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../BoardSummaryCard', () => ({ BoardSummaryCard: () => null }));
vi.mock('../GeneratorPickerCard', () => ({
  GeneratorPickerCard: ({ onChange }: { onChange: (selection: GeneratorSelection) => void }) => {
    picker.onChange = onChange;
    return null;
  },
}));
vi.mock('../select-climbs-for-plan', () => ({
  selectClimbsForPlan: vi.fn(async () => selected.items),
}));

import { PreSessionView } from '../PreSessionView';

beforeEach(() => {
  analytics.track.mockClear();
  queue.startSession.mockClear();
  queue.startSession.mockResolvedValue('session-1');
  queue.addToQueue.mockClear();
  activeBoard.data = { boardType: 'kilter', angle: 40 };
  picker.onChange = null;
  startButton.onPress = null;
});

describe('PreSessionView analytics', () => {
  it('fires "Session Queue Generated" with the queued/failed counts when starting with the generator on', async () => {
    render(createElement(PreSessionView));

    // Flip the generator on so handleStart takes the generate branch.
    const volumeOptions: VolumeOptions = {
      type: 'volume',
      warmUp: 'none',
      targetGrade: 10,
      mainSetClimbs: 20,
      mainSetVariability: 0,
      climbBias: 'any',
      minAscents: 0,
      minRating: 0,
      onlyTallClimbs: false,
    };
    act(() => {
      picker.onChange?.({ type: 'on', options: volumeOptions });
    });

    await act(async () => {
      startButton.onPress?.();
    });

    // handleStart awaits startSession → select before tracking; poll until those
    // promises settle rather than flushing a fixed number of microtasks.
    await waitFor(() =>
      expect(analytics.track).toHaveBeenCalledWith('Session Queue Generated', {
        workoutType: 'volume',
        boardName: 'kilter',
        angle: 40,
        // 2 climbs queued out of a 3-slot plan → 1 short.
        savedCount: 2,
        failedCount: 1,
      }),
    );

    expect(queue.addToQueue).toHaveBeenCalledTimes(2);
  });

  it('does not fire when the generator is off', async () => {
    render(createElement(PreSessionView));

    await act(async () => {
      startButton.onPress?.();
    });

    // With the generator off, handleStart only starts the session. Wait for that
    // call to settle, then assert no generate event fired.
    await waitFor(() => expect(queue.startSession).toHaveBeenCalledTimes(1));

    expect(analytics.track).not.toHaveBeenCalledWith('Session Queue Generated', expect.anything());
  });
});
