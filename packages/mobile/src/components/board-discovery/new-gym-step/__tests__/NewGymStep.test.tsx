// @vitest-environment jsdom
//
// "Add your gym": Save (the ✓ in the bar) waits for a name and a pin, the
// listed gyms that look like it are asked about, a server refusal brings its
// gyms into the same list and "No, add a new gym" saves again naming every gym
// dismissed, the gym cap says so, a gym is never created twice, and the map
// stays on screen while any field is in use.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, forwardRef, useImperativeHandle, type ReactElement, type ReactNode, type Ref } from 'react';
import type { PlaceSuggestion, SimilarGym } from '@boardsesh/shared-schema';
import type { NewGymRow } from '../new-gym-step-state';

type Children = { children?: ReactNode; testID?: string };
type Coords = { latitude: number; longitude: number };

const trackMock = vi.hoisted(() => vi.fn());
const createGymMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const requestIfAllowedMock = vi.hoisted(() => vi.fn());
const setCenterMock = vi.hoisted(() => vi.fn());
const geocodeMock = vi.hoisted(() => vi.fn());
const scrollToItemKeyMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  signedIn: true,
  location: { status: 'idle', permission: 'unknown', permissionChecked: true, coords: null as Coords | null },
  similar: undefined as SimilarGym[] | undefined,
  similarInputs: [] as unknown[],
  onRegionChange: undefined as ((coords: Coords, zoom?: number) => void) | undefined,
  onMapUnavailable: undefined as (() => void) | undefined,
  list: null as {
    mapHidden?: boolean;
    mapAvailable?: boolean;
    cardPinned?: boolean;
    cardCompact?: boolean;
    hasFooter: boolean;
  } | null,
}));
type HeaderTrailing = {
  kind?: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  prominent?: boolean;
};
const header = vi.hoisted(() => ({
  trailing: null as HeaderTrailing | null,
  clearOnUnmount: undefined as boolean | undefined,
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../../../lib/graphql/hooks/use-create-gym', () => ({
  useCreateGym: () => ({ mutateAsync: createGymMock }),
  useSimilarGyms: (input: unknown) => {
    state.similarInputs.push(input);
    return { data: input ? state.similar : undefined };
  },
}));
vi.mock('../../../../lib/use-device-location', () => ({
  useDeviceLocation: () => ({ ...state.location, request: requestMock, requestIfAllowed: requestIfAllowedMock }),
}));
vi.mock('../../../../lib/use-place-search', () => ({
  useGeocodePlace: () => ({ geocode: geocodeMock, isGeocoding: false }),
}));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => false,
}));
vi.mock('../../../../lib/open-app-settings', () => ({ canOpenAppSettings: () => true, openAppSettings: vi.fn() }));
vi.mock('../../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../../hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing, clearOnUnmount }: { trailing?: HeaderTrailing | null; clearOnUnmount?: boolean }) => {
    header.trailing = trailing ?? null;
    header.clearOnUnmount = clearOnUnmount;
  },
}));
vi.mock('../../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: state.signedIn }) }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: { primary: '#639' } }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 } }));
vi.mock('../../../Text', () => ({
  Text: ({ children, testID }: Children) => createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { type: 'button', disabled, onClick: onPress }, title),
}));
vi.mock('../../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('div', null, 'loading') }));
vi.mock('../../../ReadableColumn', () => ({ READABLE_CONTENT_WIDTH: 672 }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress?: () => void }) =>
    createElement('button', { type: 'button', 'data-testid': testID, onClick: onPress }, children),
}));
vi.mock('../../add-board-wizard/WizardStepHeader', () => ({
  WizardStepHeader: ({ stepLabel, title }: { stepLabel: string | null; title: string }) =>
    createElement('h2', null, `${stepLabel ?? ''} ${title}`),
}));
vi.mock('../NewGymTextField', () => ({
  NewGymTextField: ({
    value,
    onChangeText,
    onFocusChange,
    testID,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    onFocusChange?: (focused: boolean) => void;
    testID?: string;
  }) =>
    createElement('input', {
      'data-testid': testID,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      onFocus: () => onFocusChange?.(true),
      onBlur: () => onFocusChange?.(false),
    }),
}));
vi.mock('../SimilarGymRow', () => ({
  SimilarGymRow: ({
    gym,
    onPickGym,
    onClaimGym,
  }: {
    gym: SimilarGym;
    onPickGym: (uuid: string) => void;
    onClaimGym: (uuid: string) => void;
  }) =>
    createElement('div', null, [
      createElement(
        'button',
        { key: 'pick', type: 'button', 'data-testid': `similar:${gym.uuid}`, onClick: () => onPickGym(gym.uuid) },
        gym.name,
      ),
      gym.isClaimable
        ? createElement(
            'button',
            { key: 'claim', type: 'button', 'data-testid': `claim:${gym.uuid}`, onClick: () => onClaimGym(gym.uuid) },
            'claim',
          )
        : null,
    ]),
}));
vi.mock('../../../gym-directory/GymMap', () => ({
  GymMap: forwardRef(
    (
      {
        onRegionChange,
        onMapUnavailable,
      }: { onRegionChange: (coords: Coords, zoom?: number) => void; onMapUnavailable: () => void },
      ref: Ref<unknown>,
    ) => {
      state.onRegionChange = onRegionChange;
      state.onMapUnavailable = onMapUnavailable;
      useImperativeHandle(ref, () => ({ setCenter: setCenterMock, showWorld: vi.fn() }), []);
      return createElement('div', { 'data-testid': 'gym-map' });
    },
  ),
}));
vi.mock('../../../gym-directory/MapCardList', () => ({
  MapCardList: ({
    ref,
    data,
    renderItem,
    keyExtractor,
    map,
    footer,
    mapHidden,
    mapAvailable,
    cardPinned,
    cardCompact,
    onLocate,
  }: {
    ref?: Ref<unknown>;
    data: NewGymRow[];
    renderItem: (info: { item: NewGymRow }) => ReactElement | null;
    keyExtractor: (row: NewGymRow) => string;
    map?: ReactNode;
    footer?: ReactNode;
    mapHidden?: boolean;
    mapAvailable?: boolean;
    cardPinned?: boolean;
    cardCompact?: boolean;
    onLocate?: () => void;
  }) => {
    state.list = {
      mapHidden,
      mapAvailable,
      cardPinned,
      cardCompact,
      hasFooter: footer !== undefined && footer !== null,
    };
    useImperativeHandle(ref, () => ({ scrollToItemKey: scrollToItemKeyMock, scrollToTop: vi.fn() }), []);
    return createElement('section', null, [
      createElement('div', { key: 'map' }, map),
      createElement('button', { key: 'locate', type: 'button', 'data-testid': 'locate', onClick: onLocate }),
      ...data.map((row) => createElement('div', { key: keyExtractor(row) }, renderItem({ item: row }))),
      createElement('div', { key: 'footer' }, footer),
    ]);
  },
}));
vi.mock('../../../gym-directory/GymListTextRows', () => ({
  GymListSectionHeader: ({ label }: { label: string }) => createElement('h3', null, label),
  GymListEmptyRow: ({ label }: { label: string }) => createElement('p', { 'data-testid': 'notice' }, label),
}));
vi.mock('../../../gym-directory/PickGymRow', () => ({
  PickPlaceRow: ({
    place,
    onSelectPlace,
  }: {
    place: PlaceSuggestion;
    onSelectPlace: (place: PlaceSuggestion) => void;
  }) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': `place:${place.id}`, onClick: () => onSelectPlace(place) },
      place.name,
    ),
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
    onSubmit,
    onSelectPlace,
    onSuggestionsChange,
    onFocusChange,
  }: {
    text: string;
    onChangeText: (text: string) => void;
    onSubmit: () => void;
    onSelectPlace: (place: PlaceSuggestion) => void;
    onSuggestionsChange?: (places: readonly PlaceSuggestion[]) => void;
    onFocusChange?: (focused: boolean) => void;
  }) =>
    createElement('div', null, [
      createElement('input', {
        key: 'input',
        'data-testid': 'search',
        value: text,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        onFocus: () => onFocusChange?.(true),
        onBlur: () => onFocusChange?.(false),
      }),
      createElement('button', { key: 'submit', type: 'button', 'data-testid': 'search-submit', onClick: onSubmit }),
      createElement('button', {
        key: 'town',
        type: 'button',
        'data-testid': 'pick-amsterdam',
        onClick: () => onSelectPlace(AMSTERDAM),
      }),
      createElement('button', {
        key: 'suggest',
        type: 'button',
        'data-testid': 'suggest-amsterdam',
        onClick: () => onSuggestionsChange?.([AMSTERDAM]),
      }),
    ]),
}));

