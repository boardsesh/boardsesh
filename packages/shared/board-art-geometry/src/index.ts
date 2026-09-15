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
  getWallLightness,
  listBoardArtGeometryKeys,
  loadBoardArtGeometry,
  prefetchBoardArtGeometry,
} from './loader';
export type { VeilInput } from './veil';
export { VEIL_TUNING, oklabLightness, veilOpacityFor } from './veil';
export { SPILL_NEIGHBOUR_RADII, isWithinSpillRange } from './spill';
