// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, createRef, forwardRef, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { BoardPresenceClimb, BoardPresenceStats, Climb } from '@boardsesh/shared-schema';

const presence = vi.hoisted(() => ({
  currentClimb: null as BoardPresenceClimb | null,
  history: [] as BoardPresenceClimb[],
  stats: null as BoardPresenceStats | null,
  refresh: vi.fn(),
}));

const historyPagination = vi.hoisted(() => ({
  olderHistory: [] as BoardPresenceClimb[],
  isLoadingOlder: false,
  hasMore: true,
  loadOlder: vi.fn(),
  // The onPageLoaded callback BoardSheetContent passes to the (mocked) hook,
  // captured so tests can fire it and assert the analytics wiring.
  capturedOnPageLoaded: null as ((info: { pageSize: number; returnedCount: number }) => void) | null,
}));

const presenceControls = vi.hoisted(() => ({
  boardId: 123 as number | null,
}));

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
}));

const graphql = vi.hoisted(() => ({
  request: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

const sheetModal = vi.hoisted(() => ({
  present: vi.fn(),
  dismiss: vi.fn(),
  // The BottomSheetModal's `onChange` prop, captured so tests can fire native
  // index changes (index >= 0 = the sheet actually came up).
  onChange: null as ((index: number) => void) | null,
}));
const managedSheet = vi.hoisted(() => ({
  // When true, `handle.dismiss` does NOT fire onFullyDismissed synchronously —
  // simulating the coordinator's dismiss settle window (up to 550ms). The test
  // then fires `lastOnFullyDismissed` itself to settle the dismiss late.
  deferSettle: false,
  lastOnFullyDismissed: null as (() => void) | null,
  dismissAndWait: vi.fn(async () => ({ status: 'dismissed' as const })),
}));
const climbRows = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const thumbnails = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
// Mutable safe-area inset so a test can simulate an Android 3-button nav bar
// (a non-zero bottom inset) and assert it reaches the switch-board footer.
const safeArea = vi.hoisted(() => ({ bottom: 0 }));

type ViewMockProps = { children?: ReactNode; style?: unknown };
type ClimbListRowMockProps = {
  climb?: { uuid?: string; name?: string };
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  angle?: number;
  renderContent?: (args: {
    climb?: { uuid?: string; name?: string };
    boardName?: string;
    layoutId?: number;
    sizeId?: number;
    setIds?: string;
    angle?: number;
  }) => ReactNode;
  onPress?: (climb?: { uuid?: string; name?: string }) => void;
  onAddToQueue?: (climb?: { uuid?: string; name?: string }) => void;
  onOpenPlaylist?: (climb?: { uuid?: string; name?: string }) => void;
  onOpenActions?: (climb?: { uuid?: string; name?: string }) => void;
  [key: string]: unknown;
};
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    style,
  }: ViewMockProps & { onPress?: () => void; accessibilityLabel?: string }) => {
    // Surface the flattened paddingBottom so tests can assert the safe-area inset
    // reaches bottom-anchored controls (the switch-board footer). Recursive so a
    // nested style array (e.g. withSheetBottomInset output) flattens correctly.
    const flattenStyle = (input: unknown): Record<string, unknown> =>
      Array.isArray(input)
        ? Object.assign({}, ...input.map(flattenStyle))
        : input && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {};
    const flat = flattenStyle(style);
    return createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'data-padding-bottom': flat.paddingBottom },
      children,
    );
  },
  // Surface onRefresh as a clickable element so the pull-to-refresh wiring is testable.
  RefreshControl: ({ onRefresh }: { onRefresh?: () => void }) =>
    createElement('button', { onClick: onRefresh, 'aria-label': 'refresh' }),
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(
    ({ children, onChange }: { children?: ReactNode; onChange?: (index: number) => void }, ref: Ref<unknown>) => {
      sheetModal.onChange = onChange ?? null;
      useImperativeHandle(ref, () => ({ present: sheetModal.present, dismiss: sheetModal.dismiss }));
      return createElement('div', { 'data-sheet': 'true' }, children);
    },
  ),
  // Render the list inline so header + items + empty state appear in the DOM.
  // "begin scroll" / "reach end" buttons surface `onScrollBeginDrag` /
  // `onEndReached` for tests to trigger directly (real FlatList
  // scroll-position math isn't exercised under jsdom).
  BottomSheetFlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    keyExtractor,
    refreshControl,
    onEndReached,
    onScrollBeginDrag,
  }: {
    data: BoardPresenceClimb[];
    renderItem: (info: { item: BoardPresenceClimb }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    keyExtractor: (item: BoardPresenceClimb) => string;
    refreshControl?: ReactNode;
    onEndReached?: () => void;
    onScrollBeginDrag?: () => void;
  }) =>
    createElement(
      'div',
      { 'data-list': 'true' },
      refreshControl,
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
      ListFooterComponent,
      createElement('button', { 'aria-label': 'begin scroll', onClick: () => onScrollBeginDrag?.() }),
      createElement('button', { 'aria-label': 'reach list end', onClick: () => onEndReached?.() }),
    ),
}));

