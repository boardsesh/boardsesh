// @vitest-environment jsdom
vi.mock('../../../src/components/AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../src/hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../../src/components/PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
//
// #4623: "Change board" and "My Boards" were two drawer rows with the same glyph
// and the same chevron onto two screens showing the same boards with disjoint
// affordances. /boards now carries the board actions, in each card's menu (the
// ⋯ and the hold), so this suite pins what the menu offers where, what each row
// does, and the fact that a picker opened mid-session must still switch boards
// when the identity lookup fails.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type {
  BoardCardMenuAction,
  BoardCardMenuCapabilities,
  BoardCardMenuVia,
} from '../../../src/components/board-discovery/board-card-menu';
import type { DiscoveryBoardItem } from '../../../src/components/board-discovery/BoardDiscoveryCard';

type Children = { children?: ReactNode };
type ButtonProps = { title: string; onPress?: () => void };
type CarouselItem = Pick<
  DiscoveryBoardItem,
  'key' | 'title' | 'isViewerOwner' | 'isPinned' | 'offlineState' | 'sprayImport'
>;
type CarouselProps = {
  items: CarouselItem[];
  onSelect: (item: CarouselItem) => void;
  menuCapabilities?: BoardCardMenuCapabilities;
  onMenuAction?: (item: CarouselItem, action: BoardCardMenuAction, via: BoardCardMenuVia) => void;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearSessionMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deleteBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const unfollowBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const pinBoardMock = vi.hoisted(() => vi.fn());
// The screen passes usePinBoard an onPinError callback; capturing it is how the
// rollback-on-failure path gets exercised without a real mutation.
const pinBoardOptions = vi.hoisted(() => ({
  last: null as { onPinError?: (boardUuid: string, error: unknown) => void } | null,
}));
const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const forgetOfflineBoardMock = vi.hoisted(() => vi.fn());
const confirmAndDownloadMock = vi.hoisted(() => vi.fn(async () => true));
// The last props the carousel was handed, so ownership can be asserted on the
// ITEMS (stamped once at list build) rather than inferred from what rendered.
type DetailProps = {
  board: UserBoard | null;
  visible: boolean;
  onClose: () => void;
  onSetActive: (board: UserBoard) => void;
};
const detailProps = vi.hoisted(() => ({ last: null as DetailProps | null }));
// The last props each carousel was handed, keyed by its first item, so Your
// boards and Near you can be told apart when both render.
const carouselProps = vi.hoisted(() => ({
  last: null as CarouselProps | null,
  byFirstKey: new Map<string, CarouselProps>(),
}));
const trackMock = vi.hoisted(() => vi.fn());
// The In range slot: the scan the screen reads, and the section's props, so a
// pick from it can be driven directly.
const scanCtrl = vi.hoisted(() => ({
  phase: 'hidden' as string,
  rows: [] as unknown[],
  stop: vi.fn(),
}));
const inRangeProps = vi.hoisted(() => ({
  last: null as {
    view: { content: { kind: string; board?: { key: string } } };
    onPickBoard: (item: { key: string }) => void;
  } | null,
}));
const alsoAtProps = vi.hoisted(() => ({
  last: null as { anchor: UserBoard; onSelectBoard: (board: UserBoard) => void } | null,
}));
const navigationMock = vi.hoisted(() => ({ setOptions: vi.fn() }));

const state = vi.hoisted(() => ({
  isAuthenticated: true,
  source: undefined as string | undefined,
  profile: { id: 'me' } as { id: string } | undefined,
  storedUserId: undefined as string | undefined,
  activeBoard: undefined as unknown,
  myBoards: [] as unknown[],
  nearbyBoards: [] as unknown[],
  willFollow: false,
  activeBoardGeneration: 0,
  deletePending: null as string | null,
  unfollowPending: null as string | null,
  // A live progress read that no longer lists a wall the board list called an import.
  liveImportCleared: false,
  myBoardsInputs: [] as unknown[],
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
  },
}));

vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueActions: () => ({ clearSession: clearSessionMock }),
}));

