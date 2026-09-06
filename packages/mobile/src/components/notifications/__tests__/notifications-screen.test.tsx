// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GroupedNotification } from '@boardsesh/shared-schema';

type Query = {
  data?: { pages: Array<{ groups: GroupedNotification[]; hasMore: boolean; unreadCount: number }> };
  isPending: boolean;
  isError: boolean;
  isRefetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
  fetchNextPage: () => void;
};

const fetchNextPage = vi.hoisted(() => vi.fn());
const refetch = vi.hoisted(() => vi.fn());
const markGroupMutate = vi.hoisted(() => vi.fn());
const markAllMutate = vi.hoisted(() => vi.fn());
const openPlayDrawer = vi.hoisted(() => vi.fn());
const openClimbInPlayDrawer = vi.hoisted(() => vi.fn());

// Mutable slices each test dials in.
const state = vi.hoisted(() => ({
  query: null as unknown as Query,
  unreadCount: 0,
  offline: { isOffline: false, isBlocked: false, reason: null as null | 'offline' | 'error' },
}));

// The FlashList props the screen last handed down, so the perf test can compare
// `renderItem` / `keyExtractor` identities across renders and the pagination
// test can fire `onEndReached` directly.
const list = vi.hoisted(() => ({
  renderItem: null as unknown,
  keyExtractor: null as unknown,
  onEndReached: null as null | (() => void),
}));

// Captures navigation.setOptions so the headerRight assertions can read back
// what the native header was given.
const navMock = vi.hoisted(() => ({ setOptions: vi.fn() }));

// The last props the CommentSheet was rendered with — `entityId` is null while
// the sheet is closed, so it doubles as the open/closed signal.
const commentSheet = vi.hoisted(() => ({ entityId: null as string | null, entityType: '' }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// `useRouter` hands back one stable object, matching expo-router: its
// implementation returns the module-level imperative api, not a fresh handle.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('expo-router', () => ({
  useNavigation: () => navMock,
  useRouter: () => routerMock,
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
  RefreshControl: () => createElement('div', { 'data-refresh': 'true' }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: 'ios' },
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: GroupedNotification[];
    renderItem: (info: { item: GroupedNotification }) => ReactNode;
    keyExtractor: (group: GroupedNotification) => string;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
  }) => {
    list.renderItem = props.renderItem;
    list.keyExtractor = props.keyExtractor;
    list.onEndReached = props.onEndReached ?? null;
    const rows = props.data ?? [];
    return createElement(
      'div',
      { 'data-list': 'true' },
      rows.length > 0
        ? rows.map((item) => createElement('div', { key: item.uuid }, props.renderItem({ item })))
        : props.ListEmptyComponent,
      props.ListFooterComponent,
    );
  },
}));

vi.mock('../../../lib/graphql/hooks/use-notifications', () => ({
  useGroupedNotifications: () => state.query,
  useUnreadNotificationCount: () => state.unreadCount,
  // Stable objects: an unstable `mutate` would churn the nav callback and, with
  // it, `renderItem` — which is exactly what the perf test measures.
  useMarkGroupAsRead: () => ({ mutate: markGroupMutate }),
  useMarkAllAsRead: () => ({ mutate: markAllMutate }),
}));

vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => state.offline }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: '#fff', tertiaryLabel: '#999', label: '#000' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 5: 20, 8: 32, 16: 64 } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#FF3B30' } }));

// The nav hook under test is NOT mocked — the mark-then-navigate assertions run
// the real implementation. Its own dependencies are.
// One stable result object, matching React Query: `.data` keeps its identity
// until the cache entry actually changes.
const activeBoardMock = vi.hoisted(() => ({
  data: { boardType: 'kilter', angle: 45, layoutId: 8, sizeId: 25, setIds: '1,20' },
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => activeBoardMock }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer }) }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer }));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason }: { reason: string }) => createElement('div', { 'data-offline': reason }),
}));
// The real sheet reaches @expo/ui's native bottom sheet; the screen only owns
// WHICH thread it is pointed at, so capture the props and assert on those.
vi.mock('../../you/CommentSheet', () => ({
  CommentSheet: (props: { entityId: string | null; entityType: string }) => {
    commentSheet.entityId = props.entityId;
    commentSheet.entityType = props.entityType;
    return createElement('div', { 'data-comment-sheet': props.entityId ?? 'closed' });
  },
}));

vi.mock('../NotificationRow', () => ({
  NotificationRow: ({
    notification,
    onPress,
  }: {
    notification: GroupedNotification;
    onPress: (notification: GroupedNotification) => void;
  }) => createElement('button', { 'data-row': notification.uuid, onClick: () => onPress(notification) }),
}));

