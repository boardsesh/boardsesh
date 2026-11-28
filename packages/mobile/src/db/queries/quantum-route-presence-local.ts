import { getBoardCapabilities } from '@boardsesh/board-config';
import type { OfflineDatabase } from '@boardsesh/offline-sync';

const CANONICAL_QUANTUM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type QuantumRoutePresenceRow = {
  uuid: string;
  controller_route_uuid: string;
  angle: number;
  frames: string | null;
  compatible_size_ids: string;
};

export type LocalQuantumRoutePresenceClimb = Readonly<{
  uuid: string;
  controllerRouteUuid: string;
  angle: number;
  frames: string;
  compatibleSizeIds: number[];
}>;

/** Resolve only downloaded source-owned Quantum routes. Missing provenance and
 * mutable app-authored rows cannot describe what a foreign controller is lighting.
 * Source recovery also requires known membership in the selected physical size.
 * Raw controller identities never leave SQLite or reach GraphQL. */
export async function getQuantumRoutePresenceClimbsLocal(
  db: OfflineDatabase,
  layoutId: number,
  sizeId: number,
  routeUuids: readonly string[],
): Promise<LocalQuantumRoutePresenceClimb[]> {
  const canonicalRouteUuids = [...new Set(routeUuids.map((routeUuid) => routeUuid.toLowerCase()))].filter((routeUuid) =>
    CANONICAL_QUANTUM_UUID.test(routeUuid),
  );
  if (canonicalRouteUuids.length === 0) return [];
  // One route per layer the Quantum row says the controller keeps lit.
  const maxRosterRoutes = getBoardCapabilities('quantum').maxActiveWallClimbs;
  if (canonicalRouteUuids.length > maxRosterRoutes) {
    throw new Error(`Quantum roster lookup is limited to ${maxRosterRoutes} routes`);
  }

  const placeholders = canonicalRouteUuids.map(() => '?').join(', ');
  const rows = await db.getAllAsync<QuantumRoutePresenceRow>(
    `SELECT uuid, controller_route_uuid, angle, frames, compatible_size_ids
       FROM board_climbs
      WHERE board_type = 'quantum'
        AND user_id IS NULL
        AND is_boardsesh_authored = 0
        AND layout_id = ?
        AND compatible_size_ids IS NOT NULL
        AND json_type(compatible_size_ids) = 'array'
        AND EXISTS (SELECT 1 FROM json_each(compatible_size_ids) WHERE type = 'integer' AND value = ?)
        AND controller_route_uuid IN (${placeholders})`,
    [layoutId, sizeId, ...canonicalRouteUuids],
  );

  return rows.flatMap((row) => {
    const controllerRouteUuid = row.controller_route_uuid.toLowerCase();
    const compatibleSizeIds: unknown = JSON.parse(row.compatible_size_ids);
    if (
      row.uuid.length === 0 ||
      !CANONICAL_QUANTUM_UUID.test(controllerRouteUuid) ||
      !Number.isSafeInteger(row.angle) ||
      !Array.isArray(compatibleSizeIds) ||
      !compatibleSizeIds.every(
        (candidateSizeId: unknown): candidateSizeId is number =>
          typeof candidateSizeId === 'number' && Number.isSafeInteger(candidateSizeId),
      ) ||
      !compatibleSizeIds.includes(sizeId)
    ) {
      return [];
    }
    return [
      {
        uuid: row.uuid,
        controllerRouteUuid,
        angle: row.angle,
        frames: row.frames ?? '',
        compatibleSizeIds,
      },
    ];
  });
}
