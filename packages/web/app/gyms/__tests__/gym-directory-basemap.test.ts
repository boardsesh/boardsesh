import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import type * as Leaflet from 'leaflet';
import { attachDirectoryBasemap, DARK_MAP_STYLE } from '../gym-directory-basemap';

vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('@maplibre/maplibre-gl-leaflet', () => ({}));

const map = {} as Leaflet.Map;
const listeners = new Map<string, () => void>();
const renderer = {
  on: vi.fn((event: string, callback: () => void) => listeners.set(event, callback)),
  off: vi.fn((event: string) => listeners.delete(event)),
  isStyleLoaded: vi.fn(() => false),
};
const container = { remove: vi.fn() };
const vector = {
  addTo: vi.fn(),
  remove: vi.fn(),
  getMaplibreMap: vi.fn((): typeof renderer | undefined => renderer),
  getContainer: () => container,
  onRemove: vi.fn(),
};
const raster = { addTo: vi.fn(), remove: vi.fn() };
const maplibreGL = vi.fn(() => vector);
const tileLayer = vi.fn(() => raster);
const leaflet = { default: { maplibreGL }, tileLayer } as unknown as typeof Leaflet;
const setDark = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vector.getMaplibreMap.mockReturnValue(renderer);
  vector.addTo.mockReturnValue(vector);
  vector.remove.mockImplementation(() => undefined);
  renderer.isStyleLoaded.mockReturnValue(false);
  raster.addTo.mockReturnValue(raster);
});

describe('directory basemap', () => {
  it('loads the dark style with all provider attributions, and cleans up listeners', async () => {
    const dispose = attachDirectoryBasemap(map, leaflet, setDark);
    await vi.waitFor(() => expect(setDark).toHaveBeenCalledWith(true));
    const options = maplibreGL.mock.calls[0] as unknown as [
      { style: string; attributionControl: { customAttribution: string } },
    ];
    expect(options[0].style).toBe(DARK_MAP_STYLE);
    for (const provider of ['OpenFreeMap', 'OpenMapTiles', 'OpenStreetMap']) {
      expect(options[0].attributionControl.customAttribution).toContain(provider);
    }
    expect(tileLayer).not.toHaveBeenCalled();
    dispose();
    expect(listeners.size).toBe(0);
    expect(vector.remove).toHaveBeenCalledOnce();
  });

  it('does not construct a layer when unmounted during the lazy import', async () => {
    attachDirectoryBasemap(map, leaflet, setDark)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(maplibreGL).not.toHaveBeenCalled();
    expect(tileLayer).not.toHaveBeenCalled();
    expect(setDark).not.toHaveBeenCalled();
  });

  it('falls back to attributed raster tiles and matching markers after a style error', async () => {
    const dispose = attachDirectoryBasemap(map, leaflet, setDark);
    await vi.waitFor(() => expect(setDark).toHaveBeenCalledWith(true));
    listeners.get('error')?.();
    expect(tileLayer).toHaveBeenCalledWith(
      expect.stringContaining('tile.openstreetmap.org'),
      expect.objectContaining({ attribution: expect.stringContaining('OpenStreetMap') }),
    );
    expect(setDark).toHaveBeenLastCalledWith(false);
    expect(vector.remove).toHaveBeenCalledOnce();
    dispose();
    expect(raster.remove).toHaveBeenCalledOnce();
  });

  it('keeps a loaded style after an individual tile error', async () => {
    const dispose = attachDirectoryBasemap(map, leaflet, setDark);
    await vi.waitFor(() => expect(setDark).toHaveBeenCalledWith(true));
    renderer.isStyleLoaded.mockReturnValue(true);
    listeners.get('error')?.();
    expect(tileLayer).not.toHaveBeenCalled();
    dispose();
  });

  it('falls back after WebGL context loss even when the style loaded', async () => {
    const dispose = attachDirectoryBasemap(map, leaflet, setDark);
    await vi.waitFor(() => expect(setDark).toHaveBeenCalledWith(true));
    renderer.isStyleLoaded.mockReturnValue(true);
    listeners.get('webglcontextlost')?.();
    expect(setDark).toHaveBeenLastCalledWith(false);
    dispose();
  });

  it('safely removes a partially initialized adapter when WebGL is unavailable', async () => {
    vector.getMaplibreMap.mockReturnValue(undefined);
    vector.addTo.mockImplementationOnce(() => {
      throw new Error('WebGL unavailable');
    });
    vector.remove.mockImplementationOnce(() => vector.onRemove());
    const dispose = attachDirectoryBasemap(map, leaflet, setDark);
    await vi.waitFor(() => expect(setDark).toHaveBeenCalledWith(false));
    expect(container.remove).toHaveBeenCalledOnce();
    expect(raster.addTo).toHaveBeenCalledWith(map);
    dispose();
  });
});
