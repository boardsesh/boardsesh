import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TrainingHold } from '../../hold-features/training-matrix';
import { canonicalizeMirrorFeatures } from '../mirror-canonicalization';

function trainingHold(): TrainingHold {
  return {
    pid: 100,
    holeId: 7,
    mirroredHoleId: 70,
    state: 'HAND',
    role: 'hand',
    nx: 0.2,
    ny: 0.4,
    edge: 0.1,
    nbr: 0.2,
    hd: null,
    fd: null,
    pull: 90,
    kb: false,
    footSet: false,
    morph: [0, 0, 0, 0, 0, 0, 0, 0.25, 0.75, 0, 0, 0],
  };
}

void describe('canonicalizeMirrorFeatures', () => {
  void test('reflects directional features after whole-route mirror selection', () => {
    const [mirrored] = canonicalizeMirrorFeatures([trainingHold()], {
      usesFingerprint: false,
      mirrored: true,
    });

    assert.equal(mirrored.modelHoldId, 70);
    assert.equal(mirrored.holeId, 70);
    assert.equal(mirrored.mirroredHoleId, 7);
    assert.equal(mirrored.nx, 0.8);
    assert.equal(mirrored.pull, 270);
    assert.equal(mirrored.morph?.[7], -0.25);
    assert.equal(mirrored.morph?.[8], 0.75);
  });

  void test('keeps fingerprinted placement identity and geometry unchanged', () => {
    const original = trainingHold();
    const [canonical] = canonicalizeMirrorFeatures([original], {
      usesFingerprint: true,
      mirrored: false,
    });

    assert.equal(canonical.modelHoldId, original.pid);
    assert.equal(canonical.nx, original.nx);
    assert.notEqual(canonical, original);
  });

  void test('does not extend a partial morphology vector while mirroring', () => {
    const original = { ...trainingHold(), morph: [1, 2, 3] };
    const [mirrored] = canonicalizeMirrorFeatures([original], {
      usesFingerprint: false,
      mirrored: true,
    });

    assert.deepEqual(mirrored.morph, [1, 2, 3]);
    assert.equal(mirrored.morph?.length, 3);
  });
});
