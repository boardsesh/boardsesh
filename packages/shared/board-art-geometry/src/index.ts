// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

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
  clearBoardArtGeometryCache,
  getOutlineCounts,
  getWallLightness,
  listBoardArtGeometryKeys,
  loadBoardArtGeometry,
} from './loader';
export type { VeilInput } from './veil';
export { VEIL_TUNING, oklabLightness, veilOpacityFor } from './veil';
export { SPILL_NEIGHBOUR_RADII, isWithinSpillRange } from './spill';
