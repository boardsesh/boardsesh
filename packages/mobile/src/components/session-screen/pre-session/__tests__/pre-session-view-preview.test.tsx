// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { DEFAULT_VOLUME_OPTIONS } from '@boardsesh/playlist-generator';
import type { GeneratorSelection } from '../GeneratorPickerCard';
import { singleBlockSelection } from '../workout-blocks';

// The preview hook is mocked; the test mutates `preview.result.items` /
// `refreshingUuids` and rerenders to drive the view's row props.
const header = vi.hoisted(() => ({ native: false, inBodyLargeTitle: false }));
vi.mock('../../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => header.native }));

const preview = vi.hoisted(() => ({
  result: {
    items: [] as unknown[],
    status: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    refreshingUuids: new Set<string>(),
    plannedCount: 0,
    plannedSlots: [] as unknown[],
    plannedStages: [] as unknown[],
    regenerate: vi.fn(),
    shuffle: vi.fn(),
    refreshSlot: vi.fn(),
    toStagedQueueItems: () => ({ items: [] as ClimbQueueItem[], run: null }),
  },
}));

// Captures every WorkoutPreviewRow render so the test can read isActive /
// refreshDisabled per row, plus the latest onPress to simulate a tap.
const rows = vi.hoisted(() => ({
  rendered: [] as Array<{ uuid: string; isActive: boolean; isRefreshing: boolean; refreshDisabled: boolean }>,
  onPress: null as ((item: ClimbQueueItem) => void) | null,
}));

// The latest props PreSessionView handed the summary line (count, shortfall, Shuffle).
const summaryLine = vi.hoisted(() => ({
  props: null as null | {
    summary: { planned: number; filled: number; missing: number; sections: unknown[] };
    onShuffle: () => void;
    shuffleDisabled: boolean;
  },
}));

// Surfaces GeneratorPickerCard's onChange so a test can turn the generator on.
const picker = vi.hoisted(() => ({ onChange: null as ((selection: GeneratorSelection) => void) | null }));

// Every section heading row the list rendered, in order.
const headings = vi.hoisted(() => ({ rendered: [] as Array<{ section: string; count: number }> }));
// Every stage heading row, in order, interleaved into `headings.order` with the section ones.
const stageHeadings = vi.hoisted(() => ({ rendered: [] as Array<{ stageKind: string; count: number }> }));
const headingOrder = vi.hoisted(() => ({ labels: [] as string[] }));

const list = vi.hoisted(() => ({
  props: [] as Array<{
    nestedScrollEnabled?: boolean;
    keyboardShouldPersistTaps?: unknown;
    dataLength: number;
    hasGestureScrollComponent: boolean;
    hasHeaderComponent: boolean;
    paddingBottom?: unknown;
    contentInsetAdjustmentBehavior?: string;
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
    // Liquid Glass anchors to the raw safe-area inset (100); the Material-vs-glass
    // arbitration lives in computeBottomChromeMetrics. PreSessionView wires this field.
    preSessionFooterBottom: 100,
  },
}));

vi.mock('../../RestTimerArmRow', () => ({ RestTimerArmRow: () => null }));
vi.mock('../../../../lib/rest-timer-effective', () => ({ armRestTimerForWorkout: () => false }));
vi.mock('../../SessionVisibilityRow', () => ({ SessionVisibilityRow: () => null }));
vi.mock('react-native', () => ({
  // This suite exercises the JS chrome fallback; native headers have their own navigation tests.
  Platform: { OS: 'android' },
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
    contentInsetAdjustmentBehavior,
  }: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactNode;
    renderScrollComponent?: unknown;
    ListHeaderComponent?: ReactNode;
    nestedScrollEnabled?: boolean;
    keyboardShouldPersistTaps?: unknown;
    contentContainerStyle?: { paddingBottom?: unknown };
    contentInsetAdjustmentBehavior?: string;
  }) => {
    list.props.push({
      nestedScrollEnabled,
      keyboardShouldPersistTaps,
      dataLength: data?.length ?? 0,
      hasGestureScrollComponent: renderScrollComponent != null,
      hasHeaderComponent: ListHeaderComponent != null,
      paddingBottom: contentContainerStyle?.paddingBottom,
      contentInsetAdjustmentBehavior,
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
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {},
    features: { inBodyLargeTitle: header.inBodyLargeTitle, filtersInTopChrome: false },
  }),
}));
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
vi.mock('../../../boards/BoardSummaryCard', () => ({ BoardSummaryCard: () => null }));
vi.mock('../GeneratorPickerCard', () => ({
  GeneratorPickerCard: ({ onChange }: { onChange: (selection: GeneratorSelection) => void }) => {
    picker.onChange = onChange;
    return null;
  },
}));
vi.mock('../use-workout-preview', () => ({ useWorkoutPreview: () => preview.result }));
vi.mock('../WorkoutPreviewSummary', () => ({
  WorkoutPreviewSummary: (props: NonNullable<typeof summaryLine.props>) => {
    summaryLine.props = props;
    return null;
  },
}));
vi.mock('../WorkoutPreviewSectionHeading', () => ({
  WorkoutPreviewSectionHeading: ({ section, count }: { section: string; count: number }) => {
    headings.rendered.push({ section, count });
    headingOrder.labels.push(`${section}:${count}`);
    return null;
  },
}));
vi.mock('../WorkoutPreviewStageHeading', () => ({
  WorkoutPreviewStageHeading: ({ stageKind, count }: { stageKind: string; count: number }) => {
    stageHeadings.rendered.push({ stageKind, count });
    headingOrder.labels.push(`STAGE ${stageKind}:${count}`);
    return null;
  },
}));
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

