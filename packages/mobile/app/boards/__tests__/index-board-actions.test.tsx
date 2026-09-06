// @vitest-environment jsdom
//
// #4623: "Change board" and "My Boards" were two drawer rows with the same glyph
// and the same chevron onto two screens showing the same boards with disjoint
// affordances. /boards now carries the board actions, so this suite pins the
// three things that move: the per-card ownership action, Edit/Done, and the fact
// that a picker opened mid-session must still switch boards when the identity
// lookup fails.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress?: () => void };
type CarouselItem = { key: string; title: string; isViewerOwner?: boolean };
type CarouselProps = {
  items: CarouselItem[];
  onSelect: (item: CarouselItem) => void;
  actionFor?: (item: CarouselItem) => string | null;
  actionLabelFor?: (item: CarouselItem) => string;
  onAction?: (item: CarouselItem) => void;
  isEditing?: boolean;
  pendingActionKey?: string | null;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deleteBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const unfollowBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const forgetOfflineBoardMock = vi.hoisted(() => vi.fn());
// The last props the carousel was handed, so ownership can be asserted on the
// ITEMS (stamped once at list build) rather than inferred from what rendered.
const carouselProps = vi.hoisted(() => ({ last: null as CarouselProps | null }));

const state = vi.hoisted(() => ({
  source: undefined as string | undefined,
  profile: { id: 'me' } as { id: string } | undefined,
  storedUserId: undefined as string | undefined,
  activeBoard: undefined as unknown,
  myBoards: [] as unknown[],
  deletePending: null as string | null,
  unfollowPending: null as string | null,
}));

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '20,21',
    angle: 40,
    sizeName: '12 x 12',
    isOwned: true,
    ownerId: 'me',
    ...overrides,
  }) as unknown as UserBoard;

const myWall = board({ uuid: 'mine', name: 'Marco garage', ownerId: 'me' });
// canEdit true on a board the viewer does NOT own is the gym-admin / moderator
// case: gating the slot on canEdit would show them a pencil where the issue asks
// for Following, and take away their one-tap unfollow.
const gymBoard = board({
  uuid: 'gym',
  name: 'High Point Orlando',
  ownerId: 'someone-else',
  isOwned: false,
  canEdit: true,
} as Partial<UserBoard> & { uuid: string; name: string });

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  ScrollView: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({ source: state.source }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const map: Record<string, string> = {
        'mobile.discovery.yourBoardsTitle': 'Your boards',
        'mobile.discovery.popularTitle': 'Popular',
        'mobile.discovery.create': 'Create',
        'mobile.discovery.findNearby': 'Find nearby',
        'mobile.discovery.bluetooth': 'Bluetooth',
        'mobile.discovery.findGym': 'Find a gym',
        'mobile.manage.edit': 'Edit',
        'mobile.manage.done': 'Done',
        'mobile.manage.editAria': 'Edit {{name}}',
        'mobile.manage.deleteAria': 'Delete {{name}}',
        'mobile.manage.unfollowAria': 'Unfollow {{name}}',
        'mobile.manage.deleteTitle': 'Delete board?',
        'mobile.manage.deleteConfirm': 'Delete',
        'mobile.manage.unfollowTitle': 'Stop following?',
        'mobile.manage.unfollowConfirm': 'Unfollow',
        'mobile.manage.deleteError': "Couldn't delete that board. Try again.",
        'mobile.manage.unfollowError': "Couldn't unfollow that board. Try again.",
        'mobile.boardSwitchError': 'Could not switch board',
        'mobile.errorTitle': 'Something went wrong',
        'mobile.emptyTitle': 'No boards yet',
        'mobile.emptySubtitle': 'Search for a board to get started',
        'myBoards.title': 'Manage boards',
      };
      const template = map[key] ?? key;
      return options?.name === undefined ? template : template.replace('{{name}}', options.name);
    },
  }),
}));

