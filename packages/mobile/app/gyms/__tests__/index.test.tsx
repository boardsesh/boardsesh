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
// The gym finder binds a board through the same `useActivateBoard` path as every
// other picker (#5654), so a pick here fires the pick event, follows the board
// and, when the picker forwarded `source=onboarding`, closes out first-run. It
// used to carry its own copy of the bind that did none of that, and "Find your
// gym on the map" is the first-board picker's only way forward from "Location is
// off".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, useImperativeHandle, type ReactNode, type Ref } from 'react';
import type { Gym, PlaceSuggestion, UserBoard } from '@boardsesh/shared-schema';
import type { Coords } from '../../../src/lib/use-device-location';
import type { WallFinderFilterChipsProps } from '../../../src/components/gym-directory/WallFinderFilterChips';
import type { useNearbyBoards, useNearbyGyms } from '../../../src/lib/graphql/hooks';

type DiscoveryQuery = {
  data: { gyms: Gym[]; boards: UserBoard[] } | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isPlaceholderData: boolean;
};

type Children = { children?: ReactNode };
type ActivateOptions = { source?: 'onboarding'; returnTo: string; onBound?: unknown };
type AnalyticsOptions = { fromOnboarding: boolean; fromNoBoard?: boolean; surface?: string; returnTo: string };

const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn(), canGoBack: () => true }));
const bindMock = vi.hoisted(() => vi.fn((): Promise<void> => Promise.resolve()));
const trackSelectionMock = vi.hoisted(() => vi.fn((): Promise<void> => Promise.resolve()));
const refetchGyms = vi.hoisted(() => vi.fn());
const refetchBoards = vi.hoisted(() => vi.fn());
const queryMocks = vi.hoisted(() => ({ gyms: vi.fn(), boards: vi.fn() }));
const geocodeMock = vi.hoisted(() => vi.fn<(text: string) => Promise<Coords | null>>());
const locationMocks = vi.hoisted(() => ({
  request: vi.fn(async () => 'granted' as const),
  requestIfAllowed: vi.fn(async () => 'ask' as const),
}));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
const cameraMocks = vi.hoisted(() => ({ setCenter: vi.fn(), showWorld: vi.fn() }));
const panelSnapTo = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/analytics')>()),
  track: trackMock,
}));
const captured = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  activateOptions: null as ActivateOptions | null,
  analyticsOptions: null as AnalyticsOptions | null,
  onActivateBoard: null as ((board: UserBoard) => void) | null,
  onRegionChange: null as ((center: Coords, zoom?: number) => void) | null,
  mapCenter: undefined as Coords | null | undefined,
  keyboardOverlap: 0,
  panelBox: { availableHeight: undefined as number | undefined },
  locationStatus: 'idle',
  onMapUnavailable: null as (() => void) | null,
  onMapReady: null as (() => void) | null,
  mapAvailable: null as boolean | null,
  mapMounts: 0,
  onPressGym: null as ((gym: Gym) => void) | null,
  chips: null as WallFinderFilterChipsProps | null,
  coords: undefined as Coords | undefined,
  gymsQuery: null as DiscoveryQuery | null,
  boardsQuery: null as DiscoveryQuery | null,
  standaloneBoards: [] as UserBoard[],
  gyms: [] as Gym[],
  locationPrompt: undefined as ReactNode,
  onSelectPlace: null as ((place: PlaceSuggestion) => void) | null,
  rowArgs: null as {
    expandedGymUuid: string | null;
    expandedGymRoster?: UserBoard[];
    expandedGymRosterPending?: boolean;
  } | null,
  rosterQuery: { data: undefined, isPending: false, isError: false } as {
    data: UserBoard[] | undefined;
    isPending: boolean;
    isError: boolean;
  },
  rosterGymUuids: [] as (string | null)[],
  segments: ['gyms'] as string[],
  panelOpeners: null as { onOpenGym?: (gym: Gym) => void; onEditGym: (gym: Gym) => void } | null,
  cardList: null as {
    data: readonly { kind: string; key: string }[];
    renderItem: (info: { item: unknown }) => ReactNode;
    map?: ReactNode;
    mapAvailable?: boolean;
    mapHidden?: boolean;
    stickyHeader?: ReactNode;
  } | null,
  browseRow: null as { onOpenGym?: (gym: Gym) => void; onEditGym: (gym: Gym) => void } | null,
}));

