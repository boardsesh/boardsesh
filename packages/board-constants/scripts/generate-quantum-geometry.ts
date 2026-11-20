/// <reference types="node" />
/** Deterministic source→constants generation, following the Woods map pipeline.
 * No network or database writes. Primary vendor sync will replace this temporary
 * publisher-verified snapshot only after its contract is documented. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadQuantumGeometryTables,
  renderQuantumGeometryData,
  renderQuantumGeometryMetadata,
} from './quantum-geometry-sources';
const source = fileURLToPath(new URL('../../../docs/quantum-board-geometry/catalogue-snapshot.json', import.meta.url));
const tables = loadQuantumGeometryTables(source);
writeFileSync(new URL('../src/generated/quantum-geometry.cjs', import.meta.url), renderQuantumGeometryData(tables));
writeFileSync(
  new URL('../src/generated/quantum-geometry-metadata.ts', import.meta.url),
  renderQuantumGeometryMetadata(tables),
);