vi.mock('../../../src/lib/spray/use-spray-import-progress', () => ({
  useSprayImportProgress: (boards: Array<{ uuid: string; sprayImport?: unknown }>) => ({
    boards: state.liveImportCleared ? boards.map((listed) => ({ ...listed, sprayImport: null })) : boards,
    stale: false,
    unfinishedWallUuids: new Set(boards.filter((listed) => listed.sprayImport).map((listed) => listed.uuid)),
  }),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
  useLocalSearchParams: () => ({ source: state.source }),
  useIsFocused: () => true,
  useNavigation: () => navigationMock,
}));
vi.mock('../../../src/components/board-discovery/use-picker-board-scan', () => ({
  usePickerBoardScan: () => ({
    phase: scanCtrl.phase,
    rows: scanCtrl.rows,
    lookup: 'none',
    listenedLongEnough: () => true,
    start: vi.fn(),
    stop: scanCtrl.stop,
    openSettings: vi.fn(),
    retryLookup: vi.fn(),
  }),
}));
vi.mock('../../../src/components/board-discovery/use-in-range-location-hint', () => ({
  useInRangeLocationHint: () => null,
}));
vi.mock('../../../src/components/board-discovery/InRangeSection', () => ({
  InRangeSection: (props: NonNullable<(typeof inRangeProps)['last']>) => {
    inRangeProps.last = props;
    return null;
  },
}));
vi.mock('../../../src/components/board-discovery/AlsoAtGymSection', () => ({
  AlsoAtGymSection: (props: NonNullable<(typeof alsoAtProps)['last']>) => {
    alsoAtProps.last = props;
    return null;
  },
}));
// The + in the top bar: one button per way to add a board.
vi.mock('../../../src/components/board-discovery/AddBoardMenu', () => ({
  AddBoardMenu: ({ onSelect }: { onSelect: (kind: string) => void }) =>
    createElement(
      'div',
      null,
      ['board', 'spraywall', 'gym_map'].map((kind) =>
        createElement('button', { key: kind, type: 'button', onClick: () => onSelect(kind) }, `add ${kind}`),
      ),
    ),
}));
vi.mock('../../../src/components/board-discovery/DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
const clearPendingRecognitionMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/boards/pending-board-recognition', () => ({
  setPendingBoardRecognition: vi.fn(),
  clearPendingBoardRecognition: clearPendingRecognitionMock,
  consumePendingBoardRecognition: vi.fn(async () => {}),
}));

/** Renders whatever the screen last put in the header's trailing slot. */
function renderHeaderPlus() {
  const options = navigationMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: () => ReactElement } | undefined;
  if (options?.headerRight) render(options.headerRight());
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const map: Record<string, string> = {
        'mobile.discovery.yourBoardsTitle': 'Your boards',
        'mobile.manage.deleteTitle': 'Delete board?',
        'mobile.manage.deleteWallTitle': 'Delete spray wall?',
        'mobile.manage.deleteWallMessage':
          'Delete "{{name}}"? Its photos and climbs will no longer be available. This cannot be undone.',
        'mobile.manage.deleteSuccess': '"{{name}}" deleted',
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
        'mobile.discovery.pinError': "Couldn't update your pinned boards",
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
  useMyBoards: (input: unknown) => {
    state.myBoardsInputs.push(input);
    return {
      data: { boards: state.myBoards },
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    };
  },
  useNearbyBoards: () => ({
    data: state.nearbyBoards.length > 0 ? { boards: state.nearbyBoards } : undefined,
    isLoading: false,
  }),
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
  usePinBoard: (options?: { onPinError?: (boardUuid: string, error: unknown) => void }) => {
    pinBoardOptions.last = options ?? null;
    return { mutate: pinBoardMock };
  },
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoardIfCurrentGeneration: () => clearActiveBoardMock,
  getActiveBoardWriteGeneration: () => state.activeBoardGeneration,
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: state.storedUserId, isLoading: false }),
}));

vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => vi.fn().mockResolvedValue(undefined),
  useWillFollowFoundBoard: () => () => state.willFollow,
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({
    status: 'idle',
    coords: undefined,
    request: vi.fn(),
    requestIfAllowed: vi.fn(async () => {}),
    refresh: vi.fn(async () => false),
  }),
}));
// Keep the activation/link decision real while replacing credential and preference I/O.
vi.mock('../../../src/hooks/use-is-offline', () => ({
  useIsOffline: () => false,
}));
vi.mock('../../../src/lib/integrations/use-board-account-credentials', () => ({
  useBoardAccountCredentials: () => ({ data: [] }),
}));
vi.mock('../../../src/lib/onboarding/link-step-answered', () => ({
  hasAnsweredLinkStep: vi.fn(async () => false),
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => toastMock }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { tertiaryLabel: '#999' } }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
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
  useConfirmBoardDownload: () => ({ confirmAndDownload: confirmAndDownloadMock, armWithoutConfirm: vi.fn() }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useFeatureFlag: () => false,
  useOfflineDownloadsEnabled: () => true,
  usePickerAutoScanEnabled: () => true,
}));
vi.mock('../../../src/offline/use-downloaded-scope-keys', () => ({ useDownloadedScopeKeys: () => ({ data: [] }) }));
vi.mock('../../../src/offline/use-offline-catalog-state', () => ({ useOfflineCatalogState: () => null }));
vi.mock('../../../src/offline/use-remember-downloaded-boards', () => ({ useRememberDownloadedBoards: vi.fn() }));

vi.mock('../../../src/theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 8: 32 },
}));
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
// First-board mode (#5654) has its own suite, index-first-board.test.tsx.
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({ FirstBoardChoice: () => null }));
// Captures the props rather than rendering a card, so the item flags and the
// resolved per-card action are both assertable.
vi.mock('../../../src/components/board-discovery/BoardDetailSheet', () => ({
  BoardDetailSheet: (props: DetailProps) => {
    detailProps.last = props;
    return null;
  },
}));