// Isolate from the real coordinator (covered by sheet-presentation-provider.test):
// route the handle straight to the mocked native ref and simulate an immediate
// settle on dismiss so onFullyDismissed-driven behaviour still fires. With
// `managedSheet.deferSettle` the settle is withheld (the coordinator's dismiss
// settle window) and the test fires `lastOnFullyDismissed` itself.
vi.mock('../../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: (opts: {
    sheetRef: { current: { present?: () => void; dismiss?: () => void } | null };
    onFullyDismissed?: () => void;
  }) => {
    managedSheet.lastOnFullyDismissed = () => opts.onFullyDismissed?.();
    return {
      onChange: () => {},
      onFullyDismissed: () => opts.onFullyDismissed?.(),
      handle: {
        present: () => opts.sheetRef.current?.present?.(),
        dismiss: () => {
          opts.sheetRef.current?.dismiss?.();
          if (!managedSheet.deferSettle) {
            opts.onFullyDismissed?.();
          }
        },
        dismissAndWait: managedSheet.dismissAndWait,
      },
    };
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: safeArea.bottom, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${Object.values(opts).join(',')}` : key),
  }),
}));

vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#999999',
}));

vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceCurrent: () => ({
    currentClimb: presence.currentClimb,
    previousClimb: null,
    undoTarget: null,
    isLive: true,
  }),
  useBoardPresenceFeed: () => ({ history: presence.history, stats: presence.stats }),
  useBoardPresenceActions: () => ({ refresh: presence.refresh }),
  useBoardHistoryPagination: (
    _pageSize?: number,
    onPageLoaded?: (info: { pageSize: number; returnedCount: number }) => void,
  ) => {
    historyPagination.capturedOnPageLoaded = onPageLoaded ?? null;
    return {
      olderHistory: historyPagination.olderHistory,
      isLoadingOlder: historyPagination.isLoadingOlder,
      hasMore: historyPagination.hasMore,
      loadOlder: historyPagination.loadOlder,
    };
  },
  boardHistoryEntryKey: (climb: BoardPresenceClimb) => `${climb.climbUuid}:${climb.seq}`,
}));

vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({
    enabled: true,
    boardId: presenceControls.boardId,
    resolveAndBindBoard: vi.fn(async () => null),
  }),
}));

vi.mock('../../../lib/analytics', () => ({
  track: analytics.track,
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => graphql,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Avatar', () => ({
  Avatar: ({ name }: { name?: string | null }) => createElement('span', { 'data-avatar': name ?? '' }),
}));
vi.mock('../../PressableAvatar', () => ({
  PressableAvatar: ({ name }: { name?: string | null }) => createElement('span', { 'data-avatar': name ?? '' }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
    createElement('span', { 'aria-label': accessibilityLabel, 'data-loading': 'true' }),
}));
vi.mock('../../ClimbListRow', () => ({
  ClimbListRow: (props: ClimbListRowMockProps) => {
    climbRows.props.push(props);
    const content = props.renderContent
      ? props.renderContent({
          climb: props.climb,
          boardName: props.boardName,
          layoutId: props.layoutId,
          sizeId: props.sizeId,
          setIds: props.setIds,
          angle: props.angle,
        })
      : props.climb?.name;
    const climbUuid = props.climb?.uuid ?? 'unknown';
    return createElement(
      'div',
      { 'data-climb-row': climbUuid },
      createElement(
        'button',
        { 'aria-label': `press ${climbUuid}`, onClick: () => props.onPress?.(props.climb) },
        content,
      ),
      createElement(
        'button',
        { 'aria-label': `queue ${climbUuid}`, onClick: () => props.onAddToQueue?.(props.climb) },
        'queue',
      ),
      createElement(
        'button',
        { 'aria-label': `playlist ${climbUuid}`, onClick: () => props.onOpenPlaylist?.(props.climb) },
        'playlist',
      ),
      createElement(
        'button',
        { 'aria-label': `actions ${climbUuid}`, onClick: () => props.onOpenActions?.(props.climb) },
        'actions',
      ),
    );
  },
}));
vi.mock('../../queue-control/AccessoryClimbThumbnail', () => ({
  AccessoryClimbThumbnail: (props: Record<string, unknown>) => {
    thumbnails.props.push(props);
    return createElement('div', { 'data-thumb': 'true', 'data-size': props.size ?? 40 });
  },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      secondaryBackground: '#f2f2f7',
      separator: '#ccc',
    },
    brandColors: { warning: '#B45309', primary: '#6D28D9' },
    sheet: { scrimOpacity: 0.3, handleStyle: {} },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: toast.showToast }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (grade: string) => grade }),
}));
vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}|${alpha}`,
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { md: 8, lg: 12 },
}));

