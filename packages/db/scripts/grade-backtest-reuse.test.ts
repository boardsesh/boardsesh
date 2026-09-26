import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateResult } from '../src/queries/grade-model/index.js';
import {
  findReusableBacktest,
  gradeModelCodeHash,
  reusedBacktestGates,
  type StoredGateRun,
} from './grade-backtest-reuse.js';

const MODEL = 'v2.1';
const HASH = 'a'.repeat(64);

function backtestGates(overrides: Partial<GateResult> = {}): GateResult[] {
  return [
    { gate: 'tail_backtest', passed: true, detail: 'MAE 0.58 vs raw 0.62', metrics: { multiN: 700 }, ...overrides },
    { gate: 'head_holdout', passed: true, detail: 'MAE 0.41 vs raw 0.41', metrics: { singleN: 458 }, ...overrides },
    { gate: 'no_shock', passed: true, detail: 'ok', metrics: {} },
  ];
}

function run(runKey: string, payload: Record<string, unknown>): StoredGateRun {
  return { runKey, payload };
}

void test('reuses the newest evaluated backtest and walks past earlier reuse nights to find it', () => {
  const evaluated = run('2026-09-24T12:00:00Z', { modelVersion: MODEL, gradeModelHash: HASH, gates: backtestGates() });
  const reusedNight = run('2026-09-25T12:00:00Z', {
    modelVersion: MODEL,
    gradeModelHash: HASH,
    gates: reusedBacktestGates({ runKey: evaluated.runKey, gates: backtestGates().slice(0, 2) }),
  });
  const reusable = findReusableBacktest([reusedNight, evaluated], { modelVersion: MODEL, codeHash: HASH });
  assert.equal(reusable?.runKey, evaluated.runKey);
  assert.deepEqual(
    reusable?.gates.map((gate) => gate.gate),
    ['tail_backtest', 'head_holdout'],
  );

  const recorded = reusedBacktestGates(reusable!);
  assert.ok(recorded.every((gate) => gate.passed && gate.skipped === true));
  assert.match(recorded[0].detail, /reused from gate run 2026-09-24T12:00:00Z/);
  assert.deepEqual(recorded[0].metrics, { multiN: 700 });
});

void test('runs the backtest again whenever an input may have changed or no evaluated pass exists', () => {
  const expected = { modelVersion: MODEL, codeHash: HASH };
  // Grade-model code changed without a version bump.
  assert.equal(
    findReusableBacktest(
      [run('r1', { modelVersion: MODEL, gradeModelHash: 'b'.repeat(64), gates: backtestGates() })],
      expected,
    ),
    null,
  );
  // Model version changed.
  assert.equal(
    findReusableBacktest([run('r1', { modelVersion: 'v2.0', gradeModelHash: HASH, gates: backtestGates() })], expected),
    null,
  );
  // Rows written before the hash existed.
  assert.equal(findReusableBacktest([run('r1', { modelVersion: MODEL, gates: backtestGates() })], expected), null);
  // A dev --allow-empty-backtest waiver is not an evaluation.
  assert.equal(
    findReusableBacktest(
      [run('r1', { modelVersion: MODEL, gradeModelHash: HASH, gates: backtestGates({ skipped: true }) })],
      expected,
    ),
    null,
  );
  // A stored failure is never reused (and never published, but be strict).
  assert.equal(
    findReusableBacktest(
      [run('r1', { modelVersion: MODEL, gradeModelHash: HASH, gates: backtestGates({ passed: false }) })],
      expected,
    ),
    null,
  );
  // Only one of the two backtest gates present.
  assert.equal(
    findReusableBacktest(
      [run('r1', { modelVersion: MODEL, gradeModelHash: HASH, gates: backtestGates().slice(1) })],
      expected,
    ),
    null,
  );
  assert.equal(findReusableBacktest([], expected), null);
});

void test('the code hash changes with any grade-model source file and ignores tests', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'grade-model-hash-'));
  try {
    writeFileSync(join(sourceDir, 'blend.ts'), 'export const weight = 1;\n');
    mkdirSync(join(sourceDir, '__tests__'));
    writeFileSync(join(sourceDir, '__tests__', 'blend.test.ts'), 'test one\n');
    const original = gradeModelCodeHash(sourceDir);
    assert.match(original, /^[0-9a-f]{64}$/);
    assert.equal(gradeModelCodeHash(sourceDir), original);

    writeFileSync(join(sourceDir, '__tests__', 'blend.test.ts'), 'test two\n');
    assert.equal(gradeModelCodeHash(sourceDir), original, 'test edits do not force a backtest');

    writeFileSync(join(sourceDir, 'blend.ts'), 'export const weight = 2;\n');
    assert.notEqual(gradeModelCodeHash(sourceDir), original, 'a model edit forces a backtest');
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
  // The real directory hashes without throwing.
  assert.match(gradeModelCodeHash(), /^[0-9a-f]{64}$/);
});
