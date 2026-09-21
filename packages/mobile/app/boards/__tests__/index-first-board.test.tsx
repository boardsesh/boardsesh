// @vitest-environment jsdom
//
// #5654: the launch gate opens /boards?source=onboarding&firstBoard=1 for a new
// account with no board. This suite pins what the SCREEN does in that mode:
// "Where do you climb?" instead of the discovery tiles, location asked on the
// gym tap rather than on open, each answer wired to the flow behind it, and an
// onboarding bind that lands on Climbs. The block's own rendering has its own
// suite (FirstBoardChoice.test.tsx), so here it is a prop-capturing stub.
//
// It also pins the two other ways into the same states: Climbs' "Find my
// board" (source=no_board), which gets the block only for an account with no
// boards and never tags the bind as onboarding, and the ordinary picker's Find
// nearby tile, which says what happened instead of going dead.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { FirstBoardGymState } from '../../../src/lib/boards/first-board-gym-state';
import type { LocationStatus } from '../../../src/lib/use-device-location';

type Children = { children?: ReactNode };
type CarouselItem = { key: string; title: string };
type ChoiceProps = {
  gymState: FirstBoardGymState;
  nearbyResults: ReactNode;
  onGym: () => void;
  onOwn: () => void;
  onScan: () => void;
  onFindGymOnMap: () => void;
  onOpenSettings: () => void;
  onRetryNearby: () => void;
  onAddSprayWall?: () => void;
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn());
const requestLocationMock = vi.hoisted(() => vi.fn());
const refreshLocationMock = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ sprayWalls: false }));
const chooseFirstBoardPathMock = vi.hoisted(() => vi.fn());
const openAppSettingsMock = vi.hoisted(() => vi.fn());
const refetchNearbyMock = vi.hoisted(() => vi.fn());
const locationOptions = vi.hoisted(() => ({ last: undefined as { retryAfterDenial?: boolean } | undefined }));
const trackingCtrl = vi.hoisted(() => ({ entryArgs: [] as Array<string | null> }));
const trackMock = vi.hoisted(() => vi.fn());
const markOnboardingSeenMock = vi.hoisted(() => vi.fn());
type ModeCardProps = { label: string; sublabel?: string; state?: string; onPress: () => void };
const modeCards = vi.hoisted(() => ({ byLabel: new Map<string, ModeCardProps>() }));
const choiceProps = vi.hoisted(() => ({ last: null as ChoiceProps | null }));
const carouselProps = vi.hoisted(() => ({
  last: null as { items: CarouselItem[]; onSelect: (item: CarouselItem) => void } | null,
}));

const state = vi.hoisted(() => ({
  params: { source: 'onboarding', firstBoard: '1' } as Record<string, string | undefined>,
  myBoards: [] as unknown[],
  nearbyBoards: [] as unknown[],
  nearbyLoading: false,
  nearbyError: false,
  locationStatus: 'idle' as LocationStatus,
}));

