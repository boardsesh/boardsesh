/**
 * When the nightly grade refresh may reuse the last history backtest instead of
 * re-running it.
 *
 * The backtest (`buildBacktestSampleSql` + `evaluateBacktest`) reads about 3.2M
 * blocks of `board_climb_stats_history` per run. Its verdict depends on three
 * things: the coefficient set, the model version, and the grade-model code that
 * turns the sample into a posterior. Coefficients are frozen for up to a week,
 * so on most nights all three are unchanged and the run repeats yesterday's
 * answer. The only input that moves is the sample itself (new history rows and
 * fresher truth), and over Sep 2026 that shifted the improvement metric by under
 * 0.01 against a 0.01 tolerance. A refit (weekly or forced) or any grade-model
 * code change re-runs it.
 *
 * Pure apart from {@link gradeModelCodeHash}, which reads the source files.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateResult } from '../src/queries/grade-model/index.js';

export const BACKTEST_GATE_NAMES = ['tail_backtest', 'head_holdout'] as const;

const GRADE_MODEL_SOURCE_DIR = fileURLToPath(new URL('../src/queries/grade-model/', import.meta.url));

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Tests do not change what the model computes.
      if (entry.name === '__tests__') continue;
      files.push(...listSourceFiles(join(directory, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/**
 * sha256 over every grade-model source file (relative path + contents, in path
 * order). The nightly job runs from a source checkout, so any change to the blend,
 * the gates or the backtest SQL gives a new hash and forces a real backtest,
 * even when GRADE_MODEL_VERSION was not bumped.
 */
export function gradeModelCodeHash(sourceDirectory: string = GRADE_MODEL_SOURCE_DIR): string {
  const hash = createHash('sha256');
  const files = listSourceFiles(sourceDirectory)
    .map((filePath) => ({ filePath, relativePath: relative(sourceDirectory, filePath).split(sep).join('/') }))
    .sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
  for (const { filePath, relativePath } of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** One stored `gate_results` row for the current coefficient set. */
export interface StoredGateRun {
  runKey: string;
  payload: unknown;
}

export interface ReusableBacktest {
  runKey: string;
  gates: GateResult[];
}

function isGateResult(candidate: unknown): candidate is GateResult {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const gate = candidate as Record<string, unknown>;
  return (
    typeof gate.gate === 'string' &&
    typeof gate.passed === 'boolean' &&
    typeof gate.detail === 'string' &&
    typeof gate.metrics === 'object' &&
    gate.metrics !== null
  );
}

/**
 * The newest stored run (runs are passed newest first) that EVALUATED both
 * backtest gates — passed and not skipped — under the same model version and
 * grade-model code hash. A reused result is itself stored as skipped, so a
 * chain of reuse nights always points back at the last real evaluation. The
 * caller only asks with the current coefficient version's runs, and a frozen
 * set is at most COEFF_MAX_AGE_DAYS old, so the evaluation it finds is too.
 */
export function findReusableBacktest(
  runs: readonly StoredGateRun[],
  expected: { modelVersion: string; codeHash: string },
): ReusableBacktest | null {
  for (const run of runs) {
    if (typeof run.payload !== 'object' || run.payload === null) continue;
    const payload = run.payload as Record<string, unknown>;
    if (payload.modelVersion !== expected.modelVersion) continue;
    if (payload.gradeModelHash !== expected.codeHash) continue;
    if (!Array.isArray(payload.gates)) continue;
    const storedGates = payload.gates.filter(isGateResult);
    const backtestGates = BACKTEST_GATE_NAMES.map((name) => storedGates.find((gate) => gate.gate === name));
    const evaluated = backtestGates.every(
      (gate): gate is GateResult => gate !== undefined && gate.passed && gate.skipped !== true,
    );
    if (!evaluated) continue;
    return { runKey: run.runKey, gates: backtestGates as GateResult[] };
  }
  return null;
}

/**
 * The gate entries a reuse night records: the evaluated run's metrics, marked
 * skipped (so the next night's lookup skips over them) and naming the run they
 * came from, so run-over-run monitoring can tell a reuse from a fresh result.
 */
export function reusedBacktestGates(reusable: ReusableBacktest): GateResult[] {
  return reusable.gates.map((gate) => ({
    ...gate,
    passed: true,
    skipped: true,
    detail: `reused from gate run ${reusable.runKey} (same coefficients, model version and grade-model code): ${gate.detail}`,
  }));
}
