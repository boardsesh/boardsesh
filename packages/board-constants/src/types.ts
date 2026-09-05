// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import type { BoardName } from '@boardsesh/shared-schema';

export type { BoardName };

export type ProductSizeData = {
  id: number;
  name: string;
  description: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
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

export type HoldTuple = [number, number | null, number, number];

export type LedPositionWithColor = {
  position: number;
  r: number;
  g: number;
  b: number;
  role?: number;
};
