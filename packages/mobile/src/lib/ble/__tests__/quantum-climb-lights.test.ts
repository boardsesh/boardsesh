import { describe, expect, it } from 'vitest';
import { buildInstallationBoardLayers } from '@boardsesh/board-layers';
import type { Climb } from '@boardsesh/queue';
import type { QuantumActivePlayer } from '@boardsesh/ble-protocol/quantum';
import { buildQuantumClimbLightTarget, deriveQuantumLayerAction } from '../quantum-climb-lights';

const USER_UUIDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
] as const;
const ROUTE_UUID = '20000000-0000-4000-8000-000000000001';
const OTHER_ROUTE_UUID = '20000000-0000-4000-8000-000000000002';
const layers = buildInstallationBoardLayers(USER_UUIDS);

function climb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    layoutId: 3,
    boardType: 'quantum',
    setter_username: 'Setter',
    name: 'Test',
    frames: 'p0r15p8r12p0r14',
    controllerRouteUuid: ROUTE_UUID,
    angle: 30,
    ascensionist_count: 0,
    difficulty: 'V4',
    quality_average: '0',
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...overrides,
  };
}

const geometry = {
  layoutId: 3,
  sizeId: 3,
  revision: 'revision-1',
  edgeLeft: 0,
  edgeRight: 10,
  edgeBottom: 0,
  edgeTop: 10,
  placements: [
    { placementId: 0, holeId: 10, x: 0, y: 0, ledPosition: 0 },
    { placementId: 8, holeId: 11, x: 1, y: 1, ledPosition: 42 },
  ],
} as const;

function player(overrides: Partial<QuantumActivePlayer> = {}): QuantumActivePlayer {
  return { routeId: ROUTE_UUID, userId: USER_UUIDS[0], remainingSeconds: 120, color: 0x00ff00, ...overrides };
}

describe('buildQuantumClimbLightTarget', () => {
  it('maps placement zero and de-duplicates diode addresses through authoritative geometry', () => {
    expect(buildQuantumClimbLightTarget(climb(), geometry, 3)).toEqual({
      ok: true,
      target: {
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [0, 42],
        climbUuid: 'climb-1',
        angle: 30,
        geometryKnown: true,
      },
    });
  });

  it('fails closed when any placement has no diode address', () => {
    expect(buildQuantumClimbLightTarget(climb({ frames: 'p0r15p99r12' }), geometry, 3)).toEqual({
      ok: false,
      reason: 'missing-led-position',
    });
  });

  it('rejects a climb without a controller route uuid', () => {
    expect(buildQuantumClimbLightTarget(climb({ controllerRouteUuid: null }), geometry, 3)).toEqual({
      ok: false,
      reason: 'missing-route',
    });
  });
});

describe('deriveQuantumLayerAction', () => {
  const targetResult = buildQuantumClimbLightTarget(climb(), geometry, 3);
  if (!targetResult.ok) throw new Error('fixture target did not resolve');
  const target = targetResult.target;

  it('offers remove for the same route and replace for a different route owned by this install', () => {
    expect(deriveQuantumLayerAction(layers[0], [player()], target)).toEqual({
      kind: 'remove',
      activeRouteUuid: ROUTE_UUID,
    });
    expect(deriveQuantumLayerAction(layers[0], [player({ routeId: OTHER_ROUTE_UUID })], target)).toEqual({
      kind: 'replace',
      activeRouteUuid: OTHER_ROUTE_UUID,
    });
  });

  it('keeps a foreign player unavailable while it consumes the matching color', () => {
    expect(deriveQuantumLayerAction(layers[0], [player({ userId: USER_UUIDS[1] })], target)).toEqual({
      kind: 'unavailable',
      reason: 'color-in-use',
    });
  });

  it('allows removing an owned layer even when no climb target can be resolved', () => {
    expect(deriveQuantumLayerAction(layers[0], [player()], null)).toEqual({
      kind: 'remove',
      activeRouteUuid: ROUTE_UUID,
    });
  });
});
