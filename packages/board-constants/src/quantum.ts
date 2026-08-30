import type { LayoutData, ProductSizeData, SetData } from './types';

/**
 * Stable Boardsesh-side identities for the five Quantum Board models.
 *
 * The numeric ids deliberately live outside the Aurora ranges. They identify
 * Boardsesh catalogue rows; they are not asserted to be manufacturer ids.
 * Geometry calibration and board-art metadata are intentionally absent until
 * the pinned signer's validated catalogue supplies source coordinate bounds.
 */
export const QUANTUM_PRODUCT_ID = 91;
export const QUANTUM_SET_ID = 1;

export const QUANTUM_MODELS = {
  xl: { displayName: 'XL', layoutId: 9101, sizeId: 9201, columns: 15, rows: 15 },
  l: { displayName: 'L', layoutId: 9102, sizeId: 9202, columns: 15, rows: 12 },
  m: { displayName: 'M', layoutId: 9103, sizeId: 9203, columns: 12, rows: 12 },
  s: { displayName: 'S Fitness', layoutId: 9104, sizeId: 9204, columns: 8, rows: 12 },
  belay: { displayName: 'Belay Board', layoutId: 9105, sizeId: 9205, columns: 8, rows: 12 },
} as const;

export type QuantumModelName = keyof typeof QUANTUM_MODELS;

export const QUANTUM_LAYOUTS: Record<number, LayoutData> = Object.fromEntries(
  Object.values(QUANTUM_MODELS).map((model) => [
    model.layoutId,
    { id: model.layoutId, name: model.displayName, productId: QUANTUM_PRODUCT_ID },
  ]),
);

export const QUANTUM_PRODUCT_SIZES: Record<number, ProductSizeData> = Object.fromEntries(
  Object.values(QUANTUM_MODELS).map((model) => [
    model.sizeId,
    {
      id: model.sizeId,
      name: model.displayName,
      description: `${model.columns} columns x ${model.rows} rows`,
      edgeLeft: null,
      edgeRight: null,
      edgeBottom: null,
      edgeTop: null,
      productId: QUANTUM_PRODUCT_ID,
    },
  ]),
);

export const QUANTUM_SET: SetData = { id: QUANTUM_SET_ID, name: 'Default' };

/** Exact product-size/layout/set associations; each model accepts only its size. */
export const QUANTUM_SETS: Record<string, SetData[]> = Object.fromEntries(
  Object.values(QUANTUM_MODELS).map((model) => [`${model.layoutId}-${model.sizeId}`, [{ ...QUANTUM_SET }]]),
);
