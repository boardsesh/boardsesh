import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  HOLD_MORPHOLOGY_FEATURE_NAMES,
  HOLD_MORPHOLOGY_VERSION,
  extractHoldMorphology,
  holdMorphologyRecordKey,
  prepareMorphologyImage,
  renderHoldMorphologyJsonl,
  type HoldMorphologyRecord,
  type RawRgbaImage,
} from '../index.js';

function blankImage(width: number, height: number): RawRgbaImage {
  return {
    data: new Uint8Array(width * height * 4),
    width,
    height,
    channels: 4,
  };
}

function paintRectangle(
  image: RawRgbaImage,
  left: number,
  top: number,
  width: number,
  height: number,
  luminance: number,
): void {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const byteOffset = (y * image.width + x) * image.channels;
      image.data[byteOffset] = luminance;
      image.data[byteOffset + 1] = luminance;
      image.data[byteOffset + 2] = luminance;
      image.data[byteOffset + 3] = 255;
    }
  }
}

void describe('hold morphology extraction', () => {
  void test('produces the stable 12-value vector deterministically', () => {
    const image = blankImage(40, 40);
    paintRectangle(image, 12, 16, 16, 8, 180);
    const prepared = prepareMorphologyImage(image);
    const location = { centerX: 20, centerY: 20, cellWidth: 20, cellHeight: 20 };

    const first = extractHoldMorphology(prepared, location);
    const second = extractHoldMorphology(prepared, location);
    assert.deepEqual(second, first);
    assert.equal(HOLD_MORPHOLOGY_FEATURE_NAMES.length, 12);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.vector.length, HOLD_MORPHOLOGY_FEATURE_NAMES.length);
    assert.ok(first.vector.every(Number.isFinite));
    assert.equal(first.vector[0], 0.32);
    assert.equal(first.vector[1], 0.8);
    assert.equal(first.vector[2], 0.4);
    assert.equal(first.normalizedCenterDistance, 0);
    assert.ok(first.vector[8] > 0.99, 'a horizontal rectangle has a horizontal major axis');
  });

  void test('distinguishes an empty source image from a missing hold near the requested cell', () => {
    const empty = prepareMorphologyImage(blankImage(30, 30));
    assert.deepEqual(extractHoldMorphology(empty, { centerX: 15, centerY: 15, cellWidth: 10, cellHeight: 10 }), {
      ok: false,
      reason: 'empty-image',
    });

    const image = blankImage(40, 40);
    paintRectangle(image, 2, 2, 5, 5, 200);
    const prepared = prepareMorphologyImage(image);
    assert.deepEqual(extractHoldMorphology(prepared, { centerX: 32, centerY: 32, cellWidth: 10, cellHeight: 10 }), {
      ok: false,
      reason: 'missing-hold',
    });
  });

  void test('splits adjacent painted holds that touch across a grid-cell boundary', () => {
    const image = blankImage(40, 20);
    paintRectangle(image, 5, 5, 15, 10, 100);
    paintRectangle(image, 20, 5, 15, 10, 220);
    const prepared = prepareMorphologyImage(image);
    const left = extractHoldMorphology(prepared, {
      centerX: 10,
      centerY: 10,
      cellWidth: 20,
      cellHeight: 20,
      clipToCell: true,
    });
    const right = extractHoldMorphology(prepared, {
      centerX: 30,
      centerY: 10,
      cellWidth: 20,
      cellHeight: 20,
      clipToCell: true,
    });

    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!left.ok || !right.ok) return;
    assert.equal(left.componentId, right.componentId);
    assert.equal(left.componentWasClipped, true);
    assert.equal(right.componentWasClipped, true);
    assert.notDeepEqual(left.vector, right.vector);
    assert.ok(left.vector[1] <= 1);
    assert.ok(right.vector[1] <= 1);
  });
});

void describe('hold morphology artifact serialization', () => {
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3] as const;
  const kilter: HoldMorphologyRecord = {
    morphologyVersion: HOLD_MORPHOLOGY_VERSION,
    boardType: 'kilter',
    layoutId: 1,
    placementId: 99,
    setId: 1,
    sourceAsset: 'packages/web/public/images/kilter/test.png',
    sourceAssetSha256: 'abc',
    normalizedCenterDistance: 0,
    vector,
  };
  const moon: HoldMorphologyRecord = {
    morphologyVersion: HOLD_MORPHOLOGY_VERSION,
    boardType: 'moonboard',
    layoutId: 2,
    gridCellId: 10,
    setId: 3,
    sourceAsset: 'packages/web/public/images/moonboard/test.png',
    sourceAssetSha256: 'def',
    normalizedCenterDistance: 0.1,
    vector,
  };

  void test('uses placement and grid-cell keys without collisions', () => {
    assert.equal(holdMorphologyRecordKey(kilter), 'kilter:1:placement:99');
    assert.equal(holdMorphologyRecordKey(moon), 'moonboard:2:cell:10');
  });

  void test('sorts records before JSONL rendering for byte-stable regeneration', () => {
    const forward = renderHoldMorphologyJsonl([kilter, moon]);
    const reverse = renderHoldMorphologyJsonl([moon, kilter]);
    assert.equal(reverse, forward);
    assert.equal(forward.split('\n').filter(Boolean).length, 2);
  });
});
