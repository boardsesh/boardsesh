import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName, Gym, UserBoard } from '@boardsesh/shared-schema';
import { useNearbyBoards, useNearbyGyms } from '../../src/lib/graphql/hooks';
import { useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAdoptFoundBoard } from '../../src/lib/board-discovery/use-adopt-found-board';
import { useDeviceLocation, type Coords } from '../../src/lib/use-device-location';
import { useGeocodePlace } from '../../src/lib/use-place-search';
import { useToast } from '../../src/providers/toast-provider';
import { useTheme } from '../../src/providers/theme-provider';
import type { ManagedSheetHandle } from '../../src/providers/sheet-presentation-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { GymMap, type GymMapHandle, type GymMapMarker } from '../../src/components/gym-directory/GymMap';
import { GymListPanel, type GymListPanelHandle } from '../../src/components/gym-directory/GymListPanel';
import { ClaimGymSheet } from '../../src/components/gym-directory/ClaimGymSheet';
import { WallFinderFilterChips } from '../../src/components/gym-directory/WallFinderFilterChips';
import { buildGymListRows } from '../../src/components/gym-directory/gym-list-rows';
import {
  DEFAULT_WALL_FINDER_FILTER,
  buildLayoutOptions,
  buildSizeOptions,
  clearWallFinderChipFilters,
  toggleBoardTypeFilter,
  toggleLayoutFilter,
  toggleMultiBoardTypeFilter,
  toggleSizeFilter,
  type WallFinderFilter,
} from '../../src/lib/wall-finder-filter';
import { spacing, borderRadius, shadows } from '../../src/theme/tokens';

// How long the camera must be still after a pan before we re-query the new
// viewport, and how far it must have moved to bother. The radius queried is
// 50km, so a sub-~4km nudge isn't worth a refetch — and the threshold also
// absorbs the programmatic camera settle after a place search so it doesn't
// read as a user pan.
const REGION_DEBOUNCE_MS = 500;
const MIN_MOVE_DEG = 0.04;

// The floating close button is a fixed square; it's the only chrome left over the
// map now that search lives in the panel header.
const CLOSE_BUTTON_SIZE = 44;

function movedEnough(a: Coords, b: Coords): boolean {
  const dLat = a.latitude - b.latitude;
  const dLng = a.longitude - b.longitude;
  return dLat * dLat + dLng * dLng >= MIN_MOVE_DEG * MIN_MOVE_DEG;
}

/**
 * Gym-first board discovery: a full-screen map with a NON-MODAL draggable gym
 * panel pinned over it. The panel is a plain sibling (no scrim), so the uncovered
 * map above it stays pannable — panning re-queries gyms for the new viewport
 * (debounced, previous results kept so pins/list don't flicker). The search field
 * lives in the panel header: a typed place ("Blackheath NSW") geocodes and
 * relocates the map; otherwise the text filters gyms/boards by name. The list is
 * the primary interaction, so the flow works even where the native map is blank.
 * Selecting a board makes it active.
 */
