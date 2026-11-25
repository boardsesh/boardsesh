// The gym map's state and actions, shared by its two shells:
//  - the root stack's full-screen map with one draggable panel over it
//    (`GymFinderMapScreen`: Home's Gyms near you, Gyms you run);
//  - the board picker's copy, a map card over the list inside the picker's
//    sheet (`GymFinderCardScreen`), where a second draggable panel would be a
//    sheet on a sheet (docs/mobile/mobile-sheets-vs-routes.md).
//
// Everything a climber does here is the same in both: pan or search to look
// somewhere, filter by board type, open a gym to see its boards, pick a board
// to make it active. Only the frame differs, so the frame is the only thing
// each shell owns; the one thing the hook needs back from it is how to bring a
// row into view after a pin tap (`revealRow`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Gym, PlaceSuggestion, UserBoard } from '@boardsesh/shared-schema';
import {
  gymClaimCtaClicked,
  gymFinderGymPicked,
  gymFinderSearchUsed,
  type GymFinderSearchKind,
} from '@boardsesh/analytics';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';
import { useNearbyBoards, useNearbyGyms } from '../../lib/graphql/hooks';
import { useGymBoards } from '../../lib/graphql/hooks/use-gym-boards';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useDeviceLocation, type Coords } from '../../lib/use-device-location';
import { useGeocodePlace } from '../../lib/use-place-search';
import { useDiscoverySearch } from '../../lib/use-discovery-search';
import { useRetainedQueryData } from '../../lib/use-retained-query-data';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { hapticSelection } from '../../lib/haptics';
import { track } from '../../lib/analytics';
import { resolveBoardReturnTo } from '../../lib/boards/board-return-to';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import { useBoardPickerAnalytics } from '../../lib/boards/use-board-picker-analytics';
import { isNoBoardEntry } from '../../lib/boards/first-board-mode';
import {
  DEFAULT_WALL_FINDER_FILTER,
  buildLayoutOptions,
  buildSizeOptions,
  clearWallFinderChipFilters,
  initialWallFinderFilter,
  toggleBoardTypeFilter,
  toggleLayoutFilter,
  toggleMultiBoardTypeFilter,
  toggleSizeFilter,
  type WallFinderFilter,
} from '../../lib/wall-finder-filter';
import { gymEditHref, gymPageHref, type GymPageStack } from '../gym-page/gym-page-route';
import { useGymRouteStack } from '../gym-page/use-gym-route-stack';
import type { GymMapHandle, GymMapMarker } from './GymMap';
import { zoomedInToSearch } from './map-search-zoom';
import { buildGymListRows, filterBoardsByChips, type GymListRow } from './gym-list-rows';

// How long the camera must be still after a pan before we re-query the new
// viewport, and how far it must have moved to bother. The radius queried is
// 50km, so a sub-~4km nudge isn't worth a refetch — and the threshold also
// absorbs the programmatic camera settle after a place search so it doesn't
// read as a user pan.
const MIN_MOVE_DEG = 0.04;
/**
 * Every gym finder event from here says where it came from. Both shells are the
 * gym map: the board picker's opening events already tell a map opened from the
 * picker (`gym_finder_from_picker`) from one opened from Home.
 */
const FINDER_SURFACE = 'gyms_map';

function movedEnough(first: Coords, second: Coords): boolean {
  const latitudeDelta = first.latitude - second.latitude;
  const longitudeDelta = first.longitude - second.longitude;
  return latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta >= MIN_MOVE_DEG * MIN_MOVE_DEG;
}

export type UseGymFinderOptions = {
  /**
   * Bring the row with this key into view: a pin was tapped. The panel shell
   * also nudges its panel up; the card shell scrolls its list.
   */
  revealRow: (rowKey: string) => void;
  /**
   * Whether to lay out for the map before it has said whether it can draw.
   * The card shell starts folded in a browser, which never has the native
   * map, so no empty card flashes before the list. Default true.
   */
  mapAvailableOnOpen?: boolean;
};

