// @vitest-environment jsdom
//
// #5654: the launch gate opens /boards?source=onboarding&firstBoard=1 for a new
// account with no board. This suite pins what the SCREEN does in that mode:
// "Where do you climb?" instead of the discovery tiles, location asked on the
// gym tap rather than on open, each answer wired to the flow behind it, and an
// onboarding bind that lands on Climbs. The block's own rendering has its own
// suite (FirstBoardChoice.test.tsx), so here it is a prop-capturing stub.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
};

const routerMock = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }));
const setActiveBoardMock = vi.hoisted(() => vi.fn());
const requestLocationMock = vi.hoisted(() => vi.fn());
const chooseFirstBoardPathMock = vi.hoisted(() => vi.fn());
const openAppSettingsMock = vi.hoisted(() => vi.fn());
const refetchNearbyMock = vi.hoisted(() => vi.fn());
const locationOptions = vi.hoisted(() => ({ last: undefined as { retryAfterDenial?: boolean } | undefined }));
const trackingCtrl = vi.hoisted(() => ({ enabledArgs: [] as boolean[] }));
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
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: (options?: { retryAfterDenial?: boolean }) => {
    locationOptions.last = options;
    return {
      status: state.locationStatus,
      coords: state.locationStatus === 'granted' ? { latitude: 1, longitude: 2 } : null,
      request: requestLocationMock,
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
  markOnboardingSeen: vi.fn().mockResolvedValue(undefined),
  setBoardRevealTipPending: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../src/lib/onboarding/use-first-board-picker-tracking', () => ({
  useFirstBoardPickerTracking: (enabled: boolean) => {
    trackingCtrl.enabledArgs.push(enabled);
    return chooseFirstBoardPathMock;
  },
}));
vi.mock('../../../src/lib/open-app-settings', () => ({ openAppSettings: openAppSettingsMock }));
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
  useSprayWallsEnabled: () => false,
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
  BoardModeCard: ({ label, onPress }: { label: string; onPress?: () => void }) =>
    createElement('button', { 'data-mode-card': label, onClick: onPress, type: 'button' }, label),
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
  trackingCtrl.enabledArgs = [];
  choiceProps.last = null;
  carouselProps.last = null;
  state.params = { source: 'onboarding', firstBoard: '1' };
  state.myBoards = [];
  state.nearbyBoards = [];
  state.nearbyLoading = false;
  state.nearbyError = false;
  state.locationStatus = 'idle';
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

  it('turns its choice tracking on', () => {
    render(createElement(BoardSelection));
    expect(trackingCtrl.enabledArgs.every(Boolean)).toBe(true);
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

  it('opens the builder for a home wall, still as an onboarding pick', () => {
    render(createElement(BoardSelection));
    choice().onOwn();

    expect(chooseFirstBoardPathMock).toHaveBeenCalledWith('own');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
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

describe('the ordinary onboarding picker', () => {
  it('keeps the discovery tiles and pre-resolves location', () => {
    state.params = { source: 'onboarding' };
    render(createElement(BoardSelection));

    expect(screen.queryByTestId('first-board-choice')).toBeNull();
    expect(document.querySelector('[data-mode-card]')).not.toBeNull();
    expect(requestLocationMock).toHaveBeenCalledTimes(1);
    expect(trackingCtrl.enabledArgs.some(Boolean)).toBe(false);
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
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
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
      params: { returnTo: '/(tabs)/climbs', source: undefined },
    });
  });
});
