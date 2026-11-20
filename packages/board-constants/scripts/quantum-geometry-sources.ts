/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  QUANTUM_MODELS,
  QUANTUM_SET_ID,
  getQuantumPlacementId,
  scaleQuantumGeometryCoordinate,
  type QuantumModelName,
} from '../src/quantum';
import type { HoldTuple } from '../src/types';
import type { QuantumSourceDiodeBinding } from '../src/quantum-geometry-data';

type SourceModel = {
  model: QuantumModelName;
  name: string;
  forcedType: string;
  columns: number;
  rows: number;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};
type SourceDiode = {
  model: QuantumModelName;
  diodeUuid: string;
  placementId: number;
  autocadId: number;
  ledNode: string;
  holdType: string;
  x: number;
  y: number;
  z: number;
};
export type QuantumGeometrySource = {
  models: SourceModel[];
  diodes: SourceDiode[];
  provenance: Record<string, unknown>;
};
export type QuantumGeometryMetadata = {
  layoutId: number;
  sizeId: number;
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
  holdCount: number;
};
export type QuantumGeometryTables = {
  models: Record<QuantumModelName, QuantumGeometryMetadata>;
  holes: Record<string, HoldTuple[]>;
  leds: Record<string, Record<number, number>>;
  sourceDiodes: Record<string, QuantumSourceDiodeBinding[]>;
  sourceSha256: string;
  geometrySha256: string;
  hardwareFingerprint: string;
};

export function loadQuantumGeometryTables(sourcePath: string): QuantumGeometryTables {
  const sourceText = readFileSync(sourcePath, 'utf8');
  const source = JSON.parse(sourceText) as QuantumGeometrySource;
  const sourceSha256 = createHash('sha256').update(sourceText).digest('hex');
  if (!Array.isArray(source.models) || !Array.isArray(source.diodes) || !source.provenance)
    throw new Error('Invalid Quantum geometry source');
  const models = {} as QuantumGeometryTables['models'];
  const holesByLayout = new Map<string, Map<number, HoldTuple>>();
  const leds: QuantumGeometryTables['leds'] = {};
  const canonicalByUuid = new Map<string, string>();
  const sourceDiodesByLayout = new Map<number, Map<string, QuantumSourceDiodeBinding>>();
  const sourceModels = new Map(source.models.map((model) => [model.model, model]));
  if (sourceModels.size !== Object.keys(QUANTUM_MODELS).length)
    throw new Error('Quantum source must contain exactly the supported models');
  for (const [modelName, model] of Object.entries(QUANTUM_MODELS) as [
    QuantumModelName,
    (typeof QUANTUM_MODELS)[QuantumModelName],
  ][]) {
    const sourceModel = sourceModels.get(modelName);
    if (!sourceModel || sourceModel.columns !== model.columns || sourceModel.rows !== model.rows)
      throw new Error(`Invalid Quantum ${modelName} model metadata`);
    const bounds = Object.fromEntries(
      ['edgeLeft', 'edgeRight', 'edgeBottom', 'edgeTop'].map((key) => [
        key,
        scaleQuantumGeometryCoordinate(sourceModel[key as 'edgeLeft' | 'edgeRight' | 'edgeBottom' | 'edgeTop']),
      ]),
    ) as Pick<QuantumGeometryMetadata, 'edgeLeft' | 'edgeRight' | 'edgeBottom' | 'edgeTop'>;
    if (bounds.edgeLeft >= bounds.edgeRight || bounds.edgeBottom >= bounds.edgeTop)
      throw new Error(`Invalid Quantum ${modelName} source bounds`);
    const sourceDiodes = source.diodes
      .filter((diode) => diode.model === modelName)
      .sort((first, second) => first.placementId - second.placementId);
    if (sourceDiodes.length === 0) throw new Error(`Missing Quantum ${modelName} diodes`);
    const membership: Record<number, number> = {};
    const seenUuids = new Set<string>();
    const seenLeds = new Set<number>();
    const holesKey = `${model.layoutId}-${QUANTUM_SET_ID}`;
    const layoutHoles = holesByLayout.get(holesKey) ?? new Map<number, HoldTuple>();
    holesByLayout.set(holesKey, layoutHoles);
    for (const diode of sourceDiodes) {
      if (
        diode.placementId !== diode.autocadId ||
        !Number.isSafeInteger(diode.autocadId) ||
        diode.autocadId < 0 ||
        diode.autocadId > 65_535 ||
        seenUuids.has(diode.diodeUuid) ||
        seenLeds.has(diode.autocadId)
      )
        throw new Error(`Invalid or duplicate Quantum ${modelName} diode identity`);
      seenUuids.add(diode.diodeUuid);
      seenLeds.add(diode.autocadId);
      const id = getQuantumPlacementId(model.layoutId, diode.placementId);
      const x = scaleQuantumGeometryCoordinate(diode.x);
      const y = scaleQuantumGeometryCoordinate(diode.y);
      if (
        x < bounds.edgeLeft ||
        x > bounds.edgeRight ||
        y < bounds.edgeBottom ||
        y > bounds.edgeTop ||
        !Number.isFinite(diode.z)
      )
        throw new Error(`Quantum ${modelName} diode is outside source bounds`);
      const tuple: HoldTuple = [id, null, x, y];
      const canonical = JSON.stringify([
        diode.placementId,
        diode.autocadId,
        diode.ledNode,
        diode.x,
        diode.y,
        diode.z,
        diode.holdType,
      ]);
      const uuidKey = `${model.layoutId}:${diode.diodeUuid}`;
      if (canonicalByUuid.has(uuidKey) && canonicalByUuid.get(uuidKey) !== canonical)
        throw new Error('Shared Quantum diode UUID changed across sizes');
      canonicalByUuid.set(uuidKey, canonical);
      const layoutSourceDiodes =
        sourceDiodesByLayout.get(model.layoutId) ?? new Map<string, QuantumSourceDiodeBinding>();
      sourceDiodesByLayout.set(model.layoutId, layoutSourceDiodes);
      layoutSourceDiodes.set(diode.diodeUuid, {
        diodeUuid: diode.diodeUuid,
        placementId: id,
        autocadId: diode.autocadId,
        idLedNode: diode.ledNode,
        type: diode.holdType,
        x: diode.x,
        y: diode.y,
        z: diode.z,
      });
      const previous = layoutHoles.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(tuple))
        throw new Error('Shared Quantum placement changed across sizes');
      layoutHoles.set(id, tuple);
      membership[id] = diode.autocadId;
    }
    models[modelName] = { layoutId: model.layoutId, sizeId: model.sizeId, ...bounds, holdCount: sourceDiodes.length };
    leds[`${model.layoutId}-${model.sizeId}`] = membership;
  }
  for (const smaller of ['l', 'm'] as const) {
    const xlIds = new Set(source.diodes.filter((diode) => diode.model === 'xl').map((diode) => diode.diodeUuid));
    if (source.diodes.some((diode) => diode.model === smaller && !xlIds.has(diode.diodeUuid)))
      throw new Error(`Quantum ${smaller} is not an XL subset`);
  }
  const holes = Object.fromEntries(
    [...holesByLayout]
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, tuples]) => [key, [...tuples.values()].sort((first, second) => first[0] - second[0])]),
  );
  const geometrySha256 = createHash('sha256')
    .update(JSON.stringify([models, holes, leds]))
    .digest('hex');
  // Contract shared with backend computeQuantumHardwareFingerprint: model rows
  // sorted by model; diode rows sorted by model, source placementId, UUID. All
  // raw physical fields are retained. Only our internal catalogue IDs normalize.
  const canonicalModels = [...source.models]
    .sort((first, second) => first.model.localeCompare(second.model))
    .map((model) => [
      model.model,
      QUANTUM_MODELS[model.model].layoutId,
      QUANTUM_MODELS[model.model].sizeId,
      model.name,
      model.columns,
      model.rows,
      model.forcedType,
      model.edgeLeft,
      model.edgeRight,
      model.edgeBottom,
      model.edgeTop,
    ]);
  const canonicalDiodes = [...source.diodes]
    .sort(
      (first, second) =>
        first.model.localeCompare(second.model) ||
        first.placementId - second.placementId ||
        first.diodeUuid.localeCompare(second.diodeUuid),
    )
    .map((diode) => [
      diode.model,
      diode.diodeUuid,
      diode.placementId,
      diode.ledNode,
      diode.autocadId,
      diode.holdType,
      diode.x,
      diode.y,
      diode.z,
    ]);
  const hardwareFingerprint = createHash('sha256')
    .update(JSON.stringify([canonicalModels, canonicalDiodes]))
    .digest('hex');
  const sourceDiodes = Object.fromEntries(
    [...sourceDiodesByLayout]
      .sort(([first], [second]) => first - second)
      .map(([layoutId, diodes]) => [
        String(layoutId),
        [...diodes.values()].sort((first, second) => first.placementId - second.placementId),
      ]),
  );
  return { models, holes, leds, sourceDiodes, sourceSha256, geometrySha256, hardwareFingerprint };
}