vi.mock('expo-sqlite', () => ({ useSQLiteContext: () => ({}) }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [] }) }));
vi.mock('@boardsesh/offline-sync', () => ({
  getDownloadedScopeKeys: vi.fn(async () => []),
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));

vi.mock('../../../src/lib/graphql/hooks', () => ({
  useMyBoards: () => ({
    data: { boards: state.myBoards },
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
  usePopularBoardConfigs: () => ({ data: { configs: [] } }),
  useNearbyBoards: () => ({ data: undefined, isLoading: false }),
  useProfile: () => ({ data: state.profile }),
  useDeleteBoard: () => ({
    mutateAsync: deleteBoardMock,
    isPending: state.deletePending !== null,
    variables: state.deletePending ?? undefined,
  }),
  useUnfollowBoard: () => ({
    mutateAsync: unfollowBoardMock,
    isPending: state.unfollowPending !== null,
    variables: state.unfollowPending ?? undefined,
  }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoard: () => clearActiveBoardMock,
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: state.storedUserId, isLoading: false }),
}));

vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'idle', coords: undefined, request: vi.fn() }),
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { tertiaryLabel: '#999' } }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, reason: null }),
}));
vi.mock('../../../src/settings', () => ({
  useOfflineBoards: () => [],
  useSetting: () => [[], vi.fn()],
  forgetOfflineBoard: forgetOfflineBoardMock,
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));
vi.mock('../../../src/components/offline/OfflineCatalogCta', () => ({ OfflineCatalogCta: () => null }));
vi.mock('../../../src/offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: vi.fn(async () => true), armWithoutConfirm: vi.fn() }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock('../../../src/offline/use-downloaded-scope-keys', () => ({ useDownloadedScopeKeys: () => ({ data: [] }) }));
vi.mock('../../../src/offline/use-offline-catalog-state', () => ({ useOfflineCatalogState: () => null }));
vi.mock('../../../src/offline/use-remember-downloaded-boards', () => ({ useRememberDownloadedBoards: vi.fn() }));

vi.mock('../../../src/theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 } }));
vi.mock('../../../src/theme/ios-colors', () => ({
  iosSystemColors: { systemGray: '#8e8e93', systemRed: '#f00' },
}));

vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../../src/components/Button', () => ({
  Button: ({ title, onPress }: ButtonProps) => createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/components/board-discovery/BoardModeCard', () => ({
  BoardModeCard: ({ label }: { label: string }) => createElement('div', { 'data-mode-card': label }, label),
}));
vi.mock('../../../src/components/board-discovery/BluetoothQuickstartSheet', () => ({
  BluetoothQuickstartSheet: () => null,
}));
// Captures the props rather than rendering a card, so the item flags and the
// resolved per-card action are both assertable.
vi.mock('../../../src/components/board-discovery/BoardCarousel', () => ({
  BoardCarousel: (props: CarouselProps) => {
    carouselProps.last = props;
    return createElement(
      'div',
      { 'data-testid': 'carousel' },
      props.items.map((item) =>
        createElement('span', { key: item.key }, [
          createElement('button', { key: 'select', type: 'button', onClick: () => props.onSelect(item) }, item.title),
          props.actionFor && props.onAction
            ? createElement(
                'button',
                { key: 'action', type: 'button', onClick: () => props.onAction?.(item) },
                `${props.actionFor(item) ?? 'none'} ${item.title}`,
              )
            : null,
        ]),
      ),
    );
  },
}));

const { default: BoardSelection } = await import('../index');

beforeEach(() => {
  vi.clearAllMocks();
  deleteBoardMock.mockResolvedValue(undefined);
  unfollowBoardMock.mockResolvedValue(undefined);
  confirmMock.mockResolvedValue(true);
  carouselProps.last = null;
  state.source = undefined;
  state.profile = { id: 'me' };
  state.storedUserId = undefined;
  state.activeBoard = undefined;
  state.myBoards = [myWall, gymBoard];
  state.deletePending = null;
  state.unfollowPending = null;
});

