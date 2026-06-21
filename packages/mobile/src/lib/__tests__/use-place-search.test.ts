// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const expoLocation = vi.hoisted(() => ({
  geocodeAsync: vi.fn(),
}));

vi.mock('expo-location', () => expoLocation);

import { useGeocodePlace } from '../use-place-search';

describe('useGeocodePlace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expoLocation.geocodeAsync.mockResolvedValue([{ latitude: -33.6361, longitude: 150.2861 }]);
  });

  it('resolves the first match to coords', async () => {
    const { result } = renderHook(() => useGeocodePlace());

    let coords: { latitude: number; longitude: number } | null = null;
    await act(async () => {
      coords = await result.current.geocode('Blackheath NSW');
    });

    expect(expoLocation.geocodeAsync).toHaveBeenCalledWith('Blackheath NSW');
    expect(coords).toEqual({ latitude: -33.6361, longitude: 150.2861 });
    expect(result.current.isGeocoding).toBe(false);
  });

  it('returns null when nothing matches', async () => {
    expoLocation.geocodeAsync.mockResolvedValue([]);
    const { result } = renderHook(() => useGeocodePlace());

    let coords: { latitude: number; longitude: number } | null = { latitude: 0, longitude: 0 };
    await act(async () => {
      coords = await result.current.geocode('nowhere-at-all');
    });

    expect(coords).toBeNull();
  });

  it('returns null (no throw) when the native geocoder fails', async () => {
    expoLocation.geocodeAsync.mockRejectedValue(new Error('no Play Services'));
    const { result } = renderHook(() => useGeocodePlace());

    let coords: { latitude: number; longitude: number } | null = { latitude: 0, longitude: 0 };
    await act(async () => {
      coords = await result.current.geocode('Tokyo');
    });

    expect(coords).toBeNull();
    expect(result.current.isGeocoding).toBe(false);
  });

  it('skips the native call for empty/whitespace input', async () => {
    const { result } = renderHook(() => useGeocodePlace());

    let coords: { latitude: number; longitude: number } | null = { latitude: 0, longitude: 0 };
    await act(async () => {
      coords = await result.current.geocode('   ');
    });

    expect(coords).toBeNull();
    expect(expoLocation.geocodeAsync).not.toHaveBeenCalled();
  });

  it('flips isGeocoding true while a lookup is in flight', async () => {
    let resolveGeocode: ((value: Array<{ latitude: number; longitude: number }>) => void) | undefined;
    expoLocation.geocodeAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveGeocode = resolve;
      }),
    );
    const { result } = renderHook(() => useGeocodePlace());

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.geocode('Sydney');
    });
    await waitFor(() => expect(result.current.isGeocoding).toBe(true));

    await act(async () => {
      resolveGeocode?.([{ latitude: -33.8688, longitude: 151.2093 }]);
      await pending;
    });
    expect(result.current.isGeocoding).toBe(false);
  });
});
