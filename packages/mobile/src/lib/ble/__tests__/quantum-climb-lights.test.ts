import { describe, expect, it } from 'vitest';
import { getQuantumBundledGeometry } from '@boardsesh/board-constants/quantum';
import { buildInstallationBoardLayers } from '@boardsesh/board-layers';
import type { Climb } from '@boardsesh/queue';
import type { QuantumActivePlayer } from '@boardsesh/ble-protocol/quantum';
import {
  assessQuantumActivationSafety,
  buildQuantumClimbLightTarget,
  deriveQuantumLayerAction,
} from '../quantum-climb-lights';

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
  it('lights shared standard holds at the same address on XL and M and rejects XL-only holds on M', () => {
    const xl = getQuantumBundledGeometry(9101, 9201)!;
    const medium = getQuantumBundledGeometry(9101, 9203)!;
    const sharedHold = medium.placements[0]!;
    const sharedClimb = climb({ layoutId: 9101, frames: `p${sharedHold.placementId}r12` });
    const onXl = buildQuantumClimbLightTarget(sharedClimb, xl, 9101, 1);
    const onM = buildQuantumClimbLightTarget(sharedClimb, medium, 9101, 1);
    expect(onXl.ok && onXl.target.diodeIds).toEqual([sharedHold.ledPosition]);
    expect(onM.ok && onM.target.diodeIds).toEqual([sharedHold.ledPosition]);
    const mediumIds = new Set(medium.placements.map((placement) => placement.placementId));
    const xlOnly = xl.placements.find((placement) => !mediumIds.has(placement.placementId))!;
    const xlClimb = climb({ layoutId: 9101, frames: `p${xlOnly.placementId}r12` });
    expect(buildQuantumClimbLightTarget(xlClimb, medium, 9101, 1)).toEqual({
      ok: false,
      reason: 'missing-led-position',
    });
    expect(buildQuantumClimbLightTarget(xlClimb, xl, 9101, 1).ok).toBe(true);
  });

  it('honors a known L-only allowlist even when the same hold exists on XL', () => {
    const xl = getQuantumBundledGeometry(9101, 9201)!;
    const large = getQuantumBundledGeometry(9101, 9202)!;
    const sharedHold = large.placements[0]!;
    const restricted = climb({ layoutId: 9101, frames: `p${sharedHold.placementId}r12`, compatibleSizeIds: [9202] });
    expect(buildQuantumClimbLightTarget(restricted, xl, 9101, 1)).toEqual({ ok: false, reason: 'wrong-size' });
    const onLarge = buildQuantumClimbLightTarget(restricted, large, 9101, 1);
    expect(onLarge.ok && onLarge.target.diodeIds).toEqual([sharedHold.ledPosition]);
  });

  it.each([undefined, null, []])(
    'keeps unknown authored/legacy size metadata %j behind exact LED resolution',
    (compatibleSizeIds) => {
      expect(buildQuantumClimbLightTarget(climb({ compatibleSizeIds }), geometry, 3, 7).ok).toBe(true);
      expect(buildQuantumClimbLightTarget(climb({ compatibleSizeIds, frames: 'p999r12' }), geometry, 3, 7)).toEqual({
        ok: false,
        reason: 'missing-led-position',
      });
    },
  );

  it('maps placement zero and de-duplicates diode addresses through authoritative geometry', () => {
    expect(buildQuantumClimbLightTarget(climb(), geometry, 3, 7)).toEqual({
      ok: true,
      target: {
        controllerRouteUuid: ROUTE_UUID,
        diodeIds: [0, 42],
        placementIds: [0, 8, 0],
        layoutId: 3,
        sizeId: 3,
        geometryGeneration: 7,
        climbUuid: 'climb-1',
        angle: 30,
        geometryKnown: true,
      },
    });
  });

  it('refuses a complete 128-hold catalog route at the explicit lighting boundary', () => {
    const longGeometry = {
      ...geometry,
      placements: Array.from({ length: 128 }, (_, placementId) => ({
        placementId,
        holeId: placementId,
        x: placementId % 16,
        y: Math.floor(placementId / 16),
        ledPosition: placementId,
      })),
    };
    const longRoute = climb({
      frames: longGeometry.placements.map(({ placementId }) => `p${placementId}r13`).join(''),
    });

    expect(buildQuantumClimbLightTarget(longRoute, longGeometry, 3, 7)).toEqual({
      ok: false,
      reason: 'too-many-diodes',
    });
  });

  it('fails closed when any placement has no diode address', () => {
    expect(buildQuantumClimbLightTarget(climb({ frames: 'p0r15p99r12' }), geometry, 3, 7)).toEqual({
      ok: false,
      reason: 'missing-led-position',
    });
  });

  it('rejects a climb without a controller route uuid', () => {
    expect(buildQuantumClimbLightTarget(climb({ controllerRouteUuid: null }), geometry, 3, 7)).toEqual({
      ok: false,
      reason: 'missing-route',
    });
  });

  it('rejects multi-frame climbs instead of unioning removed holds into one static layer', () => {
    expect(buildQuantumClimbLightTarget(climb({ frames: 'p0r15p8r12,"x0' }), geometry, 3, 7)).toEqual({
      ok: false,
      reason: 'multi-frame-unsupported',
    });
  });
});

describe('assessQuantumActivationSafety', () => {
  it('fails closed when another active route has not been resolved locally', () => {
    expect(assessQuantumActivationSafety([player({ userId: USER_UUIDS[1] })], USER_UUIDS[0], [42], new Map())).toEqual({
      ok: false,
      reason: 'unresolved-active-route',
    });
  });

  it('rejects overlap with another active route', () => {
    expect(
      assessQuantumActivationSafety(
        [player({ userId: USER_UUIDS[1] })],
        USER_UUIDS[0],
        [42],
        new Map([[ROUTE_UUID, [7, 42]]]),
      ),
    ).toEqual({ ok: false, reason: 'diode-overlap' });
  });

  it('excludes the selected installation layer because activation replaces it', () => {
    expect(assessQuantumActivationSafety([player()], USER_UUIDS[0], [42], new Map([[ROUTE_UUID, null]]))).toEqual({
      ok: true,
    });
  });
});

describe('deriveQuantumLayerAction', () => {
  const targetResult = buildQuantumClimbLightTarget(climb(), geometry, 3, 7);
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
