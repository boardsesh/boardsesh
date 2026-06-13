// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// The preview hook is mocked; the test mutates `preview.result.items` /
// `refreshingUuids` and rerenders to drive the view's row props.
const preview = vi.hoisted(() => ({
  result: {
    items: [] as unknown[],
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    refreshingUuids: new Set<string>(),
    plannedCount: 0,
    plannedSlots: [],
    regenerate: vi.fn(),
    refreshSlot: vi.fn(),
    toQueueItems: () => [] as ClimbQueueItem[],
  },
}));

// Captures every WorkoutPreviewRow render so the test can read isActive /
// refreshDisabled per row, plus the latest onPress to simulate a tap.
const rows = vi.hoisted(() => ({
  rendered: [] as Array<{ uuid: string; isActive: boolean; isRefreshing: boolean; refreshDisabled: boolean }>,
  onPress: null as ((item: ClimbQueueItem) => void) | null,
}));

const list = vi.hoisted(() => ({
  props: [] as Array<{
    nestedScrollEnabled?: boolean;
    keyboardShouldPersistTaps?: unknown;
    dataLength: number;
    hasGestureScrollComponent: boolean;
    hasHeaderComponent: boolean;
    paddingBottom?: unknown;
  }>,
}));

// Captures the props PreSessionView passes to the (mocked) Start FAB, so the test
// can fire onHeightChange and verify the list reservation tracks it + the offset.
const fab = vi.hoisted(() => ({
  onHeightChange: null as ((height: number) => void) | null,
  bottomOffset: null as number | null,
}));

const bottomChrome = vi.hoisted(() => ({
  metrics: {
    insideTabs: true,
    scrollBottomPadding: 200,
    tabBarBottom: 120,
    tabBarHeight: 49,
    fixedFooterBottom: 120,
  },
}));

const headerOrder = vi.hoisted(() => ({ rendered: [] as string[] }));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 100, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => ({ value }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    renderScrollComponent,
    ListHeaderComponent,
    nestedScrollEnabled,
    keyboardShouldPersistTaps,
    contentContainerStyle,
  }: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    renderScrollComponent?: unknown;
    ListHeaderComponent?: ReactNode;
    nestedScrollEnabled?: boolean;
    keyboardShouldPersistTaps?: unknown;
    contentContainerStyle?: { paddingBottom?: unknown };
  }) => {
    list.props.push({
      nestedScrollEnabled,
      keyboardShouldPersistTaps,
      dataLength: data?.length ?? 0,
      hasGestureScrollComponent: renderScrollComponent != null,
      hasHeaderComponent: ListHeaderComponent != null,
      paddingBottom: contentContainerStyle?.paddingBottom,
    });
    return createElement(
      'div',
      null,
      ListHeaderComponent,
      ...(data ?? []).map((rowItem, index) =>
        createElement('div', { key: index }, renderItem?.({ item: rowItem, index })),
      ),
    );
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({ toBoardName: (boardType: string) => boardType }));
vi.mock('../../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../Button', () => ({ Button: () => createElement('button') }));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../../SectionHeader', () => ({ SectionHeader: () => null }));
vi.mock('../../RecordTopChrome', () => ({ RecordTopChrome: () => null }));
vi.mock('../../SessionStartFab', () => ({
  SESSION_START_FAB_HEIGHT: 60,
  SessionStartFab: ({
    onHeightChange,
    bottomOffset,
  }: {
    onHeightChange?: (height: number) => void;
    bottomOffset?: number;
  }) => {
    fab.onHeightChange = onHeightChange ?? null;
    fab.bottomOffset = bottomOffset ?? null;
    return createElement('div', { 'data-testid': 'pre-session-footer' });
  },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } }),
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../providers/queue-provider', () => ({
  useQueueActions: () => ({ startSession: vi.fn(), setQueue: vi.fn() }),
}));
vi.mock('../../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer: vi.fn() }) }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => bottomChrome.metrics,
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 }, borderRadius: { lg: 16 } }));
vi.mock('../../in-session/RepTimerSettingsCard', () => ({
  RepTimerSettingsCard: () => {
    headerOrder.rendered.push('rep-timer');
    return createElement('div', { 'data-testid': 'rep-timer-settings-card' });
  },
}));
vi.mock('../BoardSummaryCard', () => ({
  BoardSummaryCard: () => {
    headerOrder.rendered.push('board');
    return createElement('div', { 'data-testid': 'board-summary-card' });
  },
}));
vi.mock('../GeneratorPickerCard', () => ({
  GeneratorPickerCard: () => {
    headerOrder.rendered.push('generator');
    return createElement('div', { 'data-testid': 'generator-picker-card' });
  },
}));
vi.mock('../use-workout-preview', () => ({ useWorkoutPreview: () => preview.result }));
vi.mock('../WorkoutPreviewRow', () => ({
  WorkoutPreviewRow: ({
    item,
    isActive,
    isRefreshing,
    refreshDisabled,
    onPress,
  }: {
    item: ClimbQueueItem;
    isActive: boolean;
    isRefreshing: boolean;
    refreshDisabled: boolean;
    onPress: (item: ClimbQueueItem) => void;
  }) => {
    rows.rendered.push({ uuid: item.uuid, isActive, isRefreshing, refreshDisabled });
    rows.onPress = onPress;
    return null;
  },
}));

