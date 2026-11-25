// @vitest-environment jsdom
//
// "Which gym?" (the add-a-board gym step): one page under the bar, never a
// second sheet. Nothing is asked on open, the map starts on the world, a town
// flies it there and lists the gyms around it, and a row picks with the board
// type in force.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactElement, type ReactNode, type Ref } from 'react';
import type { Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import type { GymPickRow } from '../../../gym-directory/gym-pick-rows';

type Children = { children?: ReactNode; testID?: string };
type Coords = { latitude: number; longitude: number };
type StyleValue = Record<string, unknown> | false | null | undefined | StyleValue[];

function flatten(style: StyleValue): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}

const trackMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const requestIfAllowedMock = vi.hoisted(() => vi.fn());
const setCenterMock = vi.hoisted(() => vi.fn());
const showWorldMock = vi.hoisted(() => vi.fn());
const scrollToItemKeyMock = vi.hoisted(() => vi.fn());
const scrollToTopMock = vi.hoisted(() => vi.fn());
const dismissKeyboardMock = vi.hoisted(() => vi.fn());
const refetchMock = vi.hoisted(() => vi.fn());
const openSettingsMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  location: {
    status: 'idle',
    permission: 'unknown',
    permissionChecked: false,
    coords: null as Coords | null,
  },
  gyms: undefined as { gyms: unknown[] } | undefined,
  gymsFailed: false,
  gymsArgs: [] as unknown[],
  mapCenter: undefined as Coords | null | undefined,
  onRegionChange: undefined as ((coords: Coords, zoom?: number) => void) | undefined,
  onMarkerPress: undefined as ((id: string) => void) | undefined,
  onSuggestionsChange: undefined as ((places: readonly PlaceSuggestion[]) => void) | undefined,
  headerInset: 0,
  list: null as { mapHidden?: boolean; mapAvailable?: boolean; locateLabel?: string } | null,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID, style }: Children & { style?: StyleValue }) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flatten(style ?? null)) }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
  Keyboard: { dismiss: dismissKeyboardMock },
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => (options?.count ?? '') + key }),
}));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useNearbyGyms: (...args: unknown[]) => {
    state.gymsArgs = args;
    const enabled = args[0] !== null || typeof args[2] === 'string';
    return {
      data: enabled && !state.gymsFailed ? state.gyms : undefined,
      isLoading: enabled && !state.gyms && !state.gymsFailed,
      isError: enabled && state.gymsFailed,
      isFetching: false,
      error: null,
      refetch: refetchMock,
    };
  },
}));
vi.mock('../../../../lib/graphql/extract-error-message', () => ({ isGraphqlRateLimitedError: () => false }));
vi.mock('../../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ ...state.location, request: requestMock, requestIfAllowed: requestIfAllowedMock }),
}));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => false,
}));
vi.mock('../../../../lib/open-app-settings', () => ({
  canOpenAppSettings: () => true,
  openAppSettings: openSettingsMock,
}));
vi.mock('../../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../../hooks/use-transparent-header-inset', () => ({
  useTransparentHeaderInset: () => state.headerInset,
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { groupedBackground: '#f2f2f7' }, brandColors: { primary: '#639' } }),
}));
vi.mock('../../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { full: 999 },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(accessibilityRole === 'header' ? 'h2' : 'span', null, children),
}));
vi.mock('../../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', null, 'loading') }));
vi.mock('../../../ReadableColumn', () => ({ READABLE_CONTENT_WIDTH: 672 }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress }: Children & { onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, children),
}));
vi.mock('../../../spray-wall/StepCounter', () => ({
  StepCounter: ({ label }: { label: string }) => createElement('p', { 'data-testid': 'step-counter' }, label),
}));
vi.mock('../../board-builder-labels', () => ({ boardTypeLabel: (board: string) => `label:${board}` }));
vi.mock('../../../filter-capsules/CapsuleRow', () => ({
  CapsuleRow: ({
    capsules,
  }: {
    capsules: { key: string; options: { value: string; label: string }[]; onSelect: (value: string) => void }[];
  }) =>
    createElement(
      'div',
      null,
      capsules.flatMap((capsule) =>
        capsule.options.map((option) =>
          createElement(
            'button',
            {
              key: `${capsule.key}:${option.value}`,
              type: 'button',
              'data-testid': `type-${option.value}`,
              onClick: () => capsule.onSelect(option.value),
            },
            option.label,
          ),
        ),
      ),
    ),
}));
vi.mock('../../../gym-directory/GymMap', () => ({
  GymMap: forwardRef(
    (
      {
        center,
        onRegionChange,
        onMarkerPress,
      }: {
        center: Coords | null;
        onRegionChange: (coords: Coords, zoom?: number) => void;
        onMarkerPress: (id: string) => void;
      },
      ref: Ref<unknown>,
    ) => {
      state.mapCenter = center;
      state.onRegionChange = onRegionChange;
      state.onMarkerPress = onMarkerPress;
      useImperativeHandle(ref, () => ({ setCenter: setCenterMock, showWorld: showWorldMock }), []);
      return createElement('div', { 'data-testid': 'gym-map' });
    },
  ),
}));
// The step is one page inside the Boards sheet: the old draggable panel must
// never come back. Rendering it fails the test.
vi.mock('../../../gym-directory/GymListPanel', () => ({
  GymListPanel: () => {
    throw new Error('GymStep must not draw a draggable panel inside the Boards sheet');
  },
}));
// The page itself: header (map), sticky (capsules), rows, footer, in order.
vi.mock('../../../gym-directory/MapCardList', () => ({
  MapCardList: ({
    ref,
    data,
    renderItem,
    keyExtractor,
    map,
    stickyHeader,
    footer,
    mapHidden,
    mapAvailable,
    onLocate,
    locateLabel,
  }: {
    ref?: Ref<unknown>;
    data: GymPickRow[];
    renderItem: (info: { item: GymPickRow }) => ReactElement | null;
    keyExtractor: (row: GymPickRow) => string;
    map?: ReactNode;
    stickyHeader?: ReactNode;
    footer?: ReactNode;
    mapHidden?: boolean;
    mapAvailable?: boolean;
    onLocate?: () => void;
    locateLabel?: string;
  }) => {
    state.list = { mapHidden, mapAvailable, locateLabel };
    useImperativeHandle(ref, () => ({ scrollToItemKey: scrollToItemKeyMock, scrollToTop: scrollToTopMock }), []);
    return createElement('section', { 'data-testid': 'map-card-list' }, [
      createElement('div', { key: 'map' }, map),
      createElement('button', { key: 'locate', type: 'button', 'data-testid': 'locate', onClick: onLocate }),
      createElement('div', { key: 'sticky' }, stickyHeader),
      ...data.map((row) => createElement('div', { key: keyExtractor(row) }, renderItem({ item: row }))),
      createElement('div', { key: 'footer' }, footer),
    ]);
  },
}));
vi.mock('../../../gym-directory/GymListTextRows', () => ({
  GymListSectionHeader: ({ label }: { label: string }) => createElement('h3', null, label),
  GymListEmptyRow: ({ label }: { label: string }) => createElement('p', null, label),
}));
vi.mock('../../../gym-directory/PickGymRow', () => ({
  PickGymRow: ({
    gym,
    subtitle,
    boardsLabel,
    selected,
    checked,
    onPickGym,
  }: {
    gym: Gym;
    subtitle: string | null;
    boardsLabel: string;
    selected: boolean;
    checked?: boolean;
    onPickGym: (gym: Gym) => void;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': `gym:${gym.uuid}`,
        'data-selected': selected,
        'data-checked': String(checked),
        onClick: () => onPickGym(gym),
      },
      `${gym.name} | ${subtitle} | ${boardsLabel}`,
    ),
  NoGymRow: ({
    title,
    subtitle,
    checked,
    onPickNone,
  }: {
    title: string;
    subtitle: string;
    checked: boolean;
    onPickNone: () => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': 'no-gym', 'data-checked': String(checked), onClick: onPickNone },
      `${title} | ${subtitle}`,
    ),
  PickPlaceRow: ({
    place,
    label,
    onSelectPlace,
  }: {
    place: PlaceSuggestion;
    label: string;
    onSelectPlace: (place: PlaceSuggestion) => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': `place:${place.id}`, onClick: () => onSelectPlace(place) },
      label,
    ),
  PickRetryAction: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { type: 'button', 'data-testid': 'retry', onClick: onPress }, label),
  AddGymRow: ({ title, subtitle, onAddGym }: { title: string; subtitle?: string; onAddGym: () => void }) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': 'add-gym', 'data-subtitle': subtitle ?? '', onClick: onAddGym },
      title,
    ),
}));
vi.mock('../../../gym-directory/GymLocationPrompt', () => ({
  GymLocationPrompt: ({
    status,
    permission,
    permissionChecked,
    onRequest,
    onRecheck,
  }: {
    status: string;
    permission: string;
    permissionChecked: boolean;
    onRequest: () => void;
    onRecheck: () => void;
  }) =>
    createElement('div', null, [
      createElement(
        'button',
        { key: 'ask', type: 'button', 'data-testid': 'location-prompt', onClick: () => onRequest() },
        `${status}|${permission}|${permissionChecked ? 'checked' : 'reading'}`,
      ),
      createElement('button', {
        key: 'recheck',
        type: 'button',
        'data-testid': 'location-recheck',
        onClick: () => onRecheck(),
      }),
    ]),
}));
const AMSTERDAM: PlaceSuggestion = {
  id: 2759794,
  name: 'Amsterdam',
  region: 'North Holland',
  country: 'Netherlands',
  countryCode: 'NL',
  latitude: 52.374,
  longitude: 4.8897,
};
vi.mock('../../../gym-directory/GymSearchField', () => ({
  GymSearchField: ({
    text,
    onChangeText,
    onSelectPlace,
    onFocusChange,
    onClear,
    onSuggestionsChange,
    suggestionsPlacement,
  }: {
    onClear: () => void;
    text: string;
    onChangeText: (text: string) => void;
    onSelectPlace: (place: PlaceSuggestion) => void;
    onFocusChange: (focused: boolean) => void;
    onSuggestionsChange?: (places: readonly PlaceSuggestion[]) => void;
    suggestionsPlacement?: string;
  }) => {
    state.onSuggestionsChange = onSuggestionsChange;
    return createElement('div', { 'data-placement': suggestionsPlacement, 'data-testid': 'search-field' }, [
      createElement('button', {
        key: 'focus',
        type: 'button',
        'data-testid': 'focus-search',
        onClick: () => onFocusChange(true),
      }),
      createElement('button', {
        key: 'blur',
        type: 'button',
        'data-testid': 'blur-search',
        onClick: () => onFocusChange(false),
      }),
      createElement('button', { key: 'clear', type: 'button', 'data-testid': 'clear-search', onClick: onClear }),
      createElement('input', {
        key: 'input',
        value: text,
        'data-testid': 'search',
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
      createElement(
        'button',
        { key: 'place', type: 'button', 'data-testid': 'pick-amsterdam', onClick: () => onSelectPlace(AMSTERDAM) },
        'Amsterdam',
      ),
    ]);
  },
}));

const { GymStep } = await import('../GymStep');

const BOULDERHAL = {
  uuid: 'gym-1',
  name: 'Boulderhal',
  address: 'Fokkerweg 75',
  latitude: 52.3705,
  longitude: 4.8888,
  boardCount: 3,
  boardTypes: ['kilter'],
  listingState: 'RUN_BY_GYM',
} as unknown as Gym;

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

const tracked = (name: string) => trackMock.mock.calls.filter(([event]) => event === name).map(([, props]) => props);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  state.location = { status: 'idle', permission: 'unknown', permissionChecked: false, coords: null };
  state.gyms = undefined;
  state.gymsFailed = false;
  state.gymsArgs = [];
  state.onRegionChange = undefined;
  state.onMarkerPress = undefined;
  state.onSuggestionsChange = undefined;
  state.headerInset = 0;
  state.mapCenter = undefined;
  state.list = null;
  requestIfAllowedMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GymStep', () => {
  it('is one page: the step counter, "Which gym?" and the search pinned under the bar, then the list', () => {
    state.headerInset = 98;
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn(), stepLabel: 'Step 2 of 4' }));
    // On iOS the bar is transparent glass: the page starts below it, so the
    // back chevron covers neither the counter nor the field.
    expect(JSON.parse(screen.getByTestId('gym-step').getAttribute('data-style') ?? '{}').paddingTop).toBe(98);
    const header = screen.getByTestId('gym-step-header');
    expect(header.querySelector('[data-testid="step-counter"]')?.textContent).toBe('Step 2 of 4');
    expect(header.querySelector('h2')?.textContent).toBe('mobile.gymStep.title');
    expect(header.contains(screen.getByTestId('search-field'))).toBe(true);
    expect(header.contains(screen.getByTestId('map-card-list'))).toBe(false);
    expect(screen.getByTestId('search-field').getAttribute('data-placement')).toBe('inline');
    expect(state.list?.locateLabel).toBe('mobile.gyms.grantLocation');
  });

  it('asks for nothing on open: it reads the permission, shows the world, and hands the prompt the hook', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    expect(requestIfAllowedMock).toHaveBeenCalledOnce();
    expect(requestMock).not.toHaveBeenCalled();
    expect(state.mapCenter).toBeNull();
    // The prompt gets the hook's own state: a spinner until the read is back.
    expect(screen.getByTestId('location-prompt').textContent).toBe('idle|unknown|reading');
    await settle();
    expect(requestMock).not.toHaveBeenCalled();

    // Its Allow is the hook's request; its re-read after Settings is requestIfAllowed.
    fireEvent.click(screen.getByTestId('location-prompt'));
    expect(requestMock).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('location-recheck'));
    expect(requestIfAllowedMock).toHaveBeenCalledTimes(2);
  });

  it('passes a permission refused for good through to the prompt', async () => {
    state.location = { status: 'idle', permission: 'blocked', permissionChecked: true, coords: null };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(screen.getByTestId('location-prompt').textContent).toBe('idle|blocked|checked');
  });

  it('flies to a picked town and lists the gyms within 50 km of it, without location', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();

    fireEvent.click(screen.getByTestId('focus-search'));
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    const amsterdam = { latitude: AMSTERDAM.latitude, longitude: AMSTERDAM.longitude };
    expect(setCenterMock).toHaveBeenLastCalledWith(amsterdam);
    expect(state.gymsArgs[0]).toEqual(amsterdam);
    expect(state.gymsArgs[1]).toBe(50);
    expect(state.gymsArgs[2]).toBeUndefined();
    expect(screen.queryByTestId('location-prompt')).toBeNull();
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('Amsterdam, North Holland, Netherlands');
    // No distance from a town: the row says where the gym is, not how far from it.
    expect(screen.getByTestId('gym:gym-1').textContent).toBe('Boulderhal | Fokkerweg 75 | 3mobile.gyms.boardCount');
    expect(trackMock).toHaveBeenCalledWith('Board Wall Search Started', expect.objectContaining({ method: 'place' }));
    expect(tracked('Gym Finder Search Used')).toEqual([{ surface: 'wizard_gym_step', kind: 'town' }]);
    expect(dismissKeyboardMock).toHaveBeenCalled();
    // The map card comes back, scrolled into view, so the fly-to shows.
    expect(state.list?.mapHidden).toBe(false);
    expect(scrollToTopMock).toHaveBeenCalled();
  });

  it('lists the suggested towns as a Places section, and a tap there picks the town', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    act(() => state.onSuggestionsChange?.([AMSTERDAM]));
    expect(screen.getByText('mobile.gymStep.places')).toBeTruthy();
    expect(screen.getByText('mobile.gyms.placesAttribution')).toBeTruthy();
    fireEvent.click(screen.getByTestId(`place:${AMSTERDAM.id}`));
    await settle();
    expect(setCenterMock).toHaveBeenLastCalledWith({ latitude: AMSTERDAM.latitude, longitude: AMSTERDAM.longitude });
    act(() => state.onSuggestionsChange?.([]));
    expect(screen.queryByText('mobile.gymStep.places')).toBeNull();
  });

  it('keeps a picked town when a location fix arrives after it', async () => {
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    setCenterMock.mockClear();

    const climber = { latitude: 51.5, longitude: -0.12 };
    state.location = { status: 'granted', permission: 'granted', permissionChecked: true, coords: climber };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).not.toHaveBeenCalledWith(climber);
    expect(state.gymsArgs[0]).toEqual({ latitude: AMSTERDAM.latitude, longitude: AMSTERDAM.longitude });
  });

  it("clears a picked town once its label is edited, instead of searching gyms by the town's name", async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();

    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Ut' } });
    await settle();
    expect(state.gymsArgs[0]).toBeNull();
    expect(state.gymsArgs[2]).toBe('Ut');
    expect(showWorldMock).toHaveBeenCalled();
  });

  it('folds the map card on focus and keeps it folded while a search is typed, so a drag never regrows it', () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    expect(state.list?.mapHidden).toBe(false);
    fireEvent.click(screen.getByTestId('focus-search'));
    expect(state.list?.mapHidden).toBe(true);
    // Back to the top, so the results start under the field.
    expect(scrollToTopMock).toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Monk' } });
    // A drag of the results closes the keyboard: the card stays folded.
    fireEvent.click(screen.getByTestId('blur-search'));
    expect(state.list?.mapHidden).toBe(true);
    // Clear brings it back.
    fireEvent.click(screen.getByTestId('clear-search'));
    expect(state.list?.mapHidden).toBe(false);

    // A focus that typed nothing gives the card back when it ends.
    fireEvent.click(screen.getByTestId('focus-search'));
    fireEvent.click(screen.getByTestId('blur-search'));
    expect(state.list?.mapHidden).toBe(false);
  });

  it('starts new results from the top: a name looked up, towns suggested', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(scrollToTopMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Monk' } });
    await settle();
    expect(scrollToTopMock).toHaveBeenCalledTimes(1);
    act(() => state.onSuggestionsChange?.([AMSTERDAM]));
    expect(scrollToTopMock).toHaveBeenCalledTimes(2);
  });

  it('searches the world view only once it is zoomed in to a region', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    const utrecht = { latitude: 52.09, longitude: 5.12 };
    act(() => state.onRegionChange?.(utrecht, 4));
    await settle();
    expect(state.gymsArgs[0]).toBeNull();
    expect(screen.getByTestId('location-prompt')).toBeTruthy();

    act(() => state.onRegionChange?.(utrecht, 11));
    await settle();
    expect(state.gymsArgs[0]).toEqual(utrecht);
    expect(screen.queryByTestId('location-prompt')).toBeNull();

    // Zooming back out to the world never searches mid-ocean.
    act(() => state.onRegionChange?.({ latitude: 20, longitude: -30 }, 2));
    await settle();
    expect(state.gymsArgs[0]).toEqual(utrecht);
  });

  it('offers Try again when the first gym lookup fails, under the notice and in the caption', async () => {
    state.gymsFailed = true;
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    fireEvent.click(screen.getByTestId('retry'));
    expect(refetchMock).toHaveBeenCalledOnce();
    expect(screen.getByTestId('gym-step-caption').textContent).toContain('mobile.gyms.refreshFailed');
  });

  it('flies from the world to the climber when a fix arrives, and measures rows from them', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).not.toHaveBeenCalled();

    const climber = { latitude: 52.3791, longitude: 4.9003 };
    state.location = { status: 'granted', permission: 'granted', permissionChecked: true, coords: climber };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).toHaveBeenCalledWith(climber);
    expect(state.gymsArgs[0]).toEqual(climber);
    expect(screen.getByTestId('gym:gym-1').textContent).toContain('1.2 km · Fokkerweg 75');
  });

  it('filters gyms by the name typed: two characters or more, once the text is still', async () => {
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'M' } });
    await settle();
    expect(state.gymsArgs[2]).toBeUndefined();

    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Monk' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // Even the first search waits for the text to be still.
    expect(state.gymsArgs[2]).toBeUndefined();
    await settle();
    expect(state.gymsArgs[0]).toBeNull();
    expect(state.gymsArgs[2]).toBe('Monk');
    expect(trackMock).toHaveBeenCalledWith(
      'Board Wall Search Started',
      expect.objectContaining({ method: 'text', queryLength: 4 }),
    );
    // Typing alone reports no search: letting go of the field does.
    expect(tracked('Gym Finder Search Used')).toEqual([]);
    fireEvent.click(screen.getByTestId('blur-search'));
    fireEvent.click(screen.getByTestId('blur-search'));
    expect(tracked('Gym Finder Search Used')).toEqual([{ surface: 'wizard_gym_step', kind: 'name' }]);
  });

  it('reports a name search when a gym is picked from it, and never for a town typed then picked', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Amster' } });
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    fireEvent.click(screen.getByTestId('blur-search'));
    expect(tracked('Gym Finder Search Used')).toEqual([{ surface: 'wizard_gym_step', kind: 'town' }]);

    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Boulder' } });
    await settle();
    fireEvent.click(screen.getByTestId('gym:gym-1'));
    expect(tracked('Gym Finder Search Used')).toEqual([
      { surface: 'wizard_gym_step', kind: 'town' },
      { surface: 'wizard_gym_step', kind: 'name' },
    ]);
  });

  it('picks a gym, and adds one, with the board type chosen in the capsule', async () => {
    state.location = {
      status: 'granted',
      permission: 'granted',
      permissionChecked: true,
      coords: { latitude: 52.37, longitude: 4.9 },
    };
    state.gyms = { gyms: [BOULDERHAL] };
    const onPickGym = vi.fn();
    const onAddGym = vi.fn();
    render(createElement(GymStep, { onPickGym, onAddGym, initialBoardType: null }));
    await settle();

    fireEvent.click(screen.getByTestId('type-kilter'));
    await settle();
    expect(state.gymsArgs[3]).toEqual(['kilter']);
    fireEvent.click(screen.getByTestId('gym:gym-1'));
    expect(onPickGym).toHaveBeenCalledWith(BOULDERHAL, 'kilter');
    expect(tracked('Gym Finder Gym Picked')).toEqual([{ surface: 'wizard_gym_step', section: 'list' }]);

    fireEvent.click(screen.getByTestId('type-any'));
    fireEvent.click(screen.getByTestId('add-gym'));
    expect(onAddGym).toHaveBeenCalledWith(null);
    expect(tracked('Gym Finder Add My Gym Tapped')).toEqual([{ surface: 'wizard_gym_step' }]);
  });

  it('selects and scrolls to the row of a tapped pin; picking that row counts as a pin pick', async () => {
    state.location = {
      status: 'granted',
      permission: 'granted',
      permissionChecked: true,
      coords: { latitude: 52.37, longitude: 4.9 },
    };
    state.gyms = { gyms: [BOULDERHAL] };
    const onPickGym = vi.fn();
    render(createElement(GymStep, { onPickGym, onAddGym: vi.fn() }));
    await settle();

    act(() => state.onMarkerPress?.('gym-1'));
    expect(scrollToItemKeyMock).toHaveBeenCalledWith('gym:gym-1');
    expect(screen.getByTestId('gym:gym-1').getAttribute('data-selected')).toBe('true');
    // A pin only selects: nothing is picked until the row is tapped.
    expect(onPickGym).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('gym:gym-1'));
    expect(tracked('Gym Finder Gym Picked')).toEqual([{ surface: 'wizard_gym_step', section: 'map_pin' }]);
  });

  it('locates: back to the climber with a fix, a request without one, Settings once refused for good', async () => {
    const climber = { latitude: 52.3791, longitude: 4.9003 };
    state.location = { status: 'granted', permission: 'granted', permissionChecked: true, coords: climber };
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    setCenterMock.mockClear();

    fireEvent.click(screen.getByTestId('locate'));
    await settle();
    expect(setCenterMock).toHaveBeenLastCalledWith(climber);
    expect(state.gymsArgs[0]).toEqual(climber);
    // The town's label goes with it.
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('');
    expect(tracked('Gym Finder Locate Tapped')).toEqual([{ surface: 'wizard_gym_step' }]);
    view.unmount();

    state.location = { status: 'idle', permission: 'ask', permissionChecked: true, coords: null };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    fireEvent.click(screen.getByTestId('locate'));
    expect(requestMock).toHaveBeenCalledOnce();
    cleanup();

    state.location = { status: 'denied', permission: 'blocked', permissionChecked: true, coords: null };
    render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    fireEvent.click(screen.getByTestId('locate'));
    expect(openSettingsMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it('flies to a fix that arrives after a locate tap, dropping a picked town', async () => {
    state.location = { status: 'idle', permission: 'ask', permissionChecked: true, coords: null };
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    fireEvent.click(screen.getByTestId('locate'));
    expect(requestMock).toHaveBeenCalledOnce();

    const climber = { latitude: 52.3791, longitude: 4.9003 };
    state.location = { status: 'granted', permission: 'granted', permissionChecked: true, coords: climber };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).toHaveBeenLastCalledWith(climber);
    expect(state.gymsArgs[0]).toEqual(climber);
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('');
  });

  it('forgets a locate tap that ended without a fix, so a later fix keeps the picked town', async () => {
    state.location = { status: 'idle', permission: 'ask', permissionChecked: true, coords: null };
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    await settle();
    fireEvent.click(screen.getByTestId('locate'));
    state.location = { status: 'denied', permission: 'ask', permissionChecked: true, coords: null };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();

    // Later, Settings turns location on: the town stays.
    const climber = { latitude: 52.3791, longitude: 4.9003 };
    state.location = { status: 'granted', permission: 'granted', permissionChecked: true, coords: climber };
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    await settle();
    expect(setCenterMock).not.toHaveBeenCalledWith(climber);
    expect((screen.getByTestId('search') as HTMLInputElement).value).toBe('Amsterdam, North Holland, Netherlands');
  });

  it('shows the step counter only when the flow counts its steps', () => {
    const view = render(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn() }));
    expect(screen.queryByTestId('step-counter')).toBeNull();
    view.rerender(createElement(GymStep, { onPickGym: vi.fn(), onAddGym: vi.fn(), stepLabel: 'Step 2 of 3' }));
    expect(screen.getByTestId('step-counter').textContent).toBe('Step 2 of 3');
  });
});

