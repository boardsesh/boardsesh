import type { QuantumRosterSnapshot } from '@boardsesh/ble-protocol/quantum';
import type { BoardLayerPresence, ReportBoardLayer } from '@boardsesh/shared-schema';

export type ResolvedQuantumRoutePresence = Pick<BoardLayerPresence, 'climbUuid' | 'angle' | 'geometryKnown'>;

function quantumColorHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Build the only roster shape allowed to cross the party-presence boundary.
 * Foreign/unresolved players remain present, with null climb metadata, because
 * they still consume one of the controller's four physical slots. */
export function sanitizeQuantumRosterForPresence(
  snapshot: QuantumRosterSnapshot,
  resolvedRoutes: ReadonlyMap<string, ResolvedQuantumRoutePresence>,
): ReportBoardLayer[] {
  return snapshot.players.map((player) => {
    const resolved = resolvedRoutes.get(player.routeId.toLowerCase());
    return {
      color: quantumColorHex(player.color),
      remainingSeconds: player.remainingSeconds,
      climbUuid: resolved?.climbUuid ?? null,
      angle: resolved?.angle ?? null,
      geometryKnown: resolved?.geometryKnown ?? false,
    };
  });
}
