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

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

export type Coords = { latitude: number; longitude: number };

export type LocationStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';

/**
 * Location permission as last read, without asking:
 * - `unknown`: not read yet, or no location module to read it from.
 * - `ask`: a prompt can still ask (never asked, or Android after one refusal).
 * - `blocked`: refused for good (iOS after a refusal, Android "Don't ask
 *   again", any refusal in a browser); only Settings can turn it on.
 * - `granted`.
 */
export type LocationPermission = 'unknown' | 'ask' | 'blocked' | 'granted';

/**
 * expo-location's answer, as a `LocationPermission`. In a browser a refusal is
 * final whatever `canAskAgain` says (expo-location's web answer is always
 * true): the browser never shows its prompt again, so asking would be a dead
 * button. Only the site's settings can undo it.
 */
export function locationPermissionFrom(
  answer: { status: string; canAskAgain?: boolean },
  platform: string = Platform.OS,
): LocationPermission {
  if (answer.status === 'granted') return 'granted';
  if (answer.status !== 'denied') return 'ask';
  return platform === 'web' || answer.canAskAgain === false ? 'blocked' : 'ask';
}

export type LocationRequestOptions = {
  /**
   * Called once, as soon as the permission answer is known: right after the
   * system prompt closes, before the fix (which can take seconds), or at once
   * when the call is a no-op. A screen reporting the answer reads it here.
   */
  onAnswer?: (permission: LocationPermission) => void;
};

/** `DeviceLocation['request']`: the system prompt plus a one-shot fix. */
export type LocationRequest = (options?: LocationRequestOptions) => Promise<LocationPermission>;

export type DeviceLocation = {
  status: LocationStatus;
  /**
   * The permission itself, read by `requestIfAllowed` and every `request`, so
   * a screen can offer the right way to turn it on before anything is asked.
   */
  permission: LocationPermission;
  /**
   * The first permission read has finished, whatever it found (a read that
   * threw leaves `permission` at `unknown`). A screen that waits for "do we
   * already have location?" before saying anything waits on this, never on
   * `permission` alone, which can stay `unknown` for good.
   */
  permissionChecked: boolean;
  coords: Coords | null;
  /**
   * Kick off the permission prompt + one-shot fix. Safe to call repeatedly.
   * Resolves to the permission as the prompt left it (or as last read, when
   * the call was a no-op), so the caller can report the answer.
   */
  request: LocationRequest;
  /**
   * `request`, but only when location is already allowed, so it never shows the
   * permission prompt: a screen can search on open for a climber who said yes
   * before, and ask the rest from a tap. Anything else (not asked, denied, no
   * module) leaves `status` at `idle`. Resolves to the permission it read.
   * Every screen calls this, never `request`, when it opens: the system prompt
   * only ever comes from a tap.
   */
  requestIfAllowed: () => Promise<LocationPermission>;
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
  /**
   * Run `requestIfAllowed` again whenever the app comes back to the
   * foreground: permission and coordinates follow changes in Settings,
   * including approximate access or an expired one-time grant. Off by default.
   */
  rereadWhenActive?: boolean;
};

