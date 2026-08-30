import { useCallback, useSyncExternalStore } from 'react';
import { QUANTUM_MODELS } from '@boardsesh/board-constants/quantum';
import {
  getQuantumBoardDetails,
  type QuantumBoardDetails,
  type QuantumCanonicalGeometry,
} from '@boardsesh/board-config';

export type QuantumGeometryPlacement = Readonly<{
  placementId: number;
  holeId: number;
  x: number;
  y: number;
  ledPosition: number;
}>;

export type QuantumGeometryRegistration = Readonly<{
  layoutId: number;
  sizeId: number;
  revision: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  placements: readonly QuantumGeometryPlacement[];
}>;

type QuantumGeometryEntry = Readonly<{
  geometry: QuantumGeometryRegistration;
  boardDetails: QuantumBoardDetails;
}>;

type QuantumGeometryListener = () => void;

const geometryByConfig = new Map<string, QuantumGeometryEntry>();
const geometryListeners = new Set<QuantumGeometryListener>();
let geometryRegistryRevision = 0;

function geometryKey(layoutId: number, sizeId: number): string {
  return `${layoutId}:${sizeId}`;
}

function notifyGeometryListeners(): void {
  geometryRegistryRevision += 1;
  for (const listener of geometryListeners) listener();
}

function isCanonicalInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

function normalizeRegistration(registration: QuantumGeometryRegistration): QuantumGeometryEntry | null {
  const revision = registration.revision.trim();
  if (
    revision.length === 0 ||
    !isCanonicalInteger(registration.edgeLeft) ||
    !isCanonicalInteger(registration.edgeRight) ||
    !isCanonicalInteger(registration.edgeBottom) ||
    !isCanonicalInteger(registration.edgeTop)
  ) {
    return null;
  }

  const placements: QuantumGeometryPlacement[] = [];
  for (const placement of registration.placements) {
    if (
      !isCanonicalInteger(placement.placementId) ||
      placement.placementId < 0 ||
      !isCanonicalInteger(placement.holeId) ||
      placement.holeId < 0 ||
      !isCanonicalInteger(placement.x) ||
      !isCanonicalInteger(placement.y) ||
      !isCanonicalInteger(placement.ledPosition) ||
      placement.ledPosition < 0 ||
      placement.ledPosition > 65_535
    ) {
      return null;
    }
    placements.push(Object.freeze({ ...placement }));
  }

  const canonicalGeometry: QuantumCanonicalGeometry = {
    layoutId: registration.layoutId,
    sizeId: registration.sizeId,
    edgeLeft: registration.edgeLeft,
    edgeRight: registration.edgeRight,
    edgeBottom: registration.edgeBottom,
    edgeTop: registration.edgeTop,
    placements: placements.map((placement) => ({ id: placement.placementId, x: placement.x, y: placement.y })),
  };
  const boardDetails = getQuantumBoardDetails(canonicalGeometry);
  if (!boardDetails) return null;

  const geometry: QuantumGeometryRegistration = Object.freeze({
    ...registration,
    revision,
    placements: Object.freeze(placements),
  });
  return Object.freeze({ geometry, boardDetails });
}

/**
 * Install one authoritative Quantum model geometry after GraphQL/SQLite
 * hydration. Returns false and leaves the last known-good entry untouched when
 * the payload is malformed or the layout/size pair is not an exact model.
 */
export function registerQuantumGeometry(registration: QuantumGeometryRegistration): boolean {
  const entry = normalizeRegistration(registration);
  if (!entry) return false;
  const key = geometryKey(registration.layoutId, registration.sizeId);
  const current = geometryByConfig.get(key);
  if (current?.geometry.revision === entry.geometry.revision) return true;
  geometryByConfig.set(key, entry);
  notifyGeometryListeners();
  return true;
}

export function unregisterQuantumGeometry(layoutId: number, sizeId: number): void {
  if (!geometryByConfig.delete(geometryKey(layoutId, sizeId))) return;
  notifyGeometryListeners();
}

export function getQuantumGeometry(layoutId: number, sizeId: number): QuantumGeometryRegistration | null {
  return geometryByConfig.get(geometryKey(layoutId, sizeId))?.geometry ?? null;
}

export function getQuantumGeometryBoardDetails(layoutId: number, sizeId: number): QuantumBoardDetails | null {
  return geometryByConfig.get(geometryKey(layoutId, sizeId))?.boardDetails ?? null;
}

export function subscribeQuantumGeometry(listener: QuantumGeometryListener): () => void {
  geometryListeners.add(listener);
  return () => {
    geometryListeners.delete(listener);
  };
}

export function getQuantumGeometryRegistryRevision(): number {
  return geometryRegistryRevision;
}

export function hasCompleteQuantumGeometryCatalog(): boolean {
  return Object.values(QUANTUM_MODELS).every((model) =>
    geometryByConfig.has(geometryKey(model.layoutId, model.sizeId)),
  );
}

const subscribeToNothing = (): (() => void) => () => undefined;
const missingGeometrySnapshot = (): null => null;

/** Reactive selected-model geometry for render/create surfaces. */
export function useQuantumGeometry(
  layoutId: number,
  sizeId: number,
  enabled = true,
): QuantumGeometryRegistration | null {
  const getSnapshot = useCallback(
    () => (enabled ? getQuantumGeometry(layoutId, sizeId) : null),
    [enabled, layoutId, sizeId],
  );
  return useSyncExternalStore(
    enabled ? subscribeQuantumGeometry : subscribeToNothing,
    getSnapshot,
    missingGeometrySnapshot,
  );
}

/** Reactive feature gate for exposing the five-model Quantum picker. */
export function useHasCompleteQuantumGeometryCatalog(): boolean {
  useSyncExternalStore(
    subscribeQuantumGeometry,
    getQuantumGeometryRegistryRevision,
    getQuantumGeometryRegistryRevision,
  );
  return hasCompleteQuantumGeometryCatalog();
}