import { BoardSheet, type BoardSheetHandle } from '../BoardSheet';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { GET_CLIMB } from '../../../lib/graphql/operations';

function makeClimb(climbUuid: string, seq: number, overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb {
  return {
    climbUuid,
    seq,
    sentAt: '2026-06-09T00:00:00.000Z',
    name: `Climb ${climbUuid}`,
    grade: 'V5',
    angle: 40,
    setter: 'Some Setter',
    sentByDisplayName: 'Marco',
    ...overrides,
  };
}

function makeFullClimb(uuid: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    name: `Hydrated ${uuid}`,
    frames: 'hydrated-frames',
    setter_username: 'Hydrated Setter',
    angle: 40,
    ascensionist_count: 12,
    difficulty: 'V6',
    quality_average: '3.5',
    stars: 4,
    difficulty_error: '0.4',
    benchmark_difficulty: null,
    framesCount: 3,
    framesPace: 700,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const noop = () => {};
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

describe('BoardSheet', () => {
  beforeEach(() => {
    presence.currentClimb = null;
    presence.history = [];
    presence.stats = null;
    presenceControls.boardId = 123;
    presence.refresh.mockClear();
    historyPagination.olderHistory = [];
    historyPagination.isLoadingOlder = false;
    historyPagination.hasMore = true;
    historyPagination.loadOlder.mockClear();
    historyPagination.capturedOnPageLoaded = null;
    analytics.track.mockClear();
    graphql.request.mockReset();
    toast.showToast.mockClear();
    sheetModal.present.mockClear();
    sheetModal.dismiss.mockClear();
    sheetModal.onChange = null;
    managedSheet.deferSettle = false;
    managedSheet.lastOnFullyDismissed = null;
    managedSheet.dismissAndWait.mockClear();
    climbRows.props = [];
    thumbnails.props = [];
    safeArea.bottom = 0;
  });

  it('presents and dismisses via the imperative ref', () => {
    const ref = createRef<BoardSheetHandle>();
    render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall • 45°',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    expect(sheetModal.present).not.toHaveBeenCalled();

    ref.current?.present();
    expect(sheetModal.present).toHaveBeenCalled();

    ref.current?.dismiss();
    expect(sheetModal.dismiss).toHaveBeenCalled();
  });

  it('forwards dismissAndWait through the imperative ref', async () => {
    const ref = createRef<BoardSheetHandle>();
    render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    if (!ref.current) throw new Error('board sheet handle did not mount');
    await expect(ref.current.dismissAndWait()).resolves.toEqual({ status: 'dismissed' });
    expect(managedSheet.dismissAndWait).toHaveBeenCalledTimes(1);
  });

  it('renders no presence content while dismissed — zero list/hero/chrome work', () => {
    presence.currentClimb = makeClimb('c1', 3);
    presence.history = [makeClimb('c1', 3)];
    presence.stats = {
      climbsSentCount: 14,
      distinctClimbersCount: 5,
      hardestGrade: 'V9',
      topGrade: 'V5',
      lastSentAt: null,
    };

    const { container, queryByLabelText, queryByText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    // The sheet container mounts, but the whole NowOnTheWallPanel (chrome + hero
    // + stats + list) is gated behind isPresented — a dismissed sheet renders
    // none of it and subscribes to none of the presence state.
    expect(container.querySelector('[data-sheet="true"]')).not.toBeNull();
    expect(queryByText('Garage Wall')).toBeNull();
    expect(container.querySelector('[data-list="true"]')).toBeNull();
    expect(queryByLabelText('refresh')).toBeNull();
    expect(container.textContent).not.toContain('Climb c1');
    expect(container.textContent).not.toContain('mobile.boardPresence.emptyTitle');
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, expect.anything());
  });

  it('mounts the presence content (history list) once presented', () => {
    presence.history = [makeClimb('c1', 3)];
    const ref = createRef<BoardSheetHandle>();
    const { container } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    expect(container.querySelector('[data-list="true"]')).toBeNull();

    act(() => ref.current?.present());

    expect(container.querySelector('[data-list="true"]')).not.toBeNull();
    expect(sheetModal.present).toHaveBeenCalled();
  });

  it('re-mounts content when the native sheet comes up after a dismiss settles mid-re-present (settle-window race)', () => {
    presence.history = [makeClimb('c1', 3)];
    // Withhold the dismiss settle, simulating the coordinator's settle window
    // (up to 550ms on iOS) between a dismiss and its onFullyDismissed.
    managedSheet.deferSettle = true;
    const ref = createRef<BoardSheetHandle>();
    const { container } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    // Open: content mounts.
    act(() => ref.current?.present());
    expect(container.querySelector('[data-list="true"]')).not.toBeNull();

    // User dismisses; the settle window opens. Content stays mounted
    // mid-animation (we never tear down before the settle).
    act(() => ref.current?.dismiss());
    expect(container.querySelector('[data-list="true"]')).not.toBeNull();

    // User re-taps the entry point BEFORE the dismiss settles: the coordinator
    // queues the present (its pump early-returns while the dismiss is in
    // flight), so nothing native happens yet.
    act(() => ref.current?.present());

    // The dismiss now settles — AFTER the re-present request — unmounting the
    // content. Without the onChange backstop this is where it would stay stuck.
    act(() => managedSheet.lastOnFullyDismissed?.());
    expect(container.querySelector('[data-list="true"]')).toBeNull();

    // The coordinator pumps and presents the native sheet: index >= 0 through
    // the native onChange re-mounts the content.
    act(() => sheetModal.onChange?.(0));
    expect(container.querySelector('[data-list="true"]')).not.toBeNull();
  });

  it('triggers a manual catch-up when the history list is pulled to refresh', () => {
    presence.history = [makeClimb('c1', 3)];
    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('refresh'));
    expect(presence.refresh).toHaveBeenCalledWith('manual');
  });

  it('tracks history views once per presentation, from the content mount effect', () => {
    presence.history = [makeClimb('c1', 3), makeClimb('c0', 2)];
    const ref = createRef<BoardSheetHandle>();
    render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    act(() => ref.current?.present());

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: 123,
      itemCount: 2,
    });
    expect(sheetModal.present).toHaveBeenCalled();
  });

  it('does not track history views on present when there is no history', () => {
    presence.history = [];
    const ref = createRef<BoardSheetHandle>();
    render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    act(() => ref.current?.present());

    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, expect.anything());
  });

  it('fires BoardHistoryViewed when history first arrives after presenting (late backfill), once per presentation', () => {
    // Presented before the initial backfill resolves: empty at mount.
    presence.history = [];
    const ref = createRef<BoardSheetHandle>();
    const sheetProps = {
      ref,
      boardLabel: 'Garage Wall',
      onClose: noop,
      boardConfig,
      onSwitchBoard: noop,
    };
    const view = render(createElement(BoardSheet, sheetProps));
    act(() => ref.current?.present());
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, expect.anything());

    // The backfill lands while the sheet is up.
    presence.history = [makeClimb('c1', 3), makeClimb('c0', 2)];
    view.rerender(createElement(BoardSheet, sheetProps));

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: 123,
      itemCount: 2,
    });

    // More history arriving in the SAME presentation does not re-fire.
    analytics.track.mockClear();
    presence.history = [makeClimb('c2', 4), makeClimb('c1', 3), makeClimb('c0', 2)];
    view.rerender(createElement(BoardSheet, sheetProps));
    expect(analytics.track).not.toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, expect.anything());
  });

  it('renders the empty state when no climb is on the wall', () => {
    const ref = createRef<BoardSheetHandle>();
    const { container } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());
    expect(container.textContent).toContain('mobile.boardPresence.emptyTitle');
  });

  it('renders the hero, stats and virtualized history when there is wall activity', () => {
    presence.currentClimb = makeClimb('c1', 3);
    presence.history = [makeClimb('c1', 3), makeClimb('c0', 2, { name: 'Older Climb' })];
    presence.stats = {
      climbsSentCount: 14,
      distinctClimbersCount: 5,
      hardestGrade: 'V9',
      hardestSend: {
        climbUuid: 'hard-c1',
        name: 'Hard Rig',
        grade: 'V9',
        sentByUserId: 'user-1',
        sentByDisplayName: 'Mina',
        sentByAvatarUrl: 'https://example.com/mina.jpg',
        sentAt: '2026-06-09T00:00:00.000Z',
      },
      topGrade: 'V5',
      lastSentAt: null,
    };

    const ref = createRef<BoardSheetHandle>();
    const { container } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());

    // The current climb renders as the hero only; it is filtered out of history.
    expect(container.textContent?.match(/Climb c1/g) ?? []).toHaveLength(1);
    expect(container.textContent).toContain('Older Climb');
    // Stats tiles.
    expect(container.textContent).toContain('14');
    expect(container.textContent).toContain('mobile.boardPresence.hardestSendLabel');
    expect(container.textContent).toContain('Hard Rig');
    expect(container.textContent).toContain('mobile.boardPresence.sentByLine:Mina');
    expect(container.querySelector('[data-avatar="Mina"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="crown"]')).not.toBeNull();
    expect(container.textContent).toContain('mobile.boardPresence.historyHeader');
    // History list rendered one node per item.
    expect(container.querySelector('[data-list="true"]')).not.toBeNull();
  });

  it('does not show a history header when the only history entry is the current climb', () => {
    presence.currentClimb = makeClimb('c1', 3);
    presence.history = [makeClimb('c1', 3)];

    const ref = createRef<BoardSheetHandle>();
    const { container } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());

    expect(container.textContent?.match(/Climb c1/g) ?? []).toHaveLength(1);
    expect(container.textContent).not.toContain('mobile.boardPresence.historyHeader');
  });

  it('hydrates hero and lit-on-this-wall rows before invoking shared climb actions', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, {
      frames: 'hero-frames',
      grade: 'V7',
      queueItemUuid: 'queue-hero',
    });
    presence.history = [
      makeClimb('old-climb', 2, {
        frames: 'old-frames',
        grade: 'V4',
        angle: 30,
        queueItemUuid: 'queue-old',
      }),
    ];
    const onClose = vi.fn();
    const onClimbPress = vi.fn();
    const onAddToQueue = vi.fn();
    const onOpenPlaylist = vi.fn();
    const onOpenActions = vi.fn();
    const heroDetail = makeFullClimb('hero-climb', {
      name: 'Hydrated Hero',
      frames: 'hydrated-hero-frames',
      difficulty: 'V8',
      benchmark_difficulty: 'V8',
    });
    const oldDetail = makeFullClimb('old-climb', {
      name: 'Hydrated Old',
      frames: 'hydrated-old-frames',
      angle: 30,
      difficulty: 'V5',
      framesCount: 2,
      framesPace: 900,
    });
    graphql.request.mockResolvedValueOnce({ climb: heroDetail }).mockResolvedValueOnce({ climb: oldDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
        onAddToQueue,
        onOpenPlaylist,
        onOpenActions,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() =>
      expect(onClimbPress).toHaveBeenCalledWith({
        climb: heroDetail,
        queueItemUuid: 'queue-hero',
        boardConfig,
      }),
    );
    expect(onClimbPress).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledWith(GET_CLIMB, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 40,
      climbUuid: 'hero-climb',
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('queue old-climb'));
    await waitFor(() =>
      expect(onAddToQueue).toHaveBeenCalledWith({
        climb: oldDetail,
        queueItemUuid: 'queue-old',
        boardConfig: { ...boardConfig, angle: 30 },
      }),
    );
    expect(onAddToQueue).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledWith(GET_CLIMB, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 30,
      climbUuid: 'old-climb',
    });

    fireEvent.click(getByLabelText('playlist old-climb'));
    await waitFor(() =>
      expect(onOpenPlaylist).toHaveBeenCalledWith({
        climb: oldDetail,
        queueItemUuid: 'queue-old',
        boardConfig: { ...boardConfig, angle: 30 },
      }),
    );
    expect(onOpenPlaylist).toHaveBeenCalledTimes(1);

    fireEvent.click(getByLabelText('actions old-climb'));
    await waitFor(() =>
      expect(onOpenActions).toHaveBeenCalledWith({
        climb: oldDetail,
        queueItemUuid: 'queue-old',
        boardConfig: { ...boardConfig, angle: 30 },
      }),
    );
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(2);

    expect(thumbnails.props).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climb: expect.objectContaining({ uuid: 'hero-climb' }), size: 52 }),
        expect.objectContaining({
          climb: expect.objectContaining({ uuid: 'old-climb' }),
          boardConfig: { ...boardConfig, angle: 30 },
        }),
      ]),
    );
    expect(climbRows.props).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          climb: expect.objectContaining({ uuid: 'old-climb' }),
          angle: 30,
          contentRowStyle: expect.objectContaining({ paddingVertical: 8 }),
          showSeparator: false,
        }),
      ]),
    );
  });

  it('hydrates playlist actions on a cold cache without requiring a press action', async () => {
    presence.history = [
      makeClimb('old-climb', 2, {
        frames: 'old-frames',
        grade: 'V4',
        angle: 30,
        queueItemUuid: 'queue-old',
      }),
    ];
    const onOpenPlaylist = vi.fn();
    const oldDetail = makeFullClimb('old-climb', {
      name: 'Hydrated Old',
      angle: 30,
      difficulty: 'V5',
    });
    graphql.request.mockResolvedValueOnce({ climb: oldDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onOpenPlaylist,
      }),
    );
    act(() => ref.current?.present());

    expect(climbRows.props[0]?.onPress).toBeUndefined();
    fireEvent.click(getByLabelText('playlist old-climb'));

    await waitFor(() =>
      expect(onOpenPlaylist).toHaveBeenCalledWith({
        climb: oldDetail,
        queueItemUuid: 'queue-old',
        boardConfig: { ...boardConfig, angle: 30 },
      }),
    );
    expect(onOpenPlaylist).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledWith(GET_CLIMB, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 30,
      climbUuid: 'old-climb',
    });
  });

  it('hydrates action-sheet actions on a cold cache', async () => {
    presence.history = [
      makeClimb('old-climb', 2, {
        frames: 'old-frames',
        grade: 'V4',
        angle: 30,
        queueItemUuid: 'queue-old',
      }),
    ];
    const onOpenActions = vi.fn();
    const oldDetail = makeFullClimb('old-climb', {
      name: 'Hydrated Old',
      angle: 30,
      difficulty: 'V5',
    });
    graphql.request.mockResolvedValueOnce({ climb: oldDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onOpenActions,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('actions old-climb'));

    await waitFor(() =>
      expect(onOpenActions).toHaveBeenCalledWith({
        climb: oldDetail,
        queueItemUuid: 'queue-old',
        boardConfig: { ...boardConfig, angle: 30 },
      }),
    );
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledWith(GET_CLIMB, {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
      angle: 30,
      climbUuid: 'old-climb',
    });
  });

  it('shows loading feedback and ignores repeat taps while a climb action is resolving', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, {
      frames: 'hero-frames',
      grade: 'V7',
      queueItemUuid: 'queue-hero',
    });
    const onClose = vi.fn();
    const onClimbPress = vi.fn();
    const heroDetail = makeFullClimb('hero-climb', { name: 'Hydrated Hero' });
    const climbRequest = createDeferred<{ climb: Climb | null }>();
    graphql.request.mockReturnValueOnce(climbRequest.promise);

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull();

    fireEvent.click(getByLabelText('press hero-climb'));
    fireEvent.click(getByLabelText('press hero-climb'));

    expect(graphql.request).toHaveBeenCalledTimes(1);
    expect(onClimbPress).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).not.toBeNull());

    await act(async () => {
      climbRequest.resolve({ climb: heroDetail });
      await climbRequest.promise;
    });

    await waitFor(() => expect(onClimbPress).toHaveBeenCalledTimes(1));
    expect(onClimbPress).toHaveBeenCalledWith({
      climb: heroDetail,
      queueItemUuid: 'queue-hero',
      boardConfig,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast.showToast).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());
  });

  it('drops stale action results after the sheet is closed', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, {
      frames: 'hero-frames',
      grade: 'V7',
      queueItemUuid: 'queue-hero',
    });
    const onClose = vi.fn();
    const onClimbPress = vi.fn();
    const heroDetail = makeFullClimb('hero-climb', { name: 'Hydrated Hero' });
    const climbRequest = createDeferred<{ climb: Climb | null }>();
    graphql.request.mockReturnValueOnce(climbRequest.promise);

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).not.toBeNull());

    fireEvent.click(getByLabelText('mobile.boardPresence.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());

    await act(async () => {
      climbRequest.resolve({ climb: heroDetail });
      await climbRequest.promise;
    });

    expect(onClimbPress).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('drops stale action results after an imperative dismiss', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, {
      frames: 'hero-frames',
      grade: 'V7',
      queueItemUuid: 'queue-hero',
    });
    const ref = createRef<BoardSheetHandle>();
    const onClimbPress = vi.fn();
    const heroDetail = makeFullClimb('hero-climb', { name: 'Hydrated Hero' });
    const climbRequest = createDeferred<{ climb: Climb | null }>();
    graphql.request.mockReturnValueOnce(climbRequest.promise);

    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).not.toBeNull());

    act(() => {
      ref.current?.dismiss();
    });
    expect(sheetModal.dismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());

    await act(async () => {
      climbRequest.resolve({ climb: heroDetail });
      await climbRequest.promise;
    });

    expect(onClimbPress).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('shows a toast instead of leaking errors thrown by action callbacks', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3);
    const callbackError = new Error('callback failed');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onClose = vi.fn();
    const onClimbPress = vi.fn(() => {
      throw callbackError;
    });
    const heroDetail = makeFullClimb('hero-climb', { name: 'Hydrated Hero' });
    graphql.request.mockResolvedValueOnce({ climb: heroDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('mobile.boardPresence.actionFailed', 'error'));
    expect(onClimbPress).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Failed to run board-sheet climb action', callbackError);
    consoleWarn.mockRestore();
  });

  it('shows a toast and skips the action when climb hydration throws', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3);
    const onClimbPress = vi.fn();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requestError = new Error('network down');
    const retryDetail = makeFullClimb('hero-climb', { name: 'Retry Hero' });
    const climbRequest = createDeferred<{ climb: Climb | null }>();
    graphql.request.mockReturnValueOnce(climbRequest.promise).mockResolvedValueOnce({ climb: retryDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).not.toBeNull());

    await act(async () => {
      climbRequest.reject(requestError);
      await climbRequest.promise.catch(() => undefined);
    });

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('mobile.boardPresence.actionFailed', 'error'));
    expect(onClimbPress).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Failed to load board-sheet climb action', requestError);
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() =>
      expect(onClimbPress).toHaveBeenCalledWith({
        climb: retryDetail,
        queueItemUuid: null,
        boardConfig,
      }),
    );
    expect(onClimbPress).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(2);
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  it('shows a toast and skips the action when climb hydration returns no climb', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3);
    const onClimbPress = vi.fn();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryDetail = makeFullClimb('hero-climb', { name: 'Retry Hero' });
    graphql.request.mockResolvedValueOnce({ climb: null }).mockResolvedValueOnce({ climb: retryDetail });

    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());

    fireEvent.click(getByLabelText('press hero-climb'));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('mobile.boardPresence.actionFailed', 'error'));
    expect(onClimbPress).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith('Board-sheet climb action returned no climb', 'hero-climb');
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() =>
      expect(onClimbPress).toHaveBeenCalledWith({
        climb: retryDetail,
        queueItemUuid: null,
        boardConfig,
      }),
    );
    expect(onClimbPress).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(2);
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  it('shows a toast and skips stale interactive actions when board config is unavailable', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3);
    const onClimbPress = vi.fn();

    const ref = createRef<BoardSheetHandle>();
    const { rerender } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    act(() => ref.current?.present());
    const stalePress = climbRows.props[0]?.onPress;

    rerender(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig: null,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    expect(typeof stalePress).toBe('function');
    (stalePress as () => void)();

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('mobile.boardPresence.actionFailed', 'error'));
    expect(graphql.request).not.toHaveBeenCalled();
    expect(onClimbPress).not.toHaveBeenCalled();
  });

  it('fires onSwitchBoard from the footer switch control', () => {
    const onSwitchBoard = vi.fn();
    const ref = createRef<BoardSheetHandle>();
    const { container, getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard,
      }),
    );
    act(() => ref.current?.present());
    expect(container.querySelector('[data-icon="transfer"]')).not.toBeNull();
    expect(container.textContent).toContain('mobile.boardPresence.switchBoard');
    fireEvent.click(getByLabelText('mobile.boardPresence.switchBoardAria'));
    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
  });

  it('pads the switch-board footer for the bottom safe-area inset (Android 3-button nav bar)', () => {
    // Simulate a device whose system nav bar reserves a bottom inset — the native
    // sheet does not pad content for it, so the footer must add it itself or the
    // switch-board button sits under the nav bar (the reported bug).
    safeArea.bottom = 34;
    const ref = createRef<BoardSheetHandle>();
    const { getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());

    // insets.bottom (34) + spacing[3] (12) — the inset is included, not dropped.
    const footer = getByLabelText('mobile.boardPresence.switchBoardAria');
    expect(footer.getAttribute('data-padding-bottom')).toBe(String(34 + 12));
  });

  it('fires onClose from the header chevron', () => {
    const onClose = vi.fn();
    const ref = createRef<BoardSheetHandle>();
    const { container, getByLabelText } = render(
      createElement(BoardSheet, {
        ref,
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    act(() => ref.current?.present());
    expect(container.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="close"]')).toBeNull();
    fireEvent.click(getByLabelText('mobile.boardPresence.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('load older history', () => {
    it('calls loadOlder when the list end is reached after a user scroll', () => {
      presence.history = [makeClimb('c1', 3)];
      const ref = createRef<BoardSheetHandle>();
      const { getByLabelText } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      fireEvent.click(getByLabelText('begin scroll'));
      fireEvent.click(getByLabelText('reach list end'));
      expect(historyPagination.loadOlder).toHaveBeenCalledTimes(1);
    });

    it('ignores an end-reach that fires without a user scroll (short-content auto-fire)', () => {
      // FlatList fires onEndReached immediately when the content is shorter
      // than the viewport — presenting on a quiet wall must not auto-fetch.
      presence.history = [makeClimb('c1', 3)];
      const ref = createRef<BoardSheetHandle>();
      const { getByLabelText } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      fireEvent.click(getByLabelText('reach list end'));
      expect(historyPagination.loadOlder).not.toHaveBeenCalled();

      // A real scroll afterwards arms the gate.
      fireEvent.click(getByLabelText('begin scroll'));
      fireEvent.click(getByLabelText('reach list end'));
      expect(historyPagination.loadOlder).toHaveBeenCalledTimes(1);
    });

    it('does not wire onEndReached once hasMore is false', () => {
      presence.history = [makeClimb('c1', 3)];
      historyPagination.hasMore = false;
      const ref = createRef<BoardSheetHandle>();
      const { getByLabelText } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      fireEvent.click(getByLabelText('begin scroll'));
      fireEvent.click(getByLabelText('reach list end'));
      expect(historyPagination.loadOlder).not.toHaveBeenCalled();
    });

    it('drops olderHistory entries the live window has since absorbed (backfill overlap)', () => {
      // The live window gained seqs 5..3 (e.g. the initial backfill resolved
      // AFTER a page load); the loaded page overlaps on c1/3 and even carries
      // a durable copy of the current climb (c3/5). Each key must render once.
      presence.currentClimb = makeClimb('c3', 5);
      presence.history = [makeClimb('c3', 5), makeClimb('c2', 4), makeClimb('c1', 3)];
      historyPagination.olderHistory = [
        makeClimb('c3', 5, { name: 'Durable Current' }),
        makeClimb('c1', 3, { name: 'Durable Variant' }),
        makeClimb('c0', 2),
      ];
      const ref = createRef<BoardSheetHandle>();
      const { container } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      // The live variants win; the overlapping durable copies never render.
      expect(container.textContent).not.toContain('Durable Variant');
      expect(container.textContent).not.toContain('Durable Current');
      expect(container.textContent?.match(/Climb c1/g)).toHaveLength(1);
      // c3 renders once — in the hero only (visibleHistory excludes it).
      expect(container.textContent?.match(/Climb c3/g)).toHaveLength(1);
      // Non-overlapping older entries still append.
      expect(container.textContent).toContain('Climb c0');
    });

    it('renders loaded older rows appended after the live history', () => {
      presence.history = [makeClimb('c2', 4)];
      historyPagination.olderHistory = [makeClimb('c1', 3), makeClimb('c0', 2)];
      const ref = createRef<BoardSheetHandle>();
      const { container } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      expect(container.textContent).toContain('Climb c2');
      expect(container.textContent).toContain('Climb c1');
      expect(container.textContent).toContain('Climb c0');
    });

    it('shows the footer spinner while loading older history, and hides it once resolved', () => {
      presence.history = [makeClimb('c1', 3)];
      historyPagination.isLoadingOlder = true;
      const ref = createRef<BoardSheetHandle>();
      const { queryByLabelText, rerender } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      expect(queryByLabelText('mobile.boardPresence.loadingMore')).not.toBeNull();

      historyPagination.isLoadingOlder = false;
      // The real `useBoardHistoryPagination` re-renders the panel from its own
      // state when loading resolves (memo doesn't gate internal state updates).
      // The mock reads a plain flag, so pass a fresh boardConfig (same values,
      // new identity) to bust NowOnTheWallPanel's memo and re-read the flag.
      rerender(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig: { ...boardConfig },
          onSwitchBoard: noop,
        }),
      );

      expect(queryByLabelText('mobile.boardPresence.loadingMore')).toBeNull();
    });

    it('offers Load more from the empty state — an empty list cannot scroll to trigger onEndReached', () => {
      // A wall quiet longer than the Redis window's TTL: empty live window,
      // but durable rows may exist. The empty-state button is the only path.
      presence.history = [];
      const ref = createRef<BoardSheetHandle>();
      const { getByLabelText } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      fireEvent.click(getByLabelText('mobile.boardPresence.loadMore'));
      expect(historyPagination.loadOlder).toHaveBeenCalledTimes(1);
    });

    it('hides the empty-state Load more once hasMore is false', () => {
      presence.history = [];
      historyPagination.hasMore = false;
      const ref = createRef<BoardSheetHandle>();
      const { queryByLabelText } = render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      expect(queryByLabelText('mobile.boardPresence.loadMore')).toBeNull();
    });

    it('tracks BoardHistoryPageLoaded with the boardId when a page resolves', () => {
      presence.history = [makeClimb('c1', 3)];
      const ref = createRef<BoardSheetHandle>();
      render(
        createElement(BoardSheet, {
          ref,
          boardLabel: 'Garage Wall',
          onClose: noop,
          boardConfig,
          onSwitchBoard: noop,
        }),
      );
      act(() => ref.current?.present());

      // The sheet hands its onPageLoaded callback to the pagination hook;
      // firing it (as the real hook does when a page resolves) must emit the
      // analytics event with the bound boardId attached.
      expect(historyPagination.capturedOnPageLoaded).not.toBeNull();
      act(() => historyPagination.capturedOnPageLoaded?.({ pageSize: 50, returnedCount: 37 }));

      expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryPageLoaded, {
        boardId: 123,
        pageSize: 50,
        returnedCount: 37,
      });
    });
  });
});
