// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardPresenceClimb, BoardPresenceStats, Climb, UserBoard } from '@boardsesh/shared-schema';
import type { NowOnTheWallPanelProps } from '../NowOnTheWallPanel';
import type { DismissAndWaitResult } from '../../../providers/sheet-presentation-provider';

const presence = vi.hoisted(() => ({
  currentClimb: null as BoardPresenceClimb | null,
  history: [] as BoardPresenceClimb[],
  stats: null as BoardPresenceStats | null,
  holder: null as { userId?: string | null; displayName?: string | null } | null,
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

// The gym roster is a React Query hook and this harness mounts no QueryClient.
// Undefined is the single-board gym, which is what most of these tests describe.
const gymRoster = vi.hoisted(() => ({ boards: undefined as unknown[] | undefined }));
vi.mock('../../../lib/graphql/hooks/use-gym-boards', () => ({
  useGymBoards: () => ({ data: gymRoster.boards }),
}));
// Self-subscribing (React Query, Reanimated, expo-router); its own suite covers
// what it draws. Here: where it mounts and what the panel hands it.
const liveSessionsBlock = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('../../live-sessions/BoardLiveSessionsBlock', () => ({
  BoardLiveSessionsBlock: (props: Record<string, unknown>) => {
    liveSessionsBlock.props.push(props);
    return createElement('div', { 'data-live-sessions-block': 'true' });
  },
}));
// The list itself has its own suite; here we only care whether it is on screen.
vi.mock('../GymWallSwitcher', () => ({
  GymWallSwitcher: () => createElement('div', { 'data-gym-wall-switcher': 'true' }),
}));

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
    StyleSheet: {
      flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
      create: (styles: Record<string, unknown>) => styles,
      hairlineWidth: 1,
    },
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
    i18n: { resolvedLanguage: 'en-US', language: 'en-US' },
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
    holder: presence.holder,
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
  useOptionalTheme: () => null,
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
  opacity: { disabled: 0.5 },
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
  borderRadius: { md: 8, lg: 12 },
}));

// The archived notice's "Switch to the new wall" reads the board over the
// network and binds it; here it is only asked to exist.
const openSprayWall = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/spray/use-open-spray-wall', () => ({ useOpenSprayWall: () => openSprayWall }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useSetActiveBoard: () => vi.fn() }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
import { NowOnTheWallPanel } from '../NowOnTheWallPanel';
import { publishWindowInsetBottom, resetWindowInsetForTests } from '../../../lib/window-inset-store';
import {
  clearSprayWallRegistry,
  LIVE_SPRAY_WALL_ARCHIVE_STATE,
  registerSprayWall,
  type SprayWallArchiveState,
} from '../../../lib/spray/spray-wall-registry';

