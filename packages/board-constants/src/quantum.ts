import type { LayoutData, ProductSizeData, SetData } from './types';
import { QUANTUM_GEOMETRY_METADATA } from './generated/quantum-geometry-metadata';
export {
  getQuantumBundledGeometry,
  getQuantumHolePlacements,
  getQuantumLedPlacements,
  getQuantumSourceDiodeBindings,
  type QuantumBundledGeometry,
  type QuantumGeometryPlacement,
  type QuantumSourceDiodeBinding,
} from './quantum-geometry-data';
export {
  QUANTUM_GEOMETRY_SHA256,
  QUANTUM_GEOMETRY_SOURCE_SHA256,
  QUANTUM_HARDWARE_FINGERPRINT,
} from './generated/quantum-geometry-metadata';

/**
 * Stable Boardsesh-side identities for the five Quantum Board models.
 *
 * The numeric ids deliberately live outside the Aurora ranges. They identify
 * Boardsesh catalogue rows; they are not asserted to be manufacturer ids.
 * XL/L/M share one fixed hold layout and differ by size membership. S and
 * Belay use separate physical families; controller metadata remains model-specific.
 */
export const QUANTUM_PRODUCT_ID = 91;
export const QUANTUM_SET_ID = 1;

export const QUANTUM_MODELS = {
  xl: { displayName: 'XL', layoutId: 9101, sizeId: 9201, columns: 15, rows: 15 },
  l: { displayName: 'L', layoutId: 9101, sizeId: 9202, columns: 15, rows: 12 },
  m: { displayName: 'M', layoutId: 9101, sizeId: 9203, columns: 12, rows: 12 },
  s: { displayName: 'S Fitness', layoutId: 9104, sizeId: 9204, columns: 8, rows: 12 },
  belay: { displayName: 'Belay Board', layoutId: 9105, sizeId: 9205, columns: 8, rows: 12 },
} as const;

export type QuantumModelName = keyof typeof QUANTUM_MODELS;

/** eWalls 2.6.5 board-picker identities; unrelated to diode type labels. */
export const QUANTUM_MODEL_BY_EWALLS_TYPE = {
  big: 'xl',
  medium: 'l',
  small: 'm',
  xsmall: 's',
  belay: 'belay',
} as const satisfies Readonly<Record<string, QuantumModelName>>;

export const QUANTUM_PRODUCT_IDS = { standard: 91, s: 94, belay: 95 } as const;

export const QUANTUM_LAYOUTS: Record<number, LayoutData> = {
  9101: { id: 9101, name: 'Standard', productId: QUANTUM_PRODUCT_IDS.standard },
  9104: { id: 9104, name: 'S Fitness', productId: QUANTUM_PRODUCT_IDS.s },
  9105: { id: 9105, name: 'Belay Board', productId: QUANTUM_PRODUCT_IDS.belay },
};

/** Shared physical hold identity, independent of a standard-family board size. */
export function getQuantumPlacementId(layoutId: number, sourcePlacementId: number): number {
  if (!Number.isSafeInteger(layoutId) || !Object.hasOwn(QUANTUM_LAYOUTS, layoutId))
    throw new Error(`Unsupported Quantum layout ${layoutId}`);
  if (!Number.isSafeInteger(sourcePlacementId) || sourcePlacementId < 0 || sourcePlacementId >= 1_000_000) {
    throw new Error('Quantum source placement id must be between 0 and 999999');
  }
  return (layoutId - 9100) * 1_000_000 + sourcePlacementId;
}

/** Preserve the catalogue coordinate scale used by stored hold rows. */
export function scaleQuantumGeometryCoordinate(coordinate: number): number {
  const scaled = Math.trunc(coordinate * 1000);
  if (
    !Number.isFinite(coordinate) ||
    !Number.isSafeInteger(scaled) ||
    scaled < -2_147_483_648 ||
    scaled > 2_147_483_647
  ) {
    throw new Error('Quantum coordinate must fit a PostgreSQL integer after scaling');
  }
  return scaled;
}

export const QUANTUM_PRODUCT_SIZES: Record<number, ProductSizeData> = Object.fromEntries(
  Object.entries(QUANTUM_MODELS).map(([key, model]) => [
    model.sizeId,
    {
      id: model.sizeId,
      name: model.displayName,
      description: `${model.columns} columns x ${model.rows} rows`,
      edgeLeft: QUANTUM_GEOMETRY_METADATA[key as QuantumModelName].edgeLeft,
      edgeRight: QUANTUM_GEOMETRY_METADATA[key as QuantumModelName].edgeRight,
      edgeBottom: QUANTUM_GEOMETRY_METADATA[key as QuantumModelName].edgeBottom,
      edgeTop: QUANTUM_GEOMETRY_METADATA[key as QuantumModelName].edgeTop,
      productId: QUANTUM_LAYOUTS[model.layoutId]!.productId,
    },
  ]),
);

export const QUANTUM_SET: SetData = { id: QUANTUM_SET_ID, name: 'Default' };

/** Standard sizes share one layout; unrelated physical families stay separate. */
export const QUANTUM_SETS: Record<string, SetData[]> = Object.fromEntries(
  Object.values(QUANTUM_MODELS).map((model) => [`${model.layoutId}-${model.sizeId}`, [{ ...QUANTUM_SET }]]),
);
