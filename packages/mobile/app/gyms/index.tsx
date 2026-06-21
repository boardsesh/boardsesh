import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useNearbyBoards, useNearbyGyms } from '../../src/lib/graphql/hooks';
import { useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useDeviceLocation, type Coords } from '../../src/lib/use-device-location';
import { useGeocodePlace } from '../../src/lib/use-place-search';
import { useToast } from '../../src/providers/toast-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { GymMap, type GymMapHandle, type GymMapMarker } from '../../src/components/gym-directory/GymMap';
import { spacing, borderRadius, shadows } from '../../src/theme/tokens';

// How long the camera must be still after a pan before we re-query the new
// viewport, and how far it must have moved to bother. The radius queried is
// 50km, so a sub-~4km nudge isn't worth a refetch — and the threshold also
// absorbs the programmatic camera settle after a place search so it doesn't
// read as a user pan.
const REGION_DEBOUNCE_MS = 500;
const MIN_MOVE_DEG = 0.04;

// The floating close button is a fixed square; the "Showing <place>" pill aligns
// under the search field by clearing the button + the row gap.
const CLOSE_BUTTON_SIZE = 44;

function movedEnough(a: Coords, b: Coords): boolean {
  const dLat = a.latitude - b.latitude;
  const dLng = a.longitude - b.longitude;
  return dLat * dLat + dLng * dLng >= MIN_MOVE_DEG * MIN_MOVE_DEG;
}

/**
 * Gym-first board discovery: a full-screen map with a draggable gym list sheet.
 * The floating search bar geocodes a typed place ("Blackheath NSW") so you can
 * browse anywhere — not just your GPS fix — and the same text filters gyms/boards
 * by name. Panning the map re-queries gyms for the new viewport (debounced, with
 * the previous results kept on screen so pins/list don't flicker). The list is
 * the primary interaction, so the flow still works where the native map is blank
 * (Android without a Google Maps key). Selecting a board makes it active.
 */
