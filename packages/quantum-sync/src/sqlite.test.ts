import { describe, expect, it } from 'vitest';
import { DEFAULT_QUANTUM_SQLITE_ROW_LIMITS, validateQuantumSqliteSnapshot } from './sqlite';
import { createSyntheticQuantumSqlite } from './test-fixtures';

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
      quantum_diodes: 10_000,
      quantum_routes: 100_000,
      quantum_route_models: 500_000,
      quantum_route_lights: 1_000_000,
    });
    await expect(
      validateQuantumSqliteSnapshot(await createSyntheticQuantumSqlite(), {
        rowLimits: { quantum_diodes: 4 },
      }),
    ).rejects.toThrow(/quantum_diodes exceeds its row cap/);
  });
});
