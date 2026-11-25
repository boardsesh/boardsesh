// "Which gym?": the add-a-board flow's gym step, as a map with a search bar
// like the website's gym directory, built from the /gyms parts (`GymMap`,
// `GymListPanel` in pick mode, `GymSearchField`, `GymLocationPrompt`).
//
// - The search field is pinned under the bar. Typing filters gyms by name (2+
//   characters, once the text is still) and suggests towns (`searchPlaces`); a
//   town flies the map there and lists the gyms within 50 km. Neither needs
//   location. Focusing the field raises the list over the map, so the keyboard
//   never hides the results.
// - Location is never asked on open. The step only reads a permission the
//   climber already gave (`requestIfAllowed`); otherwise, until a town or a name
//   is searched, the list shows the location prompt and the map the world.
// - The map is the top 35%, the gym list a panel under it. A pin tap selects its
//   row; only a row tap picks, so a mis-tapped pin never moves the flow on.
//   Zooming the world view in to a town searches there, as the website does.
//
// A pick hands the gym to the caller (today `/boards/find-wall`, whose next
// screen is the gym's wall list); so does "Add my gym", the list's last row.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { SUPPORTED_BOARDS } from '@boardsesh/board-config';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import type { BoardName, Gym, PlaceSuggestion } from '@boardsesh/shared-schema';
import { useNearbyGyms } from '../../../lib/graphql/hooks';
import { isGraphqlRateLimitedError } from '../../../lib/graphql/extract-error-message';
import { useDeviceLocation, type Coords } from '../../../lib/use-device-location';
import { useDiscoverySearch } from '../../../lib/use-discovery-search';
import type { WallFinderFilter } from '../../../lib/wall-finder-filter';
import { selectEffectiveOffline, useConnectivityField } from '../../../lib/connectivity/use-connectivity';
import { isPickableBoardType, locationPromptStatus, lookupState } from '../../../lib/boards/find-wall-state';
import { track } from '../../../lib/analytics';
import { useAuth } from '../../../providers/auth-provider';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';
import { Text } from '../../Text';
import { PressableSurface } from '../../PressableSurface';
import { StepCounter } from '../../spray-wall/StepCounter';
import { CapsuleRow } from '../../filter-capsules/CapsuleRow';
import type { Capsule } from '../../filter-capsules/CapsuleRow.types';
import { GymMap, type GymMapHandle, type GymMapMarker } from '../../gym-directory/GymMap';
import { GymListPanel, type GymListPanelHandle } from '../../gym-directory/GymListPanel';
import { GymLocationPrompt } from '../../gym-directory/GymLocationPrompt';
import { GymSearchField } from '../../gym-directory/GymSearchField';
import { buildGymPickRows } from '../../gym-directory/gym-pick-rows';
import { boardTypeLabel } from '../board-builder-labels';

export type GymStepProps = {
  /** A gym row was tapped. `boardType` is the type filter in force, or null for any. */
  onPickGym: (gym: Gym, boardType: BoardName | null) => void;
  /** "Add my gym", the list's last row: the gym isn't listed. */
  onAddGym: (boardType: BoardName | null) => void;
  /** Only gyms with a board of this type, on open (an entry that already knows the type). */
  initialBoardType?: BoardName | null;
  /** "Step 2 of 3" above the search field, for a flow that counts its steps. */
  stepLabel?: string;
};

/** The gym search radius around the map's centre. */
const SEARCH_RADIUS_KM = 50;
/** The share of the step's body the map keeps above the list panel. */
const MAP_FRACTION = 0.35;
/** How far a pan must move the camera (degrees) before the list follows it. */
const MIN_MOVE_DEG = 0.04;
/**
 * How far in the world view must be zoomed before its centre is a place to
 * search around: about a region, where a 50 km radius covers what is shown.
 */
const SEARCH_ZOOM_THRESHOLD = 8;
/** Gym-name search: the shortest name looked up, and how long the text must be still. */
const MIN_NAME_LENGTH = 2;
const NAME_DEBOUNCE_MS = 300;
/** The capsule menu's value for "any board type". */
const ANY_BOARD = 'any';

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

