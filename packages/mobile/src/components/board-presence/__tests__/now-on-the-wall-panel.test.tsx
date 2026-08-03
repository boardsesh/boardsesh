// @vitest-environment jsdom
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb, BoardPresenceStats, Climb } from '@boardsesh/shared-schema';
import type { NowOnTheWallPanelProps } from '../NowOnTheWallPanel';

const presence = vi.hoisted(() => ({
  currentClimb: null as BoardPresenceClimb | null,
  history: [] as BoardPresenceClimb[],
  stats: null as BoardPresenceStats | null,
  refresh: vi.fn(),
}));

const safeArea = vi.hoisted(() => ({
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
}));

const graphql = vi.hoisted(() => ({
  request: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
}));
const pressableAvatar = vi.hoisted(() => vi.fn());
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const presenceControls = vi.hoisted(() => ({ boardId: 123 as number | null }));
const historyPagination = vi.hoisted(() => ({
  olderHistory: [] as BoardPresenceClimb[],
  isLoadingOlder: false,
  hasMore: false,
  loadOlder: vi.fn(),
  capturedOnPageLoaded: null as ((info: { pageSize: number; returnedCount: number }) => void) | null,
}));

type ViewMockProps = { children?: ReactNode; style?: unknown };
type PressableMockProps = ViewMockProps & {
  onPress?: () => void;
  accessibilityLabel?: string;
};
type ListMockProps = {
  data: BoardPresenceClimb[];
  renderItem: (info: { item: BoardPresenceClimb }) => ReactNode;
  ListHeaderComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
  keyExtractor: (item: BoardPresenceClimb) => string;
};
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
  onPress?: () => void;
  onAddToQueue?: () => void;
  onOpenPlaylist?: () => void;
  onOpenActions?: () => void;
};