/** Register a spray wall in the real registry, so the sheet knows whether it is archived. */
function registerSprayWallFixture(layoutId: number, wallUuid: string, archive: Partial<SprayWallArchiveState> = {}) {
  registerSprayWall(layoutId, {
    wallUuid,
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 100,
    photoHeight: 100,
    photoUrl: 'https://example.invalid/wall.jpg',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
    archive: { ...LIVE_SPRAY_WALL_ARCHIVE_STATE, ...archive },
  });
}

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
    presence.holder = null;
    presence.history = [];
    presence.stats = null;
    safeArea.insets = { top: 0, bottom: 0, left: 0, right: 0 };
    resetWindowInsetForTests();
    graphql.request.mockReset();
    toast.showToast.mockClear();
    pressableAvatar.mockClear();
    presence.refresh.mockClear();
    // mockReset, not mockClear: the tap-ordering test installs an implementation.
    analytics.track.mockReset();
  });

  const sprayWall: UserBoard = {
    uuid: 'spray-wall-1',
    slug: 'garage',
    name: 'Garage',
    ownerId: 'owner-1',
    boardType: 'spray',
    layoutId: 12,
    sizeId: 12,
    setIds: '12',
    angle: 30,
    canEdit: true,
    isPublic: true,
    isUnlisted: false,
    isOwned: true,
    isFollowedByMe: true,
    hideLocation: false,
    isAngleAdjustable: false,
    createdAt: '2026-01-01',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
  };

  it('mounts all wall actions in the live sheet and forwards the active wall identity', () => {
    clearSprayWallRegistry();
    registerSprayWallFixture(sprayWall.layoutId, sprayWall.uuid);
    const onOpenSprayMaintenance = vi.fn();
    const onShareSprayWall = vi.fn();
    const { getByLabelText } = render(
      panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance, onShareSprayWall, viewerUserId: 'owner-1' }),
    );
    fireEvent.click(getByLabelText('mobile.boardDetail.spray.editHolds'));
    fireEvent.click(getByLabelText('mobile.boardDetail.spray.resetWall'));
    fireEvent.click(getByLabelText('mobile.boardDetail.spray.shareLink'));
    expect(onOpenSprayMaintenance.mock.calls).toEqual([
      [sprayWall.uuid, 'editHolds'],
      [sprayWall.uuid, 'resetWall'],
    ]);
    expect(onShareSprayWall).toHaveBeenCalledExactlyOnceWith(sprayWall.uuid);
  });

  it('keeps public sharing for viewers and hides maintenance on the kiosk and catalogue boards', () => {
    clearSprayWallRegistry();
    registerSprayWallFixture(sprayWall.layoutId, sprayWall.uuid);
    const callbacks = { onOpenSprayMaintenance: vi.fn(), onShareSprayWall: vi.fn() };
    const { queryByLabelText, rerender } = render(
      panelElement({ activeBoard: { ...sprayWall, canEdit: false }, viewerUserId: 'someone', ...callbacks }),
    );
    expect(queryByLabelText('mobile.boardDetail.spray.editHolds')).toBeNull();
    expect(queryByLabelText('mobile.boardDetail.spray.resetWall')).toBeNull();
    expect(queryByLabelText('mobile.boardDetail.spray.shareLink')).not.toBeNull();
    rerender(panelElement({ activeBoard: sprayWall, variant: 'column', viewerUserId: 'owner-1', ...callbacks }));
    expect(queryByLabelText('mobile.boardDetail.spray.shareLink')).toBeNull();
    expect(queryByLabelText('mobile.boardDetail.spray.editHolds')).toBeNull();
    rerender(
      panelElement({ activeBoard: { ...sprayWall, boardType: 'kilter' }, viewerUserId: 'owner-1', ...callbacks }),
    );
    expect(queryByLabelText('mobile.boardDetail.spray.shareLink')).toBeNull();
    expect(queryByLabelText('mobile.boardDetail.spray.resetWall')).toBeNull();
  });

  // Holds stay editable on a live wall, published climbs or not: the owner
  // gets Edit holds and Reset, an editor who is not the owner Edit holds alone.
  it('keeps Edit holds on a live wall for the owner and for an editor', () => {
    clearSprayWallRegistry();
    registerSprayWallFixture(sprayWall.layoutId, sprayWall.uuid, {});
    const onOpenSprayMaintenance = vi.fn();
    const { getByLabelText, queryByLabelText, rerender } = render(
      panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance, viewerUserId: 'owner-1' }),
    );
    fireEvent.click(getByLabelText('mobile.boardDetail.spray.editHolds'));
    expect(onOpenSprayMaintenance).toHaveBeenCalledExactlyOnceWith(sprayWall.uuid, 'editHolds');
    expect(getByLabelText('mobile.boardDetail.spray.resetWall')).toBeTruthy();

    rerender(panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance, viewerUserId: 'gym-admin' }));
    expect(getByLabelText('mobile.boardDetail.spray.editHolds')).toBeTruthy();
    expect(queryByLabelText('mobile.boardDetail.spray.resetWall')).toBeNull();
  });

  // Only the owner can still see a wall an admin hid after a report; a wall
  // that quietly vanished for everyone else would read as data loss.
  it('tells the owner, and only the owner, that their wall is hidden', () => {
    clearSprayWallRegistry();
    registerSprayWall(sprayWall.layoutId, {
      wallUuid: sprayWall.uuid,
      angle: 40,
      version: 1,
      versionId: 1,
      photoWidth: 100,
      photoHeight: 100,
      photoUrl: 'https://example.invalid/wall.jpg',
      photoThumbUrl: null,
      photoExpiresAt: '2099-01-01T00:00:00.000Z',
      holds: [],
      hiddenAt: '2026-10-02T09:00:00.000Z',
    });
    const { getByText, queryByText, rerender } = render(
      panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance: vi.fn(), viewerUserId: 'owner-1' }),
    );
    expect(getByText('sprayHidden.title')).toBeTruthy();
    expect(getByText('sprayHidden.body')).toBeTruthy();
    rerender(panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance: vi.fn(), viewerUserId: 'gym-admin' }));
    expect(queryByText('sprayHidden.title')).toBeNull();
  });

  // An archived wall keeps its climbs: the sheet says so, offers the wall that
  // replaced it, and drops every maintenance row.
  it('shows the archived notice and no maintenance on an archived wall', () => {
    clearSprayWallRegistry();
    registerSprayWallFixture(sprayWall.layoutId, sprayWall.uuid, {
      archivedAt: '2026-10-01T09:00:00.000Z',
      replacedByWallUuid: 'new-wall',
    });
    const { getByText, queryByLabelText } = render(
      panelElement({ activeBoard: sprayWall, onOpenSprayMaintenance: vi.fn(), viewerUserId: 'owner-1' }),
    );
    expect(getByText(/^sprayArchive\.banner:/)).toBeTruthy();
    fireEvent.click(getByText('sprayArchive.switchToNew'));
    expect(openSprayWall).toHaveBeenCalledExactlyOnceWith('new-wall');
    expect(queryByLabelText('mobile.boardDetail.spray.editHolds')).toBeNull();
    expect(queryByLabelText('mobile.boardDetail.spray.resetWall')).toBeNull();
  });

  it('mounts the live-sessions block in the sheet with the board id and whoever holds the board now', () => {
    liveSessionsBlock.props = [];
    // The last climb was lit by someone who has since left; the holder is who is here.
    presence.currentClimb = {
      climbUuid: 'climb-1',
      name: 'Legion',
      grade: 'V3',
      sentAt: '2026-09-16T10:00:00.000Z',
      seq: 4,
      sentByDisplayName: 'Old Lighter',
      sentByUserId: 'old',
    };
    presence.holder = { userId: 'jonah', displayName: '  Jonah W. ' };
    const { container } = render(panelElement({ variant: 'sheet' }));
    expect(container.querySelector('[data-live-sessions-block]')).not.toBeNull();
    expect(liveSessionsBlock.props.at(-1)).toEqual(
      expect.objectContaining({ boardId: 123, holderName: 'Jonah W.', holderUserId: 'jonah' }),
    );
  });

  it('gives the block no name when nobody holds the board', () => {
    liveSessionsBlock.props = [];
    render(panelElement({ variant: 'sheet' }));
    expect(liveSessionsBlock.props.at(-1)).toEqual(expect.objectContaining({ holderName: null, holderUserId: null }));
  });

  it('closes the sheet and waits for it to settle before the block routes away', async () => {
    liveSessionsBlock.props = [];
    const dismissAndWait = vi.fn(async (): Promise<DismissAndWaitResult> => ({ status: 'dismissed' }));
    render(panelElement({ variant: 'sheet', dismissAndWait }));
    const leave = liveSessionsBlock.props.at(-1)?.onBeforeNavigate as () => Promise<boolean>;
    await expect(leave()).resolves.toBe(true);
    expect(dismissAndWait).toHaveBeenCalledTimes(1);

    dismissAndWait.mockResolvedValueOnce({ status: 'aborted' });
    await expect(leave()).resolves.toBe(false);
  });

  it('keeps the live-sessions block off the column variant (the wall kiosk)', () => {
    const { container } = render(panelElement({ variant: 'column' }));
    expect(container.querySelector('[data-live-sessions-block]')).toBeNull();
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

  it('pads the sheet footer by the WINDOW inset, not an in-tab inset that folds in the tab bar (#3776)', () => {
    // Mounted inside a NativeTabs tab, the local inset is 139 (34 home indicator
    // + 49 bar + 56 accessory, DEVICE_VERIFIED iPhone 17 Pro). The sheet covers
    // that chrome, so its footer clears only the window's 34 + spacing[3].
    safeArea.insets = { top: 0, bottom: 139, left: 0, right: 0 };
    act(() => publishWindowInsetBottom(34));
    const { getByLabelText, rerender } = render(panelElement({ variant: 'sheet' }));

    expect(getByLabelText('mobile.boardPresence.switchBoardAria').getAttribute('data-padding-bottom')).toBe('46');

    // The inline column is not a sheet: it keeps the inset of the surface it sits in.
    rerender(panelElement({ variant: 'column' }));

    expect(getByLabelText('mobile.boardPresence.switchBoardAria').getAttribute('data-padding-bottom')).toBe('151');
  });

  // The point of this event is to be provable evidence that the tap reached JS.
  // If it ever fires only alongside the host handler it stops discriminating, so
  // assert the ordering rather than just the call.
  it('reports the switch-board tap before handing off to the host', () => {
    presence.history = [makeClimb('one', 1), makeClimb('two', 2)];
    const callOrder: string[] = [];
    analytics.track.mockImplementation((event: string) => callOrder.push(`track:${event}`));
    const onSwitchBoard = vi.fn(() => callOrder.push('onSwitchBoard'));

    const { getByLabelText } = render(panelElement({ onSwitchBoard }));
    fireEvent.click(getByLabelText('mobile.boardPresence.switchBoardAria'));

    expect(callOrder).toEqual(['track:Board Swap Tapped', 'onSwitchBoard']);
    expect(analytics.track).toHaveBeenCalledWith('Board Swap Tapped', expect.objectContaining({ historyCount: 2 }));
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
});

// Kilter imports only land while a linked viewer has the app open, so the
// history is a set of snapshots with gaps. Each row says when it was on the
// wall, once, so "on the wall now" reads apart from "displayed last night" (#6012).
describe('NowOnTheWallPanel history row times', () => {
  beforeEach(() => {
    // Date only: the panel's promises and waitFor keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T08:40:00.000Z'));
    presence.currentClimb = null;
    presence.holder = null;
    presence.stats = null;
    presence.history = [
      makeClimb('kilter-import', 3, {
        source: 'kilter',
        sentAt: '2026-10-07T21:40:00.000Z',
        sentByDisplayName: 'siqo mode',
      }),
      makeClimb('native-sent', 2, { sentAt: '2026-10-08T08:38:00.000Z', sentByDisplayName: 'Marco' }),
      makeClimb('no-sender', 1, { sentAt: '2026-10-06T08:40:00.000Z', sentByDisplayName: null }),
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function spanTexts(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('span'), (span) => span.textContent ?? '');
  }

  it.each([
    ['plain rows', {}],
    ['interactive rows', { onClimbPress: noop }],
  ])('puts the time on the first caption line of each row (%s)', (_label, overrides) => {
    const { container } = render(panelElement(overrides));
    const texts = spanTexts(container);

    // Kilter import: on the source line, not again beside the sender.
    expect(texts).toContain('mobile.boardPresence.kilterHistorySource · 11 hours ago');
    expect(texts).toContain('siqo mode');
    expect(texts.filter((text) => text.includes('11 hours ago'))).toHaveLength(1);
    // Native send: beside the sender, in its own span so the name truncates first.
    expect(texts).toContain('Marco');
    expect(texts).toContain('· 2 minutes ago');
    // Nobody attributed: the time stands on its own line.
    expect(texts).toContain('2 days ago');
  });
});

// QA declined the first cut because the gym's boards were always on screen: on
// an iPhone 17 Pro the list was most of what a climber could see at the first
// detent, so the sheet opened on a board switcher instead of on the wall feed it
// exists for. It is a disclosure now, and the sheet's own title opens it.
describe('NowOnTheWallPanel gym board disclosure', () => {
  const sibling = {
    uuid: 'tension',
    boardType: 'tension',
    layoutId: 8,
    sizeId: 7,
    setIds: '5,6',
    angle: 25,
    gymUuid: 'gym-1',
  };

  function headerTitle(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[aria-label^="mobile.boardPresence.gymWalls.headerSwitcherAria"]');
  }

  it('stays collapsed when the sheet opens', () => {
    gymRoster.boards = [sibling];

    const { container } = render(panelElement({ onSelectGymWall: noop }));

    expect(headerTitle(container)).toBeTruthy();
    expect(container.querySelector('[data-gym-wall-switcher]')).toBeNull();
  });

  it('opens the list from the header title, and closes it again', () => {
    gymRoster.boards = [sibling];

    const { container } = render(panelElement({ onSelectGymWall: noop }));
    const title = headerTitle(container) as HTMLElement;

    fireEvent.click(title);
    expect(container.querySelector('[data-gym-wall-switcher]')).toBeTruthy();

    fireEvent.click(headerTitle(container) as HTMLElement);
    expect(container.querySelector('[data-gym-wall-switcher]')).toBeNull();
  });

  // One board at the gym: the title is plain text again, exactly as before this
  // feature existed.
  it('leaves the title inert when there is nothing to switch to', () => {
    gymRoster.boards = [];

    const { container } = render(panelElement({ onSelectGymWall: noop }));

    expect(headerTitle(container)).toBeNull();
  });

  // The same panel draws the iPad wall kiosk. A board switcher on a display
  // mounted to a wall lets a passer-by repoint the gym's screen with no way back.
  it('never offers the switch on the inline kiosk column', () => {
    gymRoster.boards = [sibling];

    const { container } = render(panelElement({ variant: 'column', onSelectGymWall: noop }));

    expect(headerTitle(container)).toBeNull();
    expect(container.querySelector('[data-gym-wall-switcher]')).toBeNull();
  });
});
