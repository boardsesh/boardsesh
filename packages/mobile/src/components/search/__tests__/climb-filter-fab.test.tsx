// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GradeBound } from '@boardsesh/climb-filters';

vi.mock('react-native', () => ({
  Pressable: ({ onPress }: { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, 'data-dismiss': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (initial: number) => ({ value: initial }),
  withTiming: (value: number) => value,
}));

vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16 } }));
vi.mock('../../../theme/motion-config', () => ({ timingFor: (config: { duration: number }) => config }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ motion: { standard: { duration: 150 }, emphasized: { duration: 250 } } }),
}));
vi.mock('../FilterButton', () => ({
  FILTER_FAB_SIZE: 48,
  FilterButton: ({
    activeFilterCount,
    onPress,
    onLongPress,
    prominence,
  }: {
    activeFilterCount: number;
    onPress: () => void;
    onLongPress?: () => void;
    prominence?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        onDoubleClick: onLongPress,
        'data-filter-count': String(activeFilterCount),
        'data-prominence': prominence ?? '',
      },
      'filter',
    ),
}));
vi.mock('../../grade', () => ({
  GradeRangeRail: () => createElement('div', { 'data-grade-rail': 'true' }),
}));

import { ClimbFilterFab } from '../ClimbFilterFab';

function renderFab(overrides: Partial<Parameters<typeof ClimbFilterFab>[0]> = {}) {
  return render(
    <ClimbFilterFab
      activeFilterCount={0}
      bottom={120}
      bound={{} as GradeBound}
      grades={[]}
      gradeRailVisible={false}
      onOpenFilters={vi.fn()}
      onOpenGrade={vi.fn()}
      onCloseGrade={vi.fn()}
      onGradeChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ClimbFilterFab', () => {
  it('opens filters from the bottom-right filter button', () => {
    const onOpenFilters = vi.fn();
    const { getByText } = renderFab({ activeFilterCount: 3, onOpenFilters });

    fireEvent.click(getByText('filter'));

    expect(onOpenFilters).toHaveBeenCalledTimes(1);
    expect(getByText('filter').getAttribute('data-prominence')).toBe('floating');
  });

  it('opens the grade rail from a long press', () => {
    const onOpenGrade = vi.fn();
    const { getByText } = renderFab({ onOpenGrade });

    fireEvent.doubleClick(getByText('filter'));

    expect(onOpenGrade).toHaveBeenCalledTimes(1);
  });

  it('renders and dismisses the grade rail when visible', () => {
    const onCloseGrade = vi.fn();
    const { container } = renderFab({ gradeRailVisible: true, onCloseGrade });

    expect(container.querySelector('[data-grade-rail="true"]')).not.toBeNull();
    fireEvent.click(container.querySelector('[data-dismiss="true"]') as HTMLElement);
    expect(onCloseGrade).toHaveBeenCalledTimes(1);
  });
});