vi.mock('react-native', () => ({
  Platform: platform,
  View: ({ children, style }: Children & { style?: unknown }) =>
    createElement('div', { 'data-native-style': JSON.stringify(style) }, children),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
  TextInput: ({
    value,
    onChangeText,
    onSubmitEditing,
    onFocus,
    onBlur,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    onSubmitEditing: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
  }) =>
    createElement('input', {
      value,
      onFocus,
      onBlur,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') onSubmitEditing();
      },
    }),
  useWindowDimensions: () => ({ width: 393, height: 852 }),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => routerMock,
  useLocalSearchParams: () => captured.params,
  useSegments: () => captured.segments,
}));
vi.mock('../../../src/hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
// The board picker's copy draws MapCardList; its own suite covers the layout.
vi.mock('../../../src/components/gym-directory/MapCardList', () => ({
  MapCardList: (props: NonNullable<typeof captured.cardList>) => {
    captured.cardList = props;
    return createElement('div', { 'data-testid': 'map-card-list' }, props.stickyHeader, props.map);
  },
}));
vi.mock('../../../src/components/gym-directory/GymBrowseRow', () => ({
  GymBrowseRow: (props: NonNullable<typeof captured.browseRow>) => {
    captured.browseRow = props;
    return null;
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../../../src/lib/graphql/hooks', () => ({
  useNearbyGyms: (...args: Parameters<typeof useNearbyGyms>) => {
    queryMocks.gyms(...args);
    return { ...captured.gymsQuery, refetch: refetchGyms };
  },
  useNearbyBoards: (...args: Parameters<typeof useNearbyBoards>) => {
    queryMocks.boards(...args);
    return { ...captured.boardsQuery, refetch: refetchBoards };
  },
}));
vi.mock('../../../src/lib/graphql/hooks/use-gym-boards', () => ({
  useGymBoards: (gymUuid: string | null) => {
    captured.rosterGymUuids.push(gymUuid);
    return captured.rosterQuery;
  },
}));
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null, isError: false }),
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({
    status: captured.locationStatus,
    permission: 'ask',
    permissionChecked: true,
    coords: captured.coords,
    request: locationMocks.request,
    requestIfAllowed: locationMocks.requestIfAllowed,
  }),
}));
// The native field's town suggestions talk to the API; this screen's tests drive
// a place through `onSelectPlace` instead.
vi.mock('../../../src/lib/use-place-suggestions', () => ({
  usePlaceSuggestions: () => ({ canSearch: false, lookup: null, suggestions: [] }),
}));
vi.mock('../../../src/lib/use-place-search', () => ({
  useGeocodePlace: () => ({ geocode: geocodeMock, isGeocoding: false }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: {
      background: '#fff',
      secondaryBackground: '#f7f7f7',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
      separator: '#ccc',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../src/lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../src/lib/boards/use-activate-board', () => ({
  useActivateBoard: (options: ActivateOptions) => {
    captured.activateOptions = options;
    return bindMock;
  },
}));
vi.mock('../../../src/lib/boards/use-board-picker-analytics', () => ({
  useBoardPickerAnalytics: (options: AnalyticsOptions) => {
    captured.analyticsOptions = options;
    return trackSelectionMock;
  },
}));
vi.mock('../../../src/components/Text', () => ({
  Text: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../../src/components/ChromeIconButton', () => ({
  ChromeIconButton: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }),
  useChromeIconButtonSize: () => 44,
}));
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/gym-directory/GymMap', () => ({
  GymMap: (props: {
    center: Coords | null;
    onRegionChange: (center: Coords, zoom?: number) => void;
    onMapUnavailable: () => void;
    onMapReady: () => void;
    ref?: Ref<unknown>;
  }) => {
    useImperativeHandle(props.ref, () => cameraMocks, []);
    captured.mapCenter = props.center;
    captured.onRegionChange = props.onRegionChange;
    captured.onMapUnavailable = props.onMapUnavailable;
    captured.onMapReady = props.onMapReady;
    useEffect(() => {
      captured.mapMounts += 1;
    }, []);
    return null;
  },
}));
vi.mock('../../../src/components/gym-directory/panel-keyboard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/gym-directory/panel-keyboard')>()),
  useKeyboardOverlap: () => captured.keyboardOverlap,
}));
vi.mock('../../../src/components/gym-directory/GymListPanel', () => ({
  GymListPanel: (props: {
    ref?: Ref<unknown>;
    availableHeight?: number;
    onActivateBoard: (board: UserBoard) => void;
    onPressGym: (gym: Gym) => void;
    onOpenGym?: (gym: Gym) => void;
    onEditGym: (gym: Gym) => void;
    mapAvailable: boolean;
    filterSlot?: ReactNode;
    placeCaption?: ReactNode;
    searchSlot?: ReactNode;
    locationPrompt?: ReactNode;
  }) => {
    useImperativeHandle(
      props.ref,
      () => ({ snapTo: panelSnapTo, ensureVisible: vi.fn(), scrollToRowKey: vi.fn() }),
      [],
    );
    captured.panelBox = { availableHeight: props.availableHeight };
    captured.panelOpeners = { onOpenGym: props.onOpenGym, onEditGym: props.onEditGym };
    captured.onActivateBoard = props.onActivateBoard;
    captured.onPressGym = props.onPressGym;
    captured.mapAvailable = props.mapAvailable;
    captured.locationPrompt = props.locationPrompt;
    return createElement(
      'div',
      null,
      props.searchSlot,
      props.filterSlot,
      props.placeCaption,
      props.locationPrompt ?? captured.gyms.map((gym) => createElement('span', { key: gym.uuid }, gym.name)),
    );
  },
}));
vi.mock('../../../src/components/gym-directory/GymSearchField', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/components/gym-directory/GymSearchField')>();
  return {
    GymSearchField: (
      props: import('../../../src/components/gym-directory/GymSearchField.types').GymSearchFieldProps,
    ) => {
      captured.onSelectPlace = props.onSelectPlace;
      return createElement(original.GymSearchField, props);
    },
  };
});
vi.mock('../../../src/components/gym-directory/GymLocationPrompt', () => ({ GymLocationPrompt: () => null }));
vi.mock('../../../src/components/gym-directory/ClaimGymSheet', () => ({ ClaimGymSheet: () => null }));
vi.mock('../../../src/components/gym-directory/WallFinderFilterChips', () => ({
  WallFinderFilterChips: (props: WallFinderFilterChipsProps) => {
    captured.chips = props;
    return null;
  },
}));
vi.mock('../../../src/components/gym-directory/gym-list-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/gym-directory/gym-list-rows')>()),
  buildGymListRows: (props: {
    gyms: Gym[];
    standaloneBoards: UserBoard[];
    expandedGymUuid: string | null;
    expandedGymRoster?: UserBoard[];
    expandedGymRosterPending?: boolean;
  }) => {
    captured.standaloneBoards = props.standaloneBoards;
    captured.gyms = props.gyms;
    captured.rowArgs = props;
    return [];
  },
}));
vi.mock('../../../src/theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12, full: 9999 },
  shadows: { sm: {} },
}));

