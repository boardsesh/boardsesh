import { describe, expect, it } from 'vitest';
import {
  BOARD_LAYER_COLORS,
  buildInstallationBoardLayers,
  buildOccupiedPlacementIndex,
  buildOccupiedPlacementIndexFromPresence,
  controllerRostersEqual,
  matchesQuantumOverlapFilter,
  parseBoardLayerPlacementIds,
  sanitizeBoardLayersPresence,
} from '..';

const USER_UUIDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
];

describe('installation board layers', () => {
  it('assigns four stable colours without exposing a server identity', () => {
    expect(buildInstallationBoardLayers(USER_UUIDS)).toEqual(
      USER_UUIDS.map((controllerUserUuid, slot) => ({ slot, controllerUserUuid, color: BOARD_LAYER_COLORS[slot] })),
    );
  });

  it('rejects duplicate controller users', () => {
    expect(() => buildInstallationBoardLayers([USER_UUIDS[0], USER_UUIDS[0], USER_UUIDS[2], USER_UUIDS[3]])).toThrow();
  });
});

describe('controller roster comparison', () => {
  const player = {
    controllerUserUuid: USER_UUIDS[0],
    controllerRouteUuid: '20000000-0000-4000-8000-000000000001',
    red: 0,
    green: 255,
    blue: 0,
    remainingSeconds: 10,
  };

  it('ignores order and countdown drift but not route changes', () => {
    const other = { ...player, controllerUserUuid: USER_UUIDS[1], remainingSeconds: 9 };
    expect(controllerRostersEqual([player, other], [{ ...other, remainingSeconds: 8 }, player])).toBe(true);
    expect(controllerRostersEqual([player], [{ ...player, controllerRouteUuid: USER_UUIDS[3] }])).toBe(false);
  });
});

describe('Quantum overlap filtering', () => {
  it('parses only complete canonical frames', () => {
    expect(parseBoardLayerPlacementIds('p1000001r12p1000002r13p1000003r14')).toEqual([1_000_001, 1_000_002, 1_000_003]);
    expect(parseBoardLayerPlacementIds('junkp1r12')).toBeNull();
    expect(parseBoardLayerPlacementIds('p1r12junk')).toBeNull();
    expect(parseBoardLayerPlacementIds('p1r12p1r14')).toBeNull();
  });

  it('matches zero or at-most-one shared placement', () => {
    const occupied = buildOccupiedPlacementIndex(
      ['route-a', 'route-b'],
      new Map([
        ['route-a', [1, 2]],
        ['route-b', [3]],
      ]),
    );
    expect(matchesQuantumOverlapFilter([4, 5], occupied, 'none')).toBe(true);
    expect(matchesQuantumOverlapFilter([3, 4], occupied, 'none')).toBe(false);
    expect(matchesQuantumOverlapFilter([3, 4], occupied, 'at_most_one')).toBe(true);
    expect(matchesQuantumOverlapFilter([2, 3], occupied, 'at_most_one')).toBe(false);
  });

  it('disables filtering when any occupied route has unknown geometry', () => {
    const occupied = buildOccupiedPlacementIndex(['missing'], new Map());
    expect(occupied.geometryKnown).toBe(false);
    expect(matchesQuantumOverlapFilter([1], occupied, 'none')).toBe(true);
  });

  it('builds occupied geometry from sanitized party layers', () => {
    expect(
      buildOccupiedPlacementIndexFromPresence([
        { geometryKnown: true, placementIds: [1, 2] },
        { geometryKnown: true, placementIds: [2, 3] },
      ]),
    ).toEqual({ geometryKnown: true, placementIds: new Set([1, 2, 3]) });
    expect(buildOccupiedPlacementIndexFromPresence([{ geometryKnown: false, placementIds: [] }]).geometryKnown).toBe(
      false,
    );
  });
});

describe('presence sanitization', () => {
  it('emits only display-safe fields and caps controller values', () => {
    const snapshot = sanitizeBoardLayersPresence(
      [
        {
          red: -1,
          green: 300,
          blue: 16,
          remainingSeconds: 70_000,
          resolvedClimbUuid: 'climb-a',
          angle: 40,
          geometryKnown: true,
        },
      ],
      7,
      '2026-08-30T00:00:00.000Z',
    );
    expect(snapshot.layers).toEqual([
      { color: '#00ff10', remainingSeconds: 65_535, climbUuid: 'climb-a', angle: 40, geometryKnown: true },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('controller');
  });
});
