import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  map: vi.fn(),
  tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  marker: vi.fn(),
  request: vi.fn(),
  token: 'map-viewer-token' as string | null,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/hooks/use-geolocation', () => ({
  useGeolocation: () => ({ coordinates: null, requestPermission: vi.fn() }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: mocks.token }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mocks.request }) }));
vi.mock('leaflet', () => ({ map: mocks.map, tileLayer: mocks.tileLayer, marker: mocks.marker, divIcon: vi.fn() }));
vi.mock('leaflet/dist/leaflet.css', () => ({}));

import MapLocationPicker from '../map-location-picker';

function createMapMock() {
  let removed = false;
  return {
    setView: vi.fn().mockReturnThis(),
    on: vi.fn(),
    off: vi.fn(),
    remove: vi.fn(() => {
      removed = true;
    }),
    invalidateSize: vi.fn(() => {
      if (removed) throw new Error('resize touched a removed map');
    }),
    flyTo: vi.fn(),
  };
}

let map: ReturnType<typeof createMapMock>;

async function flushLeafletImports() {
  await act(async () => {
    await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token = 'map-viewer-token';
  mocks.request
    .mockReset()
    .mockResolvedValue({ lookupGymAddressCoordinates: { latitude: -33.6405, longitude: 150.2884 } });
  map = createMapMock();
  mocks.map.mockReturnValue(map);
  mocks.marker.mockImplementation(() => ({
    addTo: vi.fn().mockReturnThis(),
    on: vi.fn(),
    setLatLng: vi.fn(),
    getLatLng: vi.fn(() => ({ lat: -33.64, lng: 150.28 })),
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('map location picker lifecycle', () => {
  it('does not initialize an element after its owning effect unmounts', async () => {
    const { unmount } = render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={vi.fn()} />);
    unmount();
    await flushLeafletImports();
    expect(mocks.map).not.toHaveBeenCalled();
  });

  it('cancels resize work before removing its map', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={vi.fn()} />);
    await flushLeafletImports();
    expect(mocks.map).toHaveBeenCalledTimes(1);
    unmount();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(map.off).toHaveBeenCalledTimes(1);
    expect(map.invalidateSize).not.toHaveBeenCalled();
  });

  it('searches only on explicit Search or Enter, through the authenticated backend', async () => {
    vi.useFakeTimers();
    const browserFetch = vi.fn();
    vi.stubGlobal('fetch', browserFetch);
    const onChange = vi.fn();
    render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    const input = screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder');
    fireEvent.change(input, { target: { value: ' Blackheath NSW Australia ' } });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mapLocationPicker.search' })));
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { address: 'Blackheath NSW Australia' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(-33.6405, 150.2884);
    expect(map.flyTo).toHaveBeenLastCalledWith([-33.6405, 150.2884], 16);
    fireEvent.change(input, { target: { value: 'Sydney NSW Australia' } });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it('aborts pending address searches and ignores their result after unmount', async () => {
    let resolveSearch:
      | ((result: { lookupGymAddressCoordinates: { latitude: number; longitude: number } }) => void)
      | undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const onChange = vi.fn();
    const { unmount } = render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    fireEvent.change(screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder'), {
      target: { value: 'Blackheath' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'mapLocationPicker.search' }));
    const requestOptions = mocks.request.mock.calls[0]?.[0] as { signal: AbortSignal };
    unmount();
    expect(requestOptions.signal.aborted).toBe(true);
    await act(async () => {
      resolveSearch?.({ lookupGymAddressCoordinates: { latitude: -33.6405, longitude: 150.2884 } });
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it('typing invalidates an outstanding result without launching another lookup', async () => {
    let resolveSearch:
      | ((result: { lookupGymAddressCoordinates: { latitude: number; longitude: number } }) => void)
      | undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const onChange = vi.fn();
    render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    const input = screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'Blackheath' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const requestOptions = mocks.request.mock.calls[0]?.[0] as { signal: AbortSignal };
    fireEvent.change(input, { target: { value: 'Sydney' } });
    expect(requestOptions.signal.aborted).toBe(true);
    await act(async () => {
      resolveSearch?.({ lookupGymAddressCoordinates: { latitude: 52.37, longitude: 4.9 } });
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a manually placed pin when an old lookup completes', async () => {
    let resolveSearch:
      | ((result: { lookupGymAddressCoordinates: { latitude: number; longitude: number } }) => void)
      | undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const onChange = vi.fn();
    render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    fireEvent.change(screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder'), {
      target: { value: 'Blackheath' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder'), { key: 'Enter' });
    const clickHandler = map.on.mock.calls.find(([event]) => event === 'click')?.[1] as (event: {
      latlng: { lat: number; lng: number };
    }) => void;
    act(() => clickHandler({ latlng: { lat: 40.7, lng: -74 } }));
    await act(async () => {
      resolveSearch?.({ lookupGymAddressCoordinates: { latitude: 52.37, longitude: 4.9 } });
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(40.7, -74);
    expect(map.flyTo).not.toHaveBeenCalled();
  });

  it('leaves the pin untouched and explains an unavailable result or failure', async () => {
    const onChange = vi.fn();
    render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    const input = screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'Ambiguous address' } });
    mocks.request.mockResolvedValueOnce({ lookupGymAddressCoordinates: null });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(screen.getByText('mapLocationPicker.searchUnavailable')).toBeTruthy();
    mocks.request.mockRejectedValueOnce(new Error('Private address must never be logged'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(screen.getByText('mapLocationPicker.searchFailed')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not search without a current authenticated token', async () => {
    mocks.token = null;
    render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={vi.fn()} />);
    await flushLeafletImports();
    const input = screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'Blackheath' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('lets users zoom and immediately leave without a late Leaflet transition touching removed panes', async () => {
    vi.useFakeTimers();
    const leaflet = await vi.importActual<typeof import('leaflet')>('leaflet');
    const mockedLeaflet = await import('leaflet');
    const originalAny3d = leaflet.Browser.any3d;
    // jsdom has no 3D rendering, so explicitly enable Leaflet's real CSS zoom
    // path. Without this capability the old teardown bug cannot be exercised.
    Object.defineProperty(leaflet.Browser, 'any3d', { configurable: true, value: true });
    let createdMap: import('leaflet').Map | undefined;
    mocks.map.mockImplementation((container: HTMLElement, options: import('leaflet').MapOptions) => {
      createdMap = leaflet.map(container, options);
      return createdMap;
    });
    mocks.marker.mockImplementation(leaflet.marker);
    vi.mocked(mockedLeaflet.divIcon).mockImplementation(leaflet.divIcon);

    try {
      const { unmount } = render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={vi.fn()} />);
      await flushLeafletImports();
      if (!createdMap) throw new Error('Leaflet map was not initialized');
      act(() => {
        createdMap?.zoomIn(1, { animate: true });
        vi.advanceTimersByTime(32);
      });
      expect(createdMap.getZoom()).toBe(15);
      unmount();
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(300);
        });
      }).not.toThrow();
    } finally {
      Object.defineProperty(leaflet.Browser, 'any3d', { configurable: true, value: originalAny3d });
    }
  });
});