export default function GymDiscovery() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const { systemColors, brandColors } = useTheme();
  const insets = useSafeAreaInsets();
  const location = useDeviceLocation();
  const { geocode, isGeocoding } = useGeocodePlace();
  const setActiveBoard = useSetActiveBoard();
  const adoptFoundBoard = useAdoptFoundBoard();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  const [expandedGymUuid, setExpandedGymUuid] = useState<string | null>(null);
  // The selected gym/board mirrors the map pin and drives the row accent. Set by a
  // row tap (→ recenter the map) or a pin tap (→ scroll the row into view).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // When the native map can't render at all, lay out as a list-only surface.
  const [mapAvailable, setMapAvailable] = useState(true);
  const mapRef = useRef<GymMapHandle>(null);
  const panelRef = useRef<GymListPanelHandle>(null);
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
  const [appliedFilter, setAppliedFilter] = useState<WallFinderFilter>(DEFAULT_WALL_FINDER_FILTER);
  const [viewCenter, setViewCenter] = useState<Coords | null>(null);
  const [searchLabel, setSearchLabel] = useState<string | null>(null);

  // A chosen view (searched or panned) wins; fall back to the device fix.
  const center = viewCenter ?? location.coords;

  // Refs mirror state so the stable, debounced region handler reads fresh values
  // without being torn down and rebuilt on every pan.
  const viewCenterRef = useRef(viewCenter);
  viewCenterRef.current = viewCenter;
  const locationCoordsRef = useRef(location.coords);
  locationCoordsRef.current = location.coords;
  // The target of the last programmatic camera move (place search / reset). The
  // resulting onCameraMove settle near this point must NOT be read as a user pan.
  const programmaticTargetRef = useRef<Coords | null>(null);
  const regionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ask for location once on mount — the map + nearby queries default to it.
  // Read `request` through a ref so this fires exactly once (the hook is
  // one-shot); a typed place search works even if the user denies location.
  const requestLocationRef = useRef(location.request);
  requestLocationRef.current = location.request;
  useEffect(() => {
    void requestLocationRef.current();
  }, []);

  useEffect(
    () => () => {
      if (regionTimerRef.current) clearTimeout(regionTimerRef.current);
    },
    [],
  );

  const { data: gymConnection, isLoading: gymsLoading } = useNearbyGyms(
    center,
    50,
    appliedFilter.name,
    appliedFilter.boardTypes,
    appliedFilter.layoutIds,
    appliedFilter.sizeIds,
    appliedFilter.multiBoardTypeOnly,
  );
  const { data: boardConnection } = useNearbyBoards(
    center,
    50,
    appliedFilter.name,
    50,
    appliedFilter.boardTypes,
    appliedFilter.layoutIds,
    appliedFilter.sizeIds,
  );

  const gyms = useMemo(
    () => (gymConnection?.gyms ?? []).filter((gym) => gym.latitude != null && gym.longitude != null),
    [gymConnection?.gyms],
  );
  const boards = useMemo(() => boardConnection?.boards ?? [], [boardConnection?.boards]);

  // Boards not attached to a gym still deserve discovery — surface them as their
  // own pins + list section so consolidating onto the gym map loses nothing.
  // The "2+ board types" filter is about gyms, and a standalone board can't have
  // two types, so hide the section entirely while it's on.
  const standaloneBoards = useMemo(
    () =>
      appliedFilter.multiBoardTypeOnly
        ? []
        : boards.filter((board) => board.gymUuid == null && board.latitude != null && board.longitude != null),
    [boards, appliedFilter.multiBoardTypeOnly],
  );

  // Pre-index a gym's boards ONCE per data change (O(1) per row, never a per-row
  // filter scan that FlashList recycling would re-run).
  const boardsByGym = useMemo(() => {
    const map = new Map<string, UserBoard[]>();
    for (const board of boards) {
      if (board.gymUuid == null) continue;
      const existing = map.get(board.gymUuid);
      if (existing) existing.push(board);
      else map.set(board.gymUuid, [board]);
    }
    return map;
  }, [boards]);

  const markers = useMemo<GymMapMarker[]>(
    () => [
      ...gyms.map((gym) => ({
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

  const rows = useMemo(
    () =>
      buildGymListRows({
        gyms,
        boardsByGym,
        standaloneBoards,
        expandedGymUuid,
        selectedId,
        gymsLoading,
        labels: {
          gymsSection: t('mobile.gyms.subtitle'),
          otherBoards: t('mobile.gyms.otherBoardsTitle'),
          empty: t('mobile.gyms.empty'),
          boardCount: (count: number) => t('mobile.gyms.boardCount', { count }),
        },
      }),
    [gyms, boardsByGym, standaloneBoards, expandedGymUuid, selectedId, gymsLoading, t],
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

  // Debounced: after the map stops moving, decide whether it was a real user pan
  // (re-query that area) or just the settle from a programmatic move (ignore).
  const handleRegionChange = useCallback((next: Coords) => {
    if (regionTimerRef.current) clearTimeout(regionTimerRef.current);
    regionTimerRef.current = setTimeout(() => {
      const target = programmaticTargetRef.current;
      if (target && !movedEnough(next, target)) {
        programmaticTargetRef.current = null;
        return; // the camera just settled where we sent it
      }
      const effective = viewCenterRef.current ?? locationCoordsRef.current;
      if (effective && !movedEnough(next, effective)) return; // tiny nudge / mount echo
      programmaticTargetRef.current = null;
      // A real pan takes over: this is now where we're browsing, so drop any
      // "Showing <place>" label and re-query around the new center.
      setViewCenter(next);
      setSearchLabel(null);
    }, REGION_DEBOUNCE_MS);
  }, []);

  const activate = useCallback(
    async (board: UserBoard) => {
      hapticSelection();
      try {
        await setActiveBoard(board);
        router.dismissTo(boardReturnTo);
        // Follow the board (so it lands in My Boards) and offer to make it available
        // offline. Fire-and-forget after navigating — the follow is idempotent and the
        // offline confirm rides the root dialog, which survives the dismiss. Its own
        // errors are handled inside (follow onError toast); they intentionally don't
        // reach this catch, which is only for the board-switch write above.
        void adoptFoundBoard(board);
      } catch {
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [setActiveBoard, adoptFoundBoard, router, boardReturnTo, showToast, t],
  );

  // Edit a board / gym the viewer can edit (the row only renders the pencil when
  // `canEdit`). The board editor already loads any board by uuid and unlocks its
  // config for moderators; the gym editor is the new gyms/edit screen.
  const onEditBoard = useCallback(
    (board: UserBoard) => {
      hapticSelection();
      router.push({ pathname: '/boards/edit', params: { boardUuid: board.uuid } });
    },
    [router],
  );

  const onEditGym = useCallback(
    (gym: Gym) => {
      hapticSelection();
      router.push({ pathname: '/gyms/edit', params: { gymUuid: gym.uuid } });
    },
    [router],
  );

  // Start an ownership claim from an expanded gym row (reaches the non-editor
  // owner the edit-screen entry can't). Stash the target; the effect below
  // presents once the per-target sheet has mounted.
  const onClaimGym = useCallback((gym: Gym) => {
    hapticSelection();
    setClaimTargetGym(gym);
  }, []);

  useEffect(() => {
    if (claimTargetGym) claimSheetRef.current?.present();
  }, [claimTargetGym]);

  const onClaimSheetClosed = useCallback(() => setClaimTargetGym(null), []);

  // Tap/expand a gym row: toggle its boards, select it, and recenter the map on it
  // (no-op when the map is blank — the row just expands).
  const onPressGym = useCallback(
    (gym: Gym) => {
      setExpandedGymUuid((prev) => (prev === gym.uuid ? null : gym.uuid));
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

  // Tap a map pin: select it, scroll its row into view, expand it if it's a gym,
  // and nudge the panel up from the Low detent so the row is visible. Pure
  // map→list polish — every selection is also reachable by scrolling the list.
  const onMarkerPress = useCallback((id: string) => {
    setSelectedId(id);
    const isGym = gymsRef.current.some((gym) => gym.uuid === id);
    if (isGym) setExpandedGymUuid(id);
    panelRef.current?.ensureVisible();
    panelRef.current?.scrollToRowKey(isGym ? `gym:${id}` : `std:${id}`);
  }, []);

  const handleMapUnavailable = useCallback(() => setMapAvailable(false), []);

  // Once we learn the native map can't render, bias the panel up to its full-list
  // detent — a half-height list over a blank background reads as broken.
  useEffect(() => {
    if (!mapAvailable) panelRef.current?.snapTo('high');
  }, [mapAvailable]);

  // One bar, two jobs: if the text resolves to a place, relocate there and show
  // everything nearby; otherwise treat it as a name filter at the current spot.
  // We deliberately don't AND the two — a place name ("Tokyo") would otherwise
  // hide every gym not literally named after it.
  const onSubmitSearch = useCallback(async () => {
    const text = inputText.trim();
    setExpandedGymUuid(null);
    setSelectedId(null);
    if (!text) {
      setSearchLabel(null);
      setAppliedFilter(DEFAULT_WALL_FINDER_FILTER);
      return;
    }
    const coords = await geocode(text);
    if (coords) {
      setViewCenter(coords);
      setSearchLabel(text);
      setAppliedFilter(DEFAULT_WALL_FINDER_FILTER);
      moveCameraTo(coords);
    } else {
      setAppliedFilter({ name: text });
    }
  }, [inputText, geocode, moveCameraTo]);

  // Clear everything and snap back to the device location.
  const clearSearch = useCallback(() => {
    setInputText('');
    setAppliedFilter(DEFAULT_WALL_FINDER_FILTER);
    setSearchLabel(null);
    setViewCenter(null);
    setExpandedGymUuid(null);
    setSelectedId(null);
    const deviceCoords = locationCoordsRef.current;
    if (deviceCoords) moveCameraTo(deviceCoords);
  }, [moveCameraTo]);

  // Chip toggles apply immediately (they re-query via the hooks' query keys) and
  // are orthogonal to a place search (a place relocates, it isn't a filter term).
  // The nested-tier clearing (layouts are board-type-scoped, sizes are
  // layout-scoped) lives in the pure helpers so it stays unit-testable.
  const onToggleBoardType = useCallback((boardType: BoardName) => {
    setAppliedFilter((prev) => toggleBoardTypeFilter(prev, boardType));
  }, []);

  const onToggleLayout = useCallback((layoutId: number) => {
    setAppliedFilter((prev) => toggleLayoutFilter(prev, layoutId));
  }, []);

  const onToggleSize = useCallback((sizeIds: number[]) => {
    setAppliedFilter((prev) => toggleSizeFilter(prev, sizeIds));
  }, []);

  const onToggleMultiBoardType = useCallback(() => {
    setAppliedFilter((prev) => toggleMultiBoardTypeFilter(prev));
  }, []);

  // The chip-row "Clear" wipes every chip filter but leaves the name/place search
  // and viewport alone (the search field has its own clear).
  const onClearFilters = useCallback(() => {
    setAppliedFilter((prev) => clearWallFinderChipFilters(prev));
  }, []);

  const closeScreen = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo(boardReturnTo);
  }, [router, boardReturnTo]);

  // Filter chips live in the panel header. Only meaningful once we have a place
  // to query, so hide them in the pre-location prompt state.
  const filterSlot = center ? (
    <WallFinderFilterChips
      selected={appliedFilter.boardTypes ?? []}
      onToggle={onToggleBoardType}
      multiBoardTypeOnly={appliedFilter.multiBoardTypeOnly ?? false}
      onToggleMultiBoardType={onToggleMultiBoardType}
      multiBoardLabel={t('mobile.gyms.multiBoardChip')}
      layoutOptions={layoutOptions}
      selectedLayoutIds={appliedFilter.layoutIds ?? []}
      onToggleLayout={onToggleLayout}
      sizeOptions={sizeOptions}
      selectedSizeIds={appliedFilter.sizeIds ?? []}
      onToggleSize={onToggleSize}
      onClear={onClearFilters}
    />
  ) : undefined;

  // The root stack hides headers globally; this screen draws its own floating
  // close button over the map. The title is kept for the back/breadcrumb affordance.
  const screen = <Stack.Screen options={{ title: t('mobile.gyms.title') }} />;

  // Floating close button over the map (the only chrome left over the map). `box-none`
  // on its wrapper lets map pans land in the gaps around it.
  const closeButton = (
    <View style={[styles.closeWrap, { paddingTop: insets.top + spacing[2] }]} pointerEvents="box-none">
      <Pressable
        onPress={closeScreen}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.gyms.closeMap')}
        style={[styles.closeButton, shadows.sm, { backgroundColor: systemColors.secondaryBackground }]}
      >
        <Icon name="close" size={20} color={systemColors.label} />
      </Pressable>
    </View>
  );

  // The search field, pinned in the panel header so it travels with the sheet and
  // survives a blank map.
  const searchField = (
    <View
      style={[styles.searchField, { backgroundColor: systemColors.background, borderColor: systemColors.separator }]}
    >
      <Icon name="search" size={18} color={systemColors.secondaryLabel} />
      <TextInput
        value={inputText}
        onChangeText={setInputText}
        onSubmitEditing={() => void onSubmitSearch()}
        placeholder={t('mobile.gyms.searchPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        style={[styles.searchInput, { color: systemColors.label }]}
        autoCorrect={false}
        returnKeyType="search"
      />
      {isGeocoding ? <ActivityIndicator /> : null}
      {inputText.length > 0 || searchLabel ? (
        <Pressable
          onPress={clearSearch}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.gyms.clearSearch')}
        >
          <Icon name="close" size={18} color={systemColors.secondaryLabel} />
        </Pressable>
      ) : null}
    </View>
  );

  const placeCaption = searchLabel ? (
    <View style={[styles.placePill, { backgroundColor: systemColors.background }]}>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {t('mobile.gyms.showingPlace', { place: searchLabel })}
      </Text>
    </View>
  ) : null;

  // No place to show yet: prompt for location inside the panel (the header search
  // still works for browsing a typed place without granting it).
  const waitingForLocation = location.status === 'idle' || location.status === 'loading';
  const locationPrompt = !center ? (
    waitingForLocation ? (
      <ActivityIndicator size="large" />
    ) : (
      <>
        <Icon name="location" size={40} color={systemColors.tertiaryLabel} />
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centerText}>
          {t('mobile.gyms.locationNeeded')}
        </Text>
        <Button
          title={t('mobile.gyms.grantLocation')}
          variant="outlined"
          // After a denial the one-shot hook won't re-prompt (iOS only asks once),
          // so send the user to Settings instead of a no-op.
          onPress={() => {
            if (location.status === 'denied') void Linking.openSettings();
            else void location.request();
          }}
          style={styles.centerButton}
        />
      </>
    )
  ) : undefined;

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {screen}
      {center ? (
        <GymMap
          ref={mapRef}
          center={center}
          markers={markers}
          onRegionChange={handleRegionChange}
          onMarkerPress={onMarkerPress}
          onMapUnavailable={handleMapUnavailable}
          selectedId={selectedId ?? undefined}
          selectedTint={brandColors.primary}
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      <GymListPanel
        ref={panelRef}
        data={rows}
        mapAvailable={mapAvailable}
        onPressGym={onPressGym}
        onActivateBoard={activate}
        onEditGym={onEditGym}
        onEditBoard={onEditBoard}
        onClaimGym={onClaimGym}
        noBoardsLabel={t('mobile.gyms.noBoards')}
        searchSlot={searchField}
        placeCaption={placeCaption}
        filterSlot={filterSlot}
        locationPrompt={locationPrompt}
      />

      {closeButton}

      {claimTargetGym ? (
        <ClaimGymSheet
          key={claimTargetGym.uuid}
          sheetRef={claimSheetRef}
          gym={claimTargetGym}
          onClosed={onClaimSheetClosed}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  closeWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    alignItems: 'flex-start',
  },
  closeButton: {
    width: CLOSE_BUTTON_SIZE,
    height: CLOSE_BUTTON_SIZE,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    height: 44,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  placePill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.full,
  },
  centerText: {
    textAlign: 'center',
  },
  centerButton: {
    marginTop: spacing[2],
  },
});
