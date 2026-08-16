import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { act, render, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { MapPin } from '../near-me-model';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

type FakeMarker = {
  latlng: [number, number];
  options: Record<string, unknown>;
  popup: string | null;
  bindPopup: (html: string) => FakeMarker;
};

const leaflet = vi.hoisted(() => {
  const map = {
    setView: vi.fn(() => map),
    remove: vi.fn(),
    invalidateSize: vi.fn(),
    fitBounds: vi.fn(),
  };
  const layerGroup = {
    addTo: vi.fn(() => layerGroup),
    clearLayers: vi.fn(),
    addLayer: vi.fn(),
  };
  const tileLayerInstance = { addTo: vi.fn() };

  const divIconOptions: { className: string; html: string }[] = [];
  const markers: FakeMarker[] = [];

  return {
    map,
    layerGroup,
    tileLayerInstance,
    divIconOptions,
    markers,
    mapFn: vi.fn((_container: HTMLElement, _options: Record<string, unknown>) => map),
    tileLayerFn: vi.fn((_url: string, _options: Record<string, unknown>) => tileLayerInstance),
    layerGroupFn: vi.fn(() => layerGroup),
    latLngBoundsFn: vi.fn((points: [number, number][]) => points),
    divIconFn: vi.fn((options: { className: string; html: string }) => {
      divIconOptions.push(options);
      return options;
    }),
    markerFn: vi.fn((latlng: [number, number], options: Record<string, unknown>) => {
      const marker: FakeMarker = {
        latlng,
        options,
        popup: null,
        bindPopup(html: string) {
          marker.popup = html;
          return marker;
        },
      };
      markers.push(marker);
      return marker;
    }),
  };
});

vi.mock('leaflet', () => ({
  map: leaflet.mapFn,
  tileLayer: leaflet.tileLayerFn,
  layerGroup: leaflet.layerGroupFn,
  latLngBounds: leaflet.latLngBoundsFn,
  divIcon: leaflet.divIconFn,
  marker: leaflet.markerFn,
}));
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const GymDirectoryMap = (await import('../gym-directory-map')).default;

/**
 * jsdom has no ResizeObserver, which is convenient: the map's whole
 * initialisation contract is "a non-zero size arrived", so a fake that lets a
 * test hand it a size is the only way to assert the zero-size case at all.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  observed: Element[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }

  emit(width: number, height: number) {
    this.callback(
      [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

function pin(index: number, latitude: number, longitude: number, overrides: Partial<MapPin> = {}): MapPin {
  return {
    uuid: `gym-${index}`,
    slug: `gym-${index}`,
    name: `Gym ${index}`,
    latitude,
    longitude,
    boardSummaries: [],
    ...overrides,
  };
}

function latestObserver(): FakeResizeObserver {
  const observer = FakeResizeObserver.instances.at(-1);
  if (!observer) throw new Error('no ResizeObserver was constructed');
  return observer;
}

async function grow(width = 640, height = 420) {
  await act(async () => {
    latestObserver().emit(width, height);
  });
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  leaflet.divIconOptions.length = 0;
  leaflet.markers.length = 0;
  for (const mock of [
    leaflet.mapFn,
    leaflet.tileLayerFn,
    leaflet.layerGroupFn,
    leaflet.latLngBoundsFn,
    leaflet.divIconFn,
    leaflet.markerFn,
    leaflet.map.remove,
    leaflet.map.invalidateSize,
    leaflet.map.fitBounds,
    leaflet.layerGroup.clearLayers,
    leaflet.layerGroup.addLayer,
  ]) {
    mock.mockClear();
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('map initialisation', () => {
  it('constructs nothing from leaflet while the container has no size', async () => {
    render(<GymDirectoryMap pins={[pin(1, 51, -2)]} pinnedCount={1} shownCount={1} locale="en-US" />);
    await grow(0, 0);

    // Not "renders grey tiles" — nothing is built, and the bundle is not even
    // asked for. This is what keeps the map off a phone that never opens it.
    expect(leaflet.mapFn).not.toHaveBeenCalled();
    expect(leaflet.tileLayerFn).not.toHaveBeenCalled();
    expect(leaflet.markerFn).not.toHaveBeenCalled();
    expect(leaflet.divIconFn).not.toHaveBeenCalled();
  });

  it('builds the map once the container reports a real size', async () => {
    render(<GymDirectoryMap pins={[]} pinnedCount={0} shownCount={0} locale="en-US" />);
    await grow();

    await waitFor(() => expect(leaflet.mapFn).toHaveBeenCalledTimes(1));
    expect(leaflet.mapFn.mock.calls[0][1]).toMatchObject({ attributionControl: true });
  });

  it('adds the tile layer WITH an OpenStreetMap attribution', async () => {
    render(<GymDirectoryMap pins={[]} pinnedCount={0} shownCount={0} locale="en-US" />);
    await grow();

    await waitFor(() => expect(leaflet.tileLayerFn).toHaveBeenCalledTimes(1));
    const [, options] = leaflet.tileLayerFn.mock.calls[0];
    // OSM's tile usage policy requires it. The private location picker sets
    // `attributionControl: false`; a public page may not copy that.
    expect(String(options.attribution)).toContain('OpenStreetMap');
  });

  it('invalidates size on a later resize instead of building a second map', async () => {
    render(<GymDirectoryMap pins={[]} pinnedCount={0} shownCount={0} locale="en-US" />);
    await grow();
    await waitFor(() => expect(leaflet.mapFn).toHaveBeenCalledTimes(1));

    await grow(900, 500);

    expect(leaflet.mapFn).toHaveBeenCalledTimes(1);
    expect(leaflet.map.invalidateSize).toHaveBeenCalled();
  });

  it('tears the map and the observer down on unmount', async () => {
    const view = render(<GymDirectoryMap pins={[]} pinnedCount={0} shownCount={0} locale="en-US" />);
    await grow();
    await waitFor(() => expect(leaflet.mapFn).toHaveBeenCalledTimes(1));

    const observer = latestObserver();
    view.unmount();

    expect(leaflet.map.remove).toHaveBeenCalledTimes(1);
    expect(observer.disconnected).toBe(true);
  });
});

describe('markers', () => {
  it('draws one divIcon marker per pin — never leaflet default icons', async () => {
    render(
      <GymDirectoryMap
        pins={[pin(1, 51, -2), pin(2, 52, -1), pin(3, 48, 11)]}
        pinnedCount={3}
        shownCount={5}
        locale="en-US"
      />,
    );
    await grow();

    await waitFor(() => expect(leaflet.markerFn).toHaveBeenCalledTimes(3));
    // Leaflet's default icon is a bundled PNG that 404s under a hashed asset
    // pipeline, so every marker carries an explicit divIcon.
    expect(leaflet.divIconFn).toHaveBeenCalledTimes(3);
    for (const [, options] of leaflet.markerFn.mock.calls) {
      expect(options.icon).toBeDefined();
    }
  });

  it('links each popup at the gym page, locale-prefixed', async () => {
    render(<GymDirectoryMap pins={[pin(7, 51, -2)]} pinnedCount={1} shownCount={1} locale="de" />);
    await grow();

    await waitFor(() => expect(leaflet.markers).toHaveLength(1));
    expect(leaflet.markers[0].popup).toContain('href="/de/gym/gym-7"');
    expect(leaflet.markers[0].popup).toContain('Gym 7');
  });

  it('keeps the default locale unprefixed', async () => {
    render(<GymDirectoryMap pins={[pin(7, 51, -2)]} pinnedCount={1} shownCount={1} locale="en-US" />);
    await grow();

    await waitFor(() => expect(leaflet.markers).toHaveLength(1));
    expect(leaflet.markers[0].popup).toContain('href="/gym/gym-7"');
  });

  it('renders board chips in the popup and escapes the gym name', async () => {
    render(
      <GymDirectoryMap
        pins={[pin(1, 51, -2, { name: 'Bob & "Als"', boardSummaries: [{ boardType: 'kilter', angle: 40 }] })]}
        pinnedCount={1}
        shownCount={1}
        locale="en-US"
      />,
    );
    await grow();

    await waitFor(() => expect(leaflet.markers).toHaveLength(1));
    expect(leaflet.markers[0].popup).toContain('Kilter 40°');
    expect(leaflet.markers[0].popup).toContain('Bob &amp; &quot;Als&quot;');
  });

  it('clusters instead of rendering an unbounded number of markers', async () => {
    const pins = Array.from({ length: 260 }, (_, index) => pin(index, -80 + (index % 160) * 0.9, -170 + index));
    render(<GymDirectoryMap pins={pins} pinnedCount={260} shownCount={260} locale="en-US" />);
    await grow();

    await waitFor(() => expect(leaflet.markerFn).toHaveBeenCalled());
    expect(leaflet.markerFn.mock.calls.length).toBeLessThan(pins.length);
    expect(leaflet.markerFn.mock.calls.length).toBeLessThanOrEqual(200);
  });

  it('redraws markers when the result set changes, without rebuilding the map', async () => {
    const view = render(<GymDirectoryMap pins={[pin(1, 51, -2)]} pinnedCount={1} shownCount={1} locale="en-US" />);
    await grow();
    await waitFor(() => expect(leaflet.markerFn).toHaveBeenCalledTimes(1));

    view.rerender(
      <GymDirectoryMap pins={[pin(2, 48, 11), pin(3, 47, 8)]} pinnedCount={2} shownCount={2} locale="en-US" />,
    );

    await waitFor(() => expect(leaflet.markerFn).toHaveBeenCalledTimes(3));
    expect(leaflet.layerGroup.clearLayers).toHaveBeenCalled();
    expect(leaflet.mapFn).toHaveBeenCalledTimes(1);
  });
});

describe('pinned-count pill', () => {
  it('states how many of the gyms on screen have a pin', () => {
    const { container } = render(
      <GymDirectoryMap pins={[pin(1, 51, -2)]} pinnedCount={15} shownCount={24} locale="en-US" />,
    );
    expect(container.textContent).toContain('15 of 24 gyms here have a map pin');
  });
});