// Renders a select button per card, plus one button per menu row named
// "<action> <title>". The rows come from the real menu builder, so what this
// suite clicks is exactly what the card's ⋯ would offer with these capabilities.
vi.mock('../../../src/components/board-discovery/BoardCarousel', async () => {
  const { boardCardMenuEntries } = await vi.importActual<
    typeof import('../../../src/components/board-discovery/board-card-menu')
  >('../../../src/components/board-discovery/board-card-menu');
  return {
    BoardCarousel: (props: CarouselProps) => {
      carouselProps.last = props;
      if (props.items[0]) carouselProps.byFirstKey.set(props.items[0].key, props);
      return createElement(
        'div',
        { 'data-testid': 'carousel' },
        props.items.map((item) => {
          const rows =
            props.menuCapabilities && props.onMenuAction
              ? boardCardMenuEntries(
                  {
                    isPinned: item.isPinned === true,
                    offlineState: item.offlineState,
                    isViewerOwner: item.isViewerOwner,
                    isImport: item.sprayImport != null,
                  },
                  props.menuCapabilities,
                )
              : [];
          return createElement('span', { key: item.key }, [
            createElement('button', { key: 'select', type: 'button', onClick: () => props.onSelect(item) }, item.title),
            ...rows.map((row) =>
              createElement(
                'button',
                {
                  key: row.action,
                  type: 'button',
                  onClick: () => props.onMenuAction?.(item, row.action, 'menu_button'),
                },
                `${row.action} ${item.title}`,
              ),
            ),
          ]);
        }),
      );
    },
  };
});

const { default: BoardSelection } = await import('../index');

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionMock.mockResolvedValue(undefined);
  deleteBoardMock.mockResolvedValue(undefined);
  unfollowBoardMock.mockResolvedValue(undefined);
  confirmMock.mockResolvedValue(true);
  carouselProps.last = null;
  carouselProps.byFirstKey.clear();
  detailProps.last = null;
  state.isAuthenticated = true;
  scanCtrl.phase = 'hidden';
  scanCtrl.rows = [];
  inRangeProps.last = null;
  alsoAtProps.last = null;
  state.activeBoardGeneration = 0;
  state.source = undefined;
  state.profile = { id: 'me' };
  state.storedUserId = undefined;
  state.activeBoard = undefined;
  state.myBoards = [myWall, gymBoard];
  state.nearbyBoards = [];
  state.willFollow = false;
  state.deletePending = null;
  state.unfollowPending = null;
  state.liveImportCleared = false;
  state.myBoardsInputs = [];
});

describe('pinning from the card menu', () => {
  it('pins a board that is not pinned yet', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'pin High Point Orlando' }));
    expect(pinBoardMock).toHaveBeenCalledWith({ boardUuid: 'gym', pinned: true });
  });

  it('unpins one that is', () => {
    state.myBoards = [{ ...myWall, isPinnedByMe: true }, gymBoard];
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.find((item) => item.key === 'mine')?.isPinned).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'unpin Marco garage' }));
    expect(pinBoardMock).toHaveBeenCalledWith({ boardUuid: 'mine', pinned: false });
  });

  // The regression this whole optimistic design exists for: the glyph flips at
  // once, but the carousel must NOT reorder, or the card slides out from under
  // the menu that just pinned it. The reorder lands on the next open.
  it('flips the pin immediately without moving the card', () => {
    render(createElement(BoardSelection));
    const before = carouselProps.last?.items.map((item) => item.key);
    expect(carouselProps.last?.items.find((item) => item.key === 'gym')?.isPinned).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'pin High Point Orlando' }));

    expect(carouselProps.last?.items.find((item) => item.key === 'gym')?.isPinned).toBe(true);
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(before);
    // The menu now offers the way back.
    expect(screen.getByRole('button', { name: 'unpin High Point Orlando' })).toBeTruthy();
  });

  it('puts the pin back and says so when the pin fails', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'pin High Point Orlando' }));
    expect(carouselProps.last?.items.find((item) => item.key === 'gym')?.isPinned).toBe(true);

    act(() => {
      pinBoardOptions.last?.onPinError?.('gym', new Error('offline'));
    });

    expect(carouselProps.last?.items.find((item) => item.key === 'gym')?.isPinned).toBe(false);
    expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't update your pinned boards", 'error');
  });
});

