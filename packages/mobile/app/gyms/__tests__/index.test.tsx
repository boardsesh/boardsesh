// @vitest-environment jsdom
//
// The gym finder binds a board through the same `useActivateBoard` path as every
// other picker (#5654), so a pick here fires the pick event, follows the board
// and, when the picker forwarded `source=onboarding`, closes out first-run. It
// used to carry its own copy of the bind that did none of that, and "Find your
// gym on the map" is the first-board picker's only way forward from "Location is
// off".
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type Children = { children?: ReactNode };
type ActivateOptions = { source?: 'onboarding'; returnTo: string; onBound?: unknown };
type AnalyticsOptions = { fromOnboarding: boolean; fromNoBoard?: boolean; surface?: string; returnTo: string };

const routerMock = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn(), canGoBack: () => true }));
const bindMock = vi.hoisted(() => vi.fn((): Promise<void> => Promise.resolve()));
const trackSelectionMock = vi.hoisted(() => vi.fn((): Promise<void> => Promise.resolve()));
const captured = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  activateOptions: null as ActivateOptions | null,
  analyticsOptions: null as AnalyticsOptions | null,
  onActivateBoard: null as ((board: UserBoard) => void) | null,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: Children) => createElement('div', null, children),
  Pressable: ({ children }: Children) => createElement('div', null, children),
  TextInput: () => createElement('input'),
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
  useNearbyGyms: () => ({ data: undefined, isLoading: false }),
  useNearbyBoards: () => ({ data: undefined }),
}));
vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null, isError: false }),
}));
vi.mock('../../../src/lib/use-device-location', () => ({
  useDeviceLocation: () => ({ status: 'idle', coords: undefined, request: vi.fn(() => Promise.resolve()) }),
}));
vi.mock('../../../src/lib/use-place-search', () => ({
  useGeocodePlace: () => ({ geocode: vi.fn(), isGeocoding: false }),
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
vi.mock('../../../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../../../src/components/ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../src/components/gym-directory/GymMap', () => ({ GymMap: () => null }));
vi.mock('../../../src/components/gym-directory/GymListPanel', () => ({
  GymListPanel: (props: { onActivateBoard: (board: UserBoard) => void }) => {
    captured.onActivateBoard = props.onActivateBoard;
    return null;
  },
}));
vi.mock('../../../src/components/gym-directory/GymLocationPrompt', () => ({ GymLocationPrompt: () => null }));
vi.mock('../../../src/components/gym-directory/ClaimGymSheet', () => ({ ClaimGymSheet: () => null }));
vi.mock('../../../src/components/gym-directory/WallFinderFilterChips', () => ({ WallFinderFilterChips: () => null }));
vi.mock('../../../src/components/gym-directory/gym-list-rows', () => ({ buildGymListRows: () => [] }));
vi.mock('../../../src/lib/wall-finder-filter', () => ({
  DEFAULT_WALL_FINDER_FILTER: {},
  buildLayoutOptions: () => [],
  buildSizeOptions: () => [],
  clearWallFinderChipFilters: (filter: unknown) => filter,
  toggleBoardTypeFilter: (filter: unknown) => filter,
  toggleLayoutFilter: (filter: unknown) => filter,
  toggleMultiBoardTypeFilter: (filter: unknown) => filter,
  toggleSizeFilter: (filter: unknown) => filter,
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
});

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