const gymWall = {
  uuid: 'gym-wall',
  name: 'Crux Kilter 40',
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '20,21',
  angle: 40,
  ownerId: 'setter-1',
  isOwned: true,
  isFollowedByMe: false,
} as unknown as UserBoard;

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
  useLocalSearchParams: () => state.params,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
  usePopularBoardConfigs: () => ({
    data: {
      configs: [{ boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: [1], displayName: 'Kilter Original 12x12' }],
    },
  }),
  useNearbyBoards: () => ({
    data: { boards: state.nearbyBoards },
    isLoading: state.nearbyLoading,
    isFetching: state.nearbyLoading,
    isError: state.nearbyError,
    refetch: refetchNearbyMock,
  }),
  useProfile: () => ({ data: { id: 'user-new' } }),
  useDeleteBoard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUnfollowBoard: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePinBoard: () => ({ mutate: vi.fn() }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null }),
  useSetActiveBoard: () => setActiveBoardMock,
  useClearActiveBoard: () => vi.fn(),
}));
vi.mock('../../../src/hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: undefined, isLoading: false }),
}));
vi.mock('../../../src/lib/board-discovery/use-adopt-found-board', () => ({
  useAdoptFoundBoard: () => vi.fn().mockResolvedValue(undefined),
  useWillFollowFoundBoard: () => () => false,
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: (options?: { retryAfterDenial?: boolean }) => {
    locationOptions.last = options;
    return {
      status: state.locationStatus,
      coords: state.locationStatus === 'granted' ? { latitude: 1, longitude: 2 } : null,
      request: requestLocationMock,
      refresh: refreshLocationMock,
    };
  },
}));
vi.mock('../../../src/providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: true, refreshAuthState: vi.fn() }),
}));
vi.mock('../../../src/providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../src/providers/dialog-provider', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9' }, systemColors: { tertiaryLabel: '#999' } }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/onboarding/onboarding-storage', () => ({
  markOnboardingSeen: markOnboardingSeenMock,
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../src/lib/onboarding/use-first-board-picker-tracking', () => ({
  useFirstBoardPickerTracking: (entry: string | null) => {
    trackingCtrl.entryArgs.push(entry);
    return chooseFirstBoardPathMock;
  },
}));
vi.mock('../../../src/lib/open-app-settings', () => ({
  openAppSettings: openAppSettingsMock,
  canOpenAppSettings: () => true,
}));
vi.mock('../../../src/hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../src/lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, reason: null }),
}));
vi.mock('../../../src/settings', () => ({
  useOfflineBoards: () => [],
  useSetting: () => [[], vi.fn()],
  forgetOfflineBoard: vi.fn(),
  offlineBoardKeyForBoard: (input: { boardType: string; layoutId: number; sizeId: number }) =>
    `${input.boardType}:${input.layoutId}:${input.sizeId}`,
}));
vi.mock('../../../src/components/offline/OfflineCatalogCta', () => ({ OfflineCatalogCta: () => null }));
vi.mock('../../../src/offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: vi.fn(async () => true) }),
}));
vi.mock('../../../src/providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => true,
  useSprayWallsEnabled: () => flags.sprayWalls,
}));
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
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement('button', { onClick: onPress, type: 'button' }, title),
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/components/board-discovery/BoardModeCard', () => ({
  BoardModeCard: (props: ModeCardProps) => {
    modeCards.byLabel.set(props.label, props);
    return createElement(
      'button',
      { 'data-mode-card': props.label, onClick: props.onPress, type: 'button' },
      props.label,
    );
  },
}));
vi.mock('../../../src/components/board-discovery/BluetoothQuickstartSheet', () => ({
  BluetoothQuickstartSheet: () => null,
}));
vi.mock('../../../src/components/board-discovery/BoardCarousel', () => ({
  BoardCarousel: (props: { items: CarouselItem[]; onSelect: (item: CarouselItem) => void }) => {
    carouselProps.last = props;
    return createElement(
      'div',
      { 'data-testid': 'carousel' },
      props.items.map((item) => createElement('span', { key: item.key }, item.title)),
    );
  },
}));
vi.mock('../../../src/components/board-discovery/FirstBoardChoice', () => ({
  FirstBoardChoice: (props: ChoiceProps) => {
    choiceProps.last = props;
    return createElement('div', { 'data-testid': 'first-board-choice' }, props.nearbyResults);
  },
}));

const { default: BoardSelection } = await import('../index');

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBoardMock.mockResolvedValue(undefined);
  markOnboardingSeenMock.mockResolvedValue(undefined);
  trackingCtrl.entryArgs = [];
  modeCards.byLabel.clear();
  choiceProps.last = null;
  carouselProps.last = null;
  state.params = { source: 'onboarding', firstBoard: '1' };
  state.myBoards = [];
  state.nearbyBoards = [];
  state.nearbyLoading = false;
  state.nearbyError = false;
  state.locationStatus = 'idle';
  flags.sprayWalls = false;
  refreshLocationMock.mockResolvedValue(false);
});

function choice(): ChoiceProps {
  if (!choiceProps.last) throw new Error('FirstBoardChoice did not render');
  return choiceProps.last;
}