import NotificationsScreen from '../NotificationsScreen';

function makeNotification(overrides: Partial<GroupedNotification> = {}): GroupedNotification {
  return {
    uuid: 'n1',
    type: 'new_follower',
    entityType: null,
    entityId: null,
    actorCount: 1,
    actors: [{ id: 'u1', displayName: 'Alex', avatarUrl: null }],
    commentBody: null,
    climbName: null,
    climbUuid: null,
    boardType: null,
    proposalUuid: null,
    setterUsername: null,
    gymName: null,
    isRead: false,
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  } as GroupedNotification;
}

function makeQuery(overrides: Partial<Query> = {}): Query {
  return {
    data: { pages: [{ groups: [], hasMore: false, unreadCount: 0 }] },
    isPending: false,
    isError: false,
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch,
    fetchNextPage,
    ...overrides,
  };
}

/** The headerRight the screen last handed the native header. */
function lastHeaderRight(): unknown {
  const options = navMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
  return options?.headerRight;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.query = makeQuery();
  state.unreadCount = 0;
  state.offline = { isOffline: false, isBlocked: false, reason: null };
  list.renderItem = null;
  list.keyExtractor = null;
  list.onEndReached = null;
  commentSheet.entityId = null;
  commentSheet.entityType = '';
});

describe('NotificationsScreen states', () => {
  it('renders the empty copy when the list came back empty', () => {
    const { container, queryByText } = render(<NotificationsScreen />);
    expect(queryByText('empty')).not.toBeNull();
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('renders the spinner while pending, not the empty copy', () => {
    state.query = makeQuery({ data: undefined, isPending: true, status: 'pending', fetchStatus: 'fetching' });
    const { container, queryByText } = render(<NotificationsScreen />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(queryByText('empty')).toBeNull();
  });

  it('renders OfflineState when the query is blocked with no data', () => {
    // The permanent-spinner bug: offlineFirst PAUSES the query, so `isPending`
    // never clears and a spinner-only branch would hang forever.
    state.query = makeQuery({ data: undefined, isPending: true, status: 'pending', fetchStatus: 'paused' });
    state.offline = { isOffline: true, isBlocked: true, reason: 'offline' };
    const { container } = render(<NotificationsScreen />);
    expect(container.querySelector('[data-offline="offline"]')).not.toBeNull();
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('renders the load error with a retry that refetches', () => {
    state.query = makeQuery({ data: undefined, isError: true, status: 'error' });
    const { getByText, queryByText } = render(<NotificationsScreen />);
    expect(queryByText('errors.load')).not.toBeNull();

    fireEvent.click(getByText('actions.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationsScreen mark all as read', () => {
  it('hides the headerRight action when nothing is unread', () => {
    state.unreadCount = 0;
    render(<NotificationsScreen />);
    expect(lastHeaderRight()).toBeUndefined();
  });

  it('offers the headerRight action once something is unread', () => {
    state.unreadCount = 3;
    state.query = makeQuery({ data: { pages: [{ groups: [makeNotification()], hasMore: false, unreadCount: 3 }] } });
    render(<NotificationsScreen />);
    expect(lastHeaderRight()).toBeTypeOf('function');
  });

  it('withholds the action while the count has resolved but the list has not', () => {
    // Mirrors web's `groupedNotifications.length > 0 && unreadCount > 0`: the
    // unread count is its own query and settles first, so without the list gate
    // "Mark all as read" floats over an empty screen on first paint.
    state.unreadCount = 3;
    state.query = makeQuery({ data: undefined, isPending: true, status: 'pending', fetchStatus: 'fetching' });
    render(<NotificationsScreen />);
    expect(lastHeaderRight()).toBeUndefined();
  });
});

describe('NotificationsScreen row taps', () => {
  it('marks an unread group read and then navigates', () => {
    const notification = makeNotification({ uuid: 'unread-1' });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 1 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="unread-1"]')!);

    expect(markGroupMutate).toHaveBeenCalledWith(notification);
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/users/[userId]', params: { userId: 'u1' } });
  });

  it('navigates without a mutation when the group is already read', () => {
    const notification = makeNotification({ uuid: 'read-1', isRead: true });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="read-1"]')!);

    expect(markGroupMutate).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });

  it("opens a climb notification on the CLIMB's layout, not the board's first layout", () => {
    // The regression this guards: dropping `climbLayoutId` sends every climb
    // through `getDefaultRenderBoard`, which falls back to `getAllLayouts(board)[0]`
    // — layout 9 for tension. `climb(uuid, layoutId)` filters on the layout, so a
    // Tension Board 2 climb (layout 10) would resolve to null and dead-end the
    // user on "climb not found".
    const notification = makeNotification({
      uuid: 'climb-tb2',
      type: 'new_climb',
      climbUuid: 'C-TB2',
      boardType: 'tension',
      climbLayoutId: 10,
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="climb-tb2"]')!);

    // A different board from the reader's kilter, so no size/sets ride along and
    // the angle falls to the tension default.
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      {
        kind: 'ref',
        climbUuid: 'C-TB2',
        boardType: 'tension',
        layoutId: 10,
        angle: 40,
        sizeId: undefined,
        setIds: undefined,
      },
      expect.objectContaining({ openPlayDrawer }),
    );
  });

  it("carries the reader's own size and sets when the climb is on their layout", () => {
    const notification = makeNotification({
      uuid: 'climb-mine',
      type: 'new_climb',
      climbUuid: 'C1',
      boardType: 'kilter',
      climbLayoutId: 8,
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="climb-mine"]')!);

    // Same board AND same layout as the active board, so the climb draws on the
    // reader's actual wall rather than the layout's biggest size. The climb
    // carries no angle of its own, so the reader's 45° wins.
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      { kind: 'ref', climbUuid: 'C1', boardType: 'kilter', layoutId: 8, angle: 45, sizeId: 25, setIds: '1,20' },
      expect.objectContaining({ openPlayDrawer }),
    );
  });

  it("prefers the setter's fixed angle over the reader's board angle", () => {
    const notification = makeNotification({
      uuid: 'climb-angled',
      type: 'new_climb',
      climbUuid: 'C2',
      boardType: 'kilter',
      climbLayoutId: 8,
      climbAngle: 50,
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="climb-angled"]')!);

    // 50 is where this climb's grade and stats live; the reader's 45 would render
    // it ungraded.
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'C2', angle: 50 }),
      expect.objectContaining({ openPlayDrawer }),
    );
  });

  it("falls back to the reader's board layout when the server sends no climbLayoutId", () => {
    // An OTA'd client briefly ahead of the backend deploy: the field is absent,
    // so the same-board fallback still beats guessing layout 1.
    const notification = makeNotification({
      uuid: 'climb-legacy',
      type: 'new_climb',
      climbUuid: 'C3',
      boardType: 'kilter',
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="climb-legacy"]')!);

    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      expect.objectContaining({ climbUuid: 'C3', layoutId: 8, angle: 45 }),
      expect.objectContaining({ openPlayDrawer }),
    );
  });

  it('marks read without navigating for a comment notification (no climbUuid)', () => {
    // The resolver never enriches comment_* groups with a climbUuid, so web's
    // climb branch is dead for them too.
    const notification = makeNotification({ uuid: 'comment-1', type: 'comment_on_tick' });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 1 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="comment-1"]')!);

    expect(markGroupMutate).toHaveBeenCalledWith(notification);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });
});

describe('NotificationsScreen thread rows', () => {
  // The regression this guards: these five types used to mark themselves read
  // and go NOWHERE, because the resolver never gave them a climbUuid and the
  // climb branch was the only fallback.
  const threadCases = [
    { type: 'comment_on_tick', threadEntityType: 'tick', threadEntityId: 'tick-9' },
    { type: 'comment_reply', threadEntityType: 'session', threadEntityId: 'session-2' },
    { type: 'comment_on_climb', threadEntityType: 'climb', threadEntityId: 'climb-4' },
    { type: 'vote_on_tick', threadEntityType: 'tick', threadEntityId: 'tick-9' },
    // A vote names the COMMENT; the resolver walks it to the thread it sits in,
    // which is what the row must open.
    { type: 'vote_on_comment', threadEntityType: 'tick', threadEntityId: 'tick-9' },
  ] as const;

  for (const { type, threadEntityType, threadEntityId } of threadCases) {
    it(`opens the comment thread for ${type}`, () => {
      const notification = makeNotification({
        uuid: `thread-${type}`,
        type,
        entityType: type === 'vote_on_comment' ? 'comment' : threadEntityType,
        entityId: type === 'vote_on_comment' ? 'comment-3' : threadEntityId,
        threadEntityType,
        threadEntityId,
        isRead: true,
      });
      state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

      const { container } = render(<NotificationsScreen />);
      fireEvent.click(container.querySelector(`[data-row="thread-${type}"]`)!);

      expect(commentSheet.entityId).toBe(threadEntityId);
      expect(commentSheet.entityType).toBe(threadEntityType);
      // The thread is the destination — it must not also push a route.
      expect(routerMock.push).not.toHaveBeenCalled();
      expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
    });
  }

  it('stays put when the backend has not resolved a thread yet', () => {
    // An OTA'd client briefly ahead of the backend deploy: no threadEntity, so
    // the row marks read and does nothing rather than opening an empty sheet.
    const notification = makeNotification({ uuid: 'thread-none', type: 'vote_on_comment', isRead: true });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="thread-none"]')!);

    expect(commentSheet.entityId).toBeNull();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('does not open a thread for a climb row', () => {
    const notification = makeNotification({
      uuid: 'climb-row',
      type: 'new_climb',
      climbUuid: 'C-1',
      boardType: 'kilter',
      climbLayoutId: 8,
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="climb-row"]')!);

    expect(commentSheet.entityId).toBeNull();
    expect(openClimbInPlayDrawer).toHaveBeenCalled();
  });
});

describe('NotificationsScreen follower rows', () => {
  it('opens the one follower profile when there is only one', () => {
    const notification = makeNotification({ uuid: 'follow-1', actorCount: 1, isRead: true });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="follow-1"]')!);

    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/users/[userId]', params: { userId: 'u1' } });
  });

  it('opens the follow-back list when several people followed you', () => {
    // A group carries only its first three actors, so the profile of actors[0]
    // strands everyone else — the list re-fetches them all by group key.
    const notification = makeNotification({
      uuid: 'follow-many',
      actorCount: 5,
      actors: [
        { id: 'u1', displayName: 'Alex', avatarUrl: null },
        { id: 'u2', displayName: 'Sam', avatarUrl: null },
        { id: 'u3', displayName: 'Nic', avatarUrl: null },
      ],
      isRead: true,
    });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="follow-many"]')!);

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/users/connections',
      params: { mode: 'newFollowers' },
    });
  });

  it('opens the follow-back list when every follower has since been deleted', () => {
    // `actor_id` is ON DELETE SET NULL and the resolver drops null actors, so a
    // group can arrive with actorCount 0 and no actors at all. The list (which
    // has its own empty state) is the right landing — a profile push would go
    // to `/users/undefined`.
    const notification = makeNotification({ uuid: 'follow-none', actorCount: 0, actors: [], isRead: true });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="follow-none"]')!);

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/users/connections',
      params: { mode: 'newFollowers' },
    });
  });

  it('opens the follow-back list when the single follower is gone', () => {
    // actorCount says 1, but the actor row is gone — the profile branch must not
    // fire with an undefined id.
    const notification = makeNotification({ uuid: 'follow-gone', actorCount: 1, actors: [], isRead: true });
    state.query = makeQuery({ data: { pages: [{ groups: [notification], hasMore: false, unreadCount: 0 }] } });

    const { container } = render(<NotificationsScreen />);
    fireEvent.click(container.querySelector('[data-row="follow-gone"]')!);

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/users/connections',
      params: { mode: 'newFollowers' },
    });
  });
});

