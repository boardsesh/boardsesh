import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertCompleteArtifactCoverage,
  contentArtifactKey,
  inspectContentArtifact,
  parseContentArtifactRecord,
  type ContentArtifactIdentity,
} from './load-content-model-records.js';

const expected: ContentArtifactIdentity = {
  boardType: 'kilter',
  modelVersion: 'climb2vec-relational-morphology-v1',
};
const embedding = Array.from({ length: 64 }, (_, index) => (index === 0 ? 1 : 0));

const supportedRecord = {
  boardType: expected.boardType,
  modelVersion: expected.modelVersion,
  climbUuid: 'climb-a',
  angle: 40,
  supported: true,
  contentPrior: 20.25,
  contentSd: 1.4,
  embedding,
};

void describe('content-model artifact validation', () => {
  void test('accepts an identified supported record without stamping CLI identity over it', () => {
    assert.deepEqual(parseContentArtifactRecord(JSON.stringify(supportedRecord), 1, expected), supportedRecord);
  });

  void test('rejects an embedding with the wrong model width', () => {
    assert.throws(
      () => parseContentArtifactRecord(JSON.stringify({ ...supportedRecord, embedding: [0.6, 0.8] }), 1, expected),
      /embedding must contain exactly 64 numbers; received 2/,
    );
  });

  void test('preserves a different board identity so a combined artifact can be filtered safely', () => {
    assert.deepEqual(
      parseContentArtifactRecord(JSON.stringify({ ...supportedRecord, boardType: 'tension' }), 7, expected),
      { ...supportedRecord, boardType: 'tension' },
    );
  });

  void test('rejects a record from a different model version', () => {
    assert.throws(
      () => parseContentArtifactRecord(JSON.stringify({ ...supportedRecord, modelVersion: 'old-model' }), 2, expected),
      /modelVersion "old-model" does not match --model=climb2vec-relational-morphology-v1/,
    );
  });

  void test('accepts an explicit unsupported record only when model outputs are null', () => {
    const unsupportedRecord = {
      ...supportedRecord,
      supported: false,
      contentPrior: null,
      contentSd: null,
      embedding: null,
    };
    assert.deepEqual(parseContentArtifactRecord(JSON.stringify(unsupportedRecord), 1, expected), unsupportedRecord);
    assert.throws(
      () => parseContentArtifactRecord(JSON.stringify({ ...unsupportedRecord, contentPrior: 18 }), 1, expected),
      /contentPrior must be null when supported=false/,
    );
  });

  void test('does not infer legacy identity unless both CLI identities were explicit', () => {
    const {
      boardType: _boardType,
      modelVersion: _modelVersion,
      supported: _supported,
      ...unidentified
    } = supportedRecord;
    assert.throws(
      () => parseContentArtifactRecord(JSON.stringify(unidentified), 1, expected),
      /legacy content records require explicit --board and --model=climb2vec-v1/,
    );
  });

  void test('does not accept an untyped artifact under a Stage-3 model name', () => {
    const {
      boardType: _boardType,
      modelVersion: _modelVersion,
      supported: _supported,
      ...unidentified
    } = supportedRecord;
    assert.throws(
      () =>
        parseContentArtifactRecord(JSON.stringify(unidentified), 1, {
          ...expected,
          allowLegacy: true,
        }),
      /legacy content records require explicit --board and --model=climb2vec-v1/,
    );
  });

  void test('normalizes the exact incumbent climb2vec-v1 JSONL schema as a supported upsert row', () => {
    const legacyLine = JSON.stringify({
      climbUuid: 'legacy-climb',
      angle: 40,
      layoutId: 1,
      contentPrior: 19.75,
      contentSd: 1.55,
      embedding,
    });
    assert.deepEqual(
      parseContentArtifactRecord(legacyLine, 1, {
        boardType: 'kilter',
        modelVersion: 'climb2vec-v1',
        allowLegacy: true,
      }),
      {
        boardType: 'kilter',
        modelVersion: 'climb2vec-v1',
        climbUuid: 'legacy-climb',
        angle: 40,
        supported: true,
        contentPrior: 19.75,
        contentSd: 1.55,
        embedding,
      },
    );
  });

  void test('rejects an artifact that mixes identified and legacy schemas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-artifact-'));
    const path = join(directory, 'mixed.jsonl');
    await writeFile(
      path,
      `${JSON.stringify(supportedRecord)}\n${JSON.stringify({
        climbUuid: 'legacy-climb',
        angle: 40,
        contentPrior: 19,
        contentSd: 1.5,
        embedding: [1, 0],
      })}\n`,
    );

    await assert.rejects(
      inspectContentArtifact(path, { ...expected, allowLegacy: true }),
      /cannot mix identified and legacy content records/,
    );
  });

  void test('rejects an empty artifact before a board can be cleared', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'content-artifact-'));
    const path = join(directory, 'empty.jsonl');
    await writeFile(path, ' \n\t\n');

    await assert.rejects(
      inspectContentArtifact(path, expected),
      /contains no records; refusing to clear the selected board/,
    );
  });

  void test('requires exact eligible-catalog coverage, not only the same row count', () => {
    assert.doesNotThrow(() =>
      assertCompleteArtifactCoverage(new Set([contentArtifactKey('climb-a', 40), contentArtifactKey('climb-b', 50)]), [
        { climbUuid: 'climb-a', angle: 40 },
        { climbUuid: 'climb-b', angle: 50 },
      ]),
    );
    assert.throws(
      () =>
        assertCompleteArtifactCoverage(
          new Set([contentArtifactKey('climb-a', 40), contentArtifactKey('wrong-climb', 50)]),
          [
            { climbUuid: 'climb-a', angle: 40 },
            { climbUuid: 'climb-b', angle: 50 },
          ],
        ),
      /artifact=2, eligible=2, missing=1 .*extra=1/,
    );
  });
});