describe('the picker in first-board mode', () => {
  it('asks where they climb instead of showing the discovery tiles', () => {
    render(createElement(BoardSelection));

    expect(screen.getByTestId('first-board-choice')).toBeTruthy();
    expect(document.querySelector('[data-mode-card]')).toBeNull();
    // Each Popular setups card builds a NEW public board: a gym climber tapping
    // one makes a duplicate of their gym's wall.
    expect(screen.queryByText('mobile.discovery.popularTitle')).toBeNull();
    expect(screen.queryByText('mobile.emptyTitle')).toBeNull();
    expect(screen.queryByText('mobile.onboardingPrompt')).toBeNull();
  });

  it('turns its choice tracking on, as the launch gate entry', () => {
    render(createElement(BoardSelection));
    expect(trackingCtrl.entryArgs.length).toBeGreaterThan(0);
    expect(trackingCtrl.entryArgs.every((entry) => entry === 'launch_gate')).toBe(true);
  });

  it('does not ask for location until "At a gym" is tapped', () => {
    render(createElement(BoardSelection));
    expect(requestLocationMock).not.toHaveBeenCalled();
    expect(choice().gymState).toBe('idle');

    act(() => {
      choice().onGym();
    });
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('gym');
    expect(choice().gymState).toBe('searching');
  });

  it('shows the boards near the gym once location answers', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });

    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('found');
    expect(carouselProps.last?.items.map((item) => item.key)).toEqual(['gym-wall']);
  });

  it('says so when location is off', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'denied';
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('location_off');
    choice().onOpenSettings();
    expect(openAppSettingsMock).toHaveBeenCalledTimes(1);
    // Back from Settings, one more tap on "At a gym" has to be able to ask again.
    expect(locationOptions.last).toEqual({ retryAfterDenial: true });
  });

  // `preset` opens the builder with a layout and size chosen, so Save works at
  // once instead of after the climber finds the layout chip.
  it('opens the builder preset for a home wall, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    choice().onOwn();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('own');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', preset: '1' },
    });
  });

  // The only way forward from "Location is off" and "Nothing within 20 km". The
  // gym map binds through useActivateBoard, and `source` is what makes that bind
  // close out first-run (the activation event, the reveal banner, no download
  // dialog on Climbs).
  it('opens the gym map, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    choice().onFindGymOnMap();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('gym_map');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms',
      params: expect.objectContaining({ source: 'onboarding', returnTo: '/(tabs)/climbs' }),
    });
  });

  it('says the lookup failed rather than that nothing is nearby, and retries it', () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyError = true;
    rerender(createElement(BoardSelection));

    expect(choice().gymState).toBe('nearby_error');
    choice().onRetryNearby();
    expect(refetchNearbyMock).toHaveBeenCalledTimes(1);
  });

  it('reports the Bluetooth scan choice', () => {
    render(createElement(BoardSelection));
    act(() => {
      choice().onScan();
    });
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('scan');
  });

  it('lands on Climbs after a pick', async () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    await act(async () => {
      carouselProps.last?.onSelect({ key: 'gym-wall', title: 'Crux Kilter 40' });
    });

    expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall);
    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
  });

  // A new account can already have boards (built on the web, or followed before
  // a sign-out cleared the active board). They stay one tap away.
  it('keeps Your boards when the account already has some', () => {
    state.myBoards = [gymWall];
    render(createElement(BoardSelection));
    expect(screen.getByText('mobile.discovery.yourBoardsTitle')).toBeTruthy();
  });
});

// The wall wizard binds without the onboarding source, so it would leave
// first-run open; the launch gate's showing keeps its three answers.
describe('the launch gate showing and spray walls', () => {
  it('offers no spray wall even with the flag on', () => {
    flags.sprayWalls = true;
    render(createElement(BoardSelection));
    expect(choice().onAddSprayWall).toBeUndefined();
  });
});