describe('the card menu on Your boards', () => {
  it('offers every row on a board the viewer owns', () => {
    render(createElement(BoardSelection));
    expect(carouselProps.last?.menuCapabilities).toEqual({
      canPin: true,
      canDownload: true,
      canOpenDetails: true,
      canManage: true,
    });
    for (const action of ['climb_here', 'pin', 'details', 'edit', 'delete']) {
      expect(screen.getByRole('button', { name: `${action} Marco garage` })).toBeTruthy();
    }
  });

  it('opens the edit form for a board the viewer owns', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'edit Marco garage' }));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards/edit', params: { boardUuid: 'mine' } });
  });

  // The gym-admin pin: canEdit is true on this board and it must NOT produce an
  // edit row, because inside myBoards `canEdit && !isViewerOwner` is exactly the
  // followed-board case.
  it('offers unfollow, never edit or delete, on a board the viewer only follows', () => {
    render(createElement(BoardSelection));
    expect(screen.getByRole('button', { name: 'unfollow High Point Orlando' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'edit High Point Orlando' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'delete High Point Orlando' })).toBeNull();
  });

  it('picks the board from Climb here, as a tap does', async () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'climb_here Marco garage' }));
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'mine' })));
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'your_boards' }),
      ),
    );
  });

  // Every row is one Board Card Action, named by the row, the way in, and the
  // carousel it was picked in.
  it('reports each row it runs', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'edit Marco garage' }));
    expect(trackMock).toHaveBeenCalledWith('Board Card Action', {
      action: 'edit',
      via: 'menu_button',
      section: 'your_boards',
    });
    act(() => {
      carouselProps.last?.onMenuAction?.(carouselProps.last.items[1], 'pin', 'long_press');
    });
    expect(trackMock).toHaveBeenCalledWith('Board Card Action', {
      action: 'pin',
      via: 'long_press',
      section: 'your_boards',
    });
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

  // The screen no longer re-partitions by ownership: myBoards arrives ordered by
  // pin, then by when the climber last opened each board (#4884). Re-sorting
  // here would file a pinned gym board behind a wall they own and never touch.
  it('keeps the order the server sent', () => {
    state.myBoards = [gymBoard, myWall];
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['gym', 'mine']);
  });

  // The one thing the server cannot order, because it lives in AsyncStorage on
  // this device.
  it('hoists the active board to the front', () => {
    state.myBoards = [gymBoard, myWall];
    state.activeBoard = { uuid: 'mine' };
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['mine', 'gym']);
  });

  it('never injects a stored active board the list does not contain', () => {
    state.myBoards = [gymBoard, myWall];
    state.activeBoard = { uuid: 'a-board-that-was-deleted' };
    render(createElement(BoardSelection));
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['gym', 'mine']);
  });

  // Edit mode is gone: the section header carries no Edit/Done toggle, and a
  // tap on a card always picks the board.
  it('has no Edit mode', () => {
    render(createElement(BoardSelection));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    expect(screen.queryByText('mobile.manage.edit')).toBeNull();
  });
});

describe('the card menu during onboarding', () => {
  const nearbyWall = board({ uuid: 'nearby', name: 'Crux Kilter', ownerId: 'setter-1', isFollowedByMe: false });

  // The first screen a brand-new account ever sees carries the choice of board
  // and nothing else: no ⋯ and no hold menu on any card, in either carousel.
  it('draws plain cards in both carousels', () => {
    state.source = 'onboarding';
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    const yourBoards = carouselProps.byFirstKey.get('mine');
    const nearby = carouselProps.byFirstKey.get('nearby');
    expect(yourBoards).toBeDefined();
    expect(nearby).toBeDefined();
    for (const carousel of [yourBoards, nearby]) {
      expect(carousel?.menuCapabilities).toBeUndefined();
      expect(carousel?.onMenuAction).toBeUndefined();
    }
    for (const action of ['climb_here', 'pin', 'download', 'details', 'edit', 'delete']) {
      expect(screen.queryByRole('button', { name: `${action} Marco garage` })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'details Crux Kilter' })).toBeNull();
    // Switching boards is the whole point of the onboarding hand-off and must
    // still work.
    expect(screen.getByRole('button', { name: 'Marco garage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Crux Kilter' })).toBeTruthy();
  });

  it('draws the menus again outside onboarding', () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    expect(carouselProps.byFirstKey.get('mine')?.onMenuAction).toBeTypeOf('function');
    expect(carouselProps.byFirstKey.get('nearby')?.onMenuAction).toBeTypeOf('function');
  });
});

describe('a menu row the gates refuse', () => {
  // Defence in depth: a row drawn before the gate closed (here, management with
  // no resolvable identity) runs nothing, and is not counted as a card action.
  it('runs nothing and reports nothing', async () => {
    state.profile = undefined;
    state.storedUserId = undefined;
    render(createElement(BoardSelection));
    const owned = carouselProps.last?.items.find((item) => item.key === 'mine');
    const followed = carouselProps.last?.items.find((item) => item.key === 'gym');
    expect(carouselProps.last?.onMenuAction).toBeTypeOf('function');

    carouselProps.last?.onMenuAction?.({ ...owned!, isViewerOwner: true }, 'delete', 'accessibility');
    carouselProps.last?.onMenuAction?.({ ...followed!, isViewerOwner: false }, 'unfollow', 'accessibility');
    carouselProps.last?.onMenuAction?.({ ...owned!, isViewerOwner: true }, 'edit', 'long_press');

    await Promise.resolve();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deleteBoardMock).not.toHaveBeenCalled();
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/boards/edit' }));
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());
  });
});