// The builders' gym row pushes the same step in pick mode (/boards/gym-picker):
// it was a searchable list in a sheet, on top of the Boards sheet.
describe("GymStep as the builders' gym picker", () => {
  const MADRID = { latitude: 40.42, longitude: -3.7 };

  function renderPicker(overrides: Partial<{ currentGymUuid: string | null; showsOnMap: boolean }> = {}) {
    const onPickGym = vi.fn();
    const onAddGym = vi.fn();
    const onPickNone = vi.fn();
    render(
      createElement(GymStep, {
        onPickGym,
        onAddGym,
        picker: {
          currentGymUuid: overrides.currentGymUuid === undefined ? 'gym-1' : overrides.currentGymUuid,
          showsOnMap: overrides.showsOnMap ?? true,
          initialCenter: MADRID,
          onPickNone,
        },
      }),
    );
    return { onPickGym, onAddGym, onPickNone };
  }

  it('counts no step, says who can edit a linked board, and opens on the board itself', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    renderPicker();
    await settle();
    expect(screen.queryByTestId('step-counter')).toBeNull();
    expect(screen.getByTestId('gym-step-header').textContent).toContain('mobile.gymPicker.sharedEditHint');
    // No location asked for: the list searches around the board's own position.
    expect(state.gymsArgs[0]).toEqual(MADRID);
  });

  it('ticks the current gym, and "Not at a gym" when there is none', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    renderPicker();
    await settle();
    expect(screen.getByTestId('gym:gym-1').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('no-gym').getAttribute('data-checked')).toBe('false');
    cleanup();
    renderPicker({ currentGymUuid: null, showsOnMap: false });
    await settle();
    expect(screen.getByTestId('gym:gym-1').getAttribute('data-checked')).toBe('false');
    expect(screen.getByTestId('no-gym').getAttribute('data-checked')).toBe('true');
    expect(screen.getByTestId('no-gym').textContent).toContain('mobile.gymPicker.noGymHintOffMap');
  });

  it('picks a gym, none, or "My gym isn\'t listed", under its own surface and outside the wizard funnel', async () => {
    state.gyms = { gyms: [BOULDERHAL] };
    const { onPickGym, onAddGym, onPickNone } = renderPicker();
    await settle();
    fireEvent.click(screen.getByTestId('gym:gym-1'));
    expect(onPickGym).toHaveBeenCalledWith(BOULDERHAL, null);
    fireEvent.click(screen.getByTestId('no-gym'));
    expect(onPickNone).toHaveBeenCalledOnce();
    expect(screen.getByTestId('add-gym').textContent).toBe('mobile.gymPicker.addNew');
    fireEvent.click(screen.getByTestId('add-gym'));
    expect(onAddGym).toHaveBeenCalledOnce();
    expect(tracked('Gym Finder Gym Picked')).toEqual([{ surface: 'builder_gym_picker', section: 'list' }]);
    expect(tracked('Gym Finder Add My Gym Tapped')).toEqual([{ surface: 'builder_gym_picker' }]);
    expect(tracked('Board Wall Search Started')).toEqual([]);
  });
});
