// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, createRef, forwardRef, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { BoardPresenceClimb, BoardPresenceStats, Climb } from '@boardsesh/shared-schema';

const presence = vi.hoisted(() => ({
  currentClimb: null as BoardPresenceClimb | null,
  history: [] as BoardPresenceClimb[],
  stats: null as BoardPresenceStats | null,
  isHydrating: false,
  isRefreshing: false,
}));

const presenceActions = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
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

const sheetModal = vi.hoisted(() => ({ present: vi.fn(), dismiss: vi.fn() }));
const climbRows = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const thumbnails = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));

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
  }: ViewMockProps & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(({ children }: { children?: ReactNode }, ref: Ref<unknown>) => {
    useImperativeHandle(ref, () => ({ present: sheetModal.present, dismiss: sheetModal.dismiss }));
    return createElement('div', { 'data-sheet': 'true' }, children);
  }),
  BottomSheetBackdrop: () => createElement('div', { 'data-backdrop': 'true' }),
  // Render the list inline so header + items + empty state appear in the DOM.
  BottomSheetFlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    keyExtractor,
  }: {
    data: BoardPresenceClimb[];
    renderItem: (info: { item: BoardPresenceClimb }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    keyExtractor: (item: BoardPresenceClimb) => string;
  }) =>
    createElement(
      'div',
      { 'data-list': 'true' },
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
  useBoardPresenceFeed: () => ({
    history: presence.history,
    stats: presence.stats,
    isHydrating: presence.isHydrating,
    isRefreshing: presence.isRefreshing,
  }),
  useBoardPresenceActions: () => ({ refresh: presenceActions.refresh }),
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

vi.mock('../../GlassSheetBackground', () => ({ GlassSheetBackground: () => createElement('div', null) }));
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
    presence.isHydrating = false;
    presence.isRefreshing = false;
    presenceActions.refresh.mockClear();
    presenceControls.boardId = 123;
    analytics.track.mockClear();
    graphql.request.mockReset();
    toast.showToast.mockClear();
    sheetModal.present.mockClear();
    sheetModal.dismiss.mockClear();
    climbRows.props = [];
    thumbnails.props = [];
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

  it('tracks distinct now-on-the-wall climbs from the presence feed', () => {
    presence.currentClimb = makeClimb('c1', 3);

    render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardNowPlayingReceived, {
      boardId: 123,
      climbUuid: 'c1',
    });
  });

  it('tracks history views from the imperative present call', () => {
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

    ref.current?.present();

    expect(analytics.track).toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: 123,
      itemCount: 2,
    });
    expect(sheetModal.present).toHaveBeenCalled();
  });

  it('renders the empty state when no climb is on the wall', () => {
    const { container } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
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

    const { container } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

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

    const { container } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );

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

    const { getByLabelText } = render(
      createElement(BoardSheet, {
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

    const { getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onOpenPlaylist,
      }),
    );

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

    const { getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onOpenActions,
      }),
    );

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

    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );

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

    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );

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

    const { getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );

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

    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );

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

    const { getByLabelText, queryByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );

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

    const { rerender } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
        onClimbPress,
      }),
    );
    const stalePress = climbRows.props[0]?.onPress;

    rerender(
      createElement(BoardSheet, {
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
    const { container, getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard,
      }),
    );
    expect(container.querySelector('[data-icon="transfer"]')).not.toBeNull();
    expect(container.textContent).toContain('mobile.boardPresence.switchBoard');
    fireEvent.click(getByLabelText('mobile.boardPresence.switchBoardAria'));
    expect(onSwitchBoard).toHaveBeenCalledTimes(1);
  });

  it('fires onClose from the header chevron', () => {
    const onClose = vi.fn();
    const { container, getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    expect(container.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="close"]')).toBeNull();
    fireEvent.click(getByLabelText('mobile.boardPresence.close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('forces a refresh from the header refresh control', () => {
    const { container, getByLabelText } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    expect(container.querySelector('[data-icon="refresh"]')).not.toBeNull();
    fireEvent.click(getByLabelText('mobile.boardPresence.refresh'));
    expect(presenceActions.refresh).toHaveBeenCalledTimes(1);
  });

  it('shows skeleton placeholders instead of history while hydrating', () => {
    presence.isHydrating = true;
    presence.history = [makeClimb('hidden-while-loading', 1)];
    const { container } = render(
      createElement(BoardSheet, {
        boardLabel: 'Garage Wall',
        onClose: noop,
        onDismissed: noop,
        boardConfig,
        onSwitchBoard: noop,
      }),
    );
    // The real history rows are withheld while the skeleton is up.
    expect(container.textContent).not.toContain('hidden-while-loading');
    // The header refresh control stays available during the initial hydrate.
    expect(container.querySelector('[data-icon="refresh"]')).not.toBeNull();
  });
});
