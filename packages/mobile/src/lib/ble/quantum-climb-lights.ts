import { parseClimbFrameHoldIds } from '@boardsesh/board-config';
import { MAX_DIODES_PER_LAYER, type InstallationBoardLayer } from '@boardsesh/board-layers';
import type { Climb } from '@boardsesh/queue';
import type { QuantumActivePlayer } from '@boardsesh/ble-protocol/quantum';
import type { QuantumGeometryRegistration } from '../quantum-geometry-store';

const QUANTUM_UUID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export type QuantumClimbLightTarget = Readonly<{
  controllerRouteUuid: string;
  diodeIds: readonly number[];
  placementIds: readonly number[];
  layoutId: number;
  sizeId: number;
  geometryGeneration: number;
  climbUuid: string;
  angle: number;
  geometryKnown: true;
}>;

export type QuantumClimbLightTargetError =
  | 'wrong-board'
  | 'wrong-layout'
  | 'missing-route'
  | 'missing-geometry'
  | 'missing-led-position'
  | 'multi-frame-unsupported'
  | 'empty-climb'
  | 'too-many-diodes';

export type QuantumClimbLightTargetResult =
  | { ok: true; target: QuantumClimbLightTarget }
  | { ok: false; reason: QuantumClimbLightTargetError };

type QuantumClimbLightSource = Pick<
  Climb,
  'uuid' | 'boardType' | 'layoutId' | 'angle' | 'frames' | 'controllerRouteUuid'
>;

export type QuantumPlacementDiodeResult =
  | { ok: true; diodeIds: readonly number[] }
  | { ok: false; reason: 'missing-geometry' | 'missing-led-position' | 'empty-climb' | 'too-many-diodes' };

export function resolveQuantumPlacementDiodes(
  placementIds: readonly number[],
  geometry: QuantumGeometryRegistration | null,
  selectedLayoutId: number,
): QuantumPlacementDiodeResult {
  if (!geometry || geometry.layoutId !== selectedLayoutId) return { ok: false, reason: 'missing-geometry' };
  if (placementIds.length === 0) return { ok: false, reason: 'empty-climb' };
  const ledByPlacementId = new Map(
    geometry.placements.map((placement) => [placement.placementId, placement.ledPosition] as const),
  );
  const diodeIds: number[] = [];
  const seenDiodes = new Set<number>();
  for (const placementId of placementIds) {
    const ledPosition = ledByPlacementId.get(placementId);
    if (ledPosition === undefined) return { ok: false, reason: 'missing-led-position' };
    if (seenDiodes.has(ledPosition)) continue;
    seenDiodes.add(ledPosition);
    diodeIds.push(ledPosition);
  }
  if (diodeIds.length > MAX_DIODES_PER_LAYER) return { ok: false, reason: 'too-many-diodes' };
  return { ok: true, diodeIds };
}

/** Resolve a climb's placement ids through the authoritative selected-model
 * geometry. Missing ids fail closed; a Quantum diode address is never guessed. */
export function buildQuantumClimbLightTarget(
  climb: QuantumClimbLightSource,
  geometry: QuantumGeometryRegistration | null,
  selectedLayoutId: number,
  geometryGeneration: number | null,
): QuantumClimbLightTargetResult {
  if (climb.boardType !== 'quantum') return { ok: false, reason: 'wrong-board' };
  if (climb.layoutId !== selectedLayoutId) return { ok: false, reason: 'wrong-layout' };
  if (!climb.controllerRouteUuid || !QUANTUM_UUID_PATTERN.test(climb.controllerRouteUuid)) {
    return { ok: false, reason: 'missing-route' };
  }
  if (!geometry || geometry.layoutId !== selectedLayoutId || geometryGeneration === null) {
    return { ok: false, reason: 'missing-geometry' };
  }
  // Aurora multi-frame strings contain both absolute and delta frames. Unioning
  // every placement would relight holds that a later frame explicitly removed,
  // while Quantum's controller accepts only one static diode set per player.
  if (climb.frames?.includes(',')) return { ok: false, reason: 'multi-frame-unsupported' };

  const placementIds = parseClimbFrameHoldIds(climb.frames);
  const diodeResult = resolveQuantumPlacementDiodes(placementIds, geometry, selectedLayoutId);
  if (!diodeResult.ok) return diodeResult;

  return {
    ok: true,
    target: {
      controllerRouteUuid: climb.controllerRouteUuid,
      diodeIds: diodeResult.diodeIds,
      placementIds,
      layoutId: selectedLayoutId,
      sizeId: geometry.sizeId,
      geometryGeneration,
      climbUuid: climb.uuid,
      angle: climb.angle,
      geometryKnown: true,
    },
  };
}

