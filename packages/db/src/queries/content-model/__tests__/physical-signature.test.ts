import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { physicalProblemIdentity, physicalProblemKey } from '../physical-signature';

void describe('physicalProblemKey', () => {
  void test('uses a layout fingerprint for duplicate Kilter UUIDs', () => {
    const key = physicalProblemKey({
      boardType: 'kilter',
      layoutId: 1,
      productId: 10,
      fingerprint: 'same-holds',
      holds: [{ pid: 1, state: 'HAND' }],
    });
    assert.equal(key, 'kilter\u00001\u0000same-holds');
  });

  void test('canonicalizes an entire mirrored route when fingerprints are absent', () => {
    const original = physicalProblemKey({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [
        { pid: 100, holeId: 7, mirroredHoleId: 70, state: 'STARTING' },
        { pid: 200, holeId: 9, mirroredHoleId: 90, state: 'FOOT' },
      ],
    });
    const mirrored = physicalProblemKey({
      boardType: 'tension',
      layoutId: 2,
      productId: 2,
      fingerprint: null,
      holds: [
        { pid: 101, holeId: 90, mirroredHoleId: 9, state: 'FOOT' },
        { pid: 201, holeId: 70, mirroredHoleId: 7, state: 'STARTING' },
      ],
    });
    assert.equal(original, mirrored);
  });

  void test('reports when the mirrored route is the canonical orientation', () => {
    const identity = physicalProblemIdentity({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [{ pid: 100, holeId: 90, mirroredHoleId: 9, state: 'HAND' }],
    });
    assert.equal(identity.mirrored, true);
    assert.match(identity.key, /9:HAND$/);
  });

  void test('does not create per-hold-min collisions between asymmetric routes', () => {
    const first = physicalProblemKey({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [
        { pid: 1, holeId: 1, mirroredHoleId: 9, state: 'HAND' },
        { pid: 2, holeId: 8, mirroredHoleId: 2, state: 'FOOT' },
      ],
    });
    const second = physicalProblemKey({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [
        { pid: 1, holeId: 1, mirroredHoleId: 9, state: 'HAND' },
        { pid: 2, holeId: 2, mirroredHoleId: 8, state: 'FOOT' },
      ],
    });
    assert.notEqual(first, second);
  });

  void test('keeps start, hand, finish, and foot states distinct', () => {
    const starting = physicalProblemKey({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [{ pid: 100, holeId: 7, state: 'STARTING' }],
    });
    const hand = physicalProblemKey({
      boardType: 'tension',
      layoutId: 1,
      productId: 2,
      fingerprint: null,
      holds: [{ pid: 100, holeId: 7, state: 'HAND' }],
    });
    assert.notEqual(starting, hand);
  });

  void test('keeps identical MoonBoard cells in different editions distinct', () => {
    const moonBoard2016 = physicalProblemKey({
      boardType: 'moonboard',
      layoutId: 2,
      productId: 1,
      fingerprint: null,
      holds: [
        { pid: 2018, holeId: 18, state: 'STARTING' },
        { pid: 2198, holeId: 198, state: 'FINISH' },
      ],
    });
    const moonBoard2024 = physicalProblemKey({
      boardType: 'moonboard',
      layoutId: 3,
      productId: 1,
      fingerprint: null,
      holds: [
        { pid: 3018, holeId: 18, state: 'STARTING' },
        { pid: 3198, holeId: 198, state: 'FINISH' },
      ],
    });

    assert.notEqual(moonBoard2016, moonBoard2024);
    assert.equal(moonBoard2016.startsWith('moonboard\u00002\u0000'), true);
    assert.equal(moonBoard2024.startsWith('moonboard\u00003\u0000'), true);
  });
});