const { NewGymStep } = await import('../NewGymStep');

const DEVICE = { latitude: 52.37, longitude: 4.89 };
const CREATED = { uuid: 'gym-new', name: 'Boulder Space' };

function refusal(candidates: Array<{ uuid: string; name: string }>) {
  return { response: { errors: [{ message: 'similar', extensions: { code: 'GYM_SIMILAR_EXISTS', candidates } }] } };
}

function similarGym(uuid: string, overrides: Partial<SimilarGym> = {}): SimilarGym {
  return {
    uuid,
    slug: null,
    name: `Listed ${uuid}`,
    address: null,
    website: null,
    distanceMeters: 120,
    ownerType: 'USER',
    isClaimable: false,
    canClaimByDomain: false,
    providerOrigins: [],
    ...overrides,
  };
}

const props = {
  onPickExistingGym: vi.fn(),
  onClaimGym: vi.fn(),
  onCreated: vi.fn(),
  onSignInNeeded: vi.fn(),
};

function renderStep() {
  return render(createElement(NewGymStep, { stepLabel: 'Step 3 of 4', ...props }));
}

function typeName(name: string) {
  fireEvent.change(screen.getByTestId('new-gym-name'), { target: { value: name } });
}

/** The ✓ in the bar, as the last render set it. */
function saveAction(): HeaderTrailing {
  if (!header.trailing) throw new Error('no trailing header action');
  return header.trailing;
}

