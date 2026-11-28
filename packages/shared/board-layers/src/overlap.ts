import { MAX_ACTIVE_BOARD_LAYERS, MAX_DIODES_PER_LAYER } from './layers';

// The values are persisted in the saved search's board filters; keep them.
const LAYER_OVERLAP_FILTERS = ['off', 'none', 'at_most_one'] as const;
export type BoardOverlapFilter = (typeof LAYER_OVERLAP_FILTERS)[number];

export function isLayerOverlapFilter(value: string): value is BoardOverlapFilter {
  return (LAYER_OVERLAP_FILTERS as readonly string[]).includes(value);
}

export type OccupiedPlacementIndex = {
  geometryKnown: boolean;
  placementIds: ReadonlySet<number>;
};

type LayerPlacementPresence = {
  geometryKnown: boolean;
  placementIds: readonly number[];
};

/**
 * Parse one canonical Boardsesh frame into placement ids safe to expose in
 * party presence. A partial parse is unknown so overlap filtering fails open
 * when catalogue geometry is malformed.
 */
export function parseBoardLayerPlacementIds(
  frames: string | null | undefined,
  maximumPlacements = MAX_DIODES_PER_LAYER,
): number[] | null {
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
    if (placementIds.length > maximumPlacements) return null;
  }

  if (consumedLength !== frames.length || placementIds.length === 0) {
    return null;
  }
  return placementIds;
}

/** Build the filter input from the sanitized party roster, never controller ids. */
function buildOccupiedPlacementIndexFromPresence(layers: readonly LayerPlacementPresence[]): OccupiedPlacementIndex {
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

/** The caller supplies the selected wall's scoped presence snapshot. */
export function buildOccupiedPlacementIndexFromSnapshot(
  snapshot: { stale: boolean; layers: readonly LayerPlacementPresence[] } | null | undefined,
): OccupiedPlacementIndex {
  if (!snapshot || snapshot.stale) {
    return { geometryKnown: false, placementIds: new Set() };
  }
  return buildOccupiedPlacementIndexFromPresence(snapshot.layers);
}