// The onboarding tip banner renders the real Icon (and @expo/vector-icons), and
// its storage hooks reach SecureStore — both irrelevant to these logic tests, so
// stub them like the other child components.
vi.mock('../../../onboarding/OnboardingTipBanner', () => ({ OnboardingTipBanner: () => null }));
vi.mock('../../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: vi.fn(async () => true),
  markTipSeen: vi.fn(async () => {}),
}));

import { PreSessionView } from '../PreSessionView';

/** Render the view with a volume workout selected, so the preview section shows. */
function renderWithWorkout() {
  const view = render(createElement(PreSessionView));
  act(() => {
    picker.onChange?.(singleBlockSelection({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 10 }, 'block-volume'));
  });
  return view;
}

function makeRow(uuid: string, section = 'main', index = 0, stageId?: string) {
  return {
    item: { uuid, climb: { uuid: `${uuid}-climb`, name: uuid } },
    slot: { grade: 10, section, index, ...(stageId === undefined ? {} : { stageId }) },
  };
}

beforeEach(() => {
  header.native = false;
  header.inBodyLargeTitle = false;
  rows.rendered = [];
  rows.onPress = null;
  list.props = [];
  summaryLine.props = null;
  headings.rendered = [];
  stageHeadings.rendered = [];
  headingOrder.labels = [];
  preview.result.plannedStages = [];
  bottomChrome.metrics = {
    insideTabs: true,
    scrollBottomPadding: 200,
    tabBarBottom: 120,
    tabBarHeight: 49,
    fixedFooterBottom: 120,
    preSessionFooterBottom: 100,
  };
  preview.result.items = [makeRow('a'), makeRow('b')] as unknown[];
  preview.result.plannedSlots = (preview.result.items as Array<ReturnType<typeof makeRow>>).map((row) => row.slot);
  preview.result.status = 'ready';
  preview.result.refreshingUuids = new Set<string>();
  fab.onHeightChange = null;
  fab.bottomOffset = null;
});