describe('NotificationsScreen pagination', () => {
  it('fetches exactly one page per end-reach', () => {
    state.query = makeQuery({
      data: { pages: [{ groups: [makeNotification()], hasMore: true, unreadCount: 0 }] },
      hasNextPage: true,
    });

    render(<NotificationsScreen />);
    list.onEndReached?.();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('ignores an end-reach while a page is already in flight', () => {
    state.query = makeQuery({
      data: { pages: [{ groups: [makeNotification()], hasMore: true, unreadCount: 0 }] },
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    render(<NotificationsScreen />);
    list.onEndReached?.();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});

describe('NotificationsScreen perf checklist', () => {
  it('keeps renderItem and keyExtractor referentially stable across a page append and an unread change', () => {
    const first = makeNotification({ uuid: 'n1' });
    state.query = makeQuery({
      data: { pages: [{ groups: [first], hasMore: true, unreadCount: 1 }] },
      hasNextPage: true,
    });
    state.unreadCount = 1;

    const { rerender } = render(<NotificationsScreen />);
    const initialRenderItem = list.renderItem;
    const initialKeyExtractor = list.keyExtractor;
    expect(initialRenderItem).toBeTypeOf('function');

    // A second page lands AND the unread count moves — the two things that
    // would invalidate `renderItem` if its dep list mentioned the data array's
    // `.length` or the count.
    state.query = makeQuery({
      data: {
        pages: [
          { groups: [first], hasMore: true, unreadCount: 1 },
          { groups: [makeNotification({ uuid: 'n2' })], hasMore: false, unreadCount: 0 },
        ],
      },
    });
    state.unreadCount = 0;
    rerender(<NotificationsScreen />);

    expect(list.renderItem).toBe(initialRenderItem);
    expect(list.keyExtractor).toBe(initialKeyExtractor);
  });
});
