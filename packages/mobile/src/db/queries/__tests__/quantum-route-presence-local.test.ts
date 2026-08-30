import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { getQuantumRoutePresenceClimbsLocal } from '../quantum-route-presence-local';

const TARGET_ROUTE_UUID = '10000000-0000-4000-8000-000000000001';

describe('Quantum route presence local lookup', () => {
  let database: TestSqliteDb;

  beforeEach(async () => {
    database = createTestDatabase();
    await runMigrations(database);
    await database.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, controller_route_uuid, angle, frames, updated_at, sync_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['quantum-climb', 'quantum', 9101, TARGET_ROUTE_UUID, 40, 'p1000001r12p1000002r13', '2026-08-30', 1],
    );
  });

  it('resolves a controller route only inside the selected Quantum layout', async () => {
    await database.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, controller_route_uuid, angle, frames, updated_at, sync_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['wrong-layout', 'quantum', 9102, '20000000-0000-4000-8000-000000000002', 25, 'p2000001r12', '2026-08-30', 1],
    );

    await expect(
      getQuantumRoutePresenceClimbsLocal(database, 9101, [TARGET_ROUTE_UUID, '20000000-0000-4000-8000-000000000002']),
    ).resolves.toEqual([
      {
        uuid: 'quantum-climb',
        controllerRouteUuid: TARGET_ROUTE_UUID,
        angle: 40,
        frames: 'p1000001r12p1000002r13',
      },
    ]);
  });

  it('rejects more controller IDs than the physical roster can contain', async () => {
    const routeUuids = Array.from(
      { length: 5 },
      (_, routeIndex) => `30000000-0000-4000-8000-${routeIndex.toString().padStart(12, '0')}`,
    );

    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, routeUuids)).rejects.toThrow(
      'Quantum roster lookup is limited to 4 routes',
    );
  });
});
