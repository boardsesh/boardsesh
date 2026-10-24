// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanFillSummary } from '@boardsesh/playlist-generator';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, opacity: { disabled: 0.5 } }),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: (difficultyId: number) => `G${difficultyId}` }),
}));
// Echo the key and its values so the test can read what was interpolated.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

import { WorkoutPreviewSummary } from '../WorkoutPreviewSummary';

function makeSummary(overrides: Partial<PlanFillSummary> = {}): PlanFillSummary {
  return {
    planned: 6,
    filled: 6,
    missing: 0,
    lowestGrade: 16,
    highestGrade: 20,
    sections: [{ section: 'main', count: 6 }],
    ...overrides,
  };
}

const onShuffle = vi.fn();

beforeEach(() => {
  onShuffle.mockClear();
});

function renderSummary(summary: PlanFillSummary, shuffleDisabled = false) {
  return render(createElement(WorkoutPreviewSummary, { summary, boardName: 'moonboard', onShuffle, shuffleDisabled }));
}

describe('WorkoutPreviewSummary', () => {
  it('counts the climbs Start will queue and spans their grades', () => {
    const { getByText } = renderSummary(makeSummary());

    getByText(
      'mobile.session.preWorkoutPreviewSummary {"count":6,"grades":"mobile.session.preWorkoutPreviewGradeSpan {\\"lowest\\":\\"G16\\",\\"highest\\":\\"G20\\"}"}',
    );
  });

  it('names a single grade once', () => {
    const { getByText } = renderSummary(makeSummary({ lowestGrade: 18, highestGrade: 18 }));

    getByText('mobile.session.preWorkoutPreviewSummary {"count":6,"grades":"G18"}');
  });

  it('says how many planned climbs were found when the pools ran short', () => {
    const { getByText } = renderSummary(makeSummary({ filled: 4, missing: 2 }));

    getByText('mobile.session.preWorkoutPreviewShortfall {"filled":4,"planned":6}');
  });

  it('shows no shortfall note for a full plan', () => {
    const { queryByText } = renderSummary(makeSummary());

    expect(queryByText(/preWorkoutPreviewShortfall/)).toBeNull();
  });

  it('shuffles on tap, and not while disabled', () => {
    const { getByLabelText, rerender } = renderSummary(makeSummary());
    fireEvent.click(getByLabelText('mobile.session.preWorkoutPreviewShuffleAccessibilityLabel'));
    expect(onShuffle).toHaveBeenCalledTimes(1);

    rerender(
      createElement(WorkoutPreviewSummary, {
        summary: makeSummary(),
        boardName: 'moonboard',
        onShuffle,
        shuffleDisabled: true,
      }),
    );
    fireEvent.click(getByLabelText('mobile.session.preWorkoutPreviewShuffleAccessibilityLabel'));
    expect(onShuffle).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for an empty preview', () => {
    const { container } = renderSummary(makeSummary({ filled: 0, missing: 6, lowestGrade: null, highestGrade: null }));

    expect(container.innerHTML).toBe('');
  });

  describe('with the queue Start hands over', () => {
    const renderWithQueue = (
      summary: PlanFillSummary,
      startQueue: { climbCount: number; estimatedMinutes: number | null },
    ) =>
      render(
        createElement(WorkoutPreviewSummary, {
          summary,
          boardName: 'moonboard',
          onShuffle,
          shuffleDisabled: false,
          startQueue,
        }),
      );

    it("counts a 4x4's rounds and says about how long it takes", () => {
      const { getByText } = renderWithQueue(makeSummary({ planned: 4, filled: 4, lowestGrade: 18, highestGrade: 18 }), {
        climbCount: 16,
        estimatedMinutes: 25,
      });

      getByText('mobile.session.preWorkoutPreviewSummaryTimed {"count":16,"grades":"G18","minutes":25}');
    });

    it('gives no time for an untimed workout', () => {
      const { getByText, queryByText } = renderWithQueue(makeSummary({ lowestGrade: 18, highestGrade: 18 }), {
        climbCount: 6,
        estimatedMinutes: null,
      });

      getByText('mobile.session.preWorkoutPreviewSummary {"count":6,"grades":"G18"}');
      expect(queryByText(/preWorkoutPreviewSummaryTimed/)).toBeNull();
    });

    it('still names the shortfall in planned slots, not queued climbs', () => {
      const { getByText } = renderWithQueue(makeSummary({ planned: 4, filled: 3, missing: 1 }), {
        climbCount: 12,
        estimatedMinutes: 20,
      });

      getByText('mobile.session.preWorkoutPreviewShortfall {"filled":3,"planned":4}');
    });
  });
});
