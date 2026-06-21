// Forward-geocoding for the gym finder's location search bar: turn a typed
// place ("Blackheath NSW", "Tokyo") into coordinates so the map + nearby
// queries can relocate there, not just to the device's GPS fix.
//
// expo-location is a NATIVE module — a JS-only OTA push to a build that predates
// it throws on import. We import lazily inside `geocode()` and treat any failure
// (missing module, no match, Android without Play Services) as "no result", so a
// failed lookup just leaves the map where it was instead of crashing.

import { useCallback, useRef, useState } from 'react';
import type { Coords } from './use-device-location';

export type PlaceSearch = {
  isGeocoding: boolean;
  /** Resolve a typed place to coordinates; null when nothing matches. */
  geocode: (queryText: string) => Promise<Coords | null>;
};

export function useGeocodePlace(): PlaceSearch {
  const [isGeocoding, setIsGeocoding] = useState(false);
  // Guards against overlapping lookups: a slow first request must not flip the
  // spinner off after a faster second one already did.
  const inFlightRef = useRef(0);

  const geocode = useCallback(async (queryText: string): Promise<Coords | null> => {
    const trimmed = queryText.trim();
    if (!trimmed) return null;

    const ticket = inFlightRef.current + 1;
    inFlightRef.current = ticket;
    setIsGeocoding(true);

    try {
      const Location = await import('expo-location');
      const matches = await Location.geocodeAsync(trimmed);
      const first = matches[0];
      return first ? { latitude: first.latitude, longitude: first.longitude } : null;
    } catch {
      // Module missing (pre-expo-location build), no network geocoder, or a
      // platform that can't geocode — caller falls back to name-only filtering.
      return null;
    } finally {
      if (inFlightRef.current === ticket) setIsGeocoding(false);
    }
  }, []);

  return { isGeocoding, geocode };
}
