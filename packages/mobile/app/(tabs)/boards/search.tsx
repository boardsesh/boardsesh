import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, TextInput, StyleSheet, Platform, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useSetActiveBoard } from '../../../src/lib/graphql/use-active-board';
import { useSearchBoardsMap } from '../../../src/lib/graphql/use-search-boards-map';
import { useDeviceLocation } from '../../../src/lib/use-device-location';
import { useToast } from '../../../src/providers/toast-provider';
import { useTheme } from '../../../src/providers/theme-provider';
import { hapticSelection } from '../../../src/lib/haptics';
import { Text } from '../../../src/components/Text';
import { Icon } from '../../../src/components/Icon';
import { BoardCarousel } from '../../../src/components/board-discovery/BoardCarousel';
import { BoardDetailSheet } from '../../../src/components/board-discovery/BoardDetailSheet';
import { userBoardToItem } from '../../../src/components/board-discovery/board-items';
import type { DiscoveryBoardItem } from '../../../src/components/board-discovery/BoardDiscoveryCard';
import { brandColors } from '../../../src/theme/colors';
import { spacing, borderRadius } from '../../../src/theme/tokens';

// Lazy/guarded expo-maps load: it's a native module, so a JS-only OTA push to a
// build that predates it would otherwise throw at import. We resolve the
// platform map view at module scope and fall back to a "needs an app update"
// placeholder when it's unavailable — search-by-text still works without a map.
type MapModule = typeof import('expo-maps');
let expoMaps: MapModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  expoMaps = require('expo-maps') as MapModule;
} catch {
  expoMaps = null;
}

// Neutral world view until the user's location resolves (mirrors web defaults).
const DEFAULT_CENTER = { latitude: 20, longitude: 0 };
const DEFAULT_ZOOM = 3;
const NEARBY_ZOOM = 11;

// iOS → Apple Maps (no API key); Android → Google Maps (env-supplied key).
// Resolved at module scope: Platform.OS is constant for the process lifetime,
// so there's no value in re-checking on every render — and a stable MapView
// reference helps the markers memo below avoid spurious invalidations.
const isApple = Platform.OS === 'ios';
const MapView = isApple ? expoMaps?.AppleMaps.View : expoMaps?.GoogleMaps.View;

type Camera = { latitude: number; longitude: number; zoom: number };

