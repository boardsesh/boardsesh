import { describe, expect, it } from 'vite-plus/test';
import {
  computeQuantumHardwareFingerprint,
  mapQuantumGrade,
  prepareQuantumCatalog,
  quantumCanonicalPlacementId,
  quantumCanonicalClimbUuid,
  scaleQuantumGeometryCoordinate,
} from './quantum-catalog-mapping';
import {
  quantumCatalogFixture,
  quantumFixtureDiodes,
  quantumSharedRouteFixture,
} from './__tests__/quantum-catalog-fixture';

describe('Quantum catalog mapping', () => {
  it('merges shared-family routes, aliases and size memberships without duplicating stats or holds', () => {
    const snapshot = quantumSharedRouteFixture();
    const prepared = prepareQuantumCatalog(snapshot);
    expect(prepared.climbs).toHaveLength(1);
    expect(prepared.climbs[0]?.compatibleSizeIds).toEqual([9201, 9202, 9203]);
    expect(prepared.holds).toHaveLength(1);
    expect(prepared.stats).toHaveLength(1);
    expect(prepared.aliases).toHaveLength(4);
    expect(prepared.products.map((product) => product.id)).toEqual([91, 94, 95]);
    const onlyMedium = {
      ...snapshot,
      rows: { ...snapshot.rows, routeModels: snapshot.rows.routeModels.filter((row) => row.model === 'm') },
    };
    expect(prepareQuantumCatalog(onlyMedium).climbs[0]?.uuid).toBe(prepared.climbs[0]?.uuid);
  });

  it('rejects different hold roles under one shared-family controller route', () => {
    const snapshot = quantumSharedRouteFixture();
    const changed = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        routeLights: snapshot.rows.routeLights.map((light) => (light.model === 'm' ? { ...light, step: 3 } : light)),
      },
    };
    expect(() => prepareQuantumCatalog(changed)).toThrow(/different holds within one physical layout/);
  });

  it.each([
    ['[6]', 10],
    ['[7]', 10],
    ['[7,8]', 11],
    ['[8]', 11],
    ['[9]', 12],
    ['[9,10]', 13],
    ['[10]', 13],
    ['[11]', 14],
    ['[11,12]', 15],
    ['[12]', 15],
    ['[12,13]', 15],
    ['[13]', 15],
    ['[14]', 16],
    ['[15]', 17],
    ['[15,16]', 18],
    ['[19,20]', 22],
    ['[20,21]', 23],
    ['[21,22]', 24],
    ['[22,23]', 25],
    ['[31]', 33],
    ['[32]', 33],
    ['not-json', null],
    ['[5]', null],
    ['[14,15]', null],
    ['[1,2,3]', null],
  ] as const)('maps source grade %s to %s', (sourceGrade, expected) => {
    expect(mapQuantumGrade(sourceGrade)).toBe(expected);
  });

  it('namespaces source placements, maps source steps, route bounds, grades, and positive metadata', () => {
    const prepared = prepareQuantumCatalog(quantumCatalogFixture(), new Date('2026-08-30T12:00:00.000Z'));

    expect(prepared.placements.map((placement) => placement.id)).toEqual([
      1_000_007, 1_000_008, 1_000_009, 1_000_010, 4_000_007, 5_000_007,
    ]);
    expect(prepared.leds.map((led) => [led.id, led.position])).toContainEqual([2_000_007, 1]);
    expect(prepared.climbs[0]).toMatchObject({
      uuid: quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111'),
      controllerRouteUuid: '11111111-1111-4111-8111-111111111111',
      frames: 'p1000007r12p1000008r13p1000009r14p1000010r13',
      edgeLeft: 1_234,
      edgeRight: 4_999,
      edgeBottom: -2_345,
      edgeTop: 7_000,
      characteristics: [
        'quantum_standard',
        'quantum_campusing',
        'quantum_edge',
        'quantum_kickplate',
        'quantum_matching',
      ],
    });
    expect(prepared.holds.map((hold) => hold.holdState)).toEqual(['STARTING', 'HAND', 'FINISH', 'HAND']);
    expect(prepared.climbs[0]?.sourceMetadata).toEqual({
      grade: '[12,13]',
      tags: ['pinch', 'technical'],
      plays: 20,
      updatedAt: 1_700_000_100,
    });
    expect(prepared.stats[0]).toMatchObject({
      displayDifficulty: 15,
      difficultyAverage: 15,
      upstreamAscensionistCount: 12,
      upstreamQualityAverage: 4.5,
    });
    expect(prepared.grades).toHaveLength(24);
    expect(prepared.grades[0]).toMatchObject({ difficulty: 10, boulderName: '4a/V0', isListed: true });
  });

  it('preserves all 128 imported holds while retaining the 92-hold authoring limit', () => {
    const template = quantumFixtureDiodes()[0]!;
    const routeDiodes = Array.from({ length: 128 }, (_, diodeIndex) => ({
      ...template,
      diodeUuid: `long-route-diode-${diodeIndex}`,
      placementId: diodeIndex,
      autocadId: diodeIndex,
      x: (diodeIndex % 16) / 2,
      y: Math.floor(diodeIndex / 16),
    }));
    const snapshot = quantumCatalogFixture({
      diodes: [
        ...quantumFixtureDiodes().filter((diode) => diode.model !== 'xl' && diode.model !== 'l' && diode.model !== 'm'),
        ...routeDiodes,
      ],
      steps: Array.from({ length: 128 }, (_, diodeIndex) => (diodeIndex === 0 ? 1 : diodeIndex === 127 ? 3 : 2)),
    });
    const prepared = prepareQuantumCatalog(snapshot, new Date('2026-11-19T12:00:00.000Z'));

    expect(prepared.holds).toHaveLength(128);
    expect(new Set(prepared.holds.map((hold) => hold.holdId)).size).toBe(128);
    expect(prepared.climbs[0]!.frames.match(/p\d+r\d+/g)).toHaveLength(128);
    expect(prepared.climbs[0]!.frames).toContain('p1000127r14');
    expect(prepared.products[0]!.maxCountInFrame).toBe(92);

    const missingPlacementSnapshot = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        diodes: snapshot.rows.diodes.filter((diode) => diode.diodeUuid !== 'long-route-diode-127'),
      },
    };
    expect(() => prepareQuantumCatalog(missingPlacementSnapshot)).toThrow(/references missing diode/);
  });

  it('uses SQL-compatible coordinate truncation for positive and negative fractions', () => {
    expect(scaleQuantumGeometryCoordinate(1.2349)).toBe(1_234);
    expect(scaleQuantumGeometryCoordinate(-1.2349)).toBe(-1_234);
  });

  it('computes a stable hardware fingerprint independent of row order', () => {
    const snapshot = quantumCatalogFixture();
    const forwards = computeQuantumHardwareFingerprint(snapshot.rows.models, snapshot.rows.diodes);
    const backwards = computeQuantumHardwareFingerprint(
      [...snapshot.rows.models].reverse(),
      [...quantumFixtureDiodes()].reverse(),
    );
    expect(forwards).toBe(backwards);
    expect(forwards).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects source placement ids that could overlap the next model namespace', () => {
    expect(quantumCanonicalPlacementId(9101, 999_999)).toBe(1_999_999);
    expect(() => quantumCanonicalPlacementId(9101, 1_000_000)).toThrow(/999999/);
  });
});