describe('deleting a board', () => {
  it('confirms, deletes and forgets the offline snapshot', async () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledWith('mine'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(forgetOfflineBoardMock).toHaveBeenCalledWith('mine');
    // Not the active board, so the selection is left alone.
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
    expect(clearSessionMock).not.toHaveBeenCalled();
    await waitFor(() => expect(toastMock.showToast).toHaveBeenCalledWith('"Marco garage" deleted', 'success'));
  });

  it('clears the selection when the deleted board was the active one', async () => {
    state.activeBoard = myWall;
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(clearActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(clearSessionMock).toHaveBeenCalledWith({ notifyServer: true });
    expect(clearSessionMock.mock.invocationCallOrder[0]).toBeGreaterThan(deleteBoardMock.mock.invocationCallOrder[0]);
    expect(clearSessionMock.mock.invocationCallOrder[0]).toBeLessThan(clearActiveBoardMock.mock.invocationCallOrder[0]);
  });

  it('preserves a newer active selection while deletion is in flight', async () => {
    state.activeBoard = myWall;
    let finishDelete: (() => void) | undefined;
    deleteBoardMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledWith('mine'));
    state.activeBoardGeneration += 1;
    await act(async () => {
      finishDelete?.();
    });
    expect(clearSessionMock).not.toHaveBeenCalled();
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
  });

  it('names the spray wall photos and climbs in the confirmation', async () => {
    state.myBoards = [{ ...myWall, boardType: 'spray' }];
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledWith('mine'));
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete spray wall?',
        message: 'Delete "Marco garage"? Its photos and climbs will no longer be available. This cannot be undone.',
      }),
    );
    await waitFor(() => expect(toastMock.showToast).toHaveBeenCalledWith('"Marco garage" deleted', 'success'));
  });

  it('does nothing when the confirm is declined', async () => {
    confirmMock.mockResolvedValue(false);
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(deleteBoardMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure instead of silently leaving the board in place', async () => {
    deleteBoardMock.mockRejectedValue(new Error('nope'));
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));

    await waitFor(() =>
      expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't delete that board. Try again.", 'error'),
    );
    // The board is still on the server, so its offline snapshot must survive.
    expect(forgetOfflineBoardMock).not.toHaveBeenCalled();
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
    expect(clearSessionMock).not.toHaveBeenCalled();
  });

  // Delete is owner-only on the server. A stale row that names a followed board
  // runs nothing rather than a mutation the backend would reject.
  it('refuses to delete a board the viewer does not own', async () => {
    render(createElement(BoardSelection));
    const followed = carouselProps.last?.items.find((item) => item.key === 'gym');
    carouselProps.last?.onMenuAction?.(followed!, 'delete', 'menu_button');
    await Promise.resolve();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deleteBoardMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());
  });

  // The ⋯ and the hold are two ways into the same delete. A second pick while
  // the first is still running must not start a second one.
  it('ignores a second Delete while the first is still running', async () => {
    let finishDelete: (() => void) | undefined;
    deleteBoardMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await Promise.resolve();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(deleteBoardMock).toHaveBeenCalledTimes(1);
    // The refused pick is not counted either.
    expect(trackMock.mock.calls.filter(([event]) => event === 'Board Card Action')).toHaveLength(1);

    await act(async () => {
      finishDelete?.();
    });
    await waitFor(() => expect(toastMock.showToast).toHaveBeenCalledWith('"Marco garage" deleted', 'success'));
  });

  // Edit mode used to disable the card body. Without that, a tap after
  // confirming Delete on a slow connection made the board active, and the
  // delete landing afterwards left a deleted board selected.
  it('does not pick a board while its delete is running, but still picks another', async () => {
    state.nearbyBoards = [board({ uuid: 'mine', name: 'Marco garage', ownerId: 'me' })];
    let finishDelete: (() => void) | undefined;
    deleteBoardMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledTimes(1));
    trackMock.mockClear();

    // The card itself, in both carousels it appears in, and its Climb here row.
    for (const card of screen.getAllByRole('button', { name: 'Marco garage' })) fireEvent.click(card);
    for (const row of screen.getAllByRole('button', { name: 'climb_here Marco garage' })) fireEvent.click(row);
    await Promise.resolve();
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    expect(routerMock.dismissTo).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'High Point Orlando' }));
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'gym' })));

    await act(async () => {
      finishDelete?.();
    });
  });

  it('picks the board again once its delete was declined', async () => {
    confirmMock.mockResolvedValueOnce(false);
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    fireEvent.click(screen.getByRole('button', { name: 'Marco garage' }));
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'mine' })));
  });

  it('does not set the board active from its detail sheet while its delete is running', async () => {
    let finishDelete: (() => void) | undefined;
    deleteBoardMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledTimes(1));

    act(() => detailProps.last?.onSetActive(myWall));
    await Promise.resolve();
    expect(setActiveBoardMock).not.toHaveBeenCalled();

    await act(async () => {
      finishDelete?.();
    });
  });

  // The guard covers the confirm dialog too: two dialogs for one board would
  // run the delete twice.
  it('ignores a second Delete while the first confirm is still open', async () => {
    let answerConfirm: ((confirmed: boolean) => void) | undefined;
    confirmMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answerConfirm = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await Promise.resolve();
    expect(confirmMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      answerConfirm?.(true);
    });
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledTimes(1));
  });

  // Cleared in `finally`, so a delete that failed can be tried again.
  it('lets the same board be deleted again once the first attempt has finished', async () => {
    deleteBoardMock.mockRejectedValueOnce(new Error('nope'));
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() =>
      expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't delete that board. Try again.", 'error'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'delete Marco garage' }));
    await waitFor(() => expect(deleteBoardMock).toHaveBeenCalledTimes(2));
    expect(confirmMock).toHaveBeenCalledTimes(2);
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
    expect(clearSessionMock).not.toHaveBeenCalled();
  });

  // The one unfollow with a side effect beyond the list, and the one that bites
  // mid-session.
  it('confirms first when it would clear the active board', async () => {
    state.activeBoard = gymBoard;
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() => expect(unfollowBoardMock).toHaveBeenCalledWith('gym'));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clearActiveBoardMock).toHaveBeenCalledTimes(1));
    expect(clearSessionMock).toHaveBeenCalledWith({ notifyServer: true });
  });

  it('does nothing when that confirm is declined', async () => {
    state.activeBoard = gymBoard;
    confirmMock.mockResolvedValue(false);
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(clearActiveBoardMock).not.toHaveBeenCalled();
    expect(clearSessionMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure', async () => {
    unfollowBoardMock.mockRejectedValue(new Error('nope'));
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));

    await waitFor(() =>
      expect(toastMock.showToast).toHaveBeenCalledWith("Couldn't unfollow that board. Try again.", 'error'),
    );
  });

  it('refuses to unfollow a board the viewer owns', async () => {
    render(createElement(BoardSelection));
    const owned = carouselProps.last?.items.find((item) => item.key === 'mine');
    carouselProps.last?.onMenuAction?.(owned!, 'unfollow', 'menu_button');
    await Promise.resolve();
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());
  });

  it('ignores a second Unfollow while the first is still running', async () => {
    let finishUnfollow: (() => void) | undefined;
    unfollowBoardMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUnfollow = resolve;
        }),
    );
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));
    await waitFor(() => expect(unfollowBoardMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'unfollow High Point Orlando' }));
    await Promise.resolve();
    expect(unfollowBoardMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishUnfollow?.();
    });
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

  // Degraded means "no management rows", not "everything looks followed" — the
  // latter would offer to unfollow the user's own wall. A pin is the viewer's
  // own state, so it stays.
  it('offers no edit, unfollow or delete with no resolvable user id', () => {
    state.profile = undefined;
    state.storedUserId = undefined;

    render(createElement(BoardSelection));

    expect(carouselProps.last?.items.every((item) => item.isViewerOwner === undefined)).toBe(true);
    expect(carouselProps.last?.menuCapabilities?.canManage).toBe(false);
    for (const action of ['edit', 'delete', 'unfollow']) {
      expect(screen.queryByRole('button', { name: `${action} Marco garage` })).toBeNull();
    }
    expect(screen.getByRole('button', { name: 'pin Marco garage' })).toBeTruthy();
  });

  // Defence in depth, independent of the gate above: hand the handler an item
  // whose ownership never resolved and it must run nothing, rather than let
  // `undefined` collapse into "followed" and unfollow the user's own wall.
  it('refuses to act on an item whose ownership did not resolve', async () => {
    render(createElement(BoardSelection));

    const onMenuAction = carouselProps.last?.onMenuAction;
    expect(onMenuAction).toBeTypeOf('function');
    for (const action of ['edit', 'unfollow', 'delete'] as const) {
      onMenuAction?.({ key: 'mine', title: 'Marco garage' }, action, 'menu_button');
    }

    await Promise.resolve();
    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(deleteBoardMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/boards/edit' }));
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());
  });

  it('falls back to the id this device already has when the profile is missing', () => {
    state.profile = undefined;
    state.storedUserId = 'me';

    render(createElement(BoardSelection));

    expect(screen.getByRole('button', { name: 'edit Marco garage' })).toBeTruthy();
  });
});