export function useGymFinder({ revealRow, mapAvailableOnOpen = true }: UseGymFinderOptions) {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const stack: GymPageStack = useGymRouteStack();
  // A climber who says no to the prompt may ask again from the card: Android's
  // second ask, or Settings once only Settings can turn it on. Coming back
  // from Settings (the card's, or the quiet Use my location's) reads the
  // permission again, so a grant there centres the map with no second tap.
  const location = useDeviceLocation({ retryAfterDenial: true, rereadWhenActive: true });
  const { geocode, isGeocoding } = useGeocodePlace();
  const { returnTo, source, from, boardType } = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    from?: string;
    /** The picker's "Search gyms" for a board it heard: open filtered to its type. */
    boardType?: string;
  }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  // Pushed from the onboarding picker, which forwards its `source`: a gym pick
  // there is the activation bind, same as a pick on `/boards` itself.
  const fromOnboarding = source === 'onboarding';
  const { data: activeBoard, isError: boardRestoreFailed } = useActiveBoard();
  // `from=picker` means the picker pushed this screen and already counted the
  // opening. Home and My gyms push it bare, so those entries count their own
  // opening under `source: 'gym_finder'`.
  const trackBoardSelection = useBoardPickerAnalytics({
    activeBoard,
    restoreFailed: boardRestoreFailed,
    returnTo: boardReturnTo,
    fromOnboarding,
    surface: from === 'picker' ? 'gym_finder_from_picker' : 'gym_finder',
    // Climbs' "Pick your board" picker forwards `source=no_board`; its gym picks
    // count under that source, as the picker's own picks do.
    fromNoBoard: isNoBoardEntry({ source }),
  });
  // The same bind as every other picker: write first, then the pick event, then
  // leave, then follow the board so it lands in Your boards (and offer it
  // offline). Its own copy used to skip the event and the first-run close-out.
  const activateBoard = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    onBound: trackBoardSelection,
  });
  const [expandedGymUuid, setExpandedGymUuid] = useState<string | null>(null);
  const expandedGymUuidRef = useRef(expandedGymUuid);
  expandedGymUuidRef.current = expandedGymUuid;
  // The selected gym/board mirrors the map pin and drives the row accent. Set by a
  // row tap (→ recenter the map) or a pin tap (→ scroll the row into view).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // When the native map can't render at all, lay out as a list-only surface.
  const [mapAvailable, setMapAvailable] = useState(mapAvailableOnOpen);
  const [mapAttempt, setMapAttempt] = useState(0);
  const mapRef = useRef<GymMapHandle>(null);
  // The gym an ownership claim is being started for. Set from an expanded row's
  // "Claim this gym" action; the ClaimGymSheet is mounted per-target so its form
  // starts clean each open, and cleared when the sheet fully dismisses.
  const [claimTargetGym, setClaimTargetGym] = useState<Gym | null>(null);
  const claimSheetRef = useRef<ManagedSheetHandle>(null);

  // `inputText` is the raw field; `appliedFilter` is the applied filter sent to the
  // backend (name + the board-type chips' selected `boardTypes`).
  // `viewCenter` is the authoritative map/query center (a searched place or a panned
  // location); `searchLabel` drives the "Showing X" caption. Filters apply on submit
  // so typing doesn't fire a request per keystroke.
  const [inputText, setInputText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState<WallFinderFilter>(() => initialWallFinderFilter(boardType));
  const appliedFilterRef = useRef(appliedFilter);
  appliedFilterRef.current = appliedFilter;
  const [viewCenter, setViewCenter] = useState<Coords | null>(null);
  const [searchLabel, setSearchLabel] = useState<string | null>(null);

  // A chosen view (searched or panned) wins; fall back to the device fix.
  const center = viewCenter ?? location.coords ?? null;

  // Refs mirror state so the stable, debounced region handler reads fresh values
  // without being torn down and rebuilt on every pan.
  const viewCenterRef = useRef(viewCenter);
  viewCenterRef.current = viewCenter;
  const locationCoordsRef = useRef(location.coords);
  locationCoordsRef.current = location.coords;
  // The target of the last programmatic camera move (place search / reset). The
  // resulting onCameraMove settle near this point must NOT be read as a user pan.
  const programmaticTargetRef = useRef<Coords | null>(null);
  const searchGenerationRef = useRef(0);
  // Gym Finder Search Used: once per kind per visit.
  const searchUsedRef = useRef(new Set<GymFinderSearchKind>());
  const reportSearchUsed = useCallback((kind: GymFinderSearchKind) => {
    if (searchUsedRef.current.has(kind)) return;
    searchUsedRef.current.add(kind);
    const event = gymFinderSearchUsed({ surface: FINDER_SURFACE, kind });
    track(event.name, event.properties);
  }, []);

  // The zoom of the last camera move: zoomed out past a region (the world view
  // with location off, or back out to it), a pan is no place to search around.
  const cameraZoomRef = useRef<number | undefined>(undefined);
  const resolveCameraCenter = useCallback((next: Coords, current: Coords | null) => {
    const target = programmaticTargetRef.current;
    if (target && !movedEnough(next, target)) {
      programmaticTargetRef.current = null;
      return current;
    }
    if (!zoomedInToSearch(cameraZoomRef.current, current !== null)) return current;
    if (current && !movedEnough(next, current)) return current;
    programmaticTargetRef.current = null;
    setViewCenter(next);
    setSearchLabel(null);
    return next;
  }, []);
  const { search, isDebouncing, cameraMoved, resetSearch } = useDiscoverySearch(center, appliedFilter, {
    resolveCameraCenter,
  });
  const handleRegionChange = useCallback(
    (coords: Coords, zoom?: number) => {
      cameraZoomRef.current = zoom;
      cameraMoved(coords);
    },
    [cameraMoved],
  );

  // On open, use location only if the climber already allowed it: the map and
  // nearby queries default to it. Never the system prompt here; that comes
  // from a tap on "See gyms near you" (GymLocationPrompt). A typed place
  // search works without location. Through a ref so this runs exactly once.
  const requestLocationIfAllowedRef = useRef(location.requestIfAllowed);
  requestLocationIfAllowedRef.current = location.requestIfAllowed;
  useEffect(() => {
    void requestLocationIfAllowedRef.current();
  }, []);

  useEffect(
    () => () => {
      searchGenerationRef.current += 1;
    },
    [],
  );

  const gymQuery = useNearbyGyms(
    search.center,
    50,
    search.filter.name,
    search.filter.boardTypes,
    search.filter.layoutIds,
    search.filter.sizeIds,
    search.filter.multiBoardTypeOnly,
  );
  const boardQuery = useNearbyBoards(
    search.center,
    50,
    search.filter.name,
    50,
    search.filter.boardTypes,
    search.filter.layoutIds,
    search.filter.sizeIds,
  );
  const gymConnection = useRetainedQueryData(gymQuery);
  const boardConnection = useRetainedQueryData(boardQuery);
  const gymsLoading = gymQuery.isLoading;
  const isUpdating = isDebouncing || gymQuery.isFetching || boardQuery.isFetching;
  const refreshFailed = !isUpdating && (gymQuery.isError || boardQuery.isError);
  const { refetch: refetchGyms } = gymQuery;
  const { refetch: refetchBoards } = boardQuery;
  const retrySearch = useCallback(() => {
    if (search.center !== null || search.filter.name?.trim()) void refetchGyms();
    if (search.center !== null) void refetchBoards();
  }, [refetchGyms, refetchBoards, search.center, search.filter.name]);

  const gyms = useMemo(() => gymConnection?.gyms ?? [], [gymConnection?.gyms]);
  // A name-only gym search disables board discovery. Retained data must not
  // keep showing standalone boards from the city that was just cleared.
  const boards = useMemo(
    () => (search.center !== null ? (boardConnection?.boards ?? []) : []),
    [boardConnection?.boards, search.center],
  );

  // Boards not attached to a gym still deserve discovery — surface them as their
  // own pins + list section so consolidating onto the gym map loses nothing.
  // The "2+ board types" filter is about gyms, and a standalone board can't have
  // two types, so hide the section entirely while it's on.
  const standaloneBoards = useMemo(
    () =>
      search.filter.multiBoardTypeOnly
        ? []
        : boards.filter((board) => board.gymUuid == null && board.latitude != null && board.longitude != null),
    [boards, search.filter.multiBoardTypeOnly],
  );

  // Pre-index a gym's boards ONCE per data change (O(1) per row, never a per-row
  // filter scan that FlashList recycling would re-run).
  const boardsByGym = useMemo(() => {
    const boardsIndex = new Map<string, UserBoard[]>();
    for (const board of boards) {
      if (board.gymUuid == null) continue;
      const existing = boardsIndex.get(board.gymUuid);
      if (existing) existing.push(board);
      else boardsIndex.set(board.gymUuid, [board]);
    }
    return boardsIndex;
  }, [boards]);

  const markers = useMemo<GymMapMarker[]>(
    () => [
      ...gyms
        .filter((gym) => Number.isFinite(gym.latitude) && Number.isFinite(gym.longitude))
        .map((gym) => ({
          id: gym.uuid,
          latitude: gym.latitude as number,
          longitude: gym.longitude as number,
          name: gym.name,
        })),
      ...standaloneBoards.map((board) => ({
        id: board.uuid,
        latitude: board.latitude as number,
        longitude: board.longitude as number,
        name: board.name,
      })),
    ],
    [gyms, standaloneBoards],
  );

  // The expanded gym's own linked boards. The nearby search above only returns
  // boards with a visible pin near the map centre, so a gym can list a board it
  // never returns.
  // A failed roster counts as settled: the row falls back to the nearby boards
  // instead of showing a spinner that never resolves.
  const { data: gymRoster, isPending: gymRosterPending } = useGymBoards(expandedGymUuid);
  const expandedGymRosterPending = expandedGymUuid != null && gymRosterPending;
  const expandedGymRoster = useMemo(
    () => (gymRoster ? filterBoardsByChips(gymRoster, search.filter) : undefined),
    [gymRoster, search.filter],
  );

  const rows = useMemo<GymListRow[]>(
    () =>
      buildGymListRows({
        gyms,
        boardsByGym,
        standaloneBoards,
        expandedGymUuid,
        expandedGymRoster,
        expandedGymRosterPending,
        selectedId,
        gymsLoading,
        labels: {
          gymsSection: t('mobile.gyms.subtitle'),
          otherBoards: t('mobile.gyms.otherBoardsTitle'),
          empty: t('mobile.gyms.empty'),
          boardCount: (count: number) => t('mobile.gyms.boardCount', { count }),
        },
      }),
    [
      gyms,
      boardsByGym,
      standaloneBoards,
      expandedGymUuid,
      expandedGymRoster,
      expandedGymRosterPending,
      selectedId,
      gymsLoading,
      t,
    ],
  );

  // Nested filter chips, derived from board-constants so they're deterministic
  // and don't vanish as the user narrows. Layouts appear once a single board type
  // is chosen; sizes once a single layout is chosen (both gated inside the
  // builders, which return [] otherwise).
  const layoutOptions = useMemo(() => buildLayoutOptions(appliedFilter), [appliedFilter]);
  const sizeOptions = useMemo(() => buildSizeOptions(appliedFilter), [appliedFilter]);

  // Move the camera to a point we chose (search result / reset) and remember the
  // target so its settle is ignored by the pan handler.
  const moveCameraTo = useCallback((coords: Coords) => {
    programmaticTargetRef.current = coords;
    mapRef.current?.setCenter(coords);
  }, []);

  // Drop a chosen city: back to the climber's fix, or out to the world when
  // there is none. The list and the map move together.
  const leaveSelectedPlace = useCallback(
    (filter: WallFinderFilter) => {
      setSearchLabel(null);
      setViewCenter(null);
      setExpandedGymUuid(null);
      setSelectedId(null);
      const deviceCoords = locationCoordsRef.current;
      resetSearch({ center: deviceCoords ?? null, filter });
      if (deviceCoords) {
        moveCameraTo(deviceCoords);
      } else {
        programmaticTargetRef.current = null;
        mapRef.current?.showWorld();
      }
    },
    [moveCameraTo, resetSearch],
  );

  const onSelectPlace = useCallback(
    (place: PlaceSuggestion) => {
      searchGenerationRef.current += 1;
      const coords = { latitude: place.latitude, longitude: place.longitude };
      const label = placeSuggestionLabel(place);
      const filter = { ...appliedFilterRef.current, name: undefined };
      setInputText(label);
      setExpandedGymUuid(null);
      setSelectedId(null);
      setViewCenter(coords);
      setSearchLabel(label);
      setAppliedFilter(filter);
      resetSearch({ center: coords, filter });
      moveCameraTo(coords);
      reportSearchUsed('town');
    },
    [moveCameraTo, resetSearch, reportSearchUsed],
  );

  const onChangeSearchText = useCallback(
    (text: string) => {
      searchGenerationRef.current += 1;
      setInputText(text);
      // Editing a selected city must not leave its invisible geographic filter
      // attached to a later gym-name search (native gets town suggestions too).
      if (searchLabel !== null) leaveSelectedPlace(appliedFilterRef.current);
    },
    [searchLabel, leaveSelectedPlace],
  );

  const activate = useCallback(
    (board: UserBoard) => {
      // The map's section; a wall on it has no place in a list to report.
      void activateBoard(board, { pickSource: 'gym_finder', section: 'map' });
    },
    [activateBoard],
  );

  // Edit a board / gym the viewer can edit (the row only renders the pencil when
  // `canEdit`). The board editor already loads any board by uuid and unlocks its
  // config for moderators. `/boards/edit` is the picker's own screen: from the
  // root map it opens the picker on it, from the picker's copy it pushes there.
  const onEditBoard = useCallback(
    (board: UserBoard) => {
      hapticSelection();
      router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
    },
    [router],
  );

  // The gym editor in this screen's own stack, never a sheet on the picker.
  const onEditGym = useCallback(
    (gym: Gym) => {
      hapticSelection();
      router.push(gymEditHref(gym.uuid, stack));
    },
    [router, stack],
  );

  // Start an ownership claim from an expanded gym row (reaches the non-editor
  // owner the edit-screen entry can't). Stash the target; the effect below
  // presents once the per-target sheet has mounted.
  const onClaimGym = useCallback((gym: Gym) => {
    hapticSelection();
    // The row only offers it on `canClaim`, which needs an account.
    const event = gymClaimCtaClicked({ placement: 'app-gym-list', viewerState: 'signed-in', gymUuid: gym.uuid });
    track(event.name, event.properties);
    setClaimTargetGym(gym);
  }, []);

  useEffect(() => {
    if (claimTargetGym) claimSheetRef.current?.present();
  }, [claimTargetGym]);

  // "See gym" on an expanded row: the gym's own page, in this screen's stack. It
  // carries the return tab, so a board picked there lands where a pick on the
  // map would.
  const onOpenGym = useCallback(
    (gym: Gym) => {
      hapticSelection();
      router.push(gymPageHref(gym.uuid, stack, returnTo));
    },
    [router, stack, returnTo],
  );

  const onClaimSheetClosed = useCallback(() => setClaimTargetGym(null), []);

  // Tap/expand a gym row: toggle its boards, select it, and recenter the map on it
  // (no-op when the map is blank — the row just expands).
  const onPressGym = useCallback(
    (gym: Gym) => {
      // Opening a gym is choosing it; folding it away again is not.
      if (expandedGymUuidRef.current !== gym.uuid) {
        const event = gymFinderGymPicked({ surface: FINDER_SURFACE, section: 'list' });
        track(event.name, event.properties);
      }
      setExpandedGymUuid((previous) => (previous === gym.uuid ? null : gym.uuid));
      setSelectedId(gym.uuid);
      if (gym.latitude != null && gym.longitude != null) {
        moveCameraTo({ latitude: gym.latitude, longitude: gym.longitude });
      }
    },
    [moveCameraTo],
  );

  // Latest gyms for the marker-tap handler without rebuilding it (and re-rendering
  // the map) on every refetch.
  const gymsRef = useRef(gyms);
  gymsRef.current = gyms;
  const revealRowRef = useRef(revealRow);
  revealRowRef.current = revealRow;

  // Tap a map pin: select it, bring its row into view and expand it if it's a
  // gym. Pure map→list polish — every selection is also reachable by scrolling
  // the list.
  const onMarkerPress = useCallback((id: string) => {
    setSelectedId(id);
    const isGym = gymsRef.current.some((gym) => gym.uuid === id);
    if (isGym && expandedGymUuidRef.current !== id) {
      const event = gymFinderGymPicked({ surface: FINDER_SURFACE, section: 'map_pin' });
      track(event.name, event.properties);
    }
    if (isGym) setExpandedGymUuid(id);
    revealRowRef.current(isGym ? `gym:${id}` : `std:${id}`);
  }, []);

  const handleMapUnavailable = useCallback(() => setMapAvailable(false), []);
  const handleMapReady = useCallback(() => setMapAvailable(true), []);
  const retryMap = useCallback(() => {
    setMapAvailable(true);
    setMapAttempt((attempt) => attempt + 1);
  }, []);

  // One bar, two jobs: if the text resolves to a place, relocate there and show
  // everything nearby; otherwise treat it as a name filter at the current spot.
  // We deliberately don't AND the two — a place name ("Tokyo") would otherwise
  // hide every gym not literally named after it.
  const onSubmitSearch = useCallback(async () => {
    const generation = ++searchGenerationRef.current;
    const text = inputText.trim();
    setExpandedGymUuid(null);
    setSelectedId(null);
    if (!text) {
      setSearchLabel(null);
      setAppliedFilter(DEFAULT_WALL_FINDER_FILTER);
      resetSearch({
        center: viewCenterRef.current ?? locationCoordsRef.current ?? null,
        filter: DEFAULT_WALL_FINDER_FILTER,
      });
      return;
    }
    if (searchLabel !== null) {
      // The chosen city is already applied. Submitting its display label must
      // not reinterpret it as a gym name.
      return;
    }
    // Browsers select cities explicitly through searchPlaces; Enter without a
    // selection is always a gym-name search. Expo's geocoder is native-only.
    const coords = Platform.OS === 'web' ? null : await geocode(text);
    if (generation !== searchGenerationRef.current) return;
    if (coords) {
      setViewCenter(coords);
      setSearchLabel(text);
      const filter = { ...appliedFilterRef.current, name: undefined };
      setAppliedFilter(filter);
      resetSearch({ center: coords, filter });
      moveCameraTo(coords);
      reportSearchUsed('town');
    } else {
      const filter = { ...appliedFilterRef.current, name: text };
      setAppliedFilter(filter);
      resetSearch({ center: viewCenterRef.current ?? locationCoordsRef.current ?? null, filter });
      reportSearchUsed('name');
    }
  }, [inputText, geocode, moveCameraTo, resetSearch, searchLabel, reportSearchUsed]);

  // Clear everything and snap back to the device location.
  const clearSearch = useCallback(() => {
    searchGenerationRef.current += 1;
    setInputText('');
    setAppliedFilter(DEFAULT_WALL_FINDER_FILTER);
    leaveSelectedPlace(DEFAULT_WALL_FINDER_FILTER);
  }, [leaveSelectedPlace]);

  // Chip toggles update immediately; the complete search input is debounced and
  // are orthogonal to a place search (a place relocates, it isn't a filter term).
  // The nested-tier clearing (layouts are board-type-scoped, sizes are
  // layout-scoped) lives in the pure helpers so it stays unit-testable.
  const onToggleBoardType = useCallback((boardName: BoardName) => {
    setAppliedFilter((previous) => toggleBoardTypeFilter(previous, boardName));
  }, []);

  const onToggleLayout = useCallback((layoutId: number) => {
    setAppliedFilter((previous) => toggleLayoutFilter(previous, layoutId));
  }, []);

  const onToggleSize = useCallback((sizeIds: number[]) => {
    setAppliedFilter((previous) => toggleSizeFilter(previous, sizeIds));
  }, []);

  const onToggleMultiBoardType = useCallback(() => {
    setAppliedFilter((previous) => toggleMultiBoardTypeFilter(previous));
  }, []);

  // The chip-row "Clear" wipes every chip filter but leaves the name/place search
  // and viewport alone (the search field has its own clear).
  const onClearFilters = useCallback(() => {
    setAppliedFilter((previous) => clearWallFinderChipFilters(previous));
  }, []);

  const closeScreen = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo(boardReturnTo);
  }, [router, boardReturnTo]);

  // The map mounts once there is somewhere to look: a fix, a city, or location
  // settled as off (then it opens on the whole world). Once up it stays up, so
  // dropping a city flies the camera instead of tearing the map down.
  const locationOff = location.status === 'denied' || location.status === 'unavailable';
  const [mapMounted, setMapMounted] = useState(false);
  const showMap = mapMounted || center !== null || locationOff;
  // A map that opened without a fix flies to the climber once one arrives.
  const mapOpenedWithoutFixRef = useRef(false);
  useEffect(() => {
    if (!showMap || mapMounted) return;
    mapOpenedWithoutFixRef.current = center === null;
    setMapMounted(true);
  }, [showMap, mapMounted, center]);
  useEffect(() => {
    if (!location.coords || !mapOpenedWithoutFixRef.current || viewCenterRef.current !== null) return;
    mapOpenedWithoutFixRef.current = false;
    moveCameraTo(location.coords);
  }, [location.coords, moveCameraTo]);

  const hasNameFilter = Boolean(appliedFilter.name?.trim());

  return {
    location,
    center,
    // map
    mapRef,
    showMap,
    mapAvailable,
    mapAttempt,
    markers,
    selectedId,
    handleRegionChange,
    onMarkerPress,
    handleMapUnavailable,
    handleMapReady,
    retryMap,
    // list
    rows,
    onPressGym,
    activate,
    onEditBoard,
    onEditGym,
    onClaimGym,
    onOpenGym,
    // search
    inputText,
    searchLabel,
    isGeocoding,
    onChangeSearchText,
    onSubmitSearch,
    onSelectPlace,
    clearSearch,
    isUpdating,
    refreshFailed,
    retrySearch,
    // filters: only meaningful once there is a place to query
    filtersShown: center !== null || hasNameFilter,
    appliedFilter,
    layoutOptions,
    sizeOptions,
    onToggleBoardType,
    onToggleLayout,
    onToggleSize,
    onToggleMultiBoardType,
    onClearFilters,
    // nowhere to look yet: the location prompt stands in for the list
    locationPromptShown: center === null && !hasNameFilter,
    // claim
    claimTargetGym,
    claimSheetRef,
    onClaimSheetClosed,
    closeScreen,
  };
}

export type GymFinder = ReturnType<typeof useGymFinder>;
