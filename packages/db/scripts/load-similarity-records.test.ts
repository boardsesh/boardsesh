import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertUnchangedSimilaritySelection,
  inspectSimilarityArtifact,
  parseSimilarityArtifactRecord,
  similarityArtifactKey,
  type SimilarityArtifactIdentity,
} from './load-similarity-records.js';

const expected: SimilarityArtifactIdentity = {
  boardType: 'kilter',
  modelVersion: 'climb2vec-relational-morphology-v1',
};

function record(boardType: string, climbUuid: string) {
  return {
    boardType,
    modelVersion: expected.modelVersion,
    climbUuid,
    layoutId: 1,
    angle: 40,
    neighbours: [[`${climbUuid}-neighbor`, 0.9]],
  };
}

void describe('similarity artifact validation', () => {
  void test('preserves record board identity instead of stamping the CLI board', () => {
    assert.deepEqual(
      parseSimilarityArtifactRecord(JSON.stringify(record('tension', 'tension-a')), 1, expected),
      record('tension', 'tension-a'),
    );
  });

  void test('rejects a mismatched model version', () => {
    assert.throws(
      () =>
        parseSimilarityArtifactRecord(
          JSON.stringify({ ...record('kilter', 'kilter-a'), modelVersion: 'old-model' }),
          4,
          expected,
        ),
      /line 4: modelVersion "old-model" does not match --model=climb2vec-relational-morphology-v1/,
    );
  });

  void test('selects one board from a fully validated combined artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'similarity-artifact-'));
    const path = join(directory, 'combined.jsonl');
    await writeFile(
      path,
      `${JSON.stringify(record('kilter', 'kilter-a'))}\n${JSON.stringify(record('tension', 'tension-a'))}\n`,
    );

    assert.deepEqual(await inspectSimilarityArtifact(path, expected), {
      mode: 'identified',
      keys: new Set([similarityArtifactKey('kilter-a', 40)]),
      artifactRows: 2,
      selectedRows: 1,
    });
  });

  void test('normalizes the exact incumbent similarity JSONL schema with explicit CLI identity', () => {
    assert.deepEqual(
      parseSimilarityArtifactRecord(
        JSON.stringify({
          climbUuid: 'legacy-climb',
          angle: 40,
          neighbours: [['legacy-neighbor', 0.8]],
        }),
        1,
        {
          boardType: 'kilter',
          modelVersion: 'climb2vec-v1',
          allowLegacy: true,
        },
      ),
      {
        boardType: 'kilter',
        modelVersion: 'climb2vec-v1',
        climbUuid: 'legacy-climb',
        layoutId: null,
        angle: 40,
        neighbours: [['legacy-neighbor', 0.8]],
      },
    );
  });

  void test('does not accept an untyped artifact under a Stage-3 model name', () => {
    assert.throws(
      () =>
        parseSimilarityArtifactRecord(
          JSON.stringify({
            climbUuid: 'untyped',
            angle: 40,
            neighbours: [['neighbor', 0.8]],
          }),
          1,
          {
            ...expected,
            allowLegacy: true,
          },
        ),
      /legacy similarity records require explicit --board and --model=climb2vec-v1/,
    );
  });

  void test('rejects an artifact that mixes identified and legacy schemas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'similarity-artifact-'));
    const path = join(directory, 'mixed.jsonl');
    await writeFile(
      path,
      `${JSON.stringify(record('kilter', 'identified'))}\n${JSON.stringify({
        climbUuid: 'legacy',
        angle: 40,
        neighbours: [['legacy-neighbor', 0.8]],
      })}\n`,
    );

    await assert.rejects(
      inspectSimilarityArtifact(path, { ...expected, allowLegacy: true }),
      /cannot mix identified and legacy similarity records/,
    );
  });

  void test('detects a selected-board key change between validation and load', () => {
    assert.throws(
      () =>
        assertUnchangedSimilaritySelection(
          new Set([similarityArtifactKey('expected', 40)]),
          new Set([similarityArtifactKey('changed', 40)]),
        ),
      /changed after validation: expected=1, loaded=1, missing=1, extra=1/,
    );
  });
});