/** Tap the ✓ in the bar and let the save settle. */
async function tapSave() {
  await act(async () => {
    saveAction().onPress();
  });
}

/** Let the name and pin settle long enough for the "is it one of these?" lookup. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(600);
  });
}

function createdEvents() {
  return trackMock.mock.calls.filter(([name]) => name === 'Gym Created').map(([, properties]) => properties);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.signedIn = true;
  state.location = { status: 'idle', permission: 'unknown', permissionChecked: true, coords: null };
  state.similar = undefined;
  state.similarInputs = [];
  state.list = null;
  header.trailing = null;
  header.clearOnUnmount = undefined;
  createGymMock.mockResolvedValue(CREATED);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Save is the ✓ in the bar', () => {
  it('is a confirm labelled "Add gym", with no button at the bottom of the page', () => {
    renderStep();
    expect(saveAction()).toMatchObject({ kind: 'confirm', label: 'mobile.newGym.save', prominent: true });
    expect(header.clearOnUnmount).toBe(true);
    expect(state.list?.hasFooter).toBe(false);
    expect(screen.queryByText('mobile.newGym.save')).toBeNull();
  });

  it('says why it is held under the map, until there is a name and a pin', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    expect(saveAction().disabled).toBe(true);
    expect(screen.getByTestId('new-gym-save-hint').textContent).toBe('mobile.newGym.saveHint');
    typeName('Boulder Space');
    expect(saveAction().disabled).toBe(false);
    expect(screen.queryByTestId('new-gym-save-hint')).toBeNull();
  });

  it('saves the gym from the ✓', async () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    typeName('Boulder Space');
    await tapSave();
    expect(createGymMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: 'Boulder Space', latitude: 52.37, longitude: 4.89 }),
    );
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(CREATED);
  });
});

describe('the map stays while a field is in use', () => {
  it('pins the card, and never hides it for a field: the name keeps the whole card, search and address go compact', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    expect(state.list).toMatchObject({ cardPinned: true, mapAvailable: true, cardCompact: false });
    expect(state.list?.mapHidden).toBeFalsy();
    setCenterMock.mockClear();
    const caption = screen.getByTestId('new-gym-pin-caption').textContent;
    for (const [field, compact] of [
      ['new-gym-name', false],
      ['search', true],
      ['new-gym-address', true],
    ] as const) {
      fireEvent.focus(screen.getByTestId(field));
      fireEvent.change(screen.getByTestId(field), { target: { value: 'Boulder' } });
      expect(state.list?.mapHidden, field).toBeFalsy();
      expect(state.list?.cardPinned, field).toBe(true);
      expect(state.list?.cardCompact, field).toBe(compact);
      expect(screen.getByTestId('gym-map'), field).toBeTruthy();
      expect(screen.getByTestId('new-gym-pin'), field).toBeTruthy();
      fireEvent.blur(screen.getByTestId(field));
      expect(state.list?.cardCompact, field).toBe(false);
      expect(state.list?.mapHidden, field).toBeFalsy();
    }
    // None of it moved the camera or the pin.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe(caption);
  });

  it('keeps the map after a search is typed and left without a pick', () => {
    renderStep();
    fireEvent.focus(screen.getByTestId('search'));
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Amster' } });
    fireEvent.blur(screen.getByTestId('search'));
    expect(state.list?.mapHidden).toBeFalsy();
    expect(state.list?.cardCompact).toBe(false);
    expect(screen.getByTestId('gym-map')).toBeTruthy();
  });
});

describe('what Save needs', () => {
  it('waits for a name and a pin, and never asks for location on open', () => {
    renderStep();
    expect(requestIfAllowedMock).toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(saveAction().disabled).toBe(true);
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinNeeded');

    typeName('Boulder Space');
    expect(saveAction().disabled).toBe(true);

    // A town is where to start looking, not the gym: Save waits for a move.
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    expect(setCenterMock).toHaveBeenLastCalledWith({ latitude: 52.374, longitude: 4.8897 }, 13);
    expect(saveAction().disabled).toBe(true);
    expect(screen.getByText('mobile.newGym.pinMoveHint')).toBeTruthy();
    // A town label is no street address.
    expect((screen.getByTestId('new-gym-address') as HTMLInputElement).value).toBe('');

    // The fly-in settles on the town: still not savable.
    act(() => {
      state.onRegionChange?.({ latitude: 52.374, longitude: 4.8897 }, 13);
      vi.advanceTimersByTime(300);
    });
    expect(saveAction().disabled).toBe(true);
    // The climber moves the map under the dot.
    act(() => {
      state.onRegionChange?.({ latitude: 52.36, longitude: 4.9 }, 16);
      vi.advanceTimersByTime(300);
    });
    expect(saveAction().disabled).toBe(false);

    typeName('   ');
    expect(saveAction().disabled).toBe(true);
  });

  it('lists towns only where the map can draw', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('suggest-amsterdam'));
    expect(screen.getByTestId('place:2759794')).toBeTruthy();
    act(() => state.onMapUnavailable?.());
    expect(screen.queryByTestId('place:2759794')).toBeNull();
  });

  it('starts the pin at a fix location already allowed', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    expect(setCenterMock).toHaveBeenCalledWith(DEVICE, 16);
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinAtYou');
    typeName('Boulder Space');
    expect(saveAction().disabled).toBe(false);
  });

  it('asks for location only from Use my location', () => {
    renderStep();
    fireEvent.click(screen.getByTestId('new-gym-use-location'));
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it('follows the map once it is still, and has no pin zoomed out past a town', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    typeName('Boulder Space');
    // Our own fly-in settling is not a pan.
    act(() => state.onRegionChange?.(DEVICE, 16));
    act(() => {
      vi.advanceTimersByTime(2000);
      state.onRegionChange?.({ latitude: 52.38, longitude: 4.89 }, 16);
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe(
      'mobile.newGym.pinFromYou {"distance":"1.1 km"}',
    );
    act(() => {
      state.onRegionChange?.({ latitude: 30, longitude: 0 }, 4);
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinZoomIn');
    expect(saveAction().disabled).toBe(true);
  });

  it('falls back to an address where the map cannot draw, and says where the gym goes', async () => {
    geocodeMock.mockResolvedValue({ latitude: 52.36, longitude: 4.88 });
    renderStep();
    act(() => state.onMapUnavailable?.());
    expect(state.list?.mapAvailable).toBe(false);
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.fallbackNeeded');
    typeName('Boulder Space');
    fireEvent.change(screen.getByTestId('search'), { target: { value: 'Fokkerweg 75, Amsterdam' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('search-submit'));
    });
    expect(geocodeMock).toHaveBeenCalledWith('Fokkerweg 75, Amsterdam');
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe(
      'mobile.newGym.fallbackPlace {"place":"Fokkerweg 75, Amsterdam"}',
    );
    // The address is seeded from the search.
    expect((screen.getByTestId('new-gym-address') as HTMLInputElement).value).toBe('Fokkerweg 75, Amsterdam');
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 52.36, longitude: 4.88, address: 'Fokkerweg 75, Amsterdam' }),
    );
    expect(createdEvents()).toEqual([
      { surface: 'wizard', similarShown: 0, confirmedSeparate: false, hasAddress: true, locationSource: 'address' },
    ]);
  });
});

describe('"is it one of these?"', () => {
  beforeEach(() => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
  });

  it('asks about listed gyms as the name and pin settle; a tap goes to that gym', () => {
    state.similar = [similarGym('listed-1'), similarGym('listed-2', { isClaimable: true })];
    renderStep();
    typeName('Boulder Space');
    expect(screen.queryByTestId('similar:listed-1')).toBeNull();
    settle();
    expect(state.similarInputs.at(-1)).toEqual({ name: 'Boulder Space', latitude: 52.37, longitude: 4.89 });
    expect(screen.getByText('mobile.newGym.similarTitle')).toBeTruthy();

    fireEvent.click(screen.getByTestId('similar:listed-1'));
    expect(props.onPickExistingGym).toHaveBeenCalledWith('listed-1');
    expect(screen.queryByTestId('claim:listed-1')).toBeNull();
    fireEvent.click(screen.getByTestId('claim:listed-2'));
    expect(props.onClaimGym).toHaveBeenCalledWith('listed-2');
    expect(createGymMock).not.toHaveBeenCalled();
  });

  it('"No, add a new gym" puts them away, and the save names them', async () => {
    state.similar = [similarGym('listed-1'), similarGym('listed-2')];
    renderStep();
    typeName('Boulder Space');
    settle();
    fireEvent.click(screen.getByText('similarGyms.refusal.addNew'));
    expect(screen.queryByTestId('similar:listed-1')).toBeNull();
    expect(createGymMock).not.toHaveBeenCalled();

    await tapSave();
    expect(createGymMock).toHaveBeenCalledExactlyOnceWith({
      name: 'Boulder Space',
      latitude: 52.37,
      longitude: 4.89,
      isPublic: true,
      isListed: true,
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['listed-1', 'listed-2'] },
    });
    expect(props.onCreated).toHaveBeenCalledWith(CREATED);
    expect(createdEvents()).toEqual([
      { surface: 'wizard', similarShown: 2, confirmedSeparate: true, hasAddress: false, locationSource: 'device' },
    ]);
  });

  it('shows the gyms a refused save names, and saves again naming every one dismissed', async () => {
    state.similar = [similarGym('listed-1')];
    createGymMock
      .mockRejectedValueOnce(refusal([{ uuid: 'server-1', name: 'Server gym' }]))
      .mockResolvedValueOnce(CREATED);
    renderStep();
    typeName('Boulder Space');
    settle();
    fireEvent.click(screen.getByText('similarGyms.refusal.addNew'));

    await tapSave();
    expect(createGymMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['listed-1'] },
      }),
    );
    expect(props.onCreated).not.toHaveBeenCalled();
    // Refused: the ✓ is free again.
    expect(saveAction()).toMatchObject({ disabled: false, loading: false });
    expect(screen.getByTestId('similar:server-1')).toBeTruthy();
    expect(screen.getByText('mobile.newGym.similarRefusedBody')).toBeTruthy();
    expect(scrollToItemKeyMock).toHaveBeenCalledWith('similar:header');

    await act(async () => {
      fireEvent.click(screen.getByText('similarGyms.refusal.addNew'));
    });
    expect(createGymMock).toHaveBeenCalledTimes(2);
    expect(createGymMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['listed-1', 'server-1'] },
      }),
    );
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(CREATED);
    expect(createdEvents()).toEqual([expect.objectContaining({ similarShown: 2, confirmedSeparate: true })]);
  });

  it('refuses first with REJECT_IF_FOUND when nothing was dismissed', async () => {
    renderStep();
    typeName('Boulder Space');
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(
      expect.objectContaining({ duplicateCheck: { mode: 'REJECT_IF_FOUND' } }),
    );
  });
});

describe('when the save does not go through', () => {
  beforeEach(() => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
  });

  it('says the gym cap is reached', async () => {
    createGymMock.mockRejectedValueOnce({
      response: { errors: [{ message: 'limit', extensions: { code: 'GYM_LIMIT_REACHED', maxGyms: 25 } }] },
    });
    renderStep();
    typeName('Boulder Space');
    await tapSave();
    expect(screen.getByTestId('notice').textContent).toBe('mobile.newGym.limitReached');
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(createdEvents()).toEqual([]);
  });

  it('says it failed otherwise, and lets the climber try again', async () => {
    createGymMock.mockRejectedValueOnce(new Error('network'));
    renderStep();
    typeName('Boulder Space');
    await tapSave();
    expect(screen.getByTestId('notice').textContent).toBe('mobile.newGym.saveFailed');
    // The ✓ is free again for another try.
    expect(saveAction()).toMatchObject({ disabled: false, loading: false });
    await tapSave();
    expect(createGymMock).toHaveBeenCalledTimes(2);
    expect(props.onCreated).toHaveBeenCalledOnce();
  });

  it('sends a signed-out climber to sign in, creating nothing', async () => {
    state.signedIn = false;
    renderStep();
    typeName('Boulder Space');
    await tapSave();
    expect(props.onSignInNeeded).toHaveBeenCalledOnce();
    expect(createGymMock).not.toHaveBeenCalled();
  });
});

describe('never two gyms', () => {
  it('ignores a second Save while the first is out, and any after it went through', async () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    let resolveCreate: (gym: typeof CREATED) => void = () => {};
    createGymMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderStep();
    typeName('Boulder Space');
    // Two taps on the same ✓ before the bar redraws: the second is refused.
    const tick = saveAction();
    act(() => {
      tick.onPress();
      tick.onPress();
    });
    expect(createGymMock).toHaveBeenCalledOnce();
    // While it is out the ✓ spins and can't be pressed.
    expect(saveAction()).toMatchObject({ disabled: true, loading: true });
    await act(async () => {
      resolveCreate(CREATED);
    });
    // It went through: the ✓ stays held while the caller moves on.
    expect(saveAction()).toMatchObject({ disabled: true, loading: true });
    await tapSave();
    expect(createGymMock).toHaveBeenCalledOnce();
    expect(props.onCreated).toHaveBeenCalledOnce();
    expect(createdEvents()).toHaveLength(1);
  });
});

describe('every camera report counts', () => {
  const PANNED = { latitude: 52.3, longitude: 4.95 };

  it('applies a single end-of-move report (iOS) that lands away from our move once its window is over', async () => {
    renderStep();
    typeName('Boulder Space');
    fireEvent.click(screen.getByTestId('pick-amsterdam'));
    // The climber grabs the map mid-flight; iOS reports once, where it ended.
    act(() => {
      vi.advanceTimersByTime(400);
      state.onRegionChange?.(PANNED, 16);
      vi.advanceTimersByTime(300);
    });
    // Held: it may be a frame of our own flight.
    expect(saveAction().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveAction().disabled).toBe(false);
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(expect.objectContaining(PANNED));
    expect(createdEvents()).toEqual([expect.objectContaining({ locationSource: 'map' })]);
  });

  it('keeps the fix through per-frame reports (Android) that settle on it, Save on the last good pin throughout', async () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    typeName('Boulder Space');
    // A long flight, a frame every 16 ms for 2 s (past the 1.5 s window): the
    // window only ends once the camera has been quiet.
    act(() => {
      for (let frame = 0; frame < 125; frame += 1) {
        state.onRegionChange?.({ latitude: 30 + frame * 0.18, longitude: 4.89 }, 4 + frame * 0.09);
        vi.advanceTimersByTime(16);
      }
    });
    // Mid-flight, zoomed out: the pin stands.
    expect(saveAction().disabled).toBe(false);
    act(() => {
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinAtYou');
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(expect.objectContaining(DEVICE));
    expect(createdEvents()).toEqual([expect.objectContaining({ locationSource: 'device' })]);
  });

  it('drops a held report once one settles on the target', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    act(() => {
      state.onRegionChange?.(PANNED, 16);
      vi.advanceTimersByTime(300);
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinAtYou');
  });

  it('saves a pan that ended a moment ago', async () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    renderStep();
    typeName('Boulder Space');
    act(() => {
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(2000);
      state.onRegionChange?.(PANNED, 16);
    });
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(expect.objectContaining(PANNED));
  });

  it('never moves a map the climber zoomed out when location is read again', () => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
    const view = renderStep();
    act(() => {
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(2000);
      state.onRegionChange?.({ latitude: 30, longitude: 0 }, 4);
      vi.advanceTimersByTime(300);
    });
    setCenterMock.mockClear();
    // Back from the background: a fresh fix.
    state.location = { ...state.location, coords: { latitude: 52.371, longitude: 4.891 } };
    view.rerender(createElement(NewGymStep, { stepLabel: 'Step 3 of 4', ...props }));
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-gym-pin-caption').textContent).toBe('mobile.newGym.pinZoomIn');
  });
});

describe('a "not my gym" answers one question', () => {
  beforeEach(() => {
    state.location = { ...state.location, status: 'granted', permission: 'granted', coords: DEVICE };
  });

  it('asks again about a gym dismissed 3 km away once the pin is on it', async () => {
    state.similar = [similarGym('far', { distanceMeters: 3000 })];
    renderStep();
    typeName('Boulder Space');
    settle();
    fireEvent.click(screen.getByText('similarGyms.refusal.addNew'));
    expect(screen.queryByTestId('similar:far')).toBeNull();

    // The climber pans 3 km, onto that very gym.
    act(() => {
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(2000);
      state.onRegionChange?.({ latitude: 52.397, longitude: 4.89 }, 16);
      vi.advanceTimersByTime(300);
    });
    settle();
    expect(screen.getByTestId('similar:far')).toBeTruthy();
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(
      expect.objectContaining({ duplicateCheck: { mode: 'REJECT_IF_FOUND' } }),
    );
  });

  it('keeps the answer for a nudge of the pin, and drops it for a new name', async () => {
    state.similar = [similarGym('near')];
    renderStep();
    typeName('Boulder Space');
    settle();
    fireEvent.click(screen.getByText('similarGyms.refusal.addNew'));
    act(() => {
      state.onRegionChange?.(DEVICE, 16);
      vi.advanceTimersByTime(2000);
      state.onRegionChange?.({ latitude: 52.3705, longitude: 4.89 }, 16);
      vi.advanceTimersByTime(300);
    });
    settle();
    expect(screen.queryByTestId('similar:near')).toBeNull();

    typeName('  boulder   SPACE ');
    settle();
    expect(screen.queryByTestId('similar:near')).toBeNull();

    typeName('Boulder Space Annex');
    settle();
    expect(screen.getByTestId('similar:near')).toBeTruthy();
    await tapSave();
    expect(createGymMock).toHaveBeenCalledWith(
      expect.objectContaining({ duplicateCheck: { mode: 'REJECT_IF_FOUND' } }),
    );
  });
});
