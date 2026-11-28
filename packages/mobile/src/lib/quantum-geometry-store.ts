import {
  getQuantumBundledGeometry,
  QUANTUM_GEOMETRY_SHA256,
  QUANTUM_MODELS,
  type QuantumBundledGeometry,
  type QuantumGeometryPlacement,
} from '@boardsesh/board-constants/quantum';
import { getQuantumBoardDetails, projectQuantumBoardArtwork, type QuantumBoardDetails } from '@boardsesh/board-config';

/** Fixed app-bundled map, matching the usual board-constants hold/LED tables.
 * The old module name stays as a compatibility import boundary; there is no
 * registry, registration, network hydration or device cache behind it. */
export type QuantumGeometryRegistration = QuantumBundledGeometry;
export type { QuantumGeometryPlacement };
const detailsByGeometry = new WeakMap<QuantumBundledGeometry, QuantumBoardDetails>();
const BUNDLED_GENERATION = Number.parseInt(QUANTUM_GEOMETRY_SHA256.slice(0, 12), 16);

export const getQuantumGeometry = getQuantumBundledGeometry;
export function getQuantumGeometryGeneration(layoutId: number, sizeId: number): number | null {
  return getQuantumBundledGeometry(layoutId, sizeId) ? BUNDLED_GENERATION : null;
}
export function getQuantumGeometryBoardDetails(layoutId: number, sizeId: number): QuantumBoardDetails | null {
  const geometry = getQuantumBundledGeometry(layoutId, sizeId);
  if (!geometry) return null;
  const cached = detailsByGeometry.get(geometry);
  if (cached) return cached;
  const details = getQuantumBoardDetails({
    ...geometry,
    placements: geometry.placements.map((placement) => ({ id: placement.placementId, x: placement.x, y: placement.y })),
  });
  if (!details) return null;
  const projectedDetails = projectQuantumBoardArtwork(details);
  detailsByGeometry.set(geometry, projectedDetails);
  return projectedDetails;
}
export function hasCompleteQuantumGeometryCatalog(): boolean {
  return Object.values(QUANTUM_MODELS).every(
    (model) => getQuantumBundledGeometry(model.layoutId, model.sizeId) !== null,
  );
}
export function useQuantumGeometry(layoutId: number, sizeId: number, enabled = true): QuantumBundledGeometry | null {
  return enabled ? getQuantumBundledGeometry(layoutId, sizeId) : null;
}