describe('PreSessionView preview rows', () => {
  it.each([
    [true, true, true, false],
    [true, false, true, true],
    [true, false, false, false],
    [false, false, true, false],
  ] as const)(
    'shows one body title only for floating glass tabs (chrome %s, native %s, large title %s)',
    (showChrome, native, inBodyLargeTitle, hasBodyTitle) => {
      header.native = native;
      header.inBodyLargeTitle = inBodyLargeTitle;
      const { queryAllByText } = render(createElement(PreSessionView, { showChrome }));
      expect(queryAllByText('mobile.session.headerStart')).toHaveLength(hasBodyTitle ? 1 : 0);
      expect(list.props.at(-1)?.contentInsetAdjustmentBehavior).toBe(showChrome && native ? 'automatic' : 'never');
    },
  );

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

  it('heads each section of a multi-section plan, in workout order', () => {
    preview.result.items = [
      makeRow('w1', 'warmUp', 0),
      makeRow('w2', 'warmUp', 1),
      makeRow('m1', 'main', 2),
    ] as unknown[];

    render(createElement(PreSessionView));

    expect(list.props.at(-1)?.dataLength).toBe(5);
    expect(headings.rendered).toEqual([
      { section: 'warmUp', count: 2 },
      { section: 'main', count: 1 },
    ]);
    expect(rows.rendered.map((row) => row.uuid)).toEqual(['w1', 'w2', 'm1']);
  });

  it('heads each block of a multi-block workout above its own sections', () => {
    preview.result.items = [
      makeRow('w1', 'warmUp', 0, 'warm'),
      makeRow('u1', 'increasing', 1, 'pyramid'),
      makeRow('p1', 'peak', 2, 'pyramid'),
      makeRow('v1', 'main', 3, 'volume'),
      makeRow('v2', 'main', 4, 'volume'),
    ] as unknown[];
    preview.result.plannedSlots = (preview.result.items as Array<ReturnType<typeof makeRow>>).map((row) => row.slot);
    preview.result.plannedStages = [
      { id: 'warm', kind: 'warmUp', warmUpType: 'standard' },
      { id: 'pyramid', kind: 'pyramid', options: { ...DEFAULT_VOLUME_OPTIONS, type: 'pyramid' } },
      { id: 'volume', kind: 'volume', options: DEFAULT_VOLUME_OPTIONS },
    ];

    render(createElement(PreSessionView));

    expect(headingOrder.labels).toEqual([
      'STAGE warmUp:1',
      'STAGE pyramid:2',
      'increasing:1',
      'peak:1',
      'STAGE volume:2',
    ]);
    expect(rows.rendered.map((row) => row.uuid)).toEqual(['w1', 'u1', 'p1', 'v1', 'v2']);

    // The summary line counts every block's climbs.
    act(() => {
      picker.onChange?.(singleBlockSelection({ ...DEFAULT_VOLUME_OPTIONS, targetGrade: 10 }, 'block-volume'));
    });
    expect(summaryLine.props?.summary).toMatchObject({ planned: 5, filled: 5, missing: 0 });
  });

  it('tells the summary how many planned climbs the preview could not fill', () => {
    preview.result.plannedSlots = [
      { grade: 10, section: 'main', index: 0 },
      { grade: 10, section: 'main', index: 1 },
      { grade: 11, section: 'main', index: 2 },
    ];

    renderWithWorkout();

    expect(summaryLine.props?.summary).toMatchObject({ planned: 3, filled: 2, missing: 1 });
  });

  it('wires Shuffle to the preview and blocks it while a row regenerates', () => {
    const view = renderWithWorkout();
    expect(summaryLine.props?.onShuffle).toBe(preview.result.shuffle);
    expect(summaryLine.props?.shuffleDisabled).toBe(false);

    preview.result.refreshingUuids = new Set<string>(['a']);
    act(() => {
      view.rerender(createElement(PreSessionView));
    });
    expect(summaryLine.props?.shuffleDisabled).toBe(true);
  });

  it('hides the summary line while the preview is empty', () => {
    preview.result.items = [];

    renderWithWorkout();

    expect(summaryLine.props).toBeNull();
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

// This suite exercises the existing flow before the server privacy rollout.
vi.mock('../../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: undefined }) }));
vi.mock('../../../privacy/PublicationAudiencePicker', () => ({
  PublicationAudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../../privacy/ContentAudienceControl', () => ({
  ContentAudienceControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../../privacy/ResourcePrivacyControl', () => ({
  ResourcePrivacyControl: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../../privacy/AudiencePicker', () => ({
  AudiencePicker: () => null,
  SESSION_AUDIENCES: ['public', 'followers', 'invite_only'],
}));
vi.mock('../../../privacy/use-publication-audience', () => ({
  usePublicationAudience: () => ({
    enabled: false,
    isPrivate: false,
    audience: 'public',
    publication: undefined,
    chooseAudience: () => {},
  }),
}));
