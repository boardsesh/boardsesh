// @vitest-environment jsdom
//
// "Find your gym's board" (#8151): location is read on open and only asked on
// a tap; every way location can fail leaves the name search; a failed lookup
// is never "nothing matches".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };

const pushMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const takeWallMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const requestIfAllowedMock = vi.hoisted(() => vi.fn());
const openSettingsMock = vi.hoisted(() => vi.fn());
const refetchMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  platform: 'ios',
  canOpenSettings: true,
  signedIn: true,
  offline: false,
  location: { status: 'idle', permission: 'unknown', coords: null as { latitude: number; longitude: number } | null },
  gyms: { data: undefined as { gyms: unknown[] } | undefined, isLoading: false, isError: false },
  gymsArgs: [] as unknown[],
  boards: { data: undefined as { boards: unknown[] } | undefined, isLoading: false, isError: false },
  boardsEnabled: false,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({
  SUPPORTED_BOARDS: ['kilter', 'moonboard'],
  toBoardName: (value: string) => value,
  boardSetupLabelParts: () => ({ layout: null, size: null, sets: [], angle: null }),
}));
vi.mock('../board-builder-labels', () => ({ boardTypeLabel: (boardName: string) => `label:${boardName}` }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.signedIn ? { id: 'viewer' } : undefined }),
  useNearbyGyms: (...args: unknown[]) => {
    state.gymsArgs = args;
    return { ...state.gyms, error: null, refetch: refetchMock };
  },
  useSearchBoards: (_input: unknown, enabled: boolean) => {
    state.boardsEnabled = enabled;
    return { ...state.boards, error: null, refetch: refetchMock };
  },
}));
vi.mock('../../../lib/graphql/extract-error-message', () => ({ isGraphqlRateLimitedError: () => false }));
vi.mock('../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ ...state.location, request: requestMock, requestIfAllowed: requestIfAllowedMock }),
}));
vi.mock('../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => state.canOpenSettings,
  openAppSettings: openSettingsMock,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => state.offline,
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 }, borderRadius: { md: 8 } }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/boards/board-return-to', () => ({ resolveBoardReturnTo: () => '/(tabs)/climbs' }));
vi.mock('../../../lib/boards/use-take-existing-wall', () => ({ useTakeExistingWall: () => takeWallMock }));
vi.mock('../../AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    value,
    onChangeText,
    testID,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    testID?: string;
  }) =>
    createElement('input', {
      value,
      'data-testid': testID,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
}));
vi.mock('../../ShelfHeader', () => ({
  ShelfSection: ({ title, children, testID }: Children & { title: string; testID?: string }) =>
    createElement('section', { 'data-testid': testID }, [createElement('h2', { key: 'title' }, title), children]),
}));
vi.mock('../../EmptyState', () => ({
  EmptyState: ({ title, actions, testID }: { title: string; actions?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, [createElement('p', { key: 'title' }, title), actions]),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: Children & { testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'spinner') }));
vi.mock('../BoardConfigChips', () => ({
  BoardConfigChips: ({
    options,
    onSelect,
  }: {
    options: { key: string; label: string; value: string }[];
    onSelect: (value: string) => void;
  }) =>
    createElement(
      'div',
      null,
      options.map((option) =>
        createElement(
          'button',
          { key: option.key, type: 'button', onClick: () => onSelect(option.value) },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../BoardRowList', () => ({
  BoardRowList: ({
    items,
    onSelect,
  }: {
    items: { key: string; title: string }[];
    onSelect: (item: unknown, position: number) => void;
  }) =>
    createElement(
      'ul',
      null,
      items.map((item, index) =>
        createElement('button', { key: item.key, type: 'button', onClick: () => onSelect(item, index) }, item.title),
      ),
    ),
}));
vi.mock('../DiscoveryBoardArt', () => ({ DiscoveryBoardArt: () => null }));
// The shared list, drawn plainly: header, rows (or the empty state), footer.
vi.mock('../GymSearchList', () => ({
  GymSearchList: ({
    gyms,
    onSelect,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    gyms: { uuid: string; name: string }[];
    onSelect: (gym: unknown) => void;
    ListHeaderComponent?: ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement('div', null, [
      createElement('div', { key: 'header' }, ListHeaderComponent),
      gyms.length > 0
        ? gyms.map((gym) =>
            createElement('button', { key: gym.uuid, type: 'button', onClick: () => onSelect(gym) }, gym.name),
          )
        : createElement('div', { key: 'empty' }, ListEmptyComponent),
      createElement('div', { key: 'footer' }, ListFooterComponent),
    ]),
}));

const { FindWallGymSearch } = await import('../FindWallGymSearch');

function renderSearch() {
  return render(
    createElement(FindWallGymSearch, { initialBoardType: null, returnTo: '/(tabs)/climbs', source: 'no_board' }),
  );
}

function events(name: string) {
  return trackMock.mock.calls.filter(([eventName]) => eventName === name).map(([, props]) => props);
}

async function typeSearch(text: string) {
  vi.useFakeTimers();
  fireEvent.change(screen.getByTestId('find-wall-search'), { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  vi.useRealTimers();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.platform = 'ios';
  state.canOpenSettings = true;
  state.signedIn = true;
  state.offline = false;
  state.location = { status: 'idle', permission: 'unknown', coords: null };
  state.gyms = { data: undefined, isLoading: false, isError: false };
  state.boards = { data: undefined, isLoading: false, isError: false };
  takeWallMock.mockResolvedValue({ alreadyFollowed: false });
});

describe('FindWallGymSearch location', () => {
  it('reads a permission already given on open, and never prompts', () => {
    renderSearch();
    expect(requestIfAllowedMock).toHaveBeenCalledTimes(1);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('asks only from Use my location, with its reason under it', () => {
    renderSearch();
    expect(screen.getByTestId('find-wall-location-ask')).toBeTruthy();
    expect(screen.getByText('mobile.findWall.useMyLocationHint')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.findWall.useMyLocation'));
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('says location is off and offers Settings where the phone can open it', () => {
    state.location = { status: 'denied', permission: 'blocked', coords: null };
    renderSearch();
    expect(screen.getByText('mobile.findWall.locationDenied')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.firstBoard.openSettings'));
    expect(openSettingsMock).toHaveBeenCalled();
  });

  it('offers no Settings where the platform has none', () => {
    state.canOpenSettings = false;
    state.location = { status: 'denied', permission: 'ask', coords: null };
    renderSearch();
    expect(screen.queryByText('mobile.firstBoard.openSettings')).toBeNull();
  });

  it('says how to unblock it in a browser', () => {
    state.platform = 'web';
    state.location = { status: 'denied', permission: 'blocked', coords: null };
    renderSearch();
    expect(screen.getByText('mobile.findWall.locationBlockedWeb')).toBeTruthy();
    expect(screen.queryByText('mobile.findWall.useMyLocation')).toBeNull();
  });

  it('searches gyms around the fix and counts a location search once', () => {
    state.location = { status: 'granted', permission: 'granted', coords: { latitude: 1, longitude: 2 } };
    state.gyms.data = { gyms: [{ uuid: 'gym-1', name: 'Boulder Space' }] };
    renderSearch();
    expect(state.gymsArgs[0]).toEqual({ latitude: 1, longitude: 2 });
    expect(screen.queryByTestId('find-wall-location-ask')).toBeNull();
    expect(events('Board Wall Search Started')).toEqual([{ method: 'location', boardType: null, queryLength: 0 }]);
  });
});

describe('FindWallGymSearch results', () => {
  it('prompts for a name or location before there is anything to search', () => {
    renderSearch();
    expect(screen.getByTestId('find-wall-prompt')).toBeTruthy();
  });

  it('opens a gym on its walls, with the chosen type', () => {
    state.location = { status: 'granted', permission: 'granted', coords: { latitude: 1, longitude: 2 } };
    state.gyms.data = { gyms: [{ uuid: 'gym-1', name: 'Boulder Space' }] };
    renderSearch();
    fireEvent.click(screen.getByText('label:moonboard'));
    fireEvent.click(screen.getByText('Boulder Space'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/find-wall',
      params: { gymUuid: 'gym-1', boardType: 'moonboard', returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });

  it('searches boards by name too, and takes one on a tap', async () => {
    state.gyms.data = { gyms: [] };
    state.boards.data = {
      boards: [
        { uuid: 'wall-1', name: 'Crag MoonBoard', boardType: 'moonboard', layoutId: 5, sizeId: 1, setIds: '17' },
      ],
    };
    renderSearch();
    await typeSearch('crag');
    expect(state.boardsEnabled).toBe(true);
    expect(screen.getByTestId('find-wall-boards')).toBeTruthy();
    fireEvent.click(screen.getByText('Crag MoonBoard'));
    expect(takeWallMock).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'wall-1' }));
    expect(events('Board Wall Search Started')).toEqual([{ method: 'text', boardType: null, queryLength: 4 }]);
  });

  it('says nothing matches only when both searches came back empty', async () => {
    state.gyms.data = { gyms: [] };
    state.boards.data = { boards: [] };
    renderSearch();
    await typeSearch('zzz');
    expect(screen.getByTestId('find-wall-no-matches')).toBeTruthy();
  });

  it('never reads a failed gym search as no matches', async () => {
    state.gyms = { data: undefined, isLoading: false, isError: true };
    renderSearch();
    await typeSearch('crag');
    expect(screen.getByTestId('find-wall-gyms-failed')).toBeTruthy();
    expect(screen.queryByTestId('find-wall-no-matches')).toBeNull();
    fireEvent.click(screen.getByText('mobile.findWall.retry'));
    expect(refetchMock).toHaveBeenCalled();
    expect(events('Board Wall Lookup Failed')[0]).toMatchObject({ stage: 'gyms', error_reason: 'exception' });
  });

  it('says it needs signal offline, and searches nothing', () => {
    state.offline = true;
    renderSearch();
    expect(screen.getByTestId('find-wall-offline')).toBeTruthy();
    expect(state.gymsArgs[7]).toEqual({ enabled: false });
  });
});

describe('FindWallGymSearch My gym isn’t listed', () => {
  it('opens the builder with the location field focused', () => {
    renderSearch();
    fireEvent.click(screen.getByText('mobile.findWall.gymNotListed'));
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/boards/create',
      params: { kind: 'gym', focusLocation: '1', returnTo: '/(tabs)/climbs', source: 'no_board' },
    });
  });

  it('sends a signed-out climber to sign in from a board row, following nothing', async () => {
    state.signedIn = false;
    state.gyms.data = { gyms: [] };
    state.boards.data = {
      boards: [
        { uuid: 'wall-1', name: 'Crag MoonBoard', boardType: 'moonboard', layoutId: 5, sizeId: 1, setIds: '17' },
      ],
    };
    renderSearch();
    await typeSearch('crag');
    fireEvent.click(screen.getByText('Crag MoonBoard'));
    expect(pushMock).toHaveBeenCalledWith('/auth/login');
    expect(takeWallMock).not.toHaveBeenCalled();
  });

  it('sends a signed-out climber to sign in', () => {
    state.signedIn = false;
    renderSearch();
    fireEvent.click(screen.getByText('mobile.findWall.signInToAdd'));
    expect(pushMock).toHaveBeenCalledWith('/auth/login');
  });
});
