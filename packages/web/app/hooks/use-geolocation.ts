'use client';

import { useState, useCallback, useEffect } from 'react';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';

export type GeolocationCoordinates = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

export type GeolocationState = {
  coordinates: GeolocationCoordinates | null;
  error: GeolocationPositionError | null;
  loading: boolean;
  permissionState: PermissionState | null;
};

export type UseGeolocationReturn = GeolocationState & {
  requestPermission: () => Promise<void>;
  refresh: () => Promise<void>;
};

const defaultOptions: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10000,
  maximumAge: 60000, // Cache position for 1 minute
};

/** Get position using Capacitor Geolocation plugin */
async function getCapacitorPosition(options: PositionOptions): Promise<GeolocationCoordinates> {
  const plugin = window.Capacitor?.Plugins?.Geolocation;
  if (!plugin) {
    throw new Error('Capacitor Geolocation plugin not available');
  }
  const result = await plugin.getCurrentPosition({
    enableHighAccuracy: options.enableHighAccuracy,
    timeout: options.timeout,
    maximumAge: options.maximumAge,
  });
  return {
    latitude: result.coords.latitude,
    longitude: result.coords.longitude,
    accuracy: result.coords.accuracy,
  };
}

/** Check permission state using Capacitor Geolocation plugin */
async function checkCapacitorPermission(): Promise<PermissionState> {
  const plugin = window.Capacitor?.Plugins?.Geolocation;
  if (!plugin) return 'denied';
  const result = await plugin.checkPermissions();
  return result.location;
}

/**
 * Custom hook for accessing geolocation.
 * Uses Capacitor Geolocation plugin on native apps, browser API on web.
 * @param options Position options for geolocation API
 */
export function useGeolocation(options: PositionOptions = defaultOptions): UseGeolocationReturn {
  const [state, setState] = useState<GeolocationState>({
    coordinates: null,
    error: null,
    loading: false,
    permissionState: null,
  });

  // Check permission state on mount
  useEffect(() => {
    if (isNativeApp()) {
      checkCapacitorPermission()
        .then((permState) => setState((prev) => ({ ...prev, permissionState: permState })))
        .catch(() => {});
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.permissions) {
      return;
    }

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        setState((prev) => ({ ...prev, permissionState: result.state }));

        // Listen for permission changes
        result.addEventListener('change', () => {
          setState((prev) => ({ ...prev, permissionState: result.state }));
        });
      })
      .catch(() => {
        // Permission API not supported, that's okay
      });
  }, []);

  const getCurrentPosition = useCallback((): Promise<GeolocationCoordinates> => {
    if (isNativeApp()) {
      return getCapacitorPosition(options);
    }

    return new Promise((resolve, reject) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        reject(new Error('Geolocation is not supported by this browser'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error) => {
          reject(error);
        },
        options,
      );
    });
  }, [options]);

  const requestPermission = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      // On native, request permissions explicitly before getting position
      if (isNativeApp()) {
        const plugin = window.Capacitor?.Plugins?.Geolocation;
        if (plugin) {
          await plugin.requestPermissions();
        }
      }

      const coords = await getCurrentPosition();
      setState((prev) => ({
        ...prev,
        coordinates: coords,
        loading: false,
        error: null,
        permissionState: 'granted',
      }));
    } catch (error) {
      const geoError = error as GeolocationPositionError;
      setState((prev) => ({
        ...prev,
        coordinates: null,
        loading: false,
        error: geoError,
        permissionState: geoError.code === 1 ? 'denied' : prev.permissionState,
      }));
    }
  }, [getCurrentPosition]);

  const refresh = useCallback(async () => {
    if (state.permissionState !== 'granted') {
      return requestPermission();
    }

    setState((prev) => ({ ...prev, loading: true }));

    try {
      const coords = await getCurrentPosition();
      setState((prev) => ({
        ...prev,
        coordinates: coords,
        loading: false,
        error: null,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error as GeolocationPositionError,
      }));
    }
  }, [state.permissionState, getCurrentPosition, requestPermission]);

  return {
    ...state,
    requestPermission,
    refresh,
  };
}

/**
 * Get a human-readable error message for geolocation errors.
 */
export function getGeolocationErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return 'Location permission was denied. Please enable location access in your browser settings.';
    case error.POSITION_UNAVAILABLE:
      return 'Location information is unavailable. Please try again later.';
    case error.TIMEOUT:
      return 'Location request timed out. Please try again.';
    default:
      return 'An unknown error occurred while getting your location.';
  }
}
