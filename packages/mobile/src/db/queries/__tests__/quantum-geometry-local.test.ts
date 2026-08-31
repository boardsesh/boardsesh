import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import {
  deleteQuantumGeometryLocal,
  getQuantumGeometryLocal,
  putQuantumGeometryLocal,
} from '../quantum-geometry-local';

describe('Quantum geometry local cache', () => {
  let database: TestSqliteDb;

  beforeEach(async () => {
    database = createTestDatabase();
    await runMigrations(database);
  });

  it('round-trips one exact model geometry payload', async () => {
    const geometry = {
      layoutId: 9103,
      sizeId: 9203,
      revision: 'signed-event-id',
      edgeLeft: 0,
      edgeRight: 12_000,
      edgeBottom: 0,
      edgeTop: 12_000,
      placements: [{ placementId: 3_000_042, holeId: 3_000_042, x: 1_250, y: 2_500, ledPosition: 42 }],
    } as const;

    await putQuantumGeometryLocal(database, geometry);

    expect(await getQuantumGeometryLocal(database, 9103, 9203)).toEqual(geometry);
    expect(await getQuantumGeometryLocal(database, 9101, 9201)).toBeNull();
  });

  it('fails closed when cached placements JSON is malformed', async () => {
    await database.runAsync(
      `INSERT INTO quantum_geometry (
         layout_id, size_id, revision, edge_left, edge_right, edge_bottom, edge_top, placements_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [9103, 9203, 'revision', 0, 12_000, 0, 12_000, '{broken', '2026-08-30T00:00:00.000Z'],
    );

    expect(await getQuantumGeometryLocal(database, 9103, 9203)).toBeNull();
  });

  it('durably removes geometry omitted by an authoritative batch', async () => {
    const geometry = {
      layoutId: 9103,
      sizeId: 9203,
      revision: 'obsolete-event-id',
      edgeLeft: 0,
      edgeRight: 12_000,
      edgeBottom: 0,
      edgeTop: 12_000,
      placements: [{ placementId: 3_000_042, holeId: 3_000_042, x: 1_250, y: 2_500, ledPosition: 42 }],
    } as const;
    await putQuantumGeometryLocal(database, geometry);

    await deleteQuantumGeometryLocal(database, geometry.layoutId, geometry.sizeId);

    expect(await getQuantumGeometryLocal(database, geometry.layoutId, geometry.sizeId)).toBeNull();
  });
});
