import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  map: vi.fn(),
  tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
  marker: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/hooks/use-geolocation', () => ({
  useGeolocation: () => ({ coordinates: null, requestPermission: vi.fn() }),
}));
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

  it('aborts pending address searches and ignores their result after unmount', async () => {
    vi.useFakeTimers();
    let resolveSearch: ((response: Response) => void) | undefined;
    const fetchSearch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchSearch);
    const onChange = vi.fn();
    const { unmount } = render(<MapLocationPicker latitude={-33.64} longitude={150.28} onChange={onChange} />);
    await flushLeafletImports();
    fireEvent.change(screen.getByPlaceholderText('mapLocationPicker.searchPlaceholder'), {
      target: { value: 'Blackheath' },
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fetchSearch).toHaveBeenCalledTimes(1);
    const requestOptions = fetchSearch.mock.calls[0]?.[1] as RequestInit | undefined;
    unmount();
    expect(requestOptions?.signal?.aborted).toBe(true);
    await act(async () => {
      resolveSearch?.(new Response(JSON.stringify([{ lat: '-33.6405', lon: '150.2884' }]), { status: 200 }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
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