// The tiles are gone: the + in the top bar holds the ways to add a board, and
// a climber with no boards gets the two that make one of their own.
describe('the empty state', () => {
  it.each([
    { title: 'mobile.addBoard.setUp', kind: 'board', pathname: '/boards/create' },
    { title: 'mobile.addBoard.sprayWall', kind: 'spraywall', pathname: '/boards/spray/new' },
  ])('offers $title and opens $pathname', ({ title, kind, pathname }) => {
    state.myBoards = [];
    render(createElement(BoardSelection));

    expect(screen.getByText('No boards yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: title }));

    expect(routerMock.push).toHaveBeenCalledWith({ pathname, params: { returnTo: '/(tabs)/climbs' } });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', { kind, surface: 'empty_state' });
  });

  it('is not shown to a climber with boards', () => {
    render(createElement(BoardSelection));
    expect(screen.queryByText('No boards yet')).toBeNull();
  });
});

// `Board Picker Selection Completed` names the list the board was tapped in, so a
// pick from Near you or the Bluetooth scan can be told apart from a switch
// between boards the climber already has (#5654).
describe('where a pick came from', () => {
  const nearbyWall = board({ uuid: 'nearby', name: 'Crux Kilter', ownerId: 'setter-1', isFollowedByMe: false });

  it('tags a Near you card as nearby, and says the pick followed it', async () => {
    state.nearbyBoards = [nearbyWall];
    state.willFollow = true;
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByRole('button', { name: 'Crux Kilter' }));

    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'nearby', followed: true }),
      ),
    );
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'nearby' }));
  });

  // Near you boards belong to other people: their menu is Climb here and
  // Details, nothing that manages a board.
  it('offers Near you cards Climb here and Details only', () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    expect(carouselProps.byFirstKey.get('nearby')?.menuCapabilities).toEqual({
      canPin: false,
      canDownload: false,
      canOpenDetails: true,
      canManage: false,
    });
    expect(screen.getByRole('button', { name: 'climb_here Crux Kilter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'details Crux Kilter' })).toBeTruthy();
    for (const action of ['pin', 'download', 'edit', 'unfollow', 'delete']) {
      expect(screen.queryByRole('button', { name: `${action} Crux Kilter` })).toBeNull();
    }
  });

  it('picks a Near you board from Climb here and reports it as nearby', async () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByRole('button', { name: 'climb_here Crux Kilter' }));

    expect(trackMock).toHaveBeenCalledWith('Board Card Action', {
      action: 'climb_here',
      via: 'menu_button',
      section: 'nearby',
    });
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'nearby' }),
      ),
    );
  });

  it('opens a Near you board’s details without picking it', () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByRole('button', { name: 'details Crux Kilter' }));

    expect(detailProps.last?.board?.uuid).toBe('nearby');
    expect(detailProps.last?.visible).toBe(true);
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  // The Near you handler only knows two rows; anything else is a stale row.
  it('runs nothing for a row Near you does not offer', () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));
    const nearby = carouselProps.byFirstKey.get('nearby');

    nearby?.onMenuAction?.(nearby.items[0], 'unfollow', 'accessibility');

    expect(unfollowBoardMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Board Card Action', expect.anything());
  });

  // The board in front of the climber, from the In range slot's hero.
  it('tags a board the In range slot found as bluetooth, ending the scan first', async () => {
    scanCtrl.phase = 'done';
    scanCtrl.rows = [{ kind: 'board', key: 'board:nearby', board: nearbyWall, rssi: -50, recognizedBy: 'serial' }];
    render(createElement(BoardSelection));

    const hero = inRangeProps.last?.view.content;
    expect(hero?.kind).toBe('hero');
    act(() => inRangeProps.last?.onPickBoard({ key: hero?.board?.key ?? '' }));

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'bluetooth' }),
      ),
    );
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'nearby' }));
    // The scan ends before the bind starts, so a bind that connects never
    // finds the radio still scanning.
    expect(scanCtrl.stop.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveBoardMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  // Every pick on the screen ends the scan, not only the In range ones.
  it('ends the scan before a pick from a card', async () => {
    state.nearbyBoards = [nearbyWall];
    render(createElement(BoardSelection));

    fireEvent.click(screen.getByRole('button', { name: 'Crux Kilter' }));

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    await waitFor(() => expect(setActiveBoardMock).toHaveBeenCalledOnce());
  });

  // The walls at the in-range board's gym, one tap each; nothing connects
  // without the tap (#7117).
  it('anchors "Also at" on the board in range and tags its picks as gym_walls', async () => {
    const crux = { gymUuid: 'gym-crux', gymName: 'Crux' };
    const inRangeWall = board({ uuid: 'crux-kilter', name: 'Crux Kilter', ...crux });
    const otherWall = board({ uuid: 'crux-moon', name: 'Crux MoonBoard', boardType: 'moonboard', ...crux });
    scanCtrl.phase = 'done';
    scanCtrl.rows = [
      { kind: 'board', key: 'board:crux-kilter', board: inRangeWall, rssi: -50, recognizedBy: 'serial' },
    ];
    render(createElement(BoardSelection));

    expect(alsoAtProps.last?.anchor.uuid).toBe('crux-kilter');
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    act(() => alsoAtProps.last?.onSelectBoard(otherWall));

    expect(scanCtrl.stop).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(trackMock).toHaveBeenCalledWith(
        'Board Picker Selection Completed',
        expect.objectContaining({ pickSource: 'gym_walls' }),
      ),
    );
  });

  it('anchors "Also at" on the active board when nothing is in range', () => {
    state.activeBoard = board({ uuid: 'gym', name: 'High Point Orlando', gymUuid: 'gym-hp', gymName: 'High Point' });
    render(createElement(BoardSelection));
    expect(alsoAtProps.last?.anchor.uuid).toBe('gym');
  });

  // Without `source` a gym picked on the map during onboarding would never close
  // out first-run; without `from` the map would count a second picker opening.
  it('hands the gym finder its source and says the picker opened it', () => {
    state.source = 'onboarding';
    render(createElement(BoardSelection));
    renderHeaderPlus();

    fireEvent.click(screen.getByRole('button', { name: 'add gym_map' }));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', from: 'picker' },
    });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', { kind: 'gym_map', surface: 'picker' });
  });

  // The wall wizard now takes the source too, so a first wall closes out first run.
  it.each([
    { kind: 'board', pathname: '/boards/create' },
    { kind: 'spraywall', pathname: '/boards/spray/new' },
  ])('opens $pathname from the + with the picker’s return and source', ({ kind, pathname }) => {
    state.source = 'onboarding';
    render(createElement(BoardSelection));
    renderHeaderPlus();

    fireEvent.click(screen.getByRole('button', { name: `add ${kind}` }));

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname,
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
    });
    expect(trackMock).toHaveBeenCalledWith('Board Picker Add Selected', { kind, surface: 'picker' });
  });

  it('offers no + to a signed-out climber', () => {
    state.isAuthenticated = false;
    render(createElement(BoardSelection));
    const options = navigationMock.setOptions.mock.calls.at(-1)?.[0] as { headerRight?: unknown } | undefined;
    expect(options?.headerRight).toBeUndefined();
  });
});