describe('the per-card ownership action', () => {
  it('opens the edit form for a board the viewer owns', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'edit Marco garage' }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards/edit', params: { boardUuid: 'mine' } });
  });

  // The gym-admin pin: canEdit is true on this board and it must NOT produce a
  // pencil, because inside myBoards `canEdit && !isViewerOwner` is exactly the
  // followed-board case.
  it('offers unfollow, never edit, on a board the viewer only follows', () => {
    render(createElement(BoardSelection));
    expect(screen.getByRole('button', { name: 'unfollow High Point Orlando' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'edit High Point Orlando' })).toBeNull();
  });

  // Ownership is stamped once per list build, so a virtualized row never scans
  // back into myBoards for it.
  it('hands the carousel items that already carry the ownership flag', () => {
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.map((item) => [item.key, item.isViewerOwner])).toEqual([
      ['mine', true],
      ['gym', false],
    ]);
  });

  it('leads with the boards the viewer owns', () => {
    state.myBoards = [gymBoard, myWall];
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['mine', 'gym']);
  });

  it('labels the action for a screen reader', () => {
    render(createElement(BoardSelection));
    expect(carouselProps.last?.actionLabelFor?.({ key: 'mine', title: 'Marco garage', isViewerOwner: true })).toBe(
      'Edit Marco garage',
    );
    expect(
      carouselProps.last?.actionLabelFor?.({ key: 'gym', title: 'High Point Orlando', isViewerOwner: false }),
    ).toBe('Unfollow High Point Orlando');
  });

  it('reports the in-flight board so only that card shows a spinner', () => {
    state.deletePending = 'mine';
    render(createElement(BoardSelection));
    expect(carouselProps.last?.pendingActionKey).toBe('mine');
  });

  it('reports no in-flight board at rest', () => {
    render(createElement(BoardSelection));
    expect(carouselProps.last?.pendingActionKey).toBeNull();
  });
});