export function GymStep({ onPickGym, onAddGym, initialBoardType = null, stepLabel }: GymStepProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const offline = useConnectivityField(selectEffectiveOffline);
  const mapRef = useRef<GymMapHandle>(null);
  const panelRef = useRef<GymListPanelHandle>(null);

  // --- location: read on open, asked only from the prompt's button ---
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true });
  const { requestIfAllowed, request: requestLocation, coords: deviceCoords } = location;
  const [permissionChecked, setPermissionChecked] = useState(false);
  useEffect(() => {
    let mounted = true;
    void requestIfAllowed().finally(() => {
      if (mounted) setPermissionChecked(true);
    });
    return () => {
      mounted = false;
    };
  }, [requestIfAllowed]);
  const onUseMyLocation = useCallback(() => void requestLocation(), [requestLocation]);

  // --- what is searched ---
  // `inputText` is the field; `nameQuery` the gym-name filter it carries (empty
  // once a town is picked, when the field holds the town's label); `viewCenter`
  // a picked town or a panned map, which wins over the device fix.
  const [inputText, setInputText] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [pickedPlace, setPickedPlace] = useState<string | null>(null);
  const [viewCenter, setViewCenter] = useState<Coords | null>(null);
  const [boardType, setBoardType] = useState<BoardName | null>(initialBoardType);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    if (current === null) {
      // The world view itself is no place to search around; zoomed in to a
      // town (location off, nothing typed), its centre is.
      const zoom = cameraZoomRef.current;
      if (zoom === undefined || zoom < SEARCH_ZOOM_THRESHOLD) return null;
      programmaticTargetRef.current = null;
      setViewCenter(next);
      return next;
    }
    if (!movedEnough(next, current)) return current;
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

  // A fix that arrives after the map opened on the world flies there, unless a
  // town was picked meanwhile.
  useEffect(() => {
    if (deviceCoords && viewCenterRef.current === null) moveCameraTo(deviceCoords);
  }, [deviceCoords, moveCameraTo]);

  // --- analytics: how the climber started looking, once per method ---
  const boardTypeRef = useRef(boardType);
  boardTypeRef.current = boardType;
  const searchStartedRef = useRef(new Set<SearchMethod>());
  const reportSearchStarted = useCallback((method: SearchMethod, queryLength: number) => {
    if (searchStartedRef.current.has(method)) return;
    searchStartedRef.current.add(method);
    track(SHARED_EVENTS.BoardWallSearchStarted, { method, boardType: boardTypeRef.current, queryLength });
  }, []);
  useEffect(() => {
    if (deviceCoords) reportSearchStarted('location', 0);
  }, [deviceCoords, reportSearchStarted]);
  useEffect(() => {
    if (searchedName.length > 0) reportSearchStarted('text', searchedName.length);
  }, [searchedName, reportSearchStarted]);

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
  const pickedPlaceRef = useRef(pickedPlace);
  pickedPlaceRef.current = pickedPlace;
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
      Keyboard.dismiss();
      setInputText(label);
      setNameQuery('');
      setSearchedName('');
      setPickedPlace(label);
      setViewCenter(coords);
      setSelectedId(null);
      resetSearch({ center: coords, filter: filterRef.current });
      moveCameraTo(coords);
      reportSearchStarted('place', 0);
    },
    [moveCameraTo, resetSearch, reportSearchStarted],
  );

  // Results follow the text as it is typed; a town comes from its suggestion.
  const onSubmit = useCallback(() => {}, []);

  const onClear = useCallback(() => {
    setInputText('');
    setNameQuery('');
    setSearchedName('');
    setPickedPlace(null);
    leaveTown();
  }, [leaveTown]);

  // Typing raises the list over the map, so the keyboard never covers it.
  const onFocusChange = useCallback((focused: boolean) => {
    if (focused) panelRef.current?.snapTo('high');
  }, []);

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
    if (lookup === 'failed') {
      track(SHARED_EVENTS.BoardWallLookupFailed, {
        stage: 'gyms',
        error_reason: lookupErrorReason(gymsQuery.error, offline),
      });
    }
    // Once per failure: the state, not the error object, says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookup]);

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
      }),
    [gyms, lookup, deviceCoords, selectedId, sectionLabel, searchedName.length, t],
  );
  const addGym = useMemo(
    () => ({
      title: t('mobile.gymStep.addGym'),
      subtitle: isAuthenticated ? t('mobile.gymStep.addGymHint') : t('mobile.findWall.signInToAdd'),
    }),
    [isAuthenticated, t],
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
    panelRef.current?.ensureVisible();
    panelRef.current?.scrollToRowKey(`gym:${id}`);
  }, []);

  const handlePickGym = useCallback((gym: Gym) => onPickGym(gym, boardType), [onPickGym, boardType]);
  const handleAddGym = useCallback(() => onAddGym(boardType), [onAddGym, boardType]);

  // --- the map ---
  const [mapAvailable, setMapAvailable] = useState(true);
  const [mapAttempt, setMapAttempt] = useState(0);
  const handleMapUnavailable = useCallback(() => setMapAvailable(false), []);
  const handleMapReady = useCallback(() => setMapAvailable(true), []);
  const retryMap = useCallback(() => {
    setMapAvailable(true);
    setMapAttempt((attempt) => attempt + 1);
  }, []);
  // Over a map that can't draw, a half-height list reads as broken: give it the screen.
  useEffect(() => {
    if (!mapAvailable) panelRef.current?.snapTo('high');
  }, [mapAvailable]);

  // The panel lays out in what is left under the search field.
  const [bodyHeight, setBodyHeight] = useState(0);
  const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.height);
    setBodyHeight((previous) => (previous === measured ? previous : measured));
  }, []);
  // The map runs under the panel's rounded top corners, so no strip of
  // background shows between them.
  const mapAreaStyle = useMemo(
    () => [styles.mapArea, { height: bodyHeight * MAP_FRACTION + borderRadius.xl }],
    [bodyHeight],
  );

  const placeCaption =
    !mapAvailable || refreshFailed ? (
      <View style={[styles.captionPill, { backgroundColor: systemColors.background }]}>
        {!mapAvailable ? (
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
    ) : null;

  // Nowhere to look yet: the location prompt in place of the list. A town or a
  // gym name typed above works without it.
  const locationPrompt =
    center === null && nameQuery.trim().length < MIN_NAME_LENGTH ? (
      <GymLocationPrompt
        status={locationPromptStatus({
          checked: permissionChecked,
          status: location.status,
          permission: location.permission,
        })}
        onRequest={onUseMyLocation}
      />
    ) : undefined;

  return (
    <View style={[styles.screen, { backgroundColor: systemColors.background }]} testID="gym-step">
      <View style={styles.header}>
        {stepLabel ? <StepCounter label={stepLabel} /> : null}
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
        />
      </View>
      <View style={styles.body} onLayout={onBodyLayout}>
        <View style={mapAreaStyle}>
          <GymMap
            key={mapAttempt}
            ref={mapRef}
            center={center}
            markers={markers}
            onRegionChange={onRegionChange}
            onMarkerPress={onMarkerPress}
            onMapUnavailable={handleMapUnavailable}
            onMapReady={handleMapReady}
            selectedId={selectedId ?? undefined}
            selectedTint={brandColors.primary}
            style={StyleSheet.absoluteFill}
          />
        </View>
        {bodyHeight > 0 ? (
          <GymListPanel
            ref={panelRef}
            mode="pick"
            data={rows}
            mapAvailable={mapAvailable}
            availableHeight={bodyHeight}
            mediumFraction={1 - MAP_FRACTION}
            allowLowDetent={false}
            onPickGym={handlePickGym}
            addGym={addGym}
            onAddGym={handleAddGym}
            onRetry={retryGyms}
            searchSlot={null}
            placeCaption={placeCaption}
            filterSlot={<CapsuleRow capsules={capsules} />}
            locationPrompt={locationPrompt}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[2],
    gap: spacing[1],
    // The field's town suggestions float over the map and the list below.
    zIndex: 1,
  },
  body: {
    flex: 1,
  },
  mapArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  captionPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
});