describe('the ordinary onboarding picker', () => {
  it('keeps the discovery tiles and pre-resolves location', () => {
    state.params = { source: 'onboarding' };
    render(createElement(BoardSelection));

    expect(screen.queryByTestId('first-board-choice')).toBeNull();
    expect(document.querySelector('[data-mode-card]')).not.toBeNull();
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(trackingCtrl.entryArgs.every((entry) => entry === null)).toBe(true);
  });

  it('ignores a stray firstBoard param outside onboarding', () => {
    state.params = { firstBoard: '1' };
    render(createElement(BoardSelection));
    expect(screen.queryByTestId('first-board-choice')).toBeNull();
  });

  // The Find gym tile forwards `source` too, so a gym-map pick from the ordinary
  // onboarding picker is the activation bind, like a pick from its own list (the
  // gym finder's side is pinned in app/gyms/__tests__/index.test.tsx).
  it('opens the gym map as an onboarding pick', () => {
    state.params = { source: 'onboarding' };
    render(createElement(BoardSelection));

    act(() => {
      screen.getByText('mobile.discovery.findGym').click();
    });

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', from: 'picker' },
    });
  });

  it('opens the gym map as an ordinary switch outside onboarding', () => {
    state.params = {};
    render(createElement(BoardSelection));

    act(() => {
      screen.getByText('mobile.discovery.findGym').click();
    });

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms',
      params: { returnTo: '/(tabs)/climbs', source: undefined, from: 'picker' },
    });
  });
});

describe('the picker opened from Climbs with no board', () => {
  beforeEach(() => {
    state.params = { source: 'no_board' };
  });

  it('asks where they climb when the account has no boards', () => {
    render(createElement(BoardSelection));

    expect(screen.getByTestId('first-board-choice')).toBeTruthy();
    expect(document.querySelector('[data-mode-card]')).toBeNull();
    expect(trackingCtrl.entryArgs.at(-1)).toBe('no_board');
    // No location prompt on open here either: it comes with "At a gym".
    expect(requestLocationMock).not.toHaveBeenCalled();
  });

  it('opens their list instead when they already have boards', () => {
    state.myBoards = [gymWall];
    render(createElement(BoardSelection));

    expect(screen.queryByTestId('first-board-choice')).toBeNull();
    expect(document.querySelector('[data-mode-card]')).not.toBeNull();
    expect(screen.getByText('mobile.discovery.yourBoardsTitle')).toBeTruthy();
    expect(trackingCtrl.entryArgs.every((entry) => entry === null)).toBe(true);
  });

  // A pick from the block follows or creates a board, and that refetch lands
  // while the modal is still dismissing. The screen must not swap under it.
  it('keeps the block once shown, even after the board list gains a board', () => {
    const { rerender } = render(createElement(BoardSelection));
    state.myBoards = [gymWall];
    rerender(createElement(BoardSelection));

    expect(screen.getByTestId('first-board-choice')).toBeTruthy();
    expect(trackingCtrl.entryArgs.at(-1)).toBe('no_board');
  });

  it('forwards its own source to the builder, preset', () => {
    render(createElement(BoardSelection));
    choice().onOwn();

    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'no_board', preset: '1' },
    });
  });

  // The tile row this block replaced carried the spray wall tile, and My own
  // board's builder cannot make a spray wall.
  it('offers a spray wall when the flag is on', () => {
    flags.sprayWalls = true;
    render(createElement(BoardSelection));
    const onAddSprayWall = choice().onAddSprayWall;
    if (!onAddSprayWall) throw new Error('no spray wall path');

    onAddSprayWall();
    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('spray_wall');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/spray/new',
      params: { returnTo: '/(tabs)/climbs' },
    });
  });

  it('offers no spray wall with the flag off', () => {
    render(createElement(BoardSelection));
    expect(choice().onAddSprayWall).toBeUndefined();
  });

  // The empty state shows for anyone with no board bound, at any account age,
  // so a bind from it is an ordinary switch: no activation event, no first-run
  // close-out, and its own source on the picker events.
  it('binds as an ordinary pick, not as onboarding', async () => {
    const { rerender } = render(createElement(BoardSelection));
    act(() => {
      choice().onGym();
    });
    state.locationStatus = 'granted';
    state.nearbyBoards = [gymWall];
    rerender(createElement(BoardSelection));

    await act(async () => {
      carouselProps.last?.onSelect({ key: 'gym-wall', title: 'Crux Kilter 40' });
    });

    expect(setActiveBoardMock).toHaveBeenCalledWith(gymWall);
    expect(routerMock.dismissTo).toHaveBeenCalledWith('/(tabs)/climbs');
    expect(markOnboardingSeenMock).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalledWith('Onboarding Board Activated', expect.anything());
    expect(trackMock).toHaveBeenCalledWith('Board Picker Opened', expect.objectContaining({ source: 'no_board' }));
  });
});

