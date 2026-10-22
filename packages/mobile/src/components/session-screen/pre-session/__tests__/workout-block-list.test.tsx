// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LADDER_OPTIONS, DEFAULT_PYRAMID_OPTIONS, DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import type { ActiveGeneratorSelection, GeneratorSelection } from '../workout-blocks';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options ? `${key}(${Object.values(options).join(',')})` : key,
  }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    onPress,
    disabled,
    accessibilityLabel,
    children,
  }: {
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', null, title),
}));
// The shared chip and steppers have their own coverage through the workout card.
vi.mock('../generator-controls', () => ({
  Chip: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }),
  GroupedSteppers: () => null,
  workoutStepperRows: () => [],
  generatorControlStyles: { chipRow: {} },
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../grade', () => ({ GradeSingleSelectRail: () => null }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {}, opacity: { disabled: 0.5 } }),
}));

import { WorkoutBlockList } from '../WorkoutBlockList';

const FIRST_CARD = { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 20, warmUp: 'standard' as const };

function selectionWith(extraCount: number): ActiveGeneratorSelection {
  const extraOptions = [
    { ...DEFAULT_LADDER_OPTIONS, targetGrade: 20 },
    { ...DEFAULT_VOLUME_OPTIONS, targetGrade: 16 },
    { ...DEFAULT_PYRAMID_OPTIONS, targetGrade: 18 },
  ];
  return {
    type: 'on',
    options: FIRST_CARD,
    extraBlocks: extraOptions.slice(0, extraCount).map((options, position) => ({ id: `b${position}`, options })),
  };
}

const onChange = vi.fn<(selection: GeneratorSelection) => void>();

function renderList(selection: ActiveGeneratorSelection) {
  return render(createElement(WorkoutBlockList, { boardName: 'kilter', railGrades: [], selection, onChange }));
}

function lastSelection(): ActiveGeneratorSelection {
  const selection = onChange.mock.calls.at(-1)?.[0];
  if (selection?.type !== 'on') throw new Error('expected an active selection');
  return selection;
}

beforeEach(() => {
  onChange.mockClear();
});

describe('WorkoutBlockList', () => {
  it('adds a block of the next type at the last block’s grade', () => {
    const screen = renderList(selectionWith(0));

    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorAddBlock'));

    expect(lastSelection().extraBlocks).toEqual([
      { id: expect.any(String), options: { ...DEFAULT_LADDER_OPTIONS, targetGrade: 20 } },
    ]);
  });

  it('numbers the extra blocks after the first card and wires move and remove', () => {
    const screen = renderList(selectionWith(2));

    expect(screen.getByText('mobile.session.preGeneratorBlockTitle(2)')).toBeTruthy();
    expect(screen.getByText('mobile.session.preGeneratorBlockTitle(3)')).toBeTruthy();

    // The first extra block can't go above the first card; the last can't go further down.
    expect(screen.getByLabelText('mobile.session.preGeneratorMoveBlockUpAccessibilityLabel(2)')).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByLabelText('mobile.session.preGeneratorMoveBlockDownAccessibilityLabel(3)')).toHaveProperty(
      'disabled',
      true,
    );

    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorMoveBlockDownAccessibilityLabel(2)'));
    expect(lastSelection().extraBlocks.map((block) => block.id)).toEqual(['b1', 'b0']);

    fireEvent.click(screen.getByLabelText('mobile.session.preGeneratorRemoveBlockAccessibilityLabel(3)'));
    expect(lastSelection().extraBlocks.map((block) => block.id)).toEqual(['b0']);
  });

  it('switches a block’s type from its chips', () => {
    const screen = renderList(selectionWith(1));

    fireEvent.click(
      screen.getByLabelText(
        'mobile.session.preGeneratorOptionAccessibilityLabel(mobile.session.preGeneratorBlockTitle(2),mobile.session.preGeneratorVolume)',
      ),
    );

    expect(lastSelection().extraBlocks[0].options).toEqual({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 20 });
  });

  it('swaps Add a block for the limit note at four blocks', () => {
    const screen = renderList(selectionWith(3));

    expect(screen.queryByLabelText('mobile.session.preGeneratorAddBlock')).toBeNull();
    expect(screen.getByText('mobile.session.preGeneratorBlockLimit(4)')).toBeTruthy();
  });
});