export function renderQuantumGeometryData(tables: QuantumGeometryTables): string {
  const holes = Object.entries(tables.holes)
    .map(
      ([key, tuples]) =>
        `    '${key}': [\n${tuples.map((tuple) => `      [${tuple.map((entry) => (entry === null ? 'null' : String(entry))).join(', ')}],`).join('\n')}\n    ],`,
    )
    .join('\n');
  const leds = Object.entries(tables.leds)
    .map(
      ([key, placements]) =>
        `    '${key}': {\n${Object.entries(placements)
          .map(([id, led]) => `      ${id}: ${led},`)
          .join('\n')}\n    },`,
    )
    .join('\n');
  const sourceDiodes = Object.entries(tables.sourceDiodes)
    .map(([layoutId, diodes]) => `    '${layoutId}': ${JSON.stringify(diodes)},`)
    .join('\n');
  return `// Generated by generate-quantum-geometry.ts; do not edit.\n// Temporary snapshot provenance: docs/quantum-board-geometry/catalogue-snapshot.json\n// Geometry SHA256: ${tables.geometrySha256}\n// Hardware fingerprint: ${tables.hardwareFingerprint}\nmodule.exports = {\n  holes: {\n${holes}\n  },\n  leds: {\n${leds}\n  },\n  sourceDiodes: {\n${sourceDiodes}\n  },\n};\n`;
}

export function renderQuantumGeometryMetadata(tables: QuantumGeometryTables): string {
  return `// Generated by generate-quantum-geometry.ts; do not edit.\n// Snapshot source: docs/quantum-board-geometry/catalogue-snapshot.json\nexport const QUANTUM_GEOMETRY_SOURCE_SHA256 = '${tables.sourceSha256}';\nexport const QUANTUM_GEOMETRY_SHA256 = '${tables.geometrySha256}';\nexport const QUANTUM_HARDWARE_FINGERPRINT = '${tables.hardwareFingerprint}';\nexport const QUANTUM_GEOMETRY_METADATA = ${JSON.stringify(tables.models, null, 2)} as const;\n`;
}
