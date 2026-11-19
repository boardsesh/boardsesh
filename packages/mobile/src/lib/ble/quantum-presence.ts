import type { QuantumRosterSnapshot } from '@boardsesh/ble-protocol/quantum';
import type { BoardLayerPresence, ReportBoardLayer } from '@boardsesh/shared-schema';

export type ResolvedQuantumRoutePresence = Pick<BoardLayerPresence, 'climbUuid' | 'angle' | 'geometryKnown'> & {
  /** Local-only owner of an explicit physical write confirmation. Downloaded
   * immutable source routes have no owner. Never forward this UUID to presence. */
  controllerUserUuid?: string;
};

export function isQuantumRoutePresenceOwnerCurrent(
  snapshot: QuantumRosterSnapshot,
  routeUuid: string,
  resolvedRoute: ResolvedQuantumRoutePresence,
): boolean {
  const ownerUuid = resolvedRoute.controllerUserUuid?.toLowerCase();
  if (!ownerUuid) return true;
  const canonicalRouteUuid = routeUuid.toLowerCase();
  let foundOwner = false;
  for (const player of snapshot.players) {
    if (player.routeId.toLowerCase() !== canonicalRouteUuid) continue;
    if (player.userId.toLowerCase() !== ownerUuid) return false;
    foundOwner = true;
  }
  return foundOwner;
}

function quantumColorHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Build the only roster shape allowed to cross the party-presence boundary.
 * Foreign/unresolved players remain present, with null climb metadata, because
 * they still consume one of the layers Boardsesh tracks. */
export function sanitizeQuantumRosterForPresence(
  snapshot: QuantumRosterSnapshot,
  resolvedRoutes: ReadonlyMap<string, ResolvedQuantumRoutePresence>,
): ReportBoardLayer[] {
  return snapshot.players.map((player) => {
    const candidate = resolvedRoutes.get(player.routeId.toLowerCase());
    const resolved =
      candidate && isQuantumRoutePresenceOwnerCurrent(snapshot, player.routeId, candidate) ? candidate : undefined;
    return {
      color: quantumColorHex(player.color),
      remainingSeconds: player.remainingSeconds,
      climbUuid: resolved?.climbUuid ?? null,
      angle: resolved?.angle ?? null,
      geometryKnown: resolved?.geometryKnown ?? false,
    };
  });
}
