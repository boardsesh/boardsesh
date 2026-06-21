// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldFilterType, HoldsFilter } from '@boardsesh/shared-schema';

// Captured cleanup from the screen's useFocusEffect, so a test can simulate the
// screen losing focus (Done / swipe-back) and assert the handoff fires.
const focus = vi.hoisted(() => ({ cleanup: null as null | (() => void) }));

// The hold the board stub paints. The stubbed InteractiveFilterBoard exposes a
// button that taps this fixed hold id, so a test can paint the active brush onto
// it deterministically.
const TAPPED_HOLD_ID = 42;

const trackMock = vi.hoisted(() => vi.fn());
const emitMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    boardName: 'kilter',
    layoutId: '1',
    sizeId: '10',
    setIds: '1,2',
    holdsFilter: undefined,
  }),
  useRouter: () => ({ back: vi.fn() }),
  // Run the effect immediately and stash its cleanup so the test can fire it.
  useFocusEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    focus.cleanup = typeof cleanup === 'function' ? cleanup : null;
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@boardsesh/analytics', () => ({
  SHARED_EVENTS: {
    SearchHoldFilterChanged: 'Search Hold Filter Changed',
    SearchHoldFilterCleared: 'Search Hold Filter Cleared',
  },
}));

vi.mock('@boardsesh/board-constants/product-sizes', () => ({
  getLayout: () => ({ name: 'Kilter Board Original' }),
}));

// Pure filter helpers: keep the real toggle/parse behaviour but mock the module
// so the test doesn't depend on the package resolving in the node env.
vi.mock('@boardsesh/climb-filters', () => ({
  parseHoldsFilter: (raw: string | undefined): HoldsFilter => (raw ? (JSON.parse(raw) as HoldsFilter) : {}),
  countFilteredHolds: (filter: HoldsFilter) => Object.keys(filter).length,
  toggleHoldFilterType: (entry: Record<string, string>, type: HoldFilterType, mode: string) => {
    const next = { ...entry };
    if (next[type]) delete next[type];
    else next[type] = mode;
    return next;
  },
}));

vi.mock('../../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../../src/lib/hold-filter-handoff', () => ({ emitHoldsFilterSelection: emitMock }));

vi.mock('../../../../src/lib/create-board-holds', () => ({
  getCreateBoardHolds: () => ({
    holdTargets: [{ id: TAPPED_HOLD_ID, cx: 100, cy: 100, r: 10 }],
    boardWidth: 1000,
    boardHeight: 1000,
  }),
  parseSetIdsParam: (setIds: string) => setIds.split(',').map(Number),
}));

vi.mock('../../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', secondaryLabel: '#666' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
  }) => createElement('button', { onClick: onPress, 'data-role': accessibilityRole }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

// The board stub surfaces a single button that routes a fixed hold id to
// onHoldTap, opening the picker for that hold.
vi.mock('../../../../src/components/search/InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: ({ onHoldTap }: { onHoldTap: (id: number) => void }) =>
    createElement('button', { 'data-board-tap': 'true', onClick: () => onHoldTap(TAPPED_HOLD_ID) }, 'board'),
}));

// The picker stub exposes a button that selects the STARTING brush, so a test
// can set the active brush before painting a hold via the board stub.
vi.mock('../../../../src/components/search/HoldFilterPicker', () => ({
  HoldFilterPicker: ({ onSelectType }: { onSelectType: (type: HoldFilterType) => void }) =>
    createElement(
      'button',
      { 'data-select-start': 'true', onClick: () => onSelectType('STARTING' as HoldFilterType) },
      'select start',
    ),
}));

import HoldFilterScreen from '../holds';

beforeEach(() => {
  trackMock.mockClear();
  emitMock.mockClear();
  focus.cleanup = null;
});

describe('HoldFilterScreen', () => {
  it('emits a hold-filter-changed analytics event with the layout name when a hold is painted', () => {
    const { getByText } = render(<HoldFilterScreen />);

    // Pick the STARTING brush, then tap a hold to paint it.
    fireEvent.click(getByText('select start'));
    fireEvent.click(getByText('board'));

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('Search Hold Filter Changed', {
      type: 'STARTING',
      mode: 'include',
      boardLayout: 'Kilter Board Original',
    });
  });

  it('hands the current filter back when the screen loses focus', () => {
    const { getByText } = render(<HoldFilterScreen />);

    // Pick a brush and paint a hold so the handoff carries a non-empty value.
    fireEvent.click(getByText('select start'));
    fireEvent.click(getByText('board'));

    // Simulate the focus-effect cleanup (Done pops / swipe-back).
    expect(focus.cleanup).toBeTypeOf('function');
    focus.cleanup?.();

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith({ [String(TAPPED_HOLD_ID)]: { STARTING: 'include' } });
  });
});
