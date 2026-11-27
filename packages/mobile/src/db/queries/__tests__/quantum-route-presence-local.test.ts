import { beforeEach, describe, expect, it } from 'vitest';
import { getQuantumBundledGeometry } from '@boardsesh/board-constants/quantum';
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
        (uuid, board_type, layout_id, controller_route_uuid, angle, frames, updated_at, sync_seq, is_boardsesh_authored, compatible_size_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'quantum-climb',
        'quantum',
        9101,
        TARGET_ROUTE_UUID,
        40,
        'p1000001r12p1000002r13',
        '2026-08-30',
        1,
        0,
        '[9201,9202,9203]',
      ],
    );
  });

  it('resolves a controller route only inside the selected Quantum layout', async () => {
    await database.runAsync(
      `INSERT INTO board_climbs
        (uuid, board_type, layout_id, controller_route_uuid, angle, frames, updated_at, sync_seq, is_boardsesh_authored, compatible_size_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'wrong-layout',
        'quantum',
        9102,
        '20000000-0000-4000-8000-000000000002',
        25,
        'p2000001r12',
        '2026-08-30',
        1,
        0,
        '[9201,9202,9203]',
      ],
    );

    await expect(
      getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, [
        TARGET_ROUTE_UUID,
        '20000000-0000-4000-8000-000000000002',
      ]),
    ).resolves.toEqual([
      {
        uuid: 'quantum-climb',
        controllerRouteUuid: TARGET_ROUTE_UUID,
        angle: 40,
        frames: 'p1000001r12p1000002r13',
        compatibleSizeIds: [9201, 9202, 9203],
      },
    ]);
  });

  it('only recovers an L-only route on its allowed size, regardless of shared hold IDs', async () => {
    await database.runAsync('UPDATE board_climbs SET compatible_size_ids = ? WHERE uuid = ?', [
      '[9202]',
      'quantum-climb',
    ]);
    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, [TARGET_ROUTE_UUID])).resolves.toEqual([]);
    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9202, [TARGET_ROUTE_UUID])).resolves.toEqual([
      expect.objectContaining({ uuid: 'quantum-climb', compatibleSizeIds: [9202] }),
    ]);
  });

  it.each([null, '[]'])(
    'keeps source routes with missing selected-size membership %s unresolved',
    async (memberships) => {
      await database.runAsync('UPDATE board_climbs SET compatible_size_ids = ? WHERE uuid = ?', [
        memberships,
        'quantum-climb',
      ]);
      await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, [TARGET_ROUTE_UUID])).resolves.toEqual([]);
    },
  );

  it('omits a real XL-only hold route from M recovery', async () => {
    const mediumIds = new Set(
      getQuantumBundledGeometry(9101, 9203)!.placements.map((placement) => placement.placementId),
    );
    const xlOnly = getQuantumBundledGeometry(9101, 9201)!.placements.find(
      (placement) => !mediumIds.has(placement.placementId),
    )!;
    await database.runAsync('UPDATE board_climbs SET compatible_size_ids = ?, frames = ? WHERE uuid = ?', [
      '[9201]',
      `p${xlOnly.placementId}r12`,
      'quantum-climb',
    ]);
    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9203, [TARGET_ROUTE_UUID])).resolves.toEqual([]);
    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, [TARGET_ROUTE_UUID])).resolves.toHaveLength(
      1,
    );
  });

  it.each([
    ['live app author', 'boardsesh-author', 1],
    ['retained app author', null, 1],
    ['missing provenance', null, null],
    ['user row with a false source marker', 'boardsesh-author', 0],
  ] as const)(
    'does not resolve a mutable or unverified %s route after another device edits its frames',
    async (_label, userId, authored) => {
      await database.runAsync(
        'UPDATE board_climbs SET user_id = ?, is_boardsesh_authored = ?, frames = ? WHERE uuid = ?',
        [userId, authored, 'p1000002r12', 'quantum-climb'],
      );
      await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, [TARGET_ROUTE_UUID])).resolves.toEqual([]);
    },
  );

  it('rejects more controller IDs than the physical roster can contain', async () => {
    const routeUuids = Array.from(
      { length: 5 },
      (_, routeIndex) => `30000000-0000-4000-8000-${routeIndex.toString().padStart(12, '0')}`,
    );

    await expect(getQuantumRoutePresenceClimbsLocal(database, 9101, 9201, routeUuids)).rejects.toThrow(
      'Quantum roster lookup is limited to 4 routes',
    );
  });
});
