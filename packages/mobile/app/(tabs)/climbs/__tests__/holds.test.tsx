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
// Captures navigation.setOptions calls so tests can assert the headerRight
// "Clear all" shows only while there's something to clear.
const navMock = vi.hoisted(() => ({ setOptions: vi.fn() }));
// Router spy for the unsupported-board bail-out, plus mutable route params so a
// test can seed a board the hold search can't answer for.
const routerMock = vi.hoisted(() => ({ canGoBack: vi.fn(() => false), back: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({
  current: { boardName: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,2' } as Record<string, string | undefined>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => routeParams.current,
  useRouter: () => routerMock,
  // The screen drives the native header (title + headerRight) through setOptions.
  useNavigation: () => navMock,
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
vi.mock('../../../../src/lib/haptics', () => ({ hapticMedium: vi.fn() }));
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

vi.mock('../../../../src/components/HeaderActionButtons', () => ({
  HeaderTrailingButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, label),
}));
vi.mock('../../../../src/components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));

// The board stub surfaces a single button that routes a fixed hold id to
// onHoldTap, opening the picker for that hold.
const boardProps = vi.hoisted(() => ({ underOverlay: undefined as unknown }));
vi.mock('../../../../src/components/search/InteractiveFilterBoard', () => ({
  InteractiveFilterBoard: ({
    onHoldTap,
    underOverlay,
  }: {
    onHoldTap: (id: number) => void;
    underOverlay?: unknown;
  }) => {
    boardProps.underOverlay = underOverlay;
    return createElement('button', { 'data-board-tap': 'true', onClick: () => onHoldTap(TAPPED_HOLD_ID) }, 'board');
  },
}));

// The picker stub exposes a button that selects the STARTING brush, so a test
// can set the active brush before painting a hold via the board stub, and
// renders the mode-row accessory (the heatmap flame).
vi.mock('../../../../src/components/search/HoldFilterPicker', () => ({
  HoldFilterPicker: ({
    onSelectType,
    modeRowAccessory,
  }: {
    onSelectType: (type: HoldFilterType) => void;
    modeRowAccessory?: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      createElement(
        'button',
        { 'data-select-start': 'true', onClick: () => onSelectType('STARTING' as HoldFilterType) },
        'select start',
      ),
      modeRowAccessory,
    ),
}));

// The heatmap: the hook reads the offline database and the network, so it is
// stubbed to record what the screen hands it.
const heatmapMock = vi.hoisted(() => ({
  enabled: false,
  toggle: vi.fn(),
  calls: [] as Array<{ board: Record<string, unknown>; draft: unknown }>,
}));
const HEAT_OVERLAY = 'heat-overlay';
vi.mock('../../../../src/components/search/heatmap/use-hold-filter-heatmap', () => ({
  useHoldFilterHeatmap: (board: Record<string, unknown>, draft: unknown) => {
    heatmapMock.calls.push({ board, draft });
    return {
      enabled: heatmapMock.enabled,
      toggle: heatmapMock.toggle,
      mode: 'climbs',
      isBusy: false,
      overlay: heatmapMock.enabled ? HEAT_OVERLAY : null,
    };
  },
}));
vi.mock('../../../../src/components/search/heatmap/HoldFilterHeatmapPanel', () => ({
  HoldFilterHeatmapPanel: () => null,
}));
vi.mock('../../../../src/components/search/heatmap/heatmap-search-input', () => ({
  parseHeatmapSearch: (raw: string | undefined) => (raw ? JSON.parse(raw) : null),
}));
vi.mock('../../../../src/components/drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: ({
    iconName,
    onPress,
    accessibilityLabel,
  }: {
    iconName: string;
    onPress: () => void;
    accessibilityLabel: string;
  }) => createElement('button', { 'data-action': iconName, onClick: onPress }, accessibilityLabel),
}));
const authMock = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../../../src/providers/auth-provider', () => ({ useAuth: () => authMock }));
vi.mock('../../../../src/lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: null }) }));

import HoldFilterScreen from '../holds';

beforeEach(() => {
  trackMock.mockClear();
  emitMock.mockClear();
  navMock.setOptions.mockClear();
  routerMock.canGoBack.mockClear();
  routerMock.canGoBack.mockReturnValue(false);
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  routeParams.current = { boardName: 'kilter', layoutId: '1', sizeId: '10', setIds: '1,2' };
  focus.cleanup = null;
  heatmapMock.enabled = false;
  heatmapMock.toggle.mockClear();
  heatmapMock.calls = [];
  authMock.isAuthenticated = true;
  boardProps.underOverlay = undefined;
});

// The headerRight the screen last handed the native header via setOptions.
function lastHeaderRight(): unknown {
  const lastOptions = navMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
  return lastOptions?.headerRight;
}

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

  it('shows the headerRight Clear all only while a hold is filtered', () => {
    const { getByText } = render(<HoldFilterScreen />);

    // Nothing to clear yet → no headerRight.
    expect(lastHeaderRight()).toBeUndefined();

    // Paint a hold → the Clear all headerRight appears.
    fireEvent.click(getByText('select start'));
    fireEvent.click(getByText('board'));
    expect(lastHeaderRight()).toBeTypeOf('function');
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

  // Woods hold ids match `board_climb_holds.hold_id` and the `p<id>r` frames token
  // directly — no placement bridge — so this route paints for it like any other
  // board (boardsesh/boardsesh#4748).
  it('paints the board for a code-driven board instead of leaving the route', () => {
    routeParams.current = { boardName: 'woods', layoutId: '1', sizeId: '1', setIds: '1' };

    const { container } = render(<HoldFilterScreen />);

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('offers the heatmap flame to a signed-in climber and toggles it', () => {
    const { getByText } = render(<HoldFilterScreen />);

    fireEvent.click(getByText('mobile.heatmap.toggle'));
    expect(heatmapMock.toggle).toHaveBeenCalledTimes(1);
  });

  it('shows no flame to a signed-out climber', () => {
    authMock.isAuthenticated = false;
    const { queryByText } = render(<HoldFilterScreen />);

    expect(queryByText('mobile.heatmap.toggle')).toBeNull();
  });

  it('counts the filter sheet draft at the board angle, and draws the heat under the rings', () => {
    const draft = { filters: { minGrade: 16 }, boardFilters: {}, searchText: 'crimp' };
    routeParams.current = { ...routeParams.current, angle: '40', heatmapSearch: JSON.stringify(draft) };
    heatmapMock.enabled = true;

    render(<HoldFilterScreen />);

    const lastCall = heatmapMock.calls.at(-1);
    expect(lastCall?.board).toMatchObject({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 });
    expect(lastCall?.draft).toEqual(draft);
    expect(boardProps.underOverlay).toBe(HEAT_OVERLAY);
  });
});