export type QuantumLayerAction =
  | { kind: 'light' }
  | { kind: 'replace'; activeRouteUuid: string }
  | { kind: 'remove'; activeRouteUuid: string }
  | { kind: 'unavailable'; reason: 'no-target' | 'color-in-use' | 'board-full' };

function canonicalUuid(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase();
}

export type QuantumActivationSafetyResult =
  | { ok: true }
  | { ok: false; reason: 'unresolved-active-route' | 'diode-overlap' };

function findResolvedRouteDiodes(
  resolvedDiodesByRoute: ReadonlyMap<string, readonly number[] | null>,
  routeUuid: string,
): readonly number[] | null | undefined {
  const directMatch = resolvedDiodesByRoute.get(routeUuid.toLowerCase());
  if (directMatch !== undefined) return directMatch;
  const canonicalRouteUuid = canonicalUuid(routeUuid);
  for (const [resolvedRouteUuid, diodeIds] of resolvedDiodesByRoute) {
    if (canonicalUuid(resolvedRouteUuid) === canonicalRouteUuid) return diodeIds;
  }
  return undefined;
}

/** Fail closed before adding a static Quantum diode layer. Every other active
 * controller route must be locally resolved and disjoint from the candidate;
 * the selected installation layer is excluded because activate replaces it. */
export function assessQuantumActivationSafety(
  players: readonly QuantumActivePlayer[],
  selectedControllerUserUuid: string,
  candidateDiodeIds: readonly number[],
  resolvedDiodesByRoute: ReadonlyMap<string, readonly number[] | null>,
): QuantumActivationSafetyResult {
  const candidateDiodes = new Set(candidateDiodeIds);
  for (const player of players) {
    if (canonicalUuid(player.userId) === canonicalUuid(selectedControllerUserUuid)) continue;
    const activeDiodeIds = findResolvedRouteDiodes(resolvedDiodesByRoute, player.routeId);
    if (!activeDiodeIds || activeDiodeIds.length === 0) {
      return { ok: false, reason: 'unresolved-active-route' };
    }
    if (activeDiodeIds.some((diodeId) => candidateDiodes.has(diodeId))) {
      return { ok: false, reason: 'diode-overlap' };
    }
  }
  return { ok: true };
}

function layerColorNumber(layer: InstallationBoardLayer): number {
  return (layer.color.red << 16) | (layer.color.green << 8) | layer.color.blue;
}

/** Derive one explicit row action from the confirmed controller roster. Foreign
 * players are never adopted as ours, but still reserve their color and slot. */
export function deriveQuantumLayerAction(
  layer: InstallationBoardLayer,
  players: readonly QuantumActivePlayer[],
  target: QuantumClimbLightTarget | null,
): QuantumLayerAction {
  const ownPlayer = players.find((player) => canonicalUuid(player.userId) === canonicalUuid(layer.controllerUserUuid));
  if (ownPlayer) {
    if (target && canonicalUuid(ownPlayer.routeId) !== canonicalUuid(target.controllerRouteUuid)) {
      return { kind: 'replace', activeRouteUuid: ownPlayer.routeId };
    }
    return { kind: 'remove', activeRouteUuid: ownPlayer.routeId };
  }

  const color = layerColorNumber(layer);
  if (players.some((player) => player.color === color)) return { kind: 'unavailable', reason: 'color-in-use' };
  if (players.length >= 4) return { kind: 'unavailable', reason: 'board-full' };
  return target ? { kind: 'light' } : { kind: 'unavailable', reason: 'no-target' };
}