describe("the ordinary picker's Find nearby tile", () => {
  beforeEach(() => {
    state.params = {};
    state.myBoards = [gymWall];
  });

  function nearbyTile(): ModeCardProps {
    const tile = modeCards.byLabel.get('mobile.discovery.findNearby');
    if (!tile) throw new Error('Find nearby tile did not render');
    return tile;
  }

  it('says nothing before it is tapped', () => {
    render(createElement(BoardSelection));

    expect(nearbyTile().state).toBe('idle');
    expect(screen.queryByText('mobile.firstBoard.locationOff')).toBeNull();
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
    nearbyTile().onPress();
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
  });

  // It used to go dim and untappable, with an "Allow location" line that could
  // not be tapped either.
  it('says location is off, offers Settings, and stays tappable', () => {
    state.locationStatus = 'denied';
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.locationOff')).toBeTruthy();
    expect(nearbyTile().state).toBe('idle');
    expect(nearbyTile().sublabel).toBe('mobile.discovery.locationDenied');

    fireEvent.click(screen.getByText('mobile.firstBoard.openSettings'));
    expect(openAppSettingsMock).toHaveBeenCalledTimes(1);

    // Back from Settings, the tile asks again rather than doing nothing.
    nearbyTile().onPress();
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(locationOptions.last).toEqual({ retryAfterDenial: true });
  });

  it('reads a failed fix the same as a denial', () => {
    state.locationStatus = 'unavailable';
    render(createElement(BoardSelection));
    expect(screen.getByText('mobile.firstBoard.locationOff')).toBeTruthy();
  });

  // It used to fall back to idle with no word, and a second tap did nothing.
  it('says when nothing is within 20 km and points to the gym map', async () => {
    state.locationStatus = 'granted';
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.nearbyEmpty')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.firstBoard.findGymOnMap'));
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/gyms',
      params: { returnTo: '/(tabs)/climbs', source: undefined, from: 'picker' },
    });

    // Same spot: a fresh fix, then the same search again.
    await act(async () => {
      nearbyTile().onPress();
    });
    expect(refreshLocationMock).toHaveBeenCalledTimes(1);
    expect(refetchNearbyMock).toHaveBeenCalledTimes(1);
    expect(requestLocationMock).not.toHaveBeenCalled();
  });

  // A climber who moved gets new coordinates, which is a new search by itself.
  it('searches from where the climber is now after they move', async () => {
    state.locationStatus = 'granted';
    refreshLocationMock.mockResolvedValue(true);
    render(createElement(BoardSelection));

    await act(async () => {
      nearbyTile().onPress();
    });
    expect(refreshLocationMock).toHaveBeenCalledTimes(1);
    expect(refetchNearbyMock).not.toHaveBeenCalled();
  });

  it('says the lookup failed and retries it', () => {
    state.locationStatus = 'granted';
    state.nearbyError = true;
    render(createElement(BoardSelection));

    expect(screen.getByText('mobile.firstBoard.nearbyError')).toBeTruthy();
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
    fireEvent.click(screen.getByText('mobile.errorRetry'));
    expect(refetchNearbyMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the searching to the tile spinner', () => {
    state.locationStatus = 'loading';
    render(createElement(BoardSelection));

    expect(nearbyTile().state).toBe('loading');
    expect(screen.queryByText('mobile.firstBoard.searching')).toBeNull();
  });

  it('shows the boards it found under the tile', () => {
    state.locationStatus = 'granted';
    state.nearbyBoards = [{ ...gymWall, uuid: 'near-wall' }];
    render(createElement(BoardSelection));

    expect(nearbyTile().state).toBe('done');
    expect(nearbyTile().sublabel).toBe('mobile.discovery.nearbyShowing');
    expect(screen.getByText('mobile.discovery.nearbyTitle')).toBeTruthy();
    expect(screen.queryByText('mobile.firstBoard.nearbyEmpty')).toBeNull();
  });
});
