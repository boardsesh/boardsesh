// "Which gym?": the add-a-board flow's gym step. One page inside the Boards
// sheet, never a sheet of its own: a pinned header block (the step counter,
// the title and the search field), then `MapCardList`, the gym rows under a
// map card, with "Add my gym" pinned at the bottom.
//
// - The header block sits under the bar: on iOS the bar is transparent glass,
//   so the block starts below it (`useTransparentHeaderInset`); Material's
//   opaque bar already pushes it down.
// - Typing filters gyms by name (2+ characters, once the text is still) and
//   suggests towns (`searchPlaces`) as a "Places" section at the top of the
//   list; a town flies the map there and lists the gyms within 50 km. Neither
//   needs location. Focusing the field folds the map card away until a town
//   is picked or the search cleared, so the keyboard never hides the results
//   and they never jump while dragged; new results start from the top.
// - Location is never asked on open. The step only reads a permission the
//   climber already gave (`requestIfAllowed`); otherwise, until a town or a name
//   is searched, the list shows the location prompt and the map the world.
// - A pin tap selects its row and scrolls to it; only a row tap picks, so a
//   mis-tapped pin never moves the flow on. Zooming the world view in to a
//   town searches there, as the website does.
// - Where the map can't draw (a browser, a broken native map), the page is
//   the list alone.
//
// A pick hands the gym to the caller (the add-a-board wizard's
// `/boards/add/gym`, whose next screen is the gym's wall list); so does "Add
// my gym".
//
// In pick mode (`picker`) it is the builders' gym row (`/boards/gym-picker`):
// no step counter, the current gym ticked, "Not at a gym" and "My gym isn't
// listed" in place of "Add my gym", and the map opening on the board's own
// position when it has one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  SHARED_EVENTS,
  gymFinderAddMyGymTapped,
  gymFinderGymPicked,
  gymFinderLocateTapped,
  gymFinderSearchUsed,
  type GymFinderSearchKind,
  type GymFinderSurface,
} from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import type { BoardName, Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import { useNearbyGyms } from '../../../lib/graphql/hooks';
import { isGraphqlRateLimitedError } from '../../../lib/graphql/extract-error-message';
import { useDeviceLocation, type Coords } from '../../../lib/use-device-location';
import { useDiscoverySearch } from '../../../lib/use-discovery-search';
import type { WallFinderFilter } from '../../../lib/wall-finder-filter';
import { selectEffectiveOffline, useConnectivityField } from '../../../lib/connectivity/use-connectivity';
import { isPickableBoardType, lookupState } from '../../../lib/boards/find-wall-state';
import { canOpenAppSettings, openAppSettings } from '../../../lib/open-app-settings';
import { track } from '../../../lib/analytics';
import { useTransparentHeaderInset } from '../../../hooks/use-transparent-header-inset';
import { useAuth } from '../../../providers/auth-provider';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';
import { Text } from '../../Text';
import { ActivityIndicator } from '../../ActivityIndicator';
import { PressableSurface } from '../../PressableSurface';
import { READABLE_CONTENT_WIDTH } from '../../ReadableColumn';
import { CapsuleRow } from '../../filter-capsules/CapsuleRow';
import type { Capsule } from '../../filter-capsules/CapsuleRow.types';
import { GymMap, type GymMapHandle, type GymMapMarker } from '../../gym-directory/GymMap';
import { MapCardList, type MapCardListHandle } from '../../gym-directory/MapCardList';
import { zoomedInToSearch } from '../../gym-directory/map-search-zoom';
import { GymLocationPrompt } from '../../gym-directory/GymLocationPrompt';
import { GymSearchField } from '../../gym-directory/GymSearchField';
import { GymListEmptyRow, GymListSectionHeader } from '../../gym-directory/GymListTextRows';
import { AddGymRow, NoGymRow, PickGymRow, PickPlaceRow, PickRetryAction } from '../../gym-directory/PickGymRow';
import { buildGymPickRows, type GymPickRow } from '../../gym-directory/gym-pick-rows';
import { WizardStepHeader } from '../add-board-wizard/WizardStepHeader';
import { boardTypeLabel } from '../board-builder-labels';

export type GymStepProps = {
  /** A gym row was tapped. `boardType` is the type filter in force, or null for any. */
  onPickGym: (gym: Gym, boardType: BoardName | null) => void;
  /** "Add my gym", pinned under the list: the gym isn't listed. */
  onAddGym: (boardType: BoardName | null) => void;
  /** Only gyms with a board of this type, on open (an entry that already knows the type). */
  initialBoardType?: BoardName | null;
  /** "Step 2 of 3" above the title, for a flow that counts its steps. */
  stepLabel?: string;
  /** The builders' gym picker: choose the board's gym rather than move a flow on. */
  picker?: GymStepPicker;
};

export type GymStepPicker = {
  /** The board's gym now, ticked; null ticks "Not at a gym". */
  currentGymUuid: string | null;
  /** Whether the board shows on the map at all, for "Not at a gym"'s line. */
  showsOnMap: boolean;
  /** Where the board is, when known: the map and the list start there. */
  initialCenter: Coords | null;
  /** "Not at a gym". "My gym isn't listed" is `onAddGym`. */
  onPickNone: () => void;
};

/** The gym search radius around the map's centre. */
const SEARCH_RADIUS_KM = 50;
/** How far a pan must move the camera (degrees) before the list follows it. */
const MIN_MOVE_DEG = 0.04;
/** Gym-name search: the shortest name looked up, and how long the text must be still. */
const MIN_NAME_LENGTH = 2;
const NAME_DEBOUNCE_MS = 300;
/** The capsule menu's value for "any board type". */
const ANY_BOARD = 'any';
/** Every gym finder event from here says where it came from. */
const WIZARD_SURFACE: GymFinderSurface = 'wizard_gym_step';
const PICKER_SURFACE: GymFinderSurface = 'builder_gym_picker';
const NO_PLACES: readonly PlaceSuggestion[] = [];

const pickRowKey = (row: GymPickRow) => row.key;
const pickRowType = (row: GymPickRow) => row.kind;

function movedEnough(first: Coords, second: Coords): boolean {
  const latitudeDelta = first.latitude - second.latitude;
  const longitudeDelta = first.longitude - second.longitude;
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta >= MIN_MOVE_DEG * MIN_MOVE_DEG;
}

function lookupErrorReason(error: unknown, offline: boolean): 'offline' | 'rate_limited' | 'exception' {
  if (offline) return 'offline';
  return isGraphqlRateLimitedError(error) ? 'rate_limited' : 'exception';
}

type SearchMethod = 'location' | 'text' | 'place';

export function GymStep({ onPickGym, onAddGym, initialBoardType = null, stepLabel, picker }: GymStepProps) {
  const { t } = useTranslation('boards');
  const finderSurface = picker ? PICKER_SURFACE : WIZARD_SURFACE;
  // The wizard's own funnel events (Board Wall Search Started / Lookup Failed)
  // are about adding a board; the builders' picker stays out of them.
  const countsInWizardFunnel = picker === undefined;
  // Undefined on the wizard: its rows carry a chevron, not a tick.
  const currentGymUuid = picker ? picker.currentGymUuid : undefined;
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const offline = useConnectivityField(selectEffectiveOffline);
  const headerInset = useTransparentHeaderInset();
  const mapRef = useRef<GymMapHandle>(null);
  const listRef = useRef<MapCardListHandle>(null);

  // --- location: read on open, asked only from the prompt or the locate button ---
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true });
  const { requestIfAllowed, request: requestLocation, coords: deviceCoords } = location;
  useEffect(() => {
    void requestIfAllowed();
  }, [requestIfAllowed]);

  // --- what is searched ---
  // `inputText` is the field; `nameQuery` the gym-name filter it carries (empty
  // once a town is picked, when the field holds the town's label); `viewCenter`
  // a picked town or a panned map, which wins over the device fix.
  const [inputText, setInputText] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [pickedPlace, setPickedPlace] = useState<string | null>(null);
  const [viewCenter, setViewCenter] = useState<Coords | null>(picker?.initialCenter ?? null);
  const [boardType, setBoardType] = useState<BoardName | null>(initialBoardType);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The map card folds when the field gains focus and stays folded while a
  // search is in progress: a drag of the results closes the keyboard, and a
  // card regrowing under the finger would throw the rows down mid-drag. It
  // comes back on a town pick, Clear, the locate button, or a blur that left
  // nothing typed.
  const [mapFolded, setMapFolded] = useState(false);
  const [placeSuggestions, setPlaceSuggestions] = useState<readonly PlaceSuggestion[]>(NO_PLACES);

  // The name the gyms are searched by: 2+ characters, once the text has been
  // still for a moment (the first keystroke too).
  const [searchedName, setSearchedName] = useState('');
  useEffect(() => {
    const trimmed = nameQuery.trim();
    const next = trimmed.length >= MIN_NAME_LENGTH ? trimmed : '';
    const timer = setTimeout(() => setSearchedName(next), NAME_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [nameQuery]);

  const center = viewCenter ?? deviceCoords ?? null;
  // The name has its own debounce above; the discovery search debounces the
  // camera and the board type.
  const filter = useMemo<WallFinderFilter>(() => ({ boardTypes: boardType ? [boardType] : undefined }), [boardType]);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const viewCenterRef = useRef(viewCenter);
  viewCenterRef.current = viewCenter;
  const deviceCoordsRef = useRef(deviceCoords);
  deviceCoordsRef.current = deviceCoords;

  // The target of the last camera move we made: its settle is not a pan.
  const programmaticTargetRef = useRef<Coords | null>(null);
  const cameraZoomRef = useRef<number | undefined>(undefined);
  const resolveCameraCenter = useCallback((next: Coords, current: Coords | null) => {
    const target = programmaticTargetRef.current;
    if (target && !movedEnough(next, target)) {
      programmaticTargetRef.current = null;
      return current;
    }
    // Zoomed out past a region (the world view, or back out to it) the centre
    // is no place to search around: the list stays where it was.
    if (!zoomedInToSearch(cameraZoomRef.current, current !== null)) return current;
    if (current !== null && !movedEnough(next, current)) return current;
    programmaticTargetRef.current = null;
    setViewCenter(next);
    return next;
  }, []);
  const { search, cameraMoved, resetSearch } = useDiscoverySearch(center, filter, { resolveCameraCenter });
  const onRegionChange = useCallback(
    (coords: Coords, zoom?: number) => {
      cameraZoomRef.current = zoom;
      cameraMoved(coords);
    },
    [cameraMoved],
  );

  const moveCameraTo = useCallback((coords: Coords) => {
    programmaticTargetRef.current = coords;
    mapRef.current?.setCenter(coords);
  }, []);

  // --- analytics: how the climber started looking, once per method ---
  const boardTypeRef = useRef(boardType);
  boardTypeRef.current = boardType;
  const searchStartedRef = useRef(new Set<SearchMethod>());
  const reportSearchStarted = useCallback(
    (method: SearchMethod, queryLength: number) => {
      if (!countsInWizardFunnel) return;
      if (searchStartedRef.current.has(method)) return;
      searchStartedRef.current.add(method);
      track(SHARED_EVENTS.BoardWallSearchStarted, { method, boardType: boardTypeRef.current, queryLength });
    },
    [countsInWizardFunnel],
  );
  const pickedPlaceRef = useRef(pickedPlace);
  pickedPlaceRef.current = pickedPlace;
  const searchUsedRef = useRef(new Set<GymFinderSearchKind>());
  const reportSearchUsed = useCallback(
    (kind: GymFinderSearchKind) => {
      if (searchUsedRef.current.has(kind)) return;
      searchUsedRef.current.add(kind);
      const event = gymFinderSearchUsed({ surface: finderSurface, kind });
      track(event.name, event.properties);
    },
    [finderSurface],
  );
  useEffect(() => {
    if (deviceCoords) reportSearchStarted('location', 0);
  }, [deviceCoords, reportSearchStarted]);
  useEffect(() => {
    if (searchedName.length > 0) reportSearchStarted('text', searchedName.length);
  }, [searchedName, reportSearchStarted]);
  // Gym Finder Search Used, kind name: the climber looked a gym up by name and
  // acted on it (picked a gym, or let go of the field), not every pause while
  // typing a town. Read through refs: the blur that follows a town pick lands
  // before the next render.
  const nameQueryRef = useRef(nameQuery);
  nameQueryRef.current = nameQuery;
  const reportNameSearchIfActive = useCallback(() => {
    if (pickedPlaceRef.current === null && nameQueryRef.current.trim().length >= MIN_NAME_LENGTH) {
      reportSearchUsed('name');
    }
  }, [reportSearchUsed]);

  // Back to the climber, or out to the world: no town, nothing panned.
  const leaveTown = useCallback(() => {
    setViewCenter(null);
    setSelectedId(null);
    const coords = deviceCoordsRef.current;
    resetSearch({ center: coords, filter: filterRef.current });
    if (coords) {
      moveCameraTo(coords);
    } else {
      programmaticTargetRef.current = null;
      mapRef.current?.showWorld();
    }
  }, [moveCameraTo, resetSearch]);

  // --- the search field ---
  const onChangeText = useCallback(
    (text: string) => {
      setInputText(text);
      setNameQuery(text);
      // Editing a picked town clears it, as on the website: the text is a new
      // search (a focus selects the label, so typing replaces it).
      if (pickedPlaceRef.current !== null) {
        setPickedPlace(null);
        leaveTown();
      }
    },
    [leaveTown],
  );

  const onSelectPlace = useCallback(
    (place: PlaceSuggestion) => {
      const coords = { latitude: place.latitude, longitude: place.longitude };
      const label = placeSuggestionLabel(place);
      // The keyboard goes, the map card comes back, and the climber sees the
      // map fly there above the town's gyms.
      pickedPlaceRef.current = label;
      nameQueryRef.current = '';
      Keyboard.dismiss();
      setMapFolded(false);
      listRef.current?.scrollToTop();
      setInputText(label);
      setNameQuery('');
      setSearchedName('');
      setPickedPlace(label);
      setViewCenter(coords);
      setSelectedId(null);
      resetSearch({ center: coords, filter: filterRef.current });
      moveCameraTo(coords);
      reportSearchStarted('place', 0);
      reportSearchUsed('town');
    },
    [moveCameraTo, resetSearch, reportSearchStarted, reportSearchUsed],
  );

  // Results follow the text as it is typed; a town comes from its suggestion.
  const onSubmit = useCallback(() => {}, []);

  const clearSearchText = useCallback(() => {
    setInputText('');
    setNameQuery('');
    setSearchedName('');
    setPickedPlace(null);
  }, []);
  const onClear = useCallback(() => {
    clearSearchText();
    setMapFolded(false);
    leaveTown();
  }, [clearSearchText, leaveTown]);

  // Focusing the field folds the map card away and goes back to the top, so
  // the keyboard never covers the results. Letting go keeps it folded while
  // anything is typed (see `mapFolded`).
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;
  const onFocusChange = useCallback(
    (focused: boolean) => {
      if (focused) {
        setMapFolded(true);
        listRef.current?.scrollToTop();
        return;
      }
      reportNameSearchIfActive();
      if (inputTextRef.current.trim().length === 0) setMapFolded(false);
    },
    [reportNameSearchIfActive],
  );

  // New results (a name looked up, towns suggested) start from the top, so
  // none of them lands above the viewport. Not on open: nothing to move yet.
  const resultsShownRef = useRef(false);
  useEffect(() => {
    if (!resultsShownRef.current) {
      resultsShownRef.current = true;
      return;
    }
    listRef.current?.scrollToTop();
  }, [searchedName, placeSuggestions]);

  // --- the locate button ---
  // Back to the climber: a picked town goes, as Clear does, and the camera
  // flies home. With no fix yet the tap asks for one (the climber's own
  // request, so whatever an earlier "Not now" said; Settings once only
  // Settings can turn location on), and the fix, when it comes, does the same.
  const locateRequestedRef = useRef(false);
  const goToClimber = useCallback(() => {
    if (pickedPlaceRef.current !== null) clearSearchText();
    setMapFolded(false);
    leaveTown();
  }, [clearSearchText, leaveTown]);
  const goToClimberRef = useRef(goToClimber);
  goToClimberRef.current = goToClimber;
  const permissionRef = useRef(location.permission);
  permissionRef.current = location.permission;
  const onLocate = useCallback(() => {
    const event = gymFinderLocateTapped(finderSurface);
    track(event.name, event.properties);
    if (deviceCoordsRef.current) {
      goToClimber();
      return;
    }
    if (permissionRef.current === 'blocked') {
      if (canOpenAppSettings()) void openAppSettings();
      return;
    }
    locateRequestedRef.current = true;
    void requestLocation();
  }, [finderSurface, goToClimber, requestLocation]);

  // A fix that arrives after the map opened on the world flies there, unless a
  // town was picked meanwhile; after a locate tap it flies there regardless.
  useEffect(() => {
    if (!deviceCoords) return;
    if (locateRequestedRef.current) {
      locateRequestedRef.current = false;
      goToClimberRef.current();
      return;
    }
    if (viewCenterRef.current === null) moveCameraTo(deviceCoords);
  }, [deviceCoords, moveCameraTo]);
  // A locate request that ended without a fix (refused, no GPS) is over: a fix
  // that turns up later, from Settings say, must not throw a picked town away.
  useEffect(() => {
    if (location.status === 'denied' || location.status === 'unavailable') locateRequestedRef.current = false;
  }, [location.status]);

  // --- the board type: one capsule menu, not a wall of chips ---
  const capsules = useMemo<Capsule[]>(() => {
    const anyLabel = t('mobile.gymStep.anyBoard');
    return [
      {
        kind: 'menu',
        key: 'boardType',
        label: boardType ? boardTypeLabel(boardType) : anyLabel,
        active: boardType !== null,
        options: [
          { value: ANY_BOARD, label: anyLabel },
          ...SUPPORTED_BOARDS.map((board) => ({ value: board, label: boardTypeLabel(board) })),
        ],
        selected: boardType ?? ANY_BOARD,
        onSelect: (value: string) => setBoardType(isPickableBoardType(value) ? value : null),
      },
    ];
  }, [boardType, t]);

  // --- the gyms ---
  const gymsQuery = useNearbyGyms(
    search.center,
    SEARCH_RADIUS_KM,
    searchedName || undefined,
    search.filter.boardTypes,
    undefined,
    undefined,
    undefined,
    { enabled: !offline },
  );
  const searchEnabled = search.center !== null || searchedName.length > 0;
  // A cleared search keeps the last answer as placeholder data: draw none of it.
  const gyms = useMemo<readonly Gym[]>(
    () => (searchEnabled ? (gymsQuery.data?.gyms ?? []) : []),
    [searchEnabled, gymsQuery.data?.gyms],
  );
  const lookup = lookupState({
    enabled: searchEnabled,
    offline,
    isLoading: gymsQuery.isLoading,
    isError: gymsQuery.isError,
    count: gymsQuery.data ? gyms.length : null,
  });
  // A failed lookup, or rows still on screen after a failed refetch: say so above them.
  const refreshFailed = lookup === 'failed' || (gymsQuery.isError && !gymsQuery.isFetching && lookup === 'listed');
  const { refetch: refetchGyms } = gymsQuery;
  const retryGyms = useCallback(() => void refetchGyms(), [refetchGyms]);

  useEffect(() => {
    if (lookup === 'failed' && countsInWizardFunnel) {
      track(SHARED_EVENTS.BoardWallLookupFailed, {
        stage: 'gyms',
        error_reason: lookupErrorReason(gymsQuery.error, offline),
      });
    }
    // Once per failure: the state, not the error object, says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup]);

  // Nowhere to look yet: the location prompt in place of the gyms. A town or a
  // gym name typed above works without it.
  const showLocationPrompt = center === null && nameQuery.trim().length < MIN_NAME_LENGTH;

  const sectionLabel =
    search.center === null
      ? t('mobile.findWall.gyms')
      : viewCenter === null
        ? t('mobile.gyms.title')
        : t('mobile.gymStep.inThisArea');
  const rows = useMemo(
    () =>
      buildGymPickRows({
        gyms,
        lookup,
        origin: deviceCoords,
        selectedId,
        labels: {
          section: sectionLabel,
          empty: searchedName.length > 0 ? t('mobile.gymStep.noNameMatch') : t('mobile.gyms.empty'),
          offline: t('mobile.findWall.offline'),
          failed: t('mobile.findWall.gymsFailed'),
          retry: t('mobile.findWall.retry'),
          boardCount: (count: number) => t('mobile.gyms.boardCount', { count }),
          noBoards: t('mobile.gyms.noBoards'),
        },
        places: {
          suggestions: placeSuggestions,
          label: t('mobile.gymStep.places'),
          // The browser's field carries its own GeoNames link.
          attribution: Platform.OS === 'web' ? null : t('mobile.gyms.placesAttribution'),
        },
        locationPrompt: showLocationPrompt,
      }),
    [
      gyms,
      lookup,
      deviceCoords,
      selectedId,
      sectionLabel,
      searchedName.length,
      placeSuggestions,
      showLocationPrompt,
      t,
    ],
  );

  const markers = useMemo<GymMapMarker[]>(
    () =>
      gyms
        .filter((gym) => Number.isFinite(gym.latitude) && Number.isFinite(gym.longitude))
        .map((gym) => ({
          id: gym.uuid,
          latitude: gym.latitude as number,
          longitude: gym.longitude as number,
          name: gym.name,
        })),
    [gyms],
  );

  // A pin only selects: its row is tinted and scrolled to. The row picks.
  const onMarkerPress = useCallback((id: string) => {
    setSelectedId(id);
    listRef.current?.scrollToItemKey(`gym:${id}`);
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const handlePickGym = useCallback(
    (gym: Gym) => {
      reportNameSearchIfActive();
      const event = gymFinderGymPicked({
        surface: finderSurface,
        section: gym.uuid === selectedIdRef.current ? 'map_pin' : 'list',
      });
      track(event.name, event.properties);
      onPickGym(gym, boardTypeRef.current);
    },
    [finderSurface, onPickGym, reportNameSearchIfActive],
  );
  const handleAddGym = useCallback(() => {
    const event = gymFinderAddMyGymTapped(finderSurface);
    track(event.name, event.properties);
    onAddGym(boardTypeRef.current);
  }, [finderSurface, onAddGym]);

  // --- the map ---
  // A browser has no native map (GymMap reports it unavailable on mount): start
  // folded there, so no empty card flashes before the list.
  const [mapAvailable, setMapAvailable] = useState(Platform.OS !== 'web');
  const [mapAttempt, setMapAttempt] = useState(0);
  // The map reads its centre only when it mounts (the camera moves through its
  // handle after that), so it gets the centre of its own mount: the element
  // stays the same through every pan instead of being rebuilt on each one.
  const [mapOpeningCenter, setMapOpeningCenter] = useState<Coords | null>(center);
  const centerRef = useRef(center);
  centerRef.current = center;
  const handleMapUnavailable = useCallback(() => setMapAvailable(false), []);
  const handleMapReady = useCallback(() => setMapAvailable(true), []);
  const retryMap = useCallback(() => {
    setMapAvailable(true);
    setMapOpeningCenter(centerRef.current);
    setMapAttempt((attempt) => attempt + 1);
  }, []);

  const mapElement = useMemo(
    () => (
      <GymMap
        key={mapAttempt}
        ref={mapRef}
        center={mapOpeningCenter}
        markers={markers}
        onRegionChange={onRegionChange}
        onMarkerPress={onMarkerPress}
        onMapUnavailable={handleMapUnavailable}
        onMapReady={handleMapReady}
        selectedId={selectedId ?? undefined}
        selectedTint={brandColors.primary}
        style={StyleSheet.absoluteFill}
      />
    ),
    [
      mapAttempt,
      mapOpeningCenter,
      markers,
      onRegionChange,
      onMarkerPress,
      handleMapUnavailable,
      handleMapReady,
      selectedId,
      brandColors.primary,
    ],
  );

  // A browser never has the map: saying so there would be noise.
  const showMapUnavailable = !mapAvailable && Platform.OS !== 'web';
  const placeCaption = useMemo(
    () =>
      showMapUnavailable || refreshFailed ? (
        <View style={[styles.captionPill, { backgroundColor: systemColors.background }]} testID="gym-step-caption">
          {showMapUnavailable ? (
            <>
              <Text variant="caption1" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
                {t('mobile.gyms.mapUnavailable')}
              </Text>
              <PressableSurface onPress={retryMap} accessibilityRole="button" hitSlop={8}>
                <Text variant="caption1" color={systemColors.accent}>
                  {t('mobile.gyms.retryMap')}
                </Text>
              </PressableSurface>
            </>
          ) : null}
          {refreshFailed ? (
            <>
              <Text variant="caption1" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
                {t('mobile.gyms.refreshFailed')}
              </Text>
              <PressableSurface onPress={retryGyms} accessibilityRole="button" hitSlop={8}>
                <Text variant="caption1" color={systemColors.accent}>
                  {t('mobile.gyms.retry')}
                </Text>
              </PressableSurface>
            </>
          ) : null}
        </View>
      ) : null,
    [
      showMapUnavailable,
      refreshFailed,
      retryMap,
      retryGyms,
      t,
      systemColors.background,
      systemColors.secondaryLabel,
      systemColors.accent,
    ],
  );

  const stickyHeader = useMemo(
    () => (
      <>
        <CapsuleRow capsules={capsules} />
        {placeCaption}
      </>
    ),
    [capsules, placeCaption],
  );

  const locationPrompt = useMemo(
    () => (
      <View style={styles.promptArea}>
        <GymLocationPrompt
          status={location.status}
          permission={location.permission}
          permissionChecked={location.permissionChecked}
          onRequest={requestLocation}
          onRecheck={requestIfAllowed}
        />
      </View>
    ),
    [location.status, location.permission, location.permissionChecked, requestLocation, requestIfAllowed],
  );

  const renderRow = useCallback(
    ({ item }: { item: GymPickRow }) => {
      switch (item.kind) {
        case 'sectionHeader':
          return (
            <View style={styles.gutter}>
              <GymListSectionHeader label={item.label} />
            </View>
          );
        case 'loading':
          return <ActivityIndicator style={styles.spinner} />;
        case 'empty':
          return (
            <View style={styles.gutter}>
              <GymListEmptyRow label={item.label} />
              {item.retryLabel ? <PickRetryAction label={item.retryLabel} onPress={retryGyms} /> : null}
            </View>
          );
        case 'pickGym':
          return (
            <PickGymRow
              gym={item.gym}
              subtitle={item.subtitle}
              boardsLabel={item.boardsLabel}
              position={item.position}
              selected={item.selected}
              checked={currentGymUuid === undefined ? undefined : item.gym.uuid === currentGymUuid}
              onPickGym={handlePickGym}
            />
          );
        case 'place':
          return (
            <PickPlaceRow
              place={item.place}
              label={item.label}
              position={item.position}
              onSelectPlace={onSelectPlace}
            />
          );
        case 'placesAttribution':
          return (
            <Text variant="caption2" tone="secondary" style={styles.attribution}>
              {item.label}
            </Text>
          );
        case 'locationPrompt':
          return locationPrompt;
      }
    },
    [retryGyms, handlePickGym, onSelectPlace, locationPrompt, currentGymUuid],
  );

  const showsOnMap = picker?.showsOnMap ?? true;
  const onPickNone = picker?.onPickNone;
  const addGymFooter = useMemo(
    () =>
      onPickNone ? (
        <View>
          <NoGymRow
            title={t('mobile.gymPicker.noGym')}
            subtitle={showsOnMap ? t('mobile.gymPicker.noGymHint') : t('mobile.gymPicker.noGymHintOffMap')}
            checked={currentGymUuid === null}
            position="first"
            onPickNone={onPickNone}
          />
          <AddGymRow title={t('mobile.gymPicker.addNew')} position="last" onAddGym={handleAddGym} />
        </View>
      ) : (
        <AddGymRow
          title={t('mobile.gymStep.addGym')}
          subtitle={isAuthenticated ? t('mobile.gymStep.addGymHint') : t('mobile.findWall.signInToAdd')}
          onAddGym={handleAddGym}
        />
      ),
    [onPickNone, showsOnMap, currentGymUuid, isAuthenticated, t, handleAddGym],
  );

  return (
    <View
      style={[styles.screen, { backgroundColor: systemColors.groupedBackground, paddingTop: headerInset }]}
      testID="gym-step"
    >
      <View style={styles.headerBlock} testID="gym-step-header">
        <WizardStepHeader
          stepLabel={stepLabel ?? null}
          title={t('mobile.gymStep.title')}
          body={picker ? t('mobile.gymPicker.sharedEditHint') : undefined}
        />
        <View style={styles.searchRow}>
          <GymSearchField
            text={inputText}
            hasSelectedPlace={pickedPlace !== null}
            isGeocoding={false}
            placeholder={t('mobile.gymStep.searchPlaceholder')}
            onChangeText={onChangeText}
            onSubmit={onSubmit}
            onSelectPlace={onSelectPlace}
            onClear={onClear}
            onFocusChange={onFocusChange}
            suggestionsPlacement="inline"
            onSuggestionsChange={setPlaceSuggestions}
          />
        </View>
      </View>
      <MapCardList
        ref={listRef}
        data={rows}
        renderItem={renderRow}
        keyExtractor={pickRowKey}
        getItemType={pickRowType}
        map={mapElement}
        mapAvailable={mapAvailable}
        mapHidden={mapFolded}
        onLocate={onLocate}
        locateLabel={t('mobile.gyms.grantLocation')}
        stickyHeader={stickyHeader}
        footer={addGymFooter}
        testID="gym-step-list"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  // Pinned under the bar; wide windows keep the readable column, as the list does.
  headerBlock: {
    width: '100%',
    maxWidth: READABLE_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    gap: spacing[3],
  },
  searchRow: {
    paddingHorizontal: spacing[4],
  },
  gutter: {
    paddingHorizontal: spacing[4],
  },
  spinner: {
    marginTop: spacing[4],
  },
  attribution: {
    paddingHorizontal: spacing[6],
    paddingTop: spacing[1],
  },
  promptArea: {
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[6],
  },
  captionPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[2],
    marginHorizontal: spacing[4],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
});