describe('detail sheet reachability', () => {
  // Details used to be a spray-wall-only link. The sheet handles home and gym
  // boards too, so every card's menu offers it.
  it('opens the details of a catalogue board, not only a spray wall', () => {
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'details High Point Orlando' }));
    expect(detailProps.last?.visible).toBe(true);
    expect(detailProps.last?.board?.uuid).toBe('gym');
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it('opens a saved wall without activating it', () => {
    const wall = board({ uuid: 'spray-wall', name: 'Garage wall', boardType: 'spray' });
    state.myBoards = [wall];
    render(createElement(BoardSelection));
    const carousel = carouselProps.last!;
    act(() => carousel.onMenuAction?.(carousel.items[0], 'details', 'menu_button'));
    expect(detailProps.last?.visible).toBe(true);
    expect(detailProps.last?.board?.uuid).toBe(wall.uuid);
    expect(setActiveBoardMock).not.toHaveBeenCalled();
    act(() => detailProps.last?.onClose());
    expect(detailProps.last?.visible).toBe(false);
  });

  it('opens an active share-link wall absent from saved and nearby lists', () => {
    state.myBoards = [];
    state.nearbyBoards = [];
    const wall = board({ uuid: 'shared-wall', name: 'Shared wall', boardType: 'spray' });
    state.activeBoard = wall;
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByText('mobile.boardDetail.activeSprayDetails'));
    expect(detailProps.last?.board?.uuid).toBe(wall.uuid);
    expect(detailProps.last?.visible).toBe(true);
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it('closes an open detail sheet when the account signs out', () => {
    const wall = board({ uuid: 'spray-wall', name: 'Garage wall', boardType: 'spray' });
    state.myBoards = [wall];
    const mounted = render(createElement(BoardSelection));
    const carousel = carouselProps.last!;
    act(() => carousel.onMenuAction?.(carousel.items[0], 'details', 'menu_button'));
    state.isAuthenticated = false;
    mounted.rerender(createElement(BoardSelection));
    state.isAuthenticated = true;
    mounted.rerender(createElement(BoardSelection));
    expect(detailProps.last?.visible).toBe(false);
    expect(detailProps.last?.board).toBeNull();
  });
});

