// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';
import type { HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import type { FilterBoardTransformContext } from '../InteractiveFilterBoard';

const zoneState = vi.hoisted(() => {
  const defaultZone: ZoneBoxInput = { edgeLeft: 1, edgeRight: 9, edgeBottom: 2, edgeTop: 11 };
  const committedZone: ZoneBoxInput = { edgeLeft: 2, edgeRight: 8, edgeBottom: 3, edgeTop: 10 };
  const prunedFilter: HoldsFilter = { 10: { HAND: 'include' } };
  return {
    defaultZone,
    committedZone,
    prunedFilter,
    buildDefaultZone: vi.fn(() => defaultZone),
    pruneHoldsToZone: vi.fn(() => prunedFilter),
  };
});

const holdGeometry = vi.hoisted(() => ({
  boardWidth: 1000,
  boardHeight: 1200,
  edgeLeft: 0,
  edgeRight: 10,
  edgeBottom: 0,
  edgeTop: 12,
  family: 'aurora' as const,
  holdTargets: [
    { id: 10, cx: 100, cy: 200, r: 20 },
    { id: 20, cx: 300, cy: 400, r: 20 },
  ],
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

vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));

vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: ReadonlyArray<{ key: ZoneMatchMode; label: string }>;
    onSelect: (key: ZoneMatchMode) => void;
  }) =>
    createElement(
      'div',
      { 'data-segmented': 'true' },
      options.map((option) =>
        createElement('button', { key: option.key, onClick: () => onSelect(option.key) }, option.label),
      ),
    ),
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-glass': 'true' }, children),
}));

type BoardMockProps = { renderInTransform?: (context: FilterBoardTransformContext) => ReactNode };
vi.mock('../InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: ({ renderInTransform }: BoardMockProps) =>
    createElement(
      'div',
      { 'data-board': 'true' },
      renderInTransform?.({
        pinchGesture: {},
        scaleSV: {},
        renderWidth: 320,
        renderHeight: 480,
      } as FilterBoardTransformContext),
    ),
}));

vi.mock('../ZoneOverlay', () => ({
  ZoneOverlay: ({ onCommit }: { onCommit: (zoneBox: ZoneBoxInput) => void }) =>
    createElement('button', { 'data-zone-commit': 'true', onClick: () => onCommit(zoneState.committedZone) }, 'commit'),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      fill: '#EEE',
      secondaryLabel: '#777',
      elevatedSurface: '#FFF',
    },
    brandColors: { primary: '#2563EB' },
  }),
}));

vi.mock('../../../lib/create-board-holds', () => ({
  getCreateBoardHolds: vi.fn(() => holdGeometry),
  parseSetIdsParam: (setIds: string) => setIds.split(',').map(Number).filter(Boolean),
}));

vi.mock('@boardsesh/climb-filters', () => ({
  buildDefaultZone: zoneState.buildDefaultZone,
  pruneHoldsToZone: zoneState.pruneHoldsToZone,
}));

vi.mock('@boardsesh/board-constants', () => ({
  getLayout: () => ({ name: 'Kilter Board Original' }),
}));

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: 'rgba(0,0,0,0.35)' },
  spacing: { 2: 8, 3: 12, 4: 16 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import { ZoneFilterEditorSheet } from '../ZoneFilterEditorSheet';

const boardConfig: BoardSearchConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 40,
};

function renderSheet(overrides: Partial<Parameters<typeof ZoneFilterEditorSheet>[0]> = {}) {
  return render(
    <ZoneFilterEditorSheet
      visible
      boardConfig={boardConfig}
      zoneBox={null}
      zoneMode="allHolds"
      holdsFilter={{}}
      onZoneFilterChange={vi.fn()}
      onClose={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ZoneFilterEditorSheet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    zoneState.buildDefaultZone.mockClear();
    zoneState.pruneHoldsToZone.mockClear();
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

  it('propagates enabling the default zone to the parent callback', () => {
    const onZoneFilterChange = vi.fn();
    const { getByText } = renderSheet({ holdsFilter: { 10: { HAND: 'include' } }, onZoneFilterChange });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(getByText('mobile.zoneFilter.enable'));

    expect(onZoneFilterChange).toHaveBeenCalledWith({
      zoneBox: zoneState.defaultZone,
      zoneMode: 'allHolds',
      holdsFilter: zoneState.prunedFilter,
    });
  });

  it('propagates zone overlay commits to the parent callback', () => {
    const onZoneFilterChange = vi.fn();
    const { container } = renderSheet({
      zoneBox: zoneState.defaultZone,
      zoneMode: 'allHolds',
      holdsFilter: { 10: { HAND: 'include' }, 20: { FOOT: 'include' } },
      onZoneFilterChange,
    });

    act(() => {
      vi.advanceTimersByTime(120);
    });
    fireEvent.click(container.querySelector('[data-zone-commit="true"]') as HTMLButtonElement);

    expect(onZoneFilterChange).toHaveBeenCalledWith({
      zoneBox: zoneState.committedZone,
      zoneMode: 'allHolds',
      holdsFilter: zoneState.prunedFilter,
    });
  });
});