export function useDeviceLocation({
  retryAfterDenial = false,
  rereadWhenActive = false,
}: DeviceLocationOptions = {}): DeviceLocation {
  const [status, setStatus] = useState<LocationStatus>('idle');
  const [permission, setPermissionState] = useState<LocationPermission>('unknown');
  const [permissionChecked, setPermissionChecked] = useState(false);
  // The permission as last read, for the promise `request` and
  // `requestIfAllowed` resolve to: state set in the same call is not readable yet.
  const permissionRef = useRef<LocationPermission>('unknown');
  const setPermission = useCallback((next: LocationPermission) => {
    permissionRef.current = next;
    setPermissionState(next);
  }, []);
  const [coords, setCoords] = useState<Coords | null>(null);
  // Settled requests ignore repeated taps. Silent foreground reads can still
  // observe Settings changes or an expired one-time grant. The separate flight
  // guard also serializes permission reads and coordinate refreshes.
  const settledRef = useRef(false);
  const inFlightRef = useRef(false);
  const mayAskPermissionRef = useRef(false);
  const requestPromiseRef = useRef<Promise<LocationPermission> | null>(null);
  const answerKnownRef = useRef(false);
  const answerCallbacksRef = useRef<Array<(answer: LocationPermission) => void>>([]);
  const statusRef = useRef<LocationStatus>('idle');
  statusRef.current = status;
  const coordsRef = useRef<Coords | null>(null);
  coordsRef.current = coords;

  const locate = useCallback(
    (mayAskPermission: boolean, options?: LocationRequestOptions): Promise<LocationPermission> => {
      const onAnswer = options?.onAnswer;
      if (mayAskPermission && settledRef.current) {
        onAnswer?.(permissionRef.current);
        return Promise.resolve(permissionRef.current);
      }
      // A tap during an automatic permission read still authorizes the prompt.
      // Reuse that read so a slow native import cannot swallow the first tap.
      if (mayAskPermission) {
        mayAskPermissionRef.current = true;
        setStatus('loading');
      }
      if (onAnswer) {
        if (inFlightRef.current && answerKnownRef.current) onAnswer(permissionRef.current);
        else answerCallbacksRef.current.push(onAnswer);
      }
      if (inFlightRef.current) return requestPromiseRef.current ?? Promise.resolve(permissionRef.current);
      inFlightRef.current = true;
      answerKnownRef.current = false;
      const answerPendingCallbacks = () => {
        answerKnownRef.current = true;
        const callbacks = answerCallbacksRef.current;
        answerCallbacksRef.current = [];
        for (const callback of callbacks) callback(permissionRef.current);
      };

      requestPromiseRef.current = (async (): Promise<LocationPermission> => {
        let resolvingPosition = false;
        try {
          const Location = await import('expo-location');
          const existingPermission = await Location.getForegroundPermissionsAsync();
          const canAskPermission = mayAskPermissionRef.current;
          const answer =
            existingPermission.status === 'granted' || !canAskPermission
              ? existingPermission
              : await Location.requestForegroundPermissionsAsync();
          setPermission(locationPermissionFrom(answer));
          setPermissionChecked(true);
          settledRef.current = answer.status === 'granted' || (canAskPermission && !retryAfterDenial);
          answerPendingCallbacks();
          if (answer.status !== 'granted') {
            setCoords(null);
            setStatus(canAskPermission ? 'denied' : 'idle');
            return permissionRef.current;
          }

          resolvingPosition = true;
          setStatus('loading');
          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
          setStatus('granted');
        } catch {
          // A silent permission read can fail on an older binary. Only show an
          // error after a tap or when an allowed position request actually fails.
          if (mayAskPermissionRef.current || resolvingPosition) {
            settledRef.current = false;
            setStatus('unavailable');
          }
        } finally {
          setPermissionChecked(true);
          mayAskPermissionRef.current = false;
          inFlightRef.current = false;
          requestPromiseRef.current = null;
          answerPendingCallbacks();
        }
        return permissionRef.current;
      })();
      return requestPromiseRef.current;
    },
    [retryAfterDenial, setPermission],
  );

  const request = useCallback<LocationRequest>((options) => locate(true, options), [locate]);
  const requestIfAllowed = useCallback(() => locate(false), [locate]);

  useEffect(() => {
    if (!rereadWhenActive) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void requestIfAllowed();
    });
    return () => subscription.remove();
  }, [rereadWhenActive, requestIfAllowed]);

  const refresh = useCallback(async () => {
    // `loading` covers both a first request and another refresh in flight.
    if (statusRef.current !== 'granted' || inFlightRef.current) return false;
    inFlightRef.current = true;
    statusRef.current = 'loading';
    setStatus('loading');
    try {
      const Location = await import('expo-location');
      const read = locationPermissionFrom(await Location.getForegroundPermissionsAsync());
      setPermission(read);
      if (read !== 'granted') {
        settledRef.current = false;
        statusRef.current = 'denied';
        setCoords(null);
        setStatus('denied');
        return false;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = position.coords;
      const previous = coordsRef.current;
      const moved = previous?.latitude !== latitude || previous?.longitude !== longitude;
      if (moved) setCoords({ latitude, longitude });
      statusRef.current = 'granted';
      setStatus('granted');
      return moved;
    } catch {
      // Keep the fix we had: it is still the best answer, and permission is
      // still granted. The caller searches again from it.
      statusRef.current = 'granted';
      setStatus('granted');
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [setPermission]);

  return { status, permission, permissionChecked, coords, request, requestIfAllowed, refresh };
}
