// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';
import type { HoldFilterMode, HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';

const holdGeometry = vi.hoisted(() => ({
  boardWidth: 1000,
  boardHeight: 1200,
  edgeLeft: 0,
  edgeRight: 10,
  edgeBottom: 0,
  edgeTop: 12,
  family: 'aurora' as const,
  holdTargets: [{ id: 42, cx: 100, cy: 200, r: 20 }],
}));

type PressableMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
};

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressableMockProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel ?? '' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('../../ModalSheet', () => ({
  ModalSheet: forwardRef<unknown, { children?: ReactNode }>(function ModalSheetMock({ children }, _ref) {
    return createElement('div', { 'data-sheet': 'true' }, children);
  }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

type BoardMockProps = { onHoldTap?: (holdId: number) => void };
vi.mock('../InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: ({ onHoldTap }: BoardMockProps) =>
    createElement('button', { 'data-board': 'true', onClick: () => onHoldTap?.(42) }, 'board'),
}));

type PickerMockProps = {
  selectedType: HoldFilterType;
  applyMode: HoldFilterMode;
  onSelectType: (type: HoldFilterType) => void;
};
vi.mock('../HoldFilterPicker', () => ({
  HoldFilterPicker: ({ selectedType, applyMode, onSelectType }: PickerMockProps) =>
    createElement(
      'button',
      {
        'data-picker-type': selectedType,
        'data-picker-mode': applyMode,
        onClick: () => onSelectType('FOOT'),
      },
      'select foot',
    ),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#777' },
    brandColors: { primary: '#2563EB' },
  }),
}));

vi.mock('../../../lib/create-board-holds', () => ({
  getCreateBoardHolds: vi.fn(() => holdGeometry),
  parseSetIdsParam: (setIds: string) => setIds.split(',').map(Number).filter(Boolean),
}));

vi.mock('@boardsesh/climb-filters', () => ({
  countFilteredHolds: (holdsFilter?: HoldsFilter) => Object.keys(holdsFilter ?? {}).length,
  toggleHoldFilterType: (_entry: unknown, type: HoldFilterType, mode: HoldFilterMode) => ({ [type]: mode }),
}));

vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  getLayout: () => ({ name: 'Kilter Board Original' }),
}));

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { count?: number }) => `${key}${values?.count ?? ''}` }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import { HoldFilterEditorSheet } from '../HoldFilterEditorSheet';

const boardConfig: BoardSearchConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

function renderSheet(overrides: Partial<Parameters<typeof HoldFilterEditorSheet>[0]> = {}) {
  return render(
    <HoldFilterEditorSheet
      visible
      boardConfig={boardConfig}
      holdsFilter={{}}
      onHoldsFilterChange={vi.fn()}
      onClose={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe('HoldFilterEditorSheet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows loading before rendering the board after the deferred timeout', () => {
    const { container } = renderSheet();

    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
    expect(container.querySelector('[data-board="true"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(119);
    });
    expect(container.querySelector('[data-board="true"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-spinner="true"]')).toBeNull();
    expect(container.querySelector('[data-board="true"]')).not.toBeNull();
  });

  it('paints the default brush onto a tapped hold', () => {
    const onHoldsFilterChange = vi.fn();
    const { container } = renderSheet({ onHoldsFilterChange });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(container.querySelector('[data-board="true"]') as HTMLButtonElement);

    expect(onHoldsFilterChange).toHaveBeenCalledWith({ 42: { HAND: 'include' } });
  });

  it('paints the selected brush type after choosing a different chip', () => {
    const onHoldsFilterChange = vi.fn();
    const { container } = renderSheet({ onHoldsFilterChange });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    // Pick the FOOT brush, then tap a hold to paint it.
    fireEvent.click(container.querySelector('[data-picker-type]') as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-board="true"]') as HTMLButtonElement);

    expect(onHoldsFilterChange).toHaveBeenCalledWith({ 42: { FOOT: 'include' } });
  });
});