const { default: GymDiscovery } = await import('../index');
const { default: BoardsGymMap } = await import('../../boards/gyms');
const { GymRouteStackContext } = await import('../../../src/components/gym-page/use-gym-route-stack');

const GYM_WALL = { uuid: 'wall-1', name: 'Crux Kilter', gymUuid: 'gym-1' } as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'ios';
  captured.params = {};
  captured.activateOptions = null;
  captured.analyticsOptions = null;
  captured.onActivateBoard = null;
  captured.onRegionChange = null;
  captured.mapCenter = undefined;
  captured.keyboardOverlap = 0;
  captured.locationStatus = 'idle';
  cameraMocks.setCenter.mockClear();
  cameraMocks.showWorld.mockClear();
  panelSnapTo.mockClear();
  captured.onMapUnavailable = null;
  captured.onMapReady = null;
  captured.mapAvailable = null;
  captured.mapMounts = 0;
  captured.onPressGym = null;
  captured.chips = null;
  captured.coords = undefined;
  captured.standaloneBoards = [];
  captured.gyms = [];
  captured.locationPrompt = undefined;
  captured.onSelectPlace = null;
  captured.rowArgs = null;
  captured.rosterQuery = { data: undefined, isPending: false, isError: false };
  captured.rosterGymUuids = [];
  captured.segments = ['gyms'];
  captured.panelOpeners = null;
  captured.cardList = null;
  captured.browseRow = null;
  captured.gymsQuery = idleQuery();
  captured.boardsQuery = idleQuery();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function idleQuery(): DiscoveryQuery {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    isPlaceholderData: false,
  };
}

function distinctQueries(queryMock: typeof queryMocks.gyms) {
  return [...new Set(queryMock.mock.calls.map((args: unknown[]) => JSON.stringify(args)))];
}

