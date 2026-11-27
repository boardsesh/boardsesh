import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadQuantumGeometryTables,
  renderQuantumGeometryData,
  renderQuantumGeometryMetadata,
  type QuantumGeometrySource,
} from './quantum-geometry-sources';
const sourcePath = new URL('../../../docs/quantum-board-geometry/catalogue-snapshot.json', import.meta.url);
const load = () => loadQuantumGeometryTables(sourcePath.pathname);

describe('fixed Quantum source and generated map', () => {
  it('pins both committed artifacts to the approved snapshot', () => {
    const tables = load();
    expect(readFileSync(new URL('../src/generated/quantum-geometry.cjs', import.meta.url), 'utf8')).toBe(
      renderQuantumGeometryData(tables),
    );
    expect(readFileSync(new URL('../src/generated/quantum-geometry-metadata.ts', import.meta.url), 'utf8')).toBe(
      renderQuantumGeometryMetadata(tables),
    );
    expect(tables.sourceSha256).toBe('f670b25bc8deb68d05929e95efa27500d824d0b2371456616b471c11b90c9303');
    expect(
      Object.fromEntries(Object.entries(tables.models).map(([model, metadata]) => [model, metadata.holdCount])),
    ).toEqual({ xl: 657, l: 549, m: 432, s: 252, belay: 1264 });
  });
  it('keeps S and Belay outside the common standard layout', () => {
    const tables = load();
    expect(Object.keys(tables.holes)).toEqual(['9101-1', '9104-1', '9105-1']);
    expect(tables.models.xl.layoutId).toBe(tables.models.m.layoutId);
    expect(tables.models.belay.layoutId).toBe(9105);
  });
  it('keeps hardware identity independent of row order and snapshot provenance', () => {
    const baseline = load();
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as QuantumGeometrySource;
    source.models.reverse();
    source.diodes.reverse();
    source.provenance = { source: 'updated acquisition evidence' };
    const directory = mkdtempSync(join(tmpdir(), 'quantum-hardware-identity-'));
    try {
      const reordered = join(directory, 'source.json');
      writeFileSync(reordered, JSON.stringify(source));
      const actual = loadQuantumGeometryTables(reordered);
      expect(actual.hardwareFingerprint).toBe(baseline.hardwareFingerprint);
      expect(actual.geometrySha256).toBe(baseline.geometrySha256);
      expect(actual.sourceDiodes).toEqual(baseline.sourceDiodes);
      expect(actual.sourceSha256).not.toBe(baseline.sourceSha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a standard-family remap instead of silently shipping mutable geometry', () => {
    const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as QuantumGeometrySource;
    const diode = source.diodes.find((row) => row.model === 'm')!;
    diode.x += 0.01;
    const directory = mkdtempSync(join(tmpdir(), 'quantum-map-drift-'));
    try {
      const changed = join(directory, 'source.json');
      writeFileSync(changed, JSON.stringify(source));
      expect(() => loadQuantumGeometryTables(changed)).toThrow(/Shared Quantum/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