describe('the Edit / Done control', () => {
  it('turns the slot destructive for owned and unfollow for followed', () => {
    render(createElement(BoardSelection));
    expect(screen.getByRole('button', { name: 'edit Marco garage' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('button', { name: 'delete Marco garage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'unfollow High Point Orlando' })).toBeTruthy();
    expect(carouselProps.last?.isEditing).toBe(true);
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('does not render with no boards to manage', () => {
    state.myBoards = [];
    render(createElement(BoardSelection));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  // The first screen a brand-new account ever sees. A destructive mode has no
  // business being one tap into it.
  it('does not render in the onboarding hand-off', () => {
    state.source = 'onboarding';
    render(createElement(BoardSelection));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  // The gate covers the per-card slot too, not just the toggle. Gating only the
  // toggle would have left a followed board's glyph live during onboarding — and
  // for as long as that glyph was a Pressable, that was a one-tap unfollow.
  it('takes the per-card action slot with it, not just the toggle', () => {
    state.source = 'onboarding';
    render(createElement(BoardSelection));

    expect(carouselProps.last?.actionFor).toBeUndefined();
    expect(carouselProps.last?.onAction).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'edit Marco garage' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'unfollow High Point Orlando' })).toBeNull();
    // Switching boards is the whole point of the onboarding hand-off and must
    // still work.
    expect(screen.getByRole('button', { name: 'Marco garage' })).toBeTruthy();
  });

  it('does not render when no identity resolved', () => {
    state.profile = undefined;
    state.storedUserId = undefined;
    render(createElement(BoardSelection));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(carouselProps.last?.actionFor).toBeUndefined();
  });

  it('stops a card tap from switching the board while editing', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Marco garage' }));
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
  });
});

describe('deleting a board', () => {
  it('confirms, deletes, forgets the offline snapshot and leaves edit mode', async () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledWith('mine'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(forgetOfflineBoardMock).toHaveBeenCalledWith('mine');
    // Not the active board, so the selection is left alone.
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
    // The carousel has just reflowed under a finger still over a red button.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy());
  });

  it('clears the selection when the deleted board was the active one', async () => {
    state.activeBoard = myWall;
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(clearActiveBoardMock).toHaveBeenCalledTimes(1));
  });

  it('does nothing when the confirm is declined', async () => {
    confirmMock.mockResolvedValue(false);
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(deleteBoardMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure instead of silently leaving the board in place', async () => {
    deleteBoardMock.mockRejectedValue(new Error('nope'));
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() =>
      expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't delete that board. Try again.", 'error'),
    );
    // The board is still on the server, so its offline snapshot must survive.
    expect(forgetOfflineBoardMock).not.toHaveBeenCalled();
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
  });
});

describe('unfollowing a board', () => {
  it('runs with no confirm on a board that is not active', async () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() => expect(unfollowBoardMock).toHaveBeenCalledWith('gym'));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(forgetOfflineBoardMock).toHaveBeenCalledWith('gym');
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
  });

  // The one unfollow with a side effect beyond the list, and the one that bites
  // mid-session.
  it('confirms first when it would clear the active board', async () => {
    state.activeBoard = gymBoard;
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() => expect(unfollowBoardMock).toHaveBeenCalledWith('gym'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(clearActiveBoardMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when that confirm is declined', async () => {
    state.activeBoard = gymBoard;
    confirmMock.mockResolvedValue(false);
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure', async () => {
    unfollowBoardMock.mockRejectedValue(new Error('nope'));
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() =>
      expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't unfollow that board. Try again.", 'error'),
    );
  });
});

describe('the drill-in to the manage screen', () => {
  it('reaches the full list from under the carousel', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Manage boards' }));
    expect(routerMock.push).toHaveBeenCalledWith('/boards/manage');
  });

  it('disappears with the section when there is nothing to manage', () => {
    state.myBoards = [];
    render(createElement(BoardSelection));
    expect(screen.queryByRole('button', { name: 'Manage boards' })).toBeNull();
  });
});

// The single most likely regression: /boards is a modal switcher pushed from
// twelve places, most of them mid-task. Adding two identity queries must never
// add a blocking state the way /boards/manage has one.
describe('identity resolution never blocks the switcher', () => {
  it('still lists and activates boards with no resolvable user id', async () => {
    state.profile = undefined;
    state.storedUserId = undefined;

    render(createElement(BoardSelection));

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(screen.getByTestId('carousel')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Marco garage' }));
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledTimes(1));
  });

  // Degraded means "no ownership slot", not "everything looks followed" — the
  // latter would offer to unfollow the user's own wall.
  it('offers no per-card action with no resolvable user id', async () => {
    state.profile = undefined;
    state.storedUserId = undefined;

    render(createElement(BoardSelection));

    expect(carouselProps.last?.items.every((item) => item.isViewerOwner === undefined)).toBe(true);
    // Suppressed at the screen, so no slot reaches a card at all.
    expect(carouselProps.last?.actionFor).toBeUndefined();
    expect(carouselProps.last?.onAction).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'none Marco garage' })).toBeNull();
  });

  // Defence in depth, independent of the screen-level gate above: hand the
  // handler an item whose ownership never resolved and it must run nothing,
  // rather than let `undefined` collapse into "followed" and unfollow the user's
  // own wall.
  it('refuses to act on an item whose ownership did not resolve', async () => {
    render(createElement(BoardSelection));

    const onAction = carouselProps.last?.onAction;
    expect(onAction).toBeTypeOf('function');
    onAction?.({ key: 'mine', title: 'Marco garage' });

    await waitFor(() => expect(carouselProps.last?.pendingActionKey).toBeNull());
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(deleteBoardMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/boards/edit' }));
  });

  it('falls back to the id this device already has when the profile is missing', () => {
    state.profile = undefined;
    state.storedUserId = 'me';

    render(createElement(BoardSelection));

    expect(screen.getByRole('button', { name: 'edit Marco garage' })).toBeTruthy();
  });
});
