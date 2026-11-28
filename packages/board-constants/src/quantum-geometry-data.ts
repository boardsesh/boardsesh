import { QUANTUM_GEOMETRY_METADATA, QUANTUM_GEOMETRY_SHA256 } from './generated/quantum-geometry-metadata';
import loadQuantumGeometryTables from './quantum-geometry-loader.cjs';
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
/** Pinned upstream identity binding; coordinates remain in the source's units. */
export type QuantumSourceDiodeBinding = Readonly<{
  diodeUuid: string;
  placementId: number;
  autocadId: number;
  idLedNode: string;
  type: string;
  x: number;
  y: number;
  z: number;
}>;
type QuantumGeometryTables = {
  holes: Record<string, HoldTuple[]>;
  leds: Record<string, Record<number, number>>;
  sourceDiodes: Record<string, QuantumSourceDiodeBinding[]>;
};
let tables: QuantumGeometryTables | null = null;
const geometryByConfig = new Map<string, QuantumBundledGeometry>();
const sourceDiodesByConfig = new Map<string, readonly QuantumSourceDiodeBinding[]>();

function getTables(): QuantumGeometryTables {
  if (tables) return tables;
  tables = loadQuantumGeometryTables() as QuantumGeometryTables;
  for (const holds of Object.values(tables.holes)) {
    for (const hold of holds) Object.freeze(hold);
    Object.freeze(holds);
  }
  for (const leds of Object.values(tables.leds)) Object.freeze(leds);
  for (const diodes of Object.values(tables.sourceDiodes)) {
    for (const diode of diodes) Object.freeze(diode);
    Object.freeze(diodes);
  }
  Object.freeze(tables.holes);
  Object.freeze(tables.leds);
  Object.freeze(tables.sourceDiodes);
  return tables;
}

/** The same layout/set hold tuples and layout/size LED maps as other boards. */
export function getQuantumHolePlacements(): Record<string, HoldTuple[]> {
  return getTables().holes;
}
export function getQuantumLedPlacements(): Record<string, Record<number, number>> {
  return getTables().leds;
}

/** Resolve API diode UUIDs only through the fixed physical size's known map. */
export function getQuantumSourceDiodeBindings(
  layoutId: number,
  sizeId: number,
): readonly QuantumSourceDiodeBinding[] | null {
  const key = `${layoutId}-${sizeId}`;
  const cached = sourceDiodesByConfig.get(key);
  if (cached) return cached;
  const geometry = getQuantumBundledGeometry(layoutId, sizeId);
  if (!geometry) return null;
  const placements = new Set(geometry.placements.map((placement) => placement.placementId));
  const bindings = Object.freeze(
    (getTables().sourceDiodes[String(layoutId)] ?? []).filter((diode) => placements.has(diode.placementId)),
  );
  if (bindings.length !== geometry.placements.length) throw new Error('Incomplete Quantum source identity bindings');
  sourceDiodesByConfig.set(key, bindings);
  return bindings;
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