export default function BoardSearchScreen() {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const setActiveBoard = useSetActiveBoard();

  const location = useDeviceLocation();
  const requestLocation = location.request;
  const [query, setQuery] = useState('');
  const [camera, setCamera] = useState<Camera>({ ...DEFAULT_CENTER, zoom: DEFAULT_ZOOM });
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  // Camera updates we push programmatically (recenter / locate) — fed to the
  // map's cameraPosition without echoing back through onCameraMove.
  const [cameraTarget, setCameraTarget] = useState<Camera>({ ...DEFAULT_CENTER, zoom: DEFAULT_ZOOM });
  // Until the user's location resolves OR they pan the map, the camera is just
  // the neutral default (20,0) — searching by those coordinates would fire a
  // wrong query near the equator (web flags the same as a footgun). Gate the
  // location-based search on a real viewport; text search works regardless.
  const [hasRealViewport, setHasRealViewport] = useState(false);

  // Ask for location on mount; center on the user once we have a fix.
  useEffect(() => {
    void requestLocation();
  }, [requestLocation]);
  useEffect(() => {
    if (location.coords) {
      const next = { ...location.coords, zoom: NEARBY_ZOOM };
      setCamera(next);
      setCameraTarget(next);
      setHasRealViewport(true);
    }
  }, [location.coords]);

  const { boards } = useSearchBoardsMap({
    query,
    latitude: hasRealViewport ? camera.latitude : null,
    longitude: hasRealViewport ? camera.longitude : null,
    zoom: camera.zoom,
    enabled: true,
  });

  // Only boards with real coordinates get a pin.
  const pinned = useMemo(() => boards.filter((b) => b.latitude != null && b.longitude != null), [boards]);

  const items = useMemo(
    () =>
      boards
        .map((b) => userBoardToItem(b))
        .filter((item): item is DiscoveryBoardItem => item !== null)
        .map((item) => ({ ...item, isActive: item.key === selectedUuid })),
    [boards, selectedUuid],
  );

  // The selected board drives both the pin recolour and the detail sheet.
  // Detail is a sheet *over* the live map — never a pushed screen — because
  // expo-maps crashes when its view is unmounted from a backgrounded stack.
  const selectedBoard = useMemo(() => boards.find((b) => b.uuid === selectedUuid) ?? null, [boards, selectedUuid]);

  const openBoardDetail = useCallback((uuid: string) => {
    hapticSelection();
    setSelectedUuid(uuid);
  }, []);

  const onSelectItem = useCallback((item: DiscoveryBoardItem) => openBoardDetail(item.key), [openBoardDetail]);

  // Tapping a pin recolours it and opens its detail sheet (no recenter — keep
  // the map exactly where it is so closing the sheet returns to the same view).
  const onMarkerClick = useCallback((uuid: string) => openBoardDetail(uuid), [openBoardDetail]);

  const handleSetActive = useCallback(
    async (board: UserBoard) => {
      try {
        await setActiveBoard(board);
        // Only close the sheet once the board is saved — if it throws, the
        // sheet stays open so the error toast has visible context.
        setSelectedUuid(null);
        // router.back() is the same foreground unmount the X button uses —
        // proven safe for expo-maps — then switch to the climbs tab.
        router.back();
        router.navigate('/(tabs)/climbs');
      } catch {
        showToast(t('mobile.boardSwitchError'), 'error');
      }
    },
    [setActiveBoard, router, showToast, t],
  );

  // Memoised so the native MapView doesn't re-bind the handler every render.
  // A user-driven move means the viewport is real — start searching by it.
  const onCameraMove = useCallback(
    (event: { coordinates: { latitude?: number; longitude?: number }; zoom: number }) => {
      const { latitude, longitude } = event.coordinates;
      if (latitude == null || longitude == null) return;
      setCamera({ latitude, longitude, zoom: event.zoom });
      setHasRealViewport(true);
    },
    [],
  );

  // Apple markers take an SF Symbol + tint (so the selected pin recolours);
  // Google markers only share id/coordinates/title — pass just those there.
  // Memoised on [pinned, selectedUuid]: any other render must NOT produce a new
  // array reference, or expo-maps will redraw all annotations on every pan
  // (this was the source of the visible flicker on scroll).
  const markers = useMemo(
    () =>
      pinned.map((board) => {
        const base = {
          id: board.uuid,
          coordinates: { latitude: board.latitude as number, longitude: board.longitude as number },
          title: board.name,
        };
        return isApple
          ? {
              ...base,
              systemImage: 'mappin.circle.fill',
              tintColor: board.uuid === selectedUuid ? brandColors.primary : brandColors.success,
            }
          : base;
      }),
    [pinned, selectedUuid],
  );

  const searchField = (
    <View
      style={[styles.searchField, { backgroundColor: systemColors.secondaryBackground, top: insets.top + spacing[2] }]}
    >
      <Icon name="search" size={18} color={systemColors.secondaryLabel} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t('mobile.search.placeholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        style={[styles.searchInput, { color: systemColors.label }]}
        autoCorrect={false}
        returnKeyType="search"
      />
      <Pressable onPress={() => router.back()} hitSlop={8}>
        <Icon name="close" size={20} color={systemColors.secondaryLabel} />
      </Pressable>
    </View>
  );

  const resultStrip =
    items.length > 0 ? (
      <View style={[styles.resultStrip, { paddingBottom: insets.bottom + spacing[3] }]}>
        <BoardCarousel items={items} onSelect={onSelectItem} />
      </View>
    ) : null;

  const detailSheet = selectedBoard ? (
    <BoardDetailSheet
      board={selectedBoard}
      onClose={() => setSelectedUuid(null)}
      onSetActive={handleSetActive}
    />
  ) : null;

  // expo-maps unavailable (pre-build client): show a placeholder but keep the
  // search field + results list working so the feature degrades, not crashes.
  if (!expoMaps || !MapView) {
    return (
      <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
        {searchField}
        <View style={styles.mapUnavailable}>
          <Icon name="location" size={40} color={systemColors.tertiaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.mapUnavailableText}>
            {t('mobile.search.mapUnavailable')}
          </Text>
        </View>
        {resultStrip}
        {detailSheet}
      </View>
    );
  }

  const cameraPosition = {
    coordinates: { latitude: cameraTarget.latitude, longitude: cameraTarget.longitude },
    zoom: cameraTarget.zoom,
  };

  return (
    <View style={styles.flex}>
      <MapView
        style={styles.flex}
        cameraPosition={cameraPosition}
        markers={markers}
        onCameraMove={onCameraMove}
        onMarkerClick={(marker: { id?: string }) => marker.id && onMarkerClick(marker.id)}
      />
      {searchField}
      {resultStrip}
      {detailSheet}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  searchField: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    height: 44,
    borderRadius: borderRadius.lg,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.12, shadowRadius: 6 },
      android: { elevation: 4 },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  resultStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  mapUnavailable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[6],
  },
  mapUnavailableText: {
    textAlign: 'center',
  },
});
