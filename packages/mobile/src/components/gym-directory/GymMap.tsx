import {
  Component,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useAppColorScheme } from '../../providers/theme-provider';

export type GymMapMarker = {
  id: string;
  latitude: number;
  longitude: number;
  name: string;
};

type LatLng = { latitude: number; longitude: number };

/** Imperative handle so the screen can recenter the camera on a place search. */
export type GymMapHandle = {
  setCenter: (coords: LatLng) => void;
};

type GymMapProps = {
  center: LatLng;
  markers: GymMapMarker[];
  // Fired (already debounced upstream) when the user pans/zooms the map, so the
  // screen can re-query gyms for the new viewport.
  onRegionChange?: (center: LatLng) => void;
  // Fired with the marker id when a pin is tapped. Selection lives in the list, so
  // this is a map→list convenience (scroll to + expand the row), never a hard
  // dependency — the screen works the same when the map can't surface taps.
  onMarkerPress?: (id: string) => void;
  // The currently-selected marker id (mirrors the list selection). Tinted with
  // `selectedTint` where the platform supports a marker colour (Apple Maps).
  selectedId?: string;
  selectedTint?: string;
  // Fired once when the native map can't render at all (expo-maps module or the
  // platform view is absent, or a mount throw). The screen biases the panel
  // toward a list-only layout instead of peeking over a dead grey rectangle.
  onMapUnavailable?: () => void;
  style?: StyleProp<ViewStyle>;
};

// The slice of the native expo-maps view ref we use. Both AppleMaps.View and
// GoogleMaps.View expose `setCameraPosition`; typing it narrowly avoids leaking
// platform-specific handle types up to callers.
type NativeMapHandle = {
  setCameraPosition?: (config: { coordinates: LatLng; zoom?: number }) => void;
};

const DEFAULT_ZOOM = 10;

// Lazy-require so a native build that predates the expo-maps module degrades to
// "no map" instead of crashing. The gym list is the primary interaction, so a
// missing map is a soft loss.
let Maps: typeof import('expo-maps') | null = null;
try {
  Maps = require('expo-maps');
} catch {
  Maps = null;
}

/**
 * Catches a render/mount throw from the native map (e.g. the expo-maps native
 * view isn't linked in this build) so it degrades to no-map instead of taking
 * the whole gym screen down with a red box. Reports the loss via `onUnavailable`
 * so the screen can lay out as a list-only surface.
 */
