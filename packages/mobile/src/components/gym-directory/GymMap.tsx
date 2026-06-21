import { Component, forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

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
 * the whole gym screen down with a red box.
 */
class MapErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn('[gym-map] native map unavailable, falling back to list-only:', error);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

const NativeGymMap = forwardRef<GymMapHandle, GymMapProps>(function NativeGymMap(
  { center, markers, onRegionChange, style },
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

  // Markers only change on a refetch; rebuild the native marker array then, not
  // on the re-renders a changing `center` prop triggers during a pan.
  const mapMarkers = useMemo(
    () =>
      markers.map((marker) => ({
        coordinates: { latitude: marker.latitude, longitude: marker.longitude },
        title: marker.name,
      })),
    [markers],
  );

  if (!Maps) return null;
  // requireNativeView can hand back a component that exists in JS but throws on
  // mount when the native side is absent — the boundary above is the real guard;
  // this short-circuits the obvious "undefined component" case.
  const MapView = Platform.OS === 'ios' ? Maps.AppleMaps?.View : Maps.GoogleMaps?.View;
  if (!MapView) return null;

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

  return (
    <MapView
      ref={assignNativeRef}
      style={[styles.map, style]}
      cameraPosition={cameraPosition}
      markers={mapMarkers}
      onCameraMove={handleCameraMove}
    />
  );
});

/**
 * Renders nearby gyms as pins on the platform map (Apple Maps on iOS, Google
 * Maps on Android — the latter needs GOOGLE_MAPS_API_KEY + a native build, else
 * blank). Marker taps aren't wired: selection happens in the gym list so the
 * flow works identically whether or not the map renders, and a missing/broken
 * native map never crashes the screen. Panning the map fires `onRegionChange`;
 * a place search drives the camera via the {@link GymMapHandle} ref. Both no-op
 * when the native map is unavailable, so the list-only fallback still works.
 */
export const GymMap = memo(
  forwardRef<GymMapHandle, GymMapProps>(function GymMap({ center, markers, onRegionChange, style }, ref) {
    return (
      <MapErrorBoundary>
        <NativeGymMap ref={ref} center={center} markers={markers} onRegionChange={onRegionChange} style={style} />
      </MapErrorBoundary>
    );
  }),
);

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
});
