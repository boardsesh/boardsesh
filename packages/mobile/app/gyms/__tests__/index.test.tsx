// @vitest-environment jsdom
//
// The gym finder binds a board through the same `useActivateBoard` path as every
// other picker (#5654), so a pick here fires the pick event, follows the board
// and, when the picker forwarded `source=onboarding`, closes out first-run. It
// used to carry its own copy of the bind that did none of that, and "Find your
// gym on the map" is the first-board picker's only way forward from "Location is
// off".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
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
const captured = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  activateOptions: null as ActivateOptions | null,
  analyticsOptions: null as AnalyticsOptions | null,
  onActivateBoard: null as ((board: UserBoard) => void) | null,
  onRegionChange: null as ((center: Coords) => void) | null,
  onPressGym: null as ((gym: Gym) => void) | null,
  chips: null as WallFinderFilterChipsProps | null,
  coords: undefined as Coords | undefined,
  gymsQuery: null as DiscoveryQuery | null,
  boardsQuery: null as DiscoveryQuery | null,
  standaloneBoards: [] as UserBoard[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
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
  }: {
    value: string;
    onChangeText: (text: string) => void;
    onSubmitEditing: () => void;
  }) =>
    createElement('input', {
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') onSubmitEditing();
      },
    }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => routerMock,
  useLocalSearchParams: () => captured.params,
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
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null, isError: false }),
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'idle', coords: captured.coords, request: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../src/lib/use-place-search', () => ({
  useGeocodePlace: () => ({ geocode: geocodeMock, isGeocoding: false }),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
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
  GymMap: (props: { onRegionChange: (center: Coords) => void }) => {
    captured.onRegionChange = props.onRegionChange;
    return null;
  },
}));
vi.mock('../../../src/components/gym-directory/GymListPanel', () => ({
  GymListPanel: (props: {
    onActivateBoard: (board: UserBoard) => void;
    onPressGym: (gym: Gym) => void;
    filterSlot?: ReactNode;
    placeCaption?: ReactNode;
    searchSlot?: ReactNode;
  }) => {
    captured.onActivateBoard = props.onActivateBoard;
    captured.onPressGym = props.onPressGym;
    return createElement('div', null, props.searchSlot, props.filterSlot, props.placeCaption);
  },
}));
vi.mock('../../../src/components/gym-directory/GymLocationPrompt', () => ({ GymLocationPrompt: () => null }));
vi.mock('../../../src/components/gym-directory/ClaimGymSheet', () => ({ ClaimGymSheet: () => null }));
vi.mock('../../../src/components/gym-directory/WallFinderFilterChips', () => ({
  WallFinderFilterChips: (props: WallFinderFilterChipsProps) => {
    captured.chips = props;
    return null;
  },
}));
vi.mock('../../../src/components/gym-directory/gym-list-rows', () => ({
  buildGymListRows: (props: { standaloneBoards: UserBoard[] }) => {
    captured.standaloneBoards = props.standaloneBoards;
    return [];
  },
}));
vi.mock('../../../src/theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12, full: 9999 },
  shadows: { sm: {} },
}));

const { default: GymDiscovery } = await import('../index');

const GYM_WALL = { uuid: 'wall-1', name: 'Crux Kilter', gymUuid: 'gym-1' } as unknown as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  captured.params = {};
  captured.activateOptions = null;
  captured.analyticsOptions = null;
  captured.onActivateBoard = null;
  captured.onRegionChange = null;
  captured.onPressGym = null;
  captured.chips = null;
  captured.coords = undefined;
  captured.standaloneBoards = [];
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
  it('binds through useActivateBoard, tagged as a gym finder pick', () => {
    render(createElement(GymDiscovery));

    captured.onActivateBoard?.(GYM_WALL);

    expect(bindMock).toHaveBeenCalledWith(GYM_WALL, { pickSource: 'gym_finder' });
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
});
