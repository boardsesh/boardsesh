import type { OfflineDatabase } from '@boardsesh/offline-sync';

const MAX_QUANTUM_ROSTER_ROUTES = 4;
const CANONICAL_QUANTUM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type QuantumRoutePresenceRow = {
  uuid: string;
  controller_route_uuid: string;
  angle: number;
  frames: string | null;
};

export type LocalQuantumRoutePresenceClimb = Readonly<{
  uuid: string;
  controllerRouteUuid: string;
  angle: number;
  frames: string;
}>;

/** Resolve controller route IDs only against the downloaded Quantum catalog.
 * Raw controller identities never leave SQLite or reach GraphQL. */
export async function getQuantumRoutePresenceClimbsLocal(
  db: OfflineDatabase,
  layoutId: number,
  routeUuids: readonly string[],
): Promise<LocalQuantumRoutePresenceClimb[]> {
  const canonicalRouteUuids = [...new Set(routeUuids.map((routeUuid) => routeUuid.toLowerCase()))].filter((routeUuid) =>
    CANONICAL_QUANTUM_UUID.test(routeUuid),
  );
  if (canonicalRouteUuids.length === 0) return [];
  if (canonicalRouteUuids.length > MAX_QUANTUM_ROSTER_ROUTES) {
    throw new Error(`Quantum roster lookup is limited to ${MAX_QUANTUM_ROSTER_ROUTES} routes`);
  }

  const placeholders = canonicalRouteUuids.map(() => '?').join(', ');
  const rows = await db.getAllAsync<QuantumRoutePresenceRow>(
    `SELECT uuid, controller_route_uuid, angle, frames
       FROM board_climbs
      WHERE board_type = 'quantum'
        AND layout_id = ?
        AND controller_route_uuid IN (${placeholders})`,
    [layoutId, ...canonicalRouteUuids],
  );

  return rows.flatMap((row) => {
    const controllerRouteUuid = row.controller_route_uuid.toLowerCase();
    if (
      row.uuid.length === 0 ||
      !CANONICAL_QUANTUM_UUID.test(controllerRouteUuid) ||
      !Number.isSafeInteger(row.angle)
    ) {
      return [];
    }
    return [
      {
        uuid: row.uuid,
        controllerRouteUuid,
        angle: row.angle,
        frames: row.frames ?? '',
      },
    ];
  });
}