describe('picking a board on the gym finder', () => {
  it('offers a fresh map attempt while keeping board selection usable after a map failure', () => {
    captured.coords = { latitude: 40.76, longitude: -111.89 };
    const { getByText, getByRole, queryByText } = render(<GymDiscovery />);
    expect(captured.mapMounts).toBe(1);
    act(() => captured.onMapUnavailable?.());
    expect(captured.mapAvailable).toBe(false);
    expect(getByText('mobile.gyms.mapUnavailable')).toBeTruthy();
    captured.onActivateBoard?.(GYM_WALL);
    expect(bindMock).toHaveBeenCalledWith(GYM_WALL, { pickSource: 'gym_finder', section: 'map' });

    fireEvent.click(getByRole('button', { name: 'mobile.gyms.retryMap' }));
    expect(captured.mapMounts).toBe(2);
    expect(captured.mapAvailable).toBe(true);
    expect(queryByText('mobile.gyms.mapUnavailable')).toBeNull();
  });

  it('restores map gestures and removes the message when a stalled map loads late', () => {
    captured.coords = { latitude: 40.76, longitude: -111.89 };
    const { queryByText } = render(<GymDiscovery />);
    act(() => captured.onMapUnavailable?.());
    expect(captured.mapAvailable).toBe(false);
    act(() => captured.onMapReady?.());
    expect(captured.mapAvailable).toBe(true);
    expect(queryByText('mobile.gyms.mapUnavailable')).toBeNull();
    expect(captured.mapMounts).toBe(1);
  });

  it('lets the search field grow beyond its 44-point minimum', () => {
    const { container } = render(<GymDiscovery />);
    const input = container.querySelector('input');
    const fieldStyles = JSON.parse(input?.parentElement?.getAttribute('data-native-style') ?? '[]') as {
      minHeight?: number;
      height?: number;
    }[];
    expect(Object.assign({}, ...fieldStyles)).toMatchObject({ minHeight: 44 });
    expect(Object.assign({}, ...fieldStyles).height).toBeUndefined();
  });

  it('binds through useActivateBoard, tagged as a gym finder pick', () => {
    render(createElement(GymDiscovery));

    captured.onActivateBoard?.(GYM_WALL);

    expect(bindMock).toHaveBeenCalledWith(GYM_WALL, { pickSource: 'gym_finder', section: 'map' });
    // The pick event rides the bind's onBound.
    expect(captured.activateOptions?.onBound).toBe(trackSelectionMock);
    expect(captured.activateOptions?.returnTo).toBe('/(tabs)/climbs');
  });

  it('is an ordinary switch when the picker did not come from onboarding', () => {
    captured.params = { from: 'picker' };
    render(createElement(GymDiscovery));

    expect(captured.activateOptions?.source).toBeUndefined();
    expect(captured.analyticsOptions?.fromOnboarding).toBe(false);
  });

  it('is the activation bind when the onboarding picker forwarded its source', () => {
    captured.params = { source: 'onboarding', from: 'picker' };
    render(createElement(GymDiscovery));

    expect(captured.activateOptions?.source).toBe('onboarding');
    expect(captured.analyticsOptions?.fromOnboarding).toBe(true);
  });

  // The no-board picker's gym picks are ordinary switches, filed under its source.
  it('files picks under the no-board picker when it forwarded its source', () => {
    captured.params = { source: 'no_board', from: 'picker' };
    render(createElement(GymDiscovery));

    expect(captured.activateOptions?.source).toBeUndefined();
    expect(captured.analyticsOptions?.fromOnboarding).toBe(false);
    expect(captured.analyticsOptions?.fromNoBoard).toBe(true);
  });

  // A stray value must not turn an ordinary gym pick into a first-run close-out.
  it('ignores any other source', () => {
    captured.params = { source: 'board_picker' };
    render(createElement(GymDiscovery));

    expect(captured.activateOptions?.source).toBeUndefined();
    expect(captured.analyticsOptions?.fromOnboarding).toBe(false);
    expect(captured.analyticsOptions?.fromNoBoard).toBe(false);
  });
});

// The map used to show the system prompt on every open. Now it only uses an
// earlier yes, and asking waits for a tap on "See gyms near you".
describe('location on open', () => {
  beforeEach(() => {
    locationMocks.request.mockClear();
    locationMocks.requestIfAllowed.mockClear();
  });

  it('never shows the system prompt on open', () => {
    captured.coords = undefined;
    render(createElement(GymDiscovery));
    expect(locationMocks.request).not.toHaveBeenCalled();
    expect(locationMocks.requestIfAllowed).toHaveBeenCalledOnce();
  });

  it('reads the permission once, not on every render', () => {
    captured.coords = undefined;
    const screen = render(createElement(GymDiscovery));
    screen.rerender(createElement(GymDiscovery));
    expect(locationMocks.requestIfAllowed).toHaveBeenCalledOnce();
    expect(locationMocks.request).not.toHaveBeenCalled();
  });
});

describe('counting the opening', () => {
  // The picker already reported `Board Picker Opened`; a second one would double
  // every picker session that went through "Find gym".
  it('leaves the opening to the picker that pushed it', () => {
    captured.params = { from: 'picker' };
    render(createElement(GymDiscovery));

    expect(captured.analyticsOptions?.surface).toBe('gym_finder_from_picker');
  });

  // Home and My gyms push `/gyms` bare. Nothing else counted that opening.
  it('counts its own opening when Home or My gyms opened it', () => {
    render(createElement(GymDiscovery));

    expect(captured.analyticsOptions?.surface).toBe('gym_finder');
  });
});

