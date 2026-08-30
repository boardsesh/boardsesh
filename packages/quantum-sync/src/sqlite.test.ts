import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUANTUM_SQLITE_AGGREGATE_LIMITS,
  DEFAULT_QUANTUM_SQLITE_ROW_LIMITS,
  openNodeQuantumSqlite,
  validateQuantumSqliteSnapshot,
} from './sqlite';
import { createSyntheticQuantumSqlite } from './test-fixtures';

async function openNodeReaderWithReadRowsProbe(filePath: string, onReadRows: () => void) {
  const reader = await openNodeQuantumSqlite(filePath);
  const readRows = reader.readRows.bind(reader);
  reader.readRows = (...arguments_) => {
    onReadRows();
    return readRows(...arguments_);
  };
  return reader;
}

describe('Quantum SQLite validation', () => {
  it('validates the v1 schema, normalizes source types, and freezes every returned row', async () => {
    const validated = await validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite());

    expect(validated.summary).toEqual({ models: 5, diodes: 5, routes: 1, routeModels: 1, routeLights: 1 });
    expect(validated.rows.diodes[0]).toMatchObject({ placementId: 0, autocadId: 0, ledNode: '0' });
    expect(validated.rows.routes[0]).toMatchObject({ grade: '[12,13]', matching: true, standard: true });
    expect(validated.rows.routeLights[0]?.step).toBe(1);
    expect(Object.isFrozen(validated.rows)).toBe(true);
    expect(Object.isFrozen(validated.rows.diodes)).toBe(true);
    expect(Object.isFrozen(validated.rows.diodes[0])).toBe(true);
  });

  it('rejects schema drift, invalid hardware ids, controller types, UUIDs, and light steps', async () => {
    await expect(validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ userVersion: 2 }))).rejects.toThrow(
      /user_version/,
    );
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ autocadId: '0x10' })),
    ).rejects.toThrow(/decimal string/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeLightStep: 256 })),
    ).rejects.toThrow(/unsigned byte/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ xlForcedType: 'xl' })),
    ).rejects.toThrow(/controller type/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeUuid: 'route-1' })),
    ).rejects.toThrow(/canonical 16-byte UUID/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ appUuid: 'app-route-1-xl' })),
    ).rejects.toThrow(/canonical 16-byte UUID/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ omitRouteModelsUnique: true })),
    ).rejects.toThrow(/unique constraint/);
  });

  it('adapts legacy source L/M layout ids to XL while preserving model sizes and controller types', async () => {
    const validated = await validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite());

    expect(validated.rows.models.filter((model) => ['xl', 'l', 'm'].includes(model.model))).toMatchObject([
      { model: 'xl', layoutId: 9101, productSizeId: 9201, columns: 15, rows: 15, forcedType: 'big' },
      { model: 'l', layoutId: 9101, productSizeId: 9202, columns: 15, rows: 12, forcedType: 'medium' },
      { model: 'm', layoutId: 9101, productSizeId: 9203, columns: 12, rows: 12, forcedType: 'small' },
    ]);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ lLayoutId: 9101 })),
    ).rejects.toThrow(/hardware dimensions, ids, or controller type/);
  });

  it.each([
    { diodeUuid: 'unknown-xl-diode' },
    { placementId: 100 },
    { ledNode: '9999' },
    { autocadId: '9999' },
    { holdType: 'different-hold' },
    { x: 10 },
    { y: 10 },
    { z: 10 },
  ])('rejects shared L/M geometry drift before exposing a common layout: %j', async (lDiode) => {
    await expect(validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ lDiode }))).rejects.toThrow(
      /does not match its shared XL placement/,
    );
  });

  it('retains all 128 distinct lights of a long route without applying the BLE send limit', async () => {
    const validated = await validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeLightCount: 128 }));

    expect(validated.rows.routeLights).toHaveLength(128);
    expect(new Set(validated.rows.routeLights.map((light) => light.diodeUuid)).size).toBe(128);
    expect(validated.rows.routeLights.at(-1)).toMatchObject({ diodeUuid: 'diode-xl-127', step: 3 });
    expect(validated.summary).toMatchObject({ diodes: 132, routeLights: 128 });
  });

  it('still rejects duplicate lights, unknown diodes and malformed long-route steps', async () => {
    await expect(
      validateQuantumSqliteSnapshot(
        await createSyntheticQuantumSqlite({ routeLightCount: 128, duplicateRouteLight: true }),
      ),
    ).rejects.toThrow(/Quantum route light diode mapping is duplicated/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeLightDiodeUuid: 'missing-diode' })),
    ).rejects.toThrow(/dangling reference/);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeLightCount: 128, routeLightStep: 256 })),
    ).rejects.toThrow(/unsigned byte/);
  });

  it('rejects a non-SQLite payload before opening it', async () => {
    await expect(validateQuantumSqliteSnapshot(new TextEncoder().encode('not sqlite'))).rejects.toMatchObject({
      code: 'SQLITE_INVALID',
    });
  });

  it('rejects diode coordinates outside the signed model edges', async () => {
    await expect(validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ diodeX: -0.001 }))).rejects.toThrow(
      /outside xl edges/,
    );
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ diodeY: 100.001 })),
    ).rejects.toThrow(/outside xl edges/);
  });

  it('uses bounded materialization caps and enforces row-limit overrides', async () => {
    expect(DEFAULT_QUANTUM_SQLITE_ROW_LIMITS).toEqual({
      quantum_models: 5,
      quantum_diodes: 5_000,
      quantum_routes: 25_000,
      quantum_route_models: 40_000,
      quantum_route_lights: 350_000,
    });
    expect(DEFAULT_QUANTUM_SQLITE_AGGREGATE_LIMITS).toEqual({
      maxRows: 400_000,
      maxStringBytes: 48 * 1024 * 1024,
    });
    let readRowsCalled = false;
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        rowLimits: { quantum_diodes: 4 },
        openSqlite: (filePath) =>
          openNodeReaderWithReadRowsProbe(filePath, () => {
            readRowsCalled = true;
          }),
      }),
    ).rejects.toThrow(/quantum_diodes exceeds its row cap/);
    expect(readRowsCalled).toBe(false);
  });

  it('enforces aggregate row and string-byte materialization caps', async () => {
    let readRowsCalled = false;
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        aggregateLimits: { maxRows: 12 },
        openSqlite: (filePath) =>
          openNodeReaderWithReadRowsProbe(filePath, () => {
            readRowsCalled = true;
          }),
      }),
    ).rejects.toThrow(/aggregate row cap/);
    expect(readRowsCalled).toBe(false);
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        aggregateLimits: { maxStringBytes: 1 },
      }),
    ).rejects.toThrow(/aggregate string-byte cap/);
  });

  it('rejects oversized dynamic values before row materialization starts', async () => {
    let readRowsCalled = false;
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ routeTips: 'x'.repeat(2_048) }), {
        aggregateLimits: { maxStringBytes: 1_024 },
        openSqlite: (filePath) =>
          openNodeReaderWithReadRowsProbe(filePath, () => {
            readRowsCalled = true;
          }),
      }),
    ).rejects.toThrow(/aggregate string-byte cap/);
    expect(readRowsCalled).toBe(false);
  });

  it('rejects excessive schema objects before schema rows are collected', async () => {
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ extraSchemaObjectCount: 128 })),
    ).rejects.toThrow(/schema exceeds its object cap/);
  });

  it('rejects oversized schema SQL while the object count remains bounded', async () => {
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite({ schemaMetadataPaddingBytes: 1024 * 1024 })),
    ).rejects.toThrow(/schema exceeds its metadata-byte cap/);
  });

  it('does not allow callers to raise row or aggregate safety ceilings', async () => {
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        rowLimits: { quantum_routes: DEFAULT_QUANTUM_SQLITE_ROW_LIMITS.quantum_routes + 1 },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        aggregateLimits: { maxRows: DEFAULT_QUANTUM_SQLITE_AGGREGATE_LIMITS.maxRows + 1 },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
