import {
  MAX_ACTIVE_BOARD_LAYERS,
  MAX_DIODES_PER_LAYER,
  parseBoardLayerPlacementIds,
  type BoardLayerColor,
} from '@boardsesh/board-layers';
import type { Climb } from '@boardsesh/queue';
import { QUANTUM_ZERO_UUID, quantumUuidsEqual, type QuantumActivePlayer } from '@boardsesh/ble-protocol/quantum';
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
  | 'wrong-size'
  | 'missing-route'
  | 'missing-geometry'
  | 'missing-led-position'
  | 'multi-frame-unsupported'
  | 'empty-climb'
  | 'invalid-frames'
  | 'too-many-diodes';

export type QuantumClimbLightTargetResult =
  | { ok: true; target: QuantumClimbLightTarget }
  | { ok: false; reason: QuantumClimbLightTargetError };

type QuantumClimbLightSource = Pick<
  Climb,
  'uuid' | 'boardType' | 'layoutId' | 'angle' | 'frames' | 'controllerRouteUuid' | 'compatibleSizeIds'
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
  if (
    !climb.controllerRouteUuid ||
    !QUANTUM_UUID_PATTERN.test(climb.controllerRouteUuid) ||
    quantumUuidsEqual(climb.controllerRouteUuid, QUANTUM_ZERO_UUID)
  ) {
    return { ok: false, reason: 'missing-route' };
  }
  if (!geometry || geometry.layoutId !== selectedLayoutId || geometryGeneration === null) {
    return { ok: false, reason: 'missing-geometry' };
  }
  // Retained queue/playlist rows can carry stricter source size membership
  // than hold containment alone. Missing/null/empty metadata on legacy or
  // authored snapshots keeps the existing policy: exact LED resolution below
  // remains mandatory, but no unrecorded size restriction is invented.
  if (climb.compatibleSizeIds?.length && !climb.compatibleSizeIds.includes(geometry.sizeId)) {
    return { ok: false, reason: 'wrong-size' };
  }
  // Aurora multi-frame strings contain both absolute and delta frames. Unioning
  // every placement would relight holds that a later frame explicitly removed,
  // while Quantum's controller accepts only one static diode set per player.
  if (climb.frames?.includes(',')) return { ok: false, reason: 'multi-frame-unsupported' };

  if (!climb.frames) return { ok: false, reason: 'empty-climb' };
  // Parse the whole route so large valid climbs get the limit message and
  // an incomplete suffix never becomes a partial lighting command.
  const placementIds = parseBoardLayerPlacementIds(climb.frames, Number.POSITIVE_INFINITY);
  if (!placementIds) return { ok: false, reason: 'invalid-frames' };
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
  | { kind: 'active' }
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
    if (quantumUuidsEqual(player.userId, selectedControllerUserUuid)) continue;
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

export function quantumLayerColorNumber(color: BoardLayerColor): number {
  return (color.red << 16) | (color.green << 8) | color.blue;
}

/** Colors are choices for the same player. Other players reserve their color. */
export function deriveQuantumLayerAction(
  controllerUserUuid: string,
  color: BoardLayerColor,
  players: readonly QuantumActivePlayer[],
  target: QuantumClimbLightTarget | null,
): QuantumLayerAction {
  const ownPlayer = players.find((player) => quantumUuidsEqual(player.userId, controllerUserUuid));
  const selectedColor = quantumLayerColorNumber(color);
  if (players.some((player) => player !== ownPlayer && player.color === selectedColor)) {
    return { kind: 'unavailable', reason: 'color-in-use' };
  }
  if (!ownPlayer && players.length >= MAX_ACTIVE_BOARD_LAYERS) {
    return { kind: 'unavailable', reason: 'board-full' };
  }
  if (
    ownPlayer?.color === selectedColor &&
    (!target || quantumUuidsEqual(ownPlayer.routeId, target.controllerRouteUuid))
  ) {
    return { kind: 'active' };
  }
  if (!target) return { kind: 'unavailable', reason: 'no-target' };
  return ownPlayer ? { kind: 'replace', activeRouteUuid: ownPlayer.routeId } : { kind: 'light' };
}