import { PreSessionView } from '../PreSessionView';

function makeRow(uuid: string) {
  return {
    item: { uuid, climb: { uuid: `${uuid}-climb`, name: uuid } },
    slot: { grade: 10, section: 'main', index: 0 },
  };
}

beforeEach(() => {
  rows.rendered = [];
  rows.onPress = null;
  list.props = [];
  bottomChrome.metrics = {
    insideTabs: true,
    scrollBottomPadding: 200,
    tabBarBottom: 120,
    tabBarHeight: 49,
    fixedFooterBottom: 120,
  };
  preview.result.items = [makeRow('a'), makeRow('b')] as unknown[];
  preview.result.refreshingUuids = new Set<string>();
  fab.onHeightChange = null;
  fab.bottomOffset = null;
  headerOrder.rendered = [];
});

describe('PreSessionView preview rows', () => {
  it('clears the active highlight once a regeneration replaces the rows', () => {
    const view = render(createElement(PreSessionView));

    // Tap row "a" → it becomes the highlighted preview row.
    act(() => {
      rows.onPress?.({ uuid: 'a' } as ClimbQueueItem);
    });
    expect(rows.rendered.some((row) => row.uuid === 'a' && row.isActive)).toBe(true);

    // Regenerate: fresh uuids replace the old rows, so "a" no longer exists.
    rows.rendered = [];
    preview.result.items = [makeRow('c'), makeRow('d')] as unknown[];
    act(() => {
      view.rerender(createElement(PreSessionView));
    });

    // The effect dropped the stale uuid, so nothing is highlighted.
    expect(rows.rendered.length).toBeGreaterThan(0);
    expect(rows.rendered.every((row) => !row.isActive)).toBe(true);
  });

  it('blocks the other rows refresh button while one row regenerates', () => {
    preview.result.refreshingUuids = new Set<string>(['a']);
    render(createElement(PreSessionView));

    const rowA = rows.rendered.find((row) => row.uuid === 'a');
    const rowB = rows.rendered.find((row) => row.uuid === 'b');
    // The regenerating row spins (isRefreshing) rather than going to the dimmed
    // disabled state, so refreshDisabled stays false for it.
    expect(rowA).toMatchObject({ isRefreshing: true, refreshDisabled: false });
    // Every other row's refresh is disabled so the dropped tap is visible.
    expect(rowB).toMatchObject({ isRefreshing: false, refreshDisabled: true });
  });

  it('keeps the preview rows virtualized in a nested FlashList', () => {
    render(createElement(PreSessionView));

    expect(list.props.at(-1)).toMatchObject({
      nestedScrollEnabled: true,
      keyboardShouldPersistTaps: 'handled',
      dataLength: 2,
      hasGestureScrollComponent: true,
      hasHeaderComponent: true,
    });
    expect(rows.rendered.map((row) => row.uuid)).toEqual(['a', 'b']);
  });

  it('keeps the generator controls in the list header when the preview is empty', () => {
    preview.result.items = [];

    render(createElement(PreSessionView));

    expect(list.props.at(-1)).toMatchObject({ dataLength: 0, hasHeaderComponent: true });
    expect(rows.rendered).toEqual([]);
  });

  it('shows rep timer settings after the board card and before the workout generator', () => {
    const { getByTestId } = render(createElement(PreSessionView));

    expect(getByTestId('board-summary-card')).not.toBeNull();
    expect(getByTestId('rep-timer-settings-card')).not.toBeNull();
    expect(getByTestId('generator-picker-card')).not.toBeNull();
    expect(headerOrder.rendered.slice(0, 3)).toEqual(['board', 'rep-timer', 'generator']);
  });

  it('reserves the Start FAB height + bottom offset as the list bottom padding', () => {
    render(createElement(PreSessionView));

    // The FAB receives the same offset the list reserves (single source — no drift).
    // Liquid Glass anchors to the safe-area inset (100 here).
    expect(fab.bottomOffset).toBe(100);

    // When the FAB measures itself, the list's bottom padding tracks height + offset.
    act(() => {
      fab.onHeightChange?.(50);
    });
    expect(list.props.at(-1)?.paddingBottom).toBe(150);
  });
});