describe('picking an importing spray wall', () => {
  const progress = {
    wallUuid: 'spray-wall',
    versionId: '42',
    detectionId: 'detection',
    stage: 'queued' as const,
    queuePosition: 3,
    retryAt: null,
    resetOfWallUuid: null,
  };

  it('opens the exact unfinished wall instead of activating an unpublished board', () => {
    state.myBoards = [
      board({ uuid: 'spray-wall', name: 'Importing garage', boardType: 'spray', canEdit: true, sprayImport: progress }),
    ];
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Importing garage' }));
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { wallUuid: 'spray-wall', versionId: '42' },
    });
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it('rejoins an importing reset clone through the wall it replaces', () => {
    state.myBoards = [
      board({
        uuid: 'spray-wall',
        name: 'Garage reset',
        boardType: 'spray',
        canEdit: true,
        sprayImport: { ...progress, resetOfWallUuid: 'old-spray-wall' },
      }),
    ];
    render(createElement(BoardSelection));
    fireEvent.click(screen.getByRole('button', { name: 'Garage reset' }));
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { resetOf: 'old-spray-wall' },
    });
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it("asks the board list for the viewer's unfinished spray walls", () => {
    render(createElement(BoardSelection));
    expect(state.myBoardsInputs.length).toBeGreaterThan(0);
    for (const input of state.myBoardsInputs) expect(input).toEqual({ includeUnfinishedSprayWalls: true });
  });

  it('never activates or downloads a wall the list called unfinished once its live progress is gone', async () => {
    const importing = board({
      uuid: 'spray-wall',
      name: 'Importing garage',
      boardType: 'spray',
      canEdit: true,
      sprayImport: progress,
    });
    state.myBoards = [importing];
    state.liveImportCleared = true;
    render(createElement(BoardSelection));
    const wizardByWall = { pathname: '/boards/spray/new', params: { wallUuid: 'spray-wall' } };

    fireEvent.click(screen.getByRole('button', { name: 'Importing garage' }));
    expect(routerMock.push).toHaveBeenLastCalledWith(wizardByWall);

    // The detail sheet's "Set active" takes the same road.
    expect(detailProps.last).not.toBeNull();
    act(() => detailProps.last?.onSetActive({ ...importing, sprayImport: null }));
    expect(routerMock.push).toHaveBeenLastCalledWith(wizardByWall);

    // An unfinished wall has no catalogue to download.
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['spray-wall']);
    expect(carouselProps.last?.menuCapabilities?.canDownload).toBe(true);
    carouselProps.last?.onMenuAction?.(carouselProps.last.items[0], 'download', 'menu_button');
    expect(confirmAndDownloadMock).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });
});
