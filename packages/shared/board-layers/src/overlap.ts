import { MAX_ACTIVE_BOARD_LAYERS, MAX_DIODES_PER_LAYER } from './layers';

export const QUANTUM_OVERLAP_FILTERS = ['off', 'none', 'at_most_one'] as const;
export type QuantumOverlapFilter = (typeof QUANTUM_OVERLAP_FILTERS)[number];

export type OccupiedPlacementIndex = {
  geometryKnown: boolean;
  placementIds: ReadonlySet<number>;
};

export type LayerPlacementPresence = {
  geometryKnown: boolean;
  placementIds: readonly number[];
};

/**
 * Parse one canonical Boardsesh frame into placement ids safe to expose in
 * party presence. A partial parse is unknown so overlap filtering fails open
 * when catalogue geometry is malformed.
 */
export function parseBoardLayerPlacementIds(frames: string | null | undefined): number[] | null {
  if (!frames) return null;
  const placementIds: number[] = [];
  const seenPlacementIds = new Set<number>();
  const framePattern = /p(\d+)r-?\d+/g;
  let consumedLength = 0;
  let match: RegExpExecArray | null;

  while ((match = framePattern.exec(frames)) !== null) {
    if (match.index !== consumedLength) return null;
    consumedLength += match[0].length;
    const placementId = Number(match[1]);
    if (!Number.isSafeInteger(placementId) || placementId < 0 || seenPlacementIds.has(placementId)) return null;
    seenPlacementIds.add(placementId);
    placementIds.push(placementId);
  }

  if (consumedLength !== frames.length || placementIds.length === 0 || placementIds.length > MAX_DIODES_PER_LAYER) {
    return null;
  }
  return placementIds;
}

export function buildOccupiedPlacementIndex(
  controllerRouteUuids: readonly string[],
  placementsByControllerRoute: ReadonlyMap<string, readonly number[]>,
): OccupiedPlacementIndex {
  const placementIds = new Set<number>();
  if (controllerRouteUuids.length > MAX_ACTIVE_BOARD_LAYERS) {
    return { geometryKnown: false, placementIds };
  }

  for (const controllerRouteUuid of controllerRouteUuids) {
    const routePlacements = placementsByControllerRoute.get(controllerRouteUuid.toLowerCase());
    if (!routePlacements || routePlacements.length === 0 || routePlacements.length > MAX_DIODES_PER_LAYER) {
      return { geometryKnown: false, placementIds: new Set() };
    }
    for (const placementId of routePlacements) {
      if (!Number.isSafeInteger(placementId) || placementId < 0) {
        return { geometryKnown: false, placementIds: new Set() };
      }
      placementIds.add(placementId);
    }
  }

  if (placementIds.size > MAX_ACTIVE_BOARD_LAYERS * MAX_DIODES_PER_LAYER) {
    return { geometryKnown: false, placementIds: new Set() };
  }
  return { geometryKnown: true, placementIds };
}

/** Build the filter input from the sanitized party roster, never controller ids. */
export function buildOccupiedPlacementIndexFromPresence(
  layers: readonly LayerPlacementPresence[],
): OccupiedPlacementIndex {
  const placementIds = new Set<number>();
  if (layers.length > MAX_ACTIVE_BOARD_LAYERS) return { geometryKnown: false, placementIds };

  for (const layer of layers) {
    if (!layer.geometryKnown || layer.placementIds.length === 0 || layer.placementIds.length > MAX_DIODES_PER_LAYER) {
      return { geometryKnown: false, placementIds: new Set() };
    }
    for (const placementId of layer.placementIds) {
      if (!Number.isSafeInteger(placementId) || placementId < 0) {
        return { geometryKnown: false, placementIds: new Set() };
      }
      placementIds.add(placementId);
    }
  }

  return { geometryKnown: true, placementIds };
}

export function countPlacementOverlap(
  climbPlacementIds: readonly number[],
  occupiedPlacementIds: ReadonlySet<number>,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let overlap = 0;
  const seen = new Set<number>();
  for (const placementId of climbPlacementIds) {
    if (seen.has(placementId)) continue;
    seen.add(placementId);
    if (occupiedPlacementIds.has(placementId)) {
      overlap += 1;
      if (overlap > stopAfter) return overlap;
    }
  }
  return overlap;
}

/** Unknown controller geometry disables the filter instead of hiding climbs. */
export function matchesQuantumOverlapFilter(
  climbPlacementIds: readonly number[],
  occupied: OccupiedPlacementIndex,
  filter: QuantumOverlapFilter,
): boolean {
  if (filter === 'off' || !occupied.geometryKnown) return true;
  const maximumOverlap = filter === 'none' ? 0 : 1;
  return countPlacementOverlap(climbPlacementIds, occupied.placementIds, maximumOverlap) <= maximumOverlap;
}