describe('discovery search integration', () => {
  const madrid: Coords = { latitude: 40.47, longitude: -3.86 };
  const panned: Coords = { latitude: 40.5, longitude: -3.9 };

  beforeEach(() => {
    vi.useFakeTimers();
    captured.coords = madrid;
  });

  it('keeps native initial map layout while a cold location request resolves', () => {
    captured.coords = undefined;
    const screen = render(createElement(GymDiscovery));
    expect(captured.mapAvailable).toBe(true);
    captured.coords = madrid;
    screen.rerender(createElement(GymDiscovery));
    expect(captured.mapAvailable).toBe(true);
  });

  it('shows a coordinate-free gym name result instead of the location prompt', () => {
    platform.OS = 'web';
    captured.coords = undefined;
    captured.gymsQuery = {
      ...idleQuery(),
      isSuccess: true,
      data: {
        gyms: [
          { uuid: 'atlanta', name: 'Central Rock Gym Atlanta Bouldering', latitude: null, longitude: null } as Gym,
        ],
        boards: [],
      },
    };
    const screen = render(createElement(GymDiscovery));
    expect(captured.locationPrompt).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'atlanta bouldering' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(geocodeMock).not.toHaveBeenCalled();
    expect(captured.locationPrompt).toBeUndefined();
    expect(captured.mapAvailable).toBe(false);
    expect(screen.getByText('Central Rock Gym Atlanta Bouldering')).toBeTruthy();
    expect(queryMocks.gyms.mock.lastCall?.[0]).toBeNull();
    expect(queryMocks.gyms.mock.lastCall?.[2]).toBe('atlanta bouldering');
  });

  it('uses selected city coordinates without a name filter and preserves board chips', () => {
    platform.OS = 'web';
    captured.coords = undefined;
    captured.params = { source: 'onboarding', boardType: 'kilter' };
    const screen = render(createElement(GymDiscovery));
    const place: PlaceSuggestion = {
      id: 4180439,
      name: 'Atlanta',
      region: 'Georgia',
      country: 'United States',
      countryCode: 'US',
      latitude: 33.749,
      longitude: -84.388,
    };
    act(() => captured.onSelectPlace?.(place));
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual({ latitude: 33.749, longitude: -84.388 });
    expect(queryMocks.gyms.mock.lastCall?.[2]).toBeUndefined();
    expect(captured.chips?.selected).toEqual(['kilter']);
    expect(captured.locationPrompt).toBeUndefined();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(queryMocks.gyms.mock.lastCall?.[2]).toBeUndefined();
  });

  it('drops retained standalone boards when a city is replaced with a global name search', () => {
    platform.OS = 'web';
    captured.coords = undefined;
    captured.boardsQuery = {
      ...idleQuery(),
      isSuccess: true,
      data: {
        gyms: [],
        boards: [
          { uuid: 'old-board', name: 'Old city board', gymUuid: null, latitude: 33.7, longitude: -84.3 } as UserBoard,
        ],
      },
    };
    const screen = render(createElement(GymDiscovery));
    act(() =>
      captured.onSelectPlace?.({
        id: 4180439,
        name: 'Atlanta',
        region: 'Georgia',
        country: 'United States',
        countryCode: 'US',
        latitude: 33.749,
        longitude: -84.388,
      }),
    );
    expect(captured.standaloneBoards).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'atlanta bouldering' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    act(() => vi.advanceTimersByTime(500));
    expect(queryMocks.gyms.mock.lastCall?.[0]).toBeNull();
    expect(captured.standaloneBoards).toEqual([]);
  });

  it('clears a town picked from the native suggestions once its label is edited', () => {
    captured.coords = undefined;
    const screen = render(createElement(GymDiscovery));
    act(() =>
      captured.onSelectPlace?.({
        id: 4180439,
        name: 'Atlanta',
        region: 'Georgia',
        country: 'United States',
        countryCode: 'US',
        latitude: 33.749,
        longitude: -84.388,
      }),
    );
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual({ latitude: 33.749, longitude: -84.388 });
    // Submitting the picked label again is not a gym-name search.
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(queryMocks.gyms.mock.lastCall?.[2]).toBeUndefined();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Atlant' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(queryMocks.gyms.mock.lastCall?.[0]).toBeNull();
    // No fix to go back to: the camera leaves the city for the world, and the
    // map stays up instead of being torn down.
    expect(cameraMocks.showWorld).toHaveBeenCalled();
    expect(captured.mapMounts).toBe(1);
    expect(captured.mapCenter).toBeNull();
  });

  it('flies back to the climber when a picked city is edited', () => {
    const screen = render(createElement(GymDiscovery));
    act(() =>
      captured.onSelectPlace?.({
        id: 4180439,
        name: 'Atlanta',
        region: 'Georgia',
        country: 'United States',
        countryCode: 'US',
        latitude: 33.749,
        longitude: -84.388,
      }),
    );
    cameraMocks.setCenter.mockClear();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Atlant' } });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(cameraMocks.setCenter).toHaveBeenCalledWith(madrid);
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual(madrid);
    expect(cameraMocks.showWorld).not.toHaveBeenCalled();
  });

  it('opens on the world with location off, flies to a fix that arrives later, and keeps the map mounted', () => {
    captured.coords = undefined;
    captured.locationStatus = 'denied';
    const screen = render(createElement(GymDiscovery));
    expect(captured.mapMounts).toBe(1);
    expect(captured.mapCenter).toBeNull();

    captured.locationStatus = 'granted';
    captured.coords = madrid;
    screen.rerender(createElement(GymDiscovery));
    expect(cameraMocks.setCenter).toHaveBeenCalledWith(madrid);
    expect(captured.mapMounts).toBe(1);
  });

  it('searches the world view only once it is zoomed in to a region', () => {
    captured.coords = undefined;
    captured.locationStatus = 'denied';
    render(createElement(GymDiscovery));
    const utrecht = { latitude: 52.09, longitude: 5.12 };
    act(() => captured.onRegionChange?.(utrecht, 3));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(queryMocks.gyms.mock.lastCall?.[0]).toBeNull();

    act(() => captured.onRegionChange?.(utrecht, 10));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual(utrecht);

    // Zooming back out to the world leaves the search where it was.
    act(() => captured.onRegionChange?.({ latitude: 20, longitude: -30 }, 2));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual(utrecht);
  });

  it('ends the panel at the keyboard top while the keyboard is up', () => {
    const screen = render(createElement(GymDiscovery));
    expect(captured.panelBox).toEqual({ availableHeight: 852 });
    captured.keyboardOverlap = 336;
    screen.rerender(createElement(GymDiscovery));
    expect(captured.panelBox).toEqual({ availableHeight: 516 });
  });

  it('raises the panel while the search field has focus', () => {
    const screen = render(createElement(GymDiscovery));
    fireEvent.focus(screen.getByRole('textbox'));
    expect(panelSnapTo).toHaveBeenCalledWith('high');
  });

  it('keeps chip changes made while native geocoding is pending', async () => {
    let finishGeocode!: (coords: Coords) => void;
    geocodeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishGeocode = resolve;
      }),
    );
    const screen = render(createElement(GymDiscovery));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Paris' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    act(() => captured.chips?.onToggle('kilter'));
    await act(async () => {
      finishGeocode({ latitude: 48.86, longitude: 2.35 });
    });
    act(() => vi.advanceTimersByTime(500));
    expect(captured.chips?.selected).toEqual(['kilter']);
    expect(queryMocks.gyms.mock.lastCall?.[3]).toEqual(['kilter']);
  });

  it('discards a geocode response after clearing the search', async () => {
    let resolveGeocode!: (coords: Coords | null) => void;
    geocodeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGeocode = resolve;
      }),
    );
    const screen = render(createElement(GymDiscovery));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Paris' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(geocodeMock).toHaveBeenCalledWith('Paris');
    fireEvent.click(screen.getByRole('button', { name: 'mobile.gyms.clearSearch' }));
    await act(async () => {
      resolveGeocode({ latitude: 48.86, longitude: 2.35 });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('textbox')).toHaveProperty('value', '');
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual(madrid);
    expect(queryMocks.boards.mock.lastCall?.[0]).toEqual(madrid);
    expect(distinctQueries(queryMocks.boards)).toHaveLength(1);
  });

  it('commits rapid chips and a pan together after the final 500 ms', () => {
    const screen = render(createElement(GymDiscovery));
    act(() => captured.chips?.onToggle('kilter'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    act(() => captured.chips?.onToggle('tension'));
    act(() => captured.chips?.onToggle('kilter'));
    act(() => captured.onRegionChange?.(panned));
    expect(captured.chips?.selected).toEqual(['tension']);
    expect(screen.getByText('mobile.gyms.updating')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(distinctQueries(queryMocks.gyms)).toHaveLength(1);
    expect(distinctQueries(queryMocks.boards)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(distinctQueries(queryMocks.gyms)).toHaveLength(2);
    expect(distinctQueries(queryMocks.boards)).toHaveLength(2);
    expect(queryMocks.gyms).toHaveBeenLastCalledWith(
      panned,
      50,
      undefined,
      ['tension'],
      undefined,
      undefined,
      undefined,
    );
    expect(queryMocks.boards).toHaveBeenLastCalledWith(panned, 50, undefined, 50, ['tension'], undefined, undefined);
    expect(screen.queryByText('mobile.gyms.updating')).toBeNull();
  });

  it('ignores a tiny pan and a programmatic gym-camera echo without changing query inputs', () => {
    render(createElement(GymDiscovery));
    act(() => captured.onRegionChange?.({ latitude: 40.47001, longitude: -3.86 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const gym = { uuid: 'gym-paris', latitude: 48.86, longitude: 2.35 } as Gym;
    act(() => captured.onPressGym?.(gym));
    act(() => captured.onRegionChange?.({ latitude: 48.86001, longitude: 2.35 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(distinctQueries(queryMocks.gyms)).toHaveLength(1);
    expect(distinctQueries(queryMocks.boards)).toHaveLength(1);
    expect(queryMocks.gyms.mock.lastCall?.[0]).toEqual(madrid);
  });

  it('shows updating during recovery, then retries both queries after terminal failure', () => {
    captured.boardsQuery = { ...idleQuery(), isFetching: true };
    const screen = render(createElement(GymDiscovery));
    expect(screen.getByText('mobile.gyms.updating')).toBeTruthy();
    expect(screen.queryByText('mobile.gyms.retry')).toBeNull();
    captured.boardsQuery = { ...idleQuery(), isError: true };
    screen.rerender(createElement(GymDiscovery));
    expect(screen.queryByText('mobile.gyms.updating')).toBeNull();
    expect(screen.getByText('mobile.gyms.refreshFailed')).toBeTruthy();
    fireEvent.click(screen.getByText('mobile.gyms.retry'));
    expect(refetchGyms).toHaveBeenCalledTimes(1);
    expect(refetchBoards).toHaveBeenCalledTimes(1);
  });

  it('retains visible boards on a failed refresh and replaces them after an empty success', () => {
    const standalone = { ...GYM_WALL, gymUuid: null, latitude: madrid.latitude, longitude: madrid.longitude };
    captured.boardsQuery = { ...idleQuery(), isSuccess: true, data: { gyms: [], boards: [standalone] } };
    const screen = render(createElement(GymDiscovery));
    expect(captured.standaloneBoards).toEqual([standalone]);
    captured.boardsQuery = { ...idleQuery(), isFetching: true };
    screen.rerender(createElement(GymDiscovery));
    expect(captured.standaloneBoards).toEqual([standalone]);
    captured.boardsQuery = { ...idleQuery(), isError: true };
    screen.rerender(createElement(GymDiscovery));
    expect(captured.standaloneBoards).toEqual([standalone]);
    captured.boardsQuery = { ...idleQuery(), isSuccess: true, data: { gyms: [], boards: [] } };
    screen.rerender(createElement(GymDiscovery));
    expect(captured.standaloneBoards).toEqual([]);
  });

  it('fetches the expanded gym roster and narrows it by the board-type chip', () => {
    const kilter = { ...GYM_WALL, uuid: 'k', boardType: 'kilter', layoutId: 1, sizeId: 7 } as unknown as UserBoard;
    const tension = { ...GYM_WALL, uuid: 't', boardType: 'tension', layoutId: 9, sizeId: 3 } as unknown as UserBoard;
    captured.rosterQuery = { data: [kilter, tension], isPending: false, isError: false };
    const screen = render(createElement(GymDiscovery));
    act(() => captured.onPressGym?.({ uuid: 'gym-1', name: 'Crux' } as unknown as Gym));
    expect(captured.rosterGymUuids.at(-1)).toBe('gym-1');
    expect(captured.rowArgs?.expandedGymRoster?.map((board) => board.uuid)).toEqual(['k', 't']);
    vi.useFakeTimers();
    act(() => captured.chips?.onToggle('tension'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(captured.rowArgs?.expandedGymRoster?.map((board) => board.uuid)).toEqual(['t']);
    screen.unmount();
  });

  it('marks the roster pending while loading, not once it has settled or failed', () => {
    captured.rosterQuery = { data: undefined, isPending: true, isError: false };
    render(createElement(GymDiscovery));
    act(() => captured.onPressGym?.({ uuid: 'gym-1', name: 'Crux' } as unknown as Gym));
    expect(captured.rowArgs?.expandedGymRosterPending).toBe(true);
    captured.rosterQuery = { data: undefined, isPending: false, isError: true };
    act(() => captured.onPressGym?.({ uuid: 'gym-2', name: 'Other' } as unknown as Gym));
    expect(captured.rowArgs?.expandedGymRosterPending).toBe(false);
    captured.rosterQuery = { data: [], isPending: false, isError: false };
    act(() => captured.onPressGym?.({ uuid: 'gym-3', name: 'Third' } as unknown as Gym));
    expect(captured.rowArgs?.expandedGymRosterPending).toBe(false);
  });
});

describe('gym finder analytics', () => {
  const madrid: Coords = { latitude: 40.47, longitude: -3.86 };
  const atlanta: PlaceSuggestion = {
    id: 4180439,
    name: 'Atlanta',
    region: 'Georgia',
    country: 'United States',
    countryCode: 'US',
    latitude: 33.749,
    longitude: -84.388,
  };

  beforeEach(() => {
    captured.coords = madrid;
  });

  it('reports a town search once per visit, tagged with the map surface', () => {
    render(createElement(GymDiscovery));
    act(() => captured.onSelectPlace?.(atlanta));
    act(() => captured.onSelectPlace?.(atlanta));
    const searches = trackMock.mock.calls.filter(([name]) => name === 'Gym Finder Search Used');
    expect(searches).toEqual([['Gym Finder Search Used', { surface: 'gyms_map', kind: 'town' }]]);
  });

  it('reports a gym opened from the list, and not its fold', () => {
    render(createElement(GymDiscovery));
    const gym = { uuid: 'gym-1', name: 'Crux' } as unknown as Gym;
    act(() => captured.onPressGym?.(gym));
    act(() => captured.onPressGym?.(gym));
    const picks = trackMock.mock.calls.filter(([name]) => name === 'Gym Finder Gym Picked');
    expect(picks).toEqual([['Gym Finder Gym Picked', { surface: 'gyms_map', section: 'list' }]]);
  });
});

// The gym map is registered twice (gym-page-route.ts): the root copy draws the
// full-screen map and its panel; the board picker's copy (app/boards/gyms.tsx)
// draws the map card over the list, because a draggable panel inside the
// picker's sheet is a sheet on a sheet. Each route file names its shell, and
// what each opens follows the stack it is REGISTERED in (the context the
// picker's layout provides), never the focused route: a root map under a Boards
// modal must not swap shells or start pushing into the picker.
describe('the two copies of the gym map', () => {
  const madrid: Coords = { latitude: 40.47, longitude: -3.86 };
  const crux = { uuid: 'gym-1', name: 'Crux' } as unknown as Gym;
  const gymRow = { kind: 'gym', key: 'gym:gym-1', gym: crux };

  function renderPickerCopy() {
    return render(createElement(GymRouteStackContext.Provider, { value: 'boards' }, createElement(BoardsGymMap)));
  }

  it('keeps the full-screen map and its panel on the root stack, whatever route is focused', () => {
    captured.segments = ['boards', 'index'];
    const { queryByTestId } = render(createElement(GymDiscovery));
    expect(captured.panelOpeners).not.toBeNull();
    expect(queryByTestId('map-card-list')).toBeNull();
  });

  it('opens the gym page and the gym editor in the root stack from the root map, even under a Boards modal', () => {
    captured.segments = ['boards', 'index'];
    render(createElement(GymDiscovery));
    act(() => captured.panelOpeners?.onOpenGym?.(crux));
    act(() => captured.panelOpeners?.onEditGym(crux));
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/[gym]', params: { gym: 'gym-1' } });
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/gyms/edit', params: { gymUuid: 'gym-1' } });
  });

  it('draws a map card over the list in the picker, with no draggable panel and no floating close', () => {
    captured.segments = ['gyms'];
    captured.coords = madrid;
    const { getByTestId, queryByLabelText } = renderPickerCopy();
    expect(getByTestId('map-card-list')).toBeTruthy();
    expect(captured.panelOpeners).toBeNull();
    expect(captured.cardList?.map).toBeTruthy();
    expect(queryByLabelText('mobile.gyms.closeMap')).toBeNull();
    // The filter chips ride in the card list's sticky slot.
    expect(captured.chips).not.toBeNull();
  });

  it('shows the location prompt as the only row while there is nowhere to look', () => {
    renderPickerCopy();
    expect(captured.cardList?.data.map((row) => row.kind)).toEqual(['locationPrompt']);
  });

  it('folds the map card on focus, and keeps it folded after a blur that left text', () => {
    captured.coords = madrid;
    const { container } = renderPickerCopy();
    expect(captured.cardList?.mapHidden).toBe(false);
    const field = container.querySelector('input');
    if (!field) throw new Error('no search field');
    act(() => {
      fireEvent.focus(field);
    });
    expect(captured.cardList?.mapHidden).toBe(true);
    act(() => {
      fireEvent.change(field, { target: { value: 'Cr' } });
    });
    act(() => {
      fireEvent.blur(field);
    });
    expect(captured.cardList?.mapHidden).toBe(true);
  });

  it('unfolds the map card on a blur that leaves the picked town unchanged', () => {
    captured.coords = madrid;
    const lyon: PlaceSuggestion = {
      id: 2996944,
      name: 'Lyon',
      region: 'Auvergne-Rhone-Alpes',
      country: 'France',
      countryCode: 'FR',
      latitude: 45.764,
      longitude: 4.8357,
    };
    const { container } = renderPickerCopy();
    act(() => captured.onSelectPlace?.(lyon));
    expect(captured.cardList?.mapHidden).toBe(false);
    const field = container.querySelector('input');
    if (!field) throw new Error('no search field');
    act(() => {
      fireEvent.focus(field);
    });
    expect(captured.cardList?.mapHidden).toBe(true);
    // Submitting the town's own label changes nothing, so the blur must bring the card back.
    act(() => {
      fireEvent.blur(field);
    });
    expect(captured.cardList?.mapHidden).toBe(false);
  });

  it('opens the gym page and the gym editor inside the picker stack, whatever route is focused', () => {
    captured.segments = ['gyms'];
    captured.coords = madrid;
    captured.params = { returnTo: '/(tabs)/climbs' };
    renderPickerCopy();
    const rowElement = captured.cardList?.renderItem({ item: gymRow });
    render(createElement('div', null, rowElement));
    act(() => captured.browseRow?.onOpenGym?.(crux));
    act(() => captured.browseRow?.onEditGym(crux));
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/boards/gym/[gym]',
      params: { gym: 'gym-1', returnTo: '/(tabs)/climbs' },
    });
    expect(routerMock.push).toHaveBeenCalledWith({ pathname: '/boards/gyms/edit', params: { gymUuid: 'gym-1' } });
  });
});
