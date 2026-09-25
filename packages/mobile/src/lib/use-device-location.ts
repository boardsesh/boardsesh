// One-shot device location for "Find Nearby". Mirrors the web's
// use-discover-boards geolocation step, but as a standalone hook: it owns only
// permission + coordinate resolution and exposes a small state machine. The
// actual board search is a separate concern (`useNearbyBoards(coords)`), so the
// mode card can reflect location status while the carousel reflects results.
//
// expo-location is a NATIVE module — a build that predates it will throw on
// import. We import lazily inside `request()` and treat a failure as
// `unavailable`, so the screen degrades gracefully on an older OTA build
// instead of crashing.

import { useCallback, useRef, useState } from 'react';

export type Coords = { latitude: number; longitude: number };

export type LocationStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';

export type DeviceLocation = {
  status: LocationStatus;
  coords: Coords | null;
  /** Kick off the permission prompt + one-shot fix. Safe to call repeatedly. */
  request: () => Promise<void>;
  /**
   * Take a fresh fix once location is granted, for a climber who has moved
   * since the first one. `request` never does: after a grant it is a no-op.
   * Resolves `true` when the coordinates changed (a search keyed on them runs
   * again by itself) and `false` when they did not, the fix failed, or there
   * was nothing to refresh (not granted yet, or a request or refresh in
   * flight). `status` reads `loading` while it runs.
   */
  refresh: () => Promise<boolean>;
};

export type DeviceLocationOptions = {
  /**
   * Let a request after a denial ask again instead of no-oping. Off by default,
   * because a surface that cannot send the climber to Settings gains nothing from
   * re-asking. The first-board picker (#5654) turns it on: it offers Open
   * Settings, and a climber who comes back having allowed location should get
   * their gyms from one more tap, not from reopening the screen.
   */
  retryAfterDenial?: boolean;
};

export function useDeviceLocation({ retryAfterDenial = false }: DeviceLocationOptions = {}): DeviceLocation {
  const [status, setStatus] = useState<LocationStatus>('idle');
  const [coords, setCoords] = useState<Coords | null>(null);
  // Once a request reaches a terminal state (granted / denied / unavailable),
  // or while one is in flight, further taps are no-ops — no redundant native
  // permission/location calls. iOS only shows the permission prompt once
  // anyway, so re-requesting after a denial would silently re-resolve denied.
  const settledRef = useRef(false);
  const statusRef = useRef<LocationStatus>('idle');
  statusRef.current = status;
  const coordsRef = useRef<Coords | null>(null);
  coordsRef.current = coords;

  const request = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setStatus('loading');

    try {
      const Location = await import('expo-location');
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== 'granted') {
        if (retryAfterDenial) settledRef.current = false;
        setStatus('denied');
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setStatus('granted');
    } catch {
      // Module missing (pre-expo-location build) or a location error — either
      // way there's nothing to show; surface it as unavailable, not a crash.
      // This can be transient (a one-off GPS error), so re-open the gate to
      // allow a later retry — unlike a permission denial, which is sticky.
      settledRef.current = false;
      setStatus('unavailable');
    }
  }, [retryAfterDenial]);

  const refresh = useCallback(async () => {
    // `loading` covers both a first request and another refresh in flight.
    if (statusRef.current !== 'granted') return false;
    statusRef.current = 'loading';
    setStatus('loading');
    try {
      const Location = await import('expo-location');
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = position.coords;
      const previous = coordsRef.current;
      const moved = previous?.latitude !== latitude || previous?.longitude !== longitude;
      if (moved) setCoords({ latitude, longitude });
      return moved;
    } catch {
      // Keep the fix we had: it is still the best answer, and permission is
      // still granted. The caller searches again from it.
      return false;
    } finally {
      statusRef.current = 'granted';
      setStatus('granted');
    }
  }, []);

  return { status, coords, request, refresh };
}
