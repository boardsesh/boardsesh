import type * as Leaflet from 'leaflet';

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const DARK_MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const DARK_ATTRIBUTION =
  '<a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
  OSM_ATTRIBUTION;

/** Starts only after the map has a size. Cleanup also cancels pending imports. */
export function attachDirectoryBasemap(
  map: Leaflet.Map,
  leaflet: typeof Leaflet,
  setDark: (dark: boolean) => void,
): () => void {
  let disposed = false;
  let fellBack = false;
  let layer: Leaflet.Layer | null = null;
  let detachError: (() => void) | undefined;

  const useRaster = () => {
    if (disposed || fellBack) return;
    fellBack = true;
    detachError?.();
    layer?.remove();
    layer = leaflet
      .tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: OSM_ATTRIBUTION,
      })
      .addTo(map);
    setDark(false);
  };

  void Promise.all([import('maplibre-gl/dist/maplibre-gl.css'), import('@maplibre/maplibre-gl-leaflet')])
    .then(() => {
      if (disposed) return;
      // The adapter augments Leaflet's CommonJS default object, rather than the
      // namespace wrapper returned by an ESM dynamic import.
      const leafletRuntime = (leaflet as typeof Leaflet & { default?: typeof Leaflet }).default ?? leaflet;
      const vector = leafletRuntime.maplibreGL({
        style: DARK_MAP_STYLE,
        attributionControl: { customAttribution: DARK_ATTRIBUTION },
      });
      layer = vector;
      try {
        vector.addTo(map);
      } catch (error) {
        // The adapter's normal onRemove assumes WebGL construction succeeded.
        // A disabled/unsupported context leaves only its container to clean up.
        if (!vector.getMaplibreMap()) {
          vector.onRemove = () => {
            vector.getContainer()?.remove();
            return vector;
          };
        }
        throw error;
      }
      const renderer = vector.getMaplibreMap();
      const handleError = () => {
        if (!renderer.isStyleLoaded()) useRaster();
      };
      renderer.on('error', handleError);
      renderer.on('webglcontextlost', useRaster);
      detachError = () => {
        renderer.off('error', handleError);
        renderer.off('webglcontextlost', useRaster);
      };
      setDark(true);
    })
    .catch(useRaster);

  return () => {
    disposed = true;
    detachError?.();
    layer?.remove();
  };
}