class MapErrorBoundary extends Component<{ children: ReactNode; onUnavailable?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('[gym-map] native map unavailable, falling back to list-only:', error);
    this.props.onUnavailable?.();
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

const NativeGymMap = forwardRef<GymMapHandle, GymMapProps>(function NativeGymMap(
  { center, markers, onRegionChange, onMarkerPress, selectedId, selectedTint, onMapUnavailable, style },
  ref,
) {
  // Keep a ref to the native view so the imperative handle can drive the camera.
  const nativeRef = useRef<NativeMapHandle | null>(null);
  // The camera position is *initial-only*: capture the first center so parent
  // re-renders (and the panned query center) never snap the camera back while
  // the user is dragging. Search relocations go through the imperative handle.
  const initialCameraRef = useRef(center);

  useImperativeHandle(
    ref,
    () => ({
      setCenter: (coords: LatLng) => {
        nativeRef.current?.setCameraPosition?.({ coordinates: coords, zoom: DEFAULT_ZOOM });
      },
    }),
    [],
  );

  // A callback ref typed against `unknown` is assignable to either platform
  // view's ref slot (params are contravariant) without an explicit cast.
  const assignNativeRef = useCallback((instance: unknown) => {
    nativeRef.current = (instance as NativeMapHandle | null) ?? null;
  }, []);

  // Pinned to ONE of the two view types rather than left as a union: TypeScript
  // intersects a union component's props, and the two platforms declare separate
  // (identically-shaped) enums, so no platform-specific value — `colorScheme`
  // below — can satisfy both. Only props both views share are passed, and the
  // runtime view is still chosen per platform.
  const MapView = (Platform.OS === 'ios' ? Maps?.AppleMaps?.View : Maps?.GoogleMaps?.View) as
    | NonNullable<typeof Maps>['GoogleMaps']['View']
    | undefined;

  // Both platform views default to following the OS scheme, so a dark app on a
  // light-mode phone drew the light basemap — black place labels on a dark screen.
  // Drive it from the app-resolved scheme instead. Apple and Google each declare
  // their own `MapColorScheme` enum with the same members; read the one belonging
  // to the platform view we picked, off the same lazily-required module.
  // Read Google's enum to match the pinned view type above. Apple declares its own
  // with the same `LIGHT`/`DARK` members and identical string values, so the value
  // is valid for either native view. (Apple's default is already AUTOMATIC, which
  // follows the app; it is Google's FOLLOW_SYSTEM default that tracked the OS.)
  const MapColorScheme = Maps?.GoogleMaps?.MapColorScheme;
  const appColorScheme = useAppColorScheme();
  const mapColorScheme = appColorScheme === 'dark' ? MapColorScheme?.DARK : MapColorScheme?.LIGHT;

  // Report a missing native map exactly once (the module or platform view is
  // absent — e.g. a build without expo-maps). Read through a ref so the effect
  // stays mount-only and isn't torn down by a changing callback identity.
  const onMapUnavailableRef = useRef(onMapUnavailable);
  onMapUnavailableRef.current = onMapUnavailable;
  useEffect(() => {
    if (!Maps || !MapView) onMapUnavailableRef.current?.();
    // Intentionally mount-only: availability is fixed for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers only change on a refetch (or a selection change); rebuild the native
  // marker array then, not on the re-renders a changing `center` prop triggers
  // during a pan. The selected marker gets a brand tint where the platform takes
  // one (Apple Maps); selection still reads in the list regardless.
  const mapMarkers = useMemo(
    () =>
      markers.map((marker) => ({
        id: marker.id,
        coordinates: { latitude: marker.latitude, longitude: marker.longitude },
        title: marker.name,
        ...(selectedTint && marker.id === selectedId ? { tintColor: selectedTint } : {}),
      })),
    [markers, selectedId, selectedTint],
  );

  if (!Maps || !MapView) return null;

  const cameraPosition = {
    coordinates: initialCameraRef.current,
    zoom: DEFAULT_ZOOM,
  };

  // expo-maps types the camera coordinates as optional; only forward a complete
  // pair so the screen never re-queries around a half-defined center.
  const handleCameraMove = onRegionChange
    ? (event: { coordinates: { latitude?: number; longitude?: number } }) => {
        const { latitude, longitude } = event.coordinates;
        if (latitude != null && longitude != null) onRegionChange({ latitude, longitude });
      }
    : undefined;

  // Both AppleMapsMarker and GoogleMapsMarker echo back the tapped marker's `id`.
  const handleMarkerClick = onMarkerPress
    ? (event: { id?: string }) => {
        if (event.id) onMarkerPress(event.id);
      }
    : undefined;

  return (
    <MapView
      ref={assignNativeRef}
      style={[styles.map, style]}
      colorScheme={mapColorScheme}
      cameraPosition={cameraPosition}
      markers={mapMarkers}
      onCameraMove={handleCameraMove}
      onMarkerClick={handleMarkerClick}
    />
  );
});

/**
 * Renders nearby gyms as pins on the platform map (Apple Maps on iOS, Google
 * Maps on Android — the latter needs GOOGLE_MAPS_API_KEY + a native build, else
 * blank). Marker taps drive `onMarkerPress` (a map→list convenience); selection
 * itself lives in the gym list so the flow works identically whether or not the
 * map renders, and a missing/broken native map never crashes the screen (it
 * reports `onMapUnavailable` so the screen lays out list-only). Panning the map
 * fires `onRegionChange`; a place search drives the camera via the
 * {@link GymMapHandle} ref. Both no-op when the native map is unavailable.
 */
export const GymMap = memo(
  forwardRef<GymMapHandle, GymMapProps>(function GymMap(
    { center, markers, onRegionChange, onMarkerPress, selectedId, selectedTint, onMapUnavailable, style },
    ref,
  ) {
    return (
      <MapErrorBoundary onUnavailable={onMapUnavailable}>
        <NativeGymMap
          ref={ref}
          center={center}
          markers={markers}
          onRegionChange={onRegionChange}
          onMarkerPress={onMarkerPress}
          selectedId={selectedId}
          selectedTint={selectedTint}
          onMapUnavailable={onMapUnavailable}
          style={style}
        />
      </MapErrorBoundary>
    );
  }),
);

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
});