export default function GymDiscovery() {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const location = useDeviceLocation();
  const { geocode, isGeocoding } = useGeocodePlace();
  const setActiveBoard = useSetActiveBoard();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const boardReturnTo = resolveBoardReturnTo(returnTo);
  const [expandedGymUuid, setExpandedGymUuid] = useState<string | null>(null);
  const mapRef = useRef<GymMapHandle>(null);

  // `inputText` is the field; `query` is the applied name filter sent to the
  // backend; `viewCenter` is the authoritative map/query center (a searched place
  // or a panned location); `searchLabel` drives the "Showing X" caption. Both
  // filters apply on submit so typing doesn't fire a request per keystroke.
  const [inputText, setInputText] = useState('');
  const [query, setQuery] = useState('');
  const [viewCenter, setViewCenter] = useState<Coords | null>(null);
  const [searchLabel, setSearchLabel] = useState<string | null>(null);

  // A chosen view (searched or panned) wins; fall back to the device fix.
  const center = viewCenter ?? location.coords;

  // Stable sheet chrome styles so they don't allocate a new object each render.
  const sheetBackgroundStyle = useMemo(
    () => ({ backgroundColor: systemColors.secondaryBackground }),
    [systemColors.secondaryBackground],
  );
  const sheetHandleStyle = useMemo(
    () => ({ backgroundColor: systemColors.tertiaryLabel }),
    [systemColors.tertiaryLabel],
  );
  // Clear the home indicator / gesture bar at the bottom of the list.
  const listContentStyle = useMemo(() => [styles.list, { paddingBottom: insets.bottom + spacing[6] }], [insets.bottom]);

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

  const { data: gymConnection, isLoading: gymsLoading } = useNearbyGyms(center, 50, query);
  const { data: boardConnection } = useNearbyBoards(center, 50, query, 50);

  const gyms = useMemo(
    () => (gymConnection?.gyms ?? []).filter((gym) => gym.latitude != null && gym.longitude != null),
    [gymConnection?.gyms],
  );
  const boards = boardConnection?.boards ?? [];

  // Boards not attached to a gym still deserve discovery — surface them as their
  // own pins + list section so consolidating onto the gym map loses nothing.
  const standaloneBoards = useMemo(
    () => boards.filter((board) => board.gymUuid == null && board.latitude != null && board.longitude != null),
    [boards],
  );

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

  const boardsForGym = useCallback((gymUuid: string) => boards.filter((board) => board.gymUuid === gymUuid), [boards]);

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
      } catch {
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [setActiveBoard, router, boardReturnTo, showToast, t],
  );

  // One bar, two jobs: if the text resolves to a place, relocate there and show
  // everything nearby; otherwise treat it as a name filter at the current spot.
  // We deliberately don't AND the two — a place name ("Tokyo") would otherwise
  // hide every gym not literally named after it.
  const onSubmitSearch = useCallback(async () => {
    const text = inputText.trim();
    setExpandedGymUuid(null);
    if (!text) {
      setSearchLabel(null);
      setQuery('');
      return;
    }
    const coords = await geocode(text);
    if (coords) {
      setViewCenter(coords);
      setSearchLabel(text);
      setQuery('');
      moveCameraTo(coords);
    } else {
      setQuery(text);
    }
  }, [inputText, geocode, moveCameraTo]);

  // Clear everything and snap back to the device location.
  const clearSearch = useCallback(() => {
    setInputText('');
    setQuery('');
    setSearchLabel(null);
    setViewCenter(null);
    setExpandedGymUuid(null);
    const deviceCoords = locationCoordsRef.current;
    if (deviceCoords) moveCameraTo(deviceCoords);
  }, [moveCameraTo]);

  const closeScreen = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo(boardReturnTo);
  }, [router, boardReturnTo]);

  const closeButton = (
    <Pressable
      onPress={closeScreen}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('mobile.gyms.closeMap')}
      style={[styles.closeButton, shadows.sm, { backgroundColor: systemColors.secondaryBackground }]}
    >
      <Icon name="close" size={20} color={systemColors.label} />
    </Pressable>
  );

  const searchField = (
    <View style={[styles.searchField, shadows.sm, { backgroundColor: systemColors.secondaryBackground }]}>
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

  // Floating top chrome over the map: close button + search field + place caption.
  // `box-none` lets pans land on the map in the gaps around the controls.
  const topBar = (
    <View style={[styles.topBar, { paddingTop: insets.top + spacing[2] }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        {closeButton}
        <View style={styles.searchColumn}>{searchField}</View>
      </View>
      {searchLabel ? (
        <View style={[styles.placePill, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.gyms.showingPlace', { place: searchLabel })}
          </Text>
        </View>
      ) : null}
    </View>
  );

  // The root stack hides headers globally; this screen draws its own floating
  // top bar over the map. The title is kept for the back/breadcrumb affordance.
  const screen = <Stack.Screen options={{ title: t('mobile.gyms.title') }} />;

  // No place to show yet: prompt for location (the search bar above still works
  // for browsing a typed place without granting it).
  if (!center) {
    const waiting = location.status === 'idle' || location.status === 'loading';
    return (
      <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
        {screen}
        {topBar}
        <View style={styles.center}>
          {waiting ? (
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
                // After a denial the one-shot hook won't re-prompt (iOS only
                // asks once), so send the user to Settings instead of a no-op.
                onPress={() => {
                  if (location.status === 'denied') {
                    void Linking.openSettings();
                  } else {
                    void location.request();
                  }
                }}
                style={styles.centerButton}
              />
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {screen}
      <GymMap
        ref={mapRef}
        center={center}
        markers={markers}
        onRegionChange={handleRegionChange}
        style={StyleSheet.absoluteFill}
      />

      <BottomSheet
        index={1}
        snapPoints={SNAP_POINTS}
        enablePanDownToClose={false}
        backgroundStyle={sheetBackgroundStyle}
        handleIndicatorStyle={sheetHandleStyle}
      >
        <BottomSheetScrollView contentContainerStyle={listContentStyle} showsVerticalScrollIndicator={false}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
            {t('mobile.gyms.subtitle')}
          </Text>

          {gymsLoading && gyms.length === 0 ? <ActivityIndicator style={styles.listSpinner} /> : null}

          {!gymsLoading && gyms.length === 0 ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.empty}>
              {t('mobile.gyms.empty')}
            </Text>
          ) : null}

          {gyms.map((gym) => {
            const expanded = expandedGymUuid === gym.uuid;
            const gymBoards = boardsForGym(gym.uuid);
            return (
              <View key={gym.uuid} style={[styles.gymBlock, { borderColor: systemColors.separator }]}>
                <Pressable onPress={() => setExpandedGymUuid(expanded ? null : gym.uuid)} style={styles.gymRow}>
                  <Icon name="pin" size={20} color={systemColors.label} />
                  <View style={styles.gymText}>
                    <Text variant="headline">{gym.name}</Text>
                    <Text variant="subheadline" color={systemColors.secondaryLabel}>
                      {gym.address ?? t('mobile.gyms.boardCount', { count: gym.boardCount ?? gymBoards.length })}
                    </Text>
                  </View>
                  <Icon name={expanded ? 'minus' : 'add'} size={20} color={systemColors.tertiaryLabel} />
                </Pressable>

                {expanded ? (
                  gymBoards.length > 0 ? (
                    gymBoards.map((board) => (
                      <Pressable
                        key={board.uuid}
                        onPress={() => void activate(board)}
                        style={[styles.boardRow, { borderTopColor: systemColors.separator }]}
                      >
                        <Icon name="boards" size={18} color={systemColors.secondaryLabel} />
                        <View style={styles.gymText}>
                          <Text variant="subheadline">{board.name}</Text>
                          <Text variant="caption1" color={systemColors.tertiaryLabel}>
                            {board.boardType}
                          </Text>
                        </View>
                      </Pressable>
                    ))
                  ) : (
                    <Text variant="caption1" color={systemColors.tertiaryLabel} style={styles.noBoards}>
                      {t('mobile.gyms.noBoards')}
                    </Text>
                  )
                ) : null}
              </View>
            );
          })}

          {standaloneBoards.length > 0 ? (
            <>
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
                {t('mobile.gyms.otherBoardsTitle')}
              </Text>
              {standaloneBoards.map((board) => (
                <Pressable
                  key={board.uuid}
                  onPress={() => void activate(board)}
                  style={[styles.gymBlock, styles.standaloneRow, { borderColor: systemColors.separator }]}
                >
                  <Icon name="boards" size={20} color={systemColors.label} />
                  <View style={styles.gymText}>
                    <Text variant="headline">{board.name}</Text>
                    <Text variant="subheadline" color={systemColors.secondaryLabel}>
                      {board.locationName ?? board.boardType}
                    </Text>
                  </View>
                  <Icon name="chevron.right" size={18} color={systemColors.tertiaryLabel} />
                </Pressable>
              ))}
            </>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>

      {topBar}
    </View>
  );
}

// Drag the sheet down to ~a quarter to see a big map; mid is the default; up
// covers most of the screen for browsing a long list.
const SNAP_POINTS = ['25%', '55%', '90%'];

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    gap: spacing[2],
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  searchColumn: {
    flex: 1,
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
    marginLeft: CLOSE_BUTTON_SIZE + spacing[2],
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    padding: spacing[6],
  },
  centerText: {
    textAlign: 'center',
  },
  centerButton: {
    marginTop: spacing[2],
  },
  list: {
    padding: spacing[4],
    gap: spacing[2],
  },
  sectionLabel: {
    textTransform: 'uppercase',
    marginBottom: spacing[1],
    marginTop: spacing[2],
  },
  listSpinner: {
    marginTop: spacing[4],
  },
  empty: {
    marginTop: spacing[4],
    textAlign: 'center',
  },
  gymBlock: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  gymRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
  },
  gymText: {
    flex: 1,
  },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    paddingLeft: spacing[6],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  standaloneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
  },
  noBoards: {
    paddingHorizontal: spacing[3],
    paddingBottom: spacing[3],
    paddingLeft: spacing[6],
  },
});
