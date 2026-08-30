import type { BoardName } from '@boardsesh/shared-schema';

export type { BoardName };

export type ProductSizeData = {
  id: number;
  name: string;
  description: string;
  /** Null until a board catalogue supplies calibrated source-coordinate bounds. */
  edgeLeft: number | null;
  edgeRight: number | null;
  edgeBottom: number | null;
  edgeTop: number | null;
  productId: number;
};

export type LayoutData = {
  id: number;
  name: string;
  productId: number;
};

export type SetData = {
  id: number;
  name: string;
};

export type SizeEdges = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

export type ProductSizeWithEdges = ProductSizeData & SizeEdges;

export type HoldTuple = [number, number | null, number, number];

export type LedPositionWithColor = {
  position: number;
  r: number;
  g: number;
  b: number;
  role?: number;
};
