import { describe, expect, it } from 'vite-plus/test';
import {
  computeQuantumHardwareFingerprint,
  mapQuantumGrade,
  prepareQuantumCatalog,
  quantumCanonicalPlacementId,
  scaleQuantumGeometryCoordinate,
} from './quantum-catalog-mapping';
import { quantumCatalogFixture, quantumFixtureDiodes } from './__tests__/quantum-catalog-fixture';

describe('Quantum catalog mapping', () => {
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
      1_000_007, 1_000_008, 1_000_009, 1_000_010, 2_000_007, 3_000_007, 4_000_007, 5_000_007,
    ]);
    expect(prepared.leds.map((led) => [led.id, led.position])).toContainEqual([2_000_007, 1]);
    expect(prepared.climbs[0]).toMatchObject({
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
    expect(prepared.metadata[0]).toMatchObject({
      sourceGrade: null,
      tags: ['pinch', 'technical'],
      isStandard: true,
      isCampusing: true,
      isEdge: true,
      usesKickplate: true,
      allowsMatching: true,
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