vi.mock('react-native', () => {
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) {
      return style.reduce<Record<string, unknown>>((mergedStyle, styleEntry) => {
        return { ...mergedStyle, ...flattenStyle(styleEntry) };
      }, {});
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
  };
  const renderList = ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, keyExtractor }: ListMockProps) =>
    createElement(
      'div',
      { 'data-list': 'flat' },
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    );

  return {
    StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
    View: ({ children }: ViewMockProps) => createElement('div', null, children),
    Pressable: ({ children, onPress, accessibilityLabel, style }: PressableMockProps) => {
      const flatStyle = flattenStyle(style);
      return createElement(
        'button',
        {
          onClick: onPress,
          'aria-label': accessibilityLabel,
          // paddings are numbers; narrow before stringifying (no-base-to-string).
          'data-padding-bottom': String(typeof flatStyle.paddingBottom === 'number' ? flatStyle.paddingBottom : ''),
          'data-padding-top': String(typeof flatStyle.paddingTop === 'number' ? flatStyle.paddingTop : ''),
        },
        children,
      );
    },
    FlatList: renderList,
    // Surface onRefresh as a clickable element so the pull-to-refresh wiring is testable.
    RefreshControl: ({ onRefresh }: { onRefresh?: () => void }) =>
      createElement('button', { onClick: onRefresh, 'aria-label': 'refresh' }),
  };
});

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: (props: ListMockProps & { refreshControl?: ReactNode }) =>
    createElement(
      'div',
      { 'data-bottom-sheet-list': 'true' },
      props.refreshControl,
      props.ListHeaderComponent,
      props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item) => createElement('div', { key: props.keyExtractor(item) }, props.renderItem({ item }))),
    ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea.insets,
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
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../PressableAvatar', () => ({
  PressableAvatar: (props: Record<string, unknown>) => {
    pressableAvatar(props);
    return createElement('span', {
      'data-avatar': props.name ?? '',
      'data-user-id': props.userId ?? '',
    });
  },
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
    createElement('span', { 'aria-label': accessibilityLabel, 'data-loading': 'true' }),
}));
vi.mock('../../ClimbListRow', () => ({
  ClimbListRow: (props: ClimbListRowMockProps) => {
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
      createElement('button', { 'aria-label': `press ${climbUuid}`, onClick: props.onPress }, content),
      createElement('button', { 'aria-label': `queue ${climbUuid}`, onClick: props.onAddToQueue }, 'queue'),
      createElement('button', { 'aria-label': `playlist ${climbUuid}`, onClick: props.onOpenPlaylist }, 'playlist'),
      createElement('button', { 'aria-label': `actions ${climbUuid}`, onClick: props.onOpenActions }, 'actions'),
    );
  },
}));
vi.mock('../../queue-control/AccessoryClimbThumbnail', () => ({
  AccessoryClimbThumbnail: () => createElement('div', { 'data-thumb': 'true' }),
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

import { NowOnTheWallPanel } from '../NowOnTheWallPanel';

const noop = () => {};
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

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

function panelElement(overrides: Partial<NowOnTheWallPanelProps> = {}) {
  return createElement(NowOnTheWallPanel, {
    variant: 'sheet',
    boardLabel: 'Garage Wall',
    boardConfig,
    onSwitchBoard: noop,
    ...overrides,
  });
}

describe('NowOnTheWallPanel', () => {
  beforeEach(() => {
    presence.currentClimb = null;
    presence.history = [];
    presence.stats = null;
    safeArea.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    graphql.request.mockReset();
    toast.showToast.mockClear();
    pressableAvatar.mockClear();
    presence.refresh.mockClear();
  });

  it('adds the bottom safe-area inset to the switch-board footer in both sheet and inline variants', () => {
    // The native sheet does not pad its content for the Android edge-to-edge
    // navigation bar, so the footer adds insets.bottom (34) + spacing[3] (12)
    // itself in every variant — otherwise the switch-board button sits under the
    // 3-button nav bar (the reported bug).
    safeArea.insets = { top: 0, bottom: 34, left: 0, right: 0 };
    const { getByLabelText, rerender } = render(panelElement({ variant: 'sheet' }));

    expect(getByLabelText('mobile.boardPresence.switchBoardAria').getAttribute('data-padding-bottom')).toBe('46');

    rerender(panelElement({ variant: 'column' }));

    expect(getByLabelText('mobile.boardPresence.switchBoardAria').getAttribute('data-padding-bottom')).toBe('46');
  });

  it('drops in-flight action results and clears loading when the board config changes', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, { queueItemUuid: 'queue-hero' });
    const onClimbPress = vi.fn();
    const climbRequest = createDeferred<{ climb: Climb | null }>();
    graphql.request.mockReturnValueOnce(climbRequest.promise);

    const { getByLabelText, queryByLabelText, rerender } = render(panelElement({ onClimbPress }));

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).not.toBeNull());

    rerender(panelElement({ onClimbPress, boardConfig: { ...boardConfig, layoutId: 2 } }));
    await waitFor(() => expect(queryByLabelText('mobile.boardPresence.actionLoading')).toBeNull());

    await act(async () => {
      climbRequest.resolve({ climb: makeFullClimb('hero-climb') });
      await climbRequest.promise;
    });

    expect(onClimbPress).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('closes after a successful primary press but leaves secondary actions open', async () => {
    presence.currentClimb = makeClimb('hero-climb', 3, { queueItemUuid: 'queue-hero' });
    const onClose = vi.fn();
    const onClimbPress = vi.fn();
    const onAddToQueue = vi.fn();
    const heroDetail = makeFullClimb('hero-climb', { name: 'Hydrated Hero' });
    graphql.request.mockResolvedValueOnce({ climb: heroDetail });

    const { getByLabelText } = render(panelElement({ onClose, onClimbPress, onAddToQueue }));

    fireEvent.click(getByLabelText('queue hero-climb'));
    await waitFor(() =>
      expect(onAddToQueue).toHaveBeenCalledWith({
        climb: heroDetail,
        queueItemUuid: 'queue-hero',
        boardConfig,
      }),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByLabelText('press hero-climb'));
    await waitFor(() =>
      expect(onClimbPress).toHaveBeenCalledWith({
        climb: heroDetail,
        queueItemUuid: 'queue-hero',
        boardConfig,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(graphql.request).toHaveBeenCalledTimes(1);
  });

  it('keeps the hardest-send avatar linked to the climber profile', () => {
    presence.stats = {
      climbsSentCount: 9,
      distinctClimbersCount: 3,
      hardestGrade: 'V8',
      hardestSend: {
        climbUuid: 'hardest-1',
        name: 'Hardest One',
        grade: 'V8',
        sentByUserId: 'user-hardest',
        sentByDisplayName: 'Alex',
        sentByAvatarUrl: 'https://example.com/avatar.png',
        sentAt: '2026-06-09T00:00:00.000Z',
      },
      topGrade: 'V8',
      lastSentAt: '2026-06-09T00:00:00.000Z',
    };

    const { container } = render(panelElement());

    expect(container.textContent).toContain('Hardest One');
    expect(pressableAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-hardest',
        name: 'Alex',
        uri: 'https://example.com/avatar.png',
        size: 34,
      }),
    );
  });

  // A large slice of the durable wall log was sent by accounts with no
  // `users.name` and no profile (Apple private-relay signups), which used to
  // drop the whole avatar-plus-name block and made those rows look empty.
  it('still attributes a history row whose climber has no display name', () => {
    presence.history = [makeClimb('nameless-1', 4, { sentByUserId: 'user-nameless', sentByDisplayName: null })];

    const { container } = render(panelElement());

    expect(container.textContent).toContain('mobile.boardPresence.unnamedClimber');
  });

  it('shows nothing where there is no climber at all', () => {
    presence.history = [makeClimb('anon-1', 5, { sentByUserId: null, sentByDisplayName: null })];

    const { container } = render(panelElement());

    expect(container.textContent).not.toContain('mobile.boardPresence.unnamedClimber');
  });
});
