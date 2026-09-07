import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MORPHOLOGY_VECTOR_LENGTH, parseMorphologyRecord } from './extract-training-matrix-records.js';

const vector = Array.from({ length: MORPHOLOGY_VECTOR_LENGTH }, (_, index) => index / 10);

const kilterRecord = {
  morphologyVersion: 'hold-morphology-v1',
  boardType: 'kilter',
  layoutId: 1,
  placementId: 1234,
  normalizedCenterDistance: 0.42,
  vector,
};

void describe('hold-morphology artifact validation', () => {
  void test('reads a placement record without inventing fields', () => {
    assert.deepEqual(parseMorphologyRecord(JSON.stringify(kilterRecord), 1), kilterRecord);
  });

  void test('reads a MoonBoard record under its grid-cell identity', () => {
    const moonboardRecord = {
      morphologyVersion: 'hold-morphology-v1',
      boardType: 'moonboard',
      layoutId: 9,
      gridCellId: 77,
      normalizedCenterDistance: 0.1,
      vector,
    };
    assert.deepEqual(parseMorphologyRecord(JSON.stringify(moonboardRecord), 4), moonboardRecord);
  });

  void test('names the line when the artifact is truncated mid-record', () => {
    assert.throws(
      () => parseMorphologyRecord('{"morphologyVersion":"hold-morph', 12),
      /morphology artifact line 12: invalid JSON/,
    );
  });

  void test('names the line when a record has no vector', () => {
    const { vector: _dropped, ...withoutVector } = kilterRecord;
    assert.throws(
      () => parseMorphologyRecord(JSON.stringify(withoutVector), 7),
      /morphology artifact line 7: vector must be a number array/,
    );
  });

  void test('rejects a vector of the wrong width', () => {
    assert.throws(
      () => parseMorphologyRecord(JSON.stringify({ ...kilterRecord, vector: [0.1, 0.2] }), 3),
      /morphology artifact line 3: vector must contain exactly 12 numbers; received 2/,
    );
  });

  void test('rejects a non-finite vector component', () => {
    assert.throws(
      () => parseMorphologyRecord(JSON.stringify({ ...kilterRecord, vector: [...vector.slice(1), null] }), 5),
      /morphology artifact line 5: vector\[11\] must be a finite number/,
    );
  });

  void test('rejects a record whose board keeps no hold identity', () => {
    const { placementId: _dropped, ...withoutPlacement } = kilterRecord;
    assert.throws(
      () => parseMorphologyRecord(JSON.stringify(withoutPlacement), 8),
      /morphology artifact line 8: placementId must be an integer/,
    );
  });

  void test('rejects a record with no morphologyVersion', () => {
    const { morphologyVersion: _dropped, ...withoutVersion } = kilterRecord;
    assert.throws(
      () => parseMorphologyRecord(JSON.stringify(withoutVersion), 2),
      /morphology artifact line 2: morphologyVersion must be a non-empty string/,
    );
  });

  void test('rejects a JSONL line that is not an object', () => {
    assert.throws(() => parseMorphologyRecord('[1,2,3]', 6), /morphology artifact line 6: expected a JSON object/);
  });
});
