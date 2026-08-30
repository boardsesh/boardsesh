/// <reference types="node" />
import { QUANTUM_GEOMETRY_METADATA, QUANTUM_GEOMETRY_SHA256 } from './generated/quantum-geometry-metadata';
import type { HoldTuple } from './types';

export type QuantumGeometryPlacement = Readonly<{
  placementId: number;
  holeId: number;
  x: number;
  y: number;
  ledPosition: number;
}>;
export type QuantumBundledGeometry = Readonly<{
  layoutId: number;
  sizeId: number;
  revision: string;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  placements: readonly QuantumGeometryPlacement[];
}>;
type QuantumGeometryTables = { holes: Record<string, HoldTuple[]>; leds: Record<string, Record<number, number>> };
let tables: QuantumGeometryTables | null = null;
const geometryByConfig = new Map<string, QuantumBundledGeometry>();

function getTables(): QuantumGeometryTables {
  if (tables) return tables;
  // Literal requires keep the fixed data out of every other board's startup.
  if (typeof require === 'function') {
    tables = require('./generated/quantum-geometry.cjs') as QuantumGeometryTables;
  } else {
    const builtin = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(
      'node:module',
    ) as {
      createRequire(path: string): (id: string) => unknown;
    };
    tables = builtin.createRequire(import.meta.url)('./generated/quantum-geometry.cjs') as QuantumGeometryTables;
  }
  for (const holds of Object.values(tables.holes)) {
    for (const hold of holds) Object.freeze(hold);
    Object.freeze(holds);
  }
  for (const leds of Object.values(tables.leds)) Object.freeze(leds);
  Object.freeze(tables.holes);
  Object.freeze(tables.leds);
  return tables;
}

/** The same layout/set hold tuples and layout/size LED maps as other boards. */
export function getQuantumHolePlacements(): Record<string, HoldTuple[]> {
  return getTables().holes;
}
export function getQuantumLedPlacements(): Record<string, Record<number, number>> {
  return getTables().leds;
}

/** Fixed geometry is shipped with the app. No server, SQLite or registration
 * can replace this physical hold/LED map while the app is running. */
export function getQuantumBundledGeometry(layoutId: number, sizeId: number): QuantumBundledGeometry | null {
  const metadata = Object.values(QUANTUM_GEOMETRY_METADATA).find(
    (model) => model.layoutId === layoutId && model.sizeId === sizeId,
  );
  if (!metadata) return null;
  const key = `${layoutId}-${sizeId}`;
  const cached = geometryByConfig.get(key);
  if (cached) return cached;
  const source = getTables();
  const leds = source.leds[key];
  const holds = source.holes[`${layoutId}-1`];
  if (!leds || !holds) return null;
  const placements = holds.flatMap(([placementId, , x, y]) => {
    const ledPosition = leds[placementId];
    return ledPosition === undefined ? [] : [Object.freeze({ placementId, holeId: placementId, x, y, ledPosition })];
  });
  if (placements.length !== metadata.holdCount) return null;
  const geometry = Object.freeze({
    layoutId,
    sizeId,
    revision: QUANTUM_GEOMETRY_SHA256,
    edgeLeft: metadata.edgeLeft,
    edgeRight: metadata.edgeRight,
    edgeBottom: metadata.edgeBottom,
    edgeTop: metadata.edgeTop,
    placements: Object.freeze(placements),
  });
  geometryByConfig.set(key, geometry);
  return geometry;
}
