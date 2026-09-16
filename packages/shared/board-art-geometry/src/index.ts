export type {
  BoardArtGeometry,
  BoardArtGeometryKey,
  BoardArtGeometryQuery,
  OutlineCounts,
  OutlineCountsTable,
  WallLightness,
  WallLightnessTable,
} from './types';
export { boardArtGeometryKey } from './types';
export {
  boardArtGeometryPending,
  clearBoardArtGeometryCache,
  getOutlineCounts,
  getRuntimeGeometry,
  getWallLightness,
  listBoardArtGeometryKeys,
  loadBoardArtGeometry,
  prefetchBoardArtGeometry,
  registerRuntimeGeometry,
  unregisterRuntimeGeometry,
} from './loader';
export type { VeilInput } from './veil';
export { VEIL_TUNING, oklabLightness, veilOpacityFor } from './veil';
export { SPILL_NEIGHBOUR_RADII, isWithinSpillRange } from './spill';
