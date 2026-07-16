/**
 * Read-only Stage 3 publish shadow.
 *
 * Loads a candidate content-prior JSONL export, replays the existing history
 * backtest against the latest frozen coefficient snapshot, and exits non-zero
 * when the content signal violates a pre-registered regression or invariant
 * threshold. It never refits coefficients and never writes database state.
 *
 * Run:
 *   vp run db:evaluate-content-prior-shadow -- \
 *     --in=ml/climb2vec/artifacts/run-7-content.jsonl
 *
 * Optional:
 *   --limit=20000
 *   --coeff-version=<persisted version>
 *   --out=ml/climb2vec/artifacts/shadow-report.json
 */
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { buildBacktestSampleSql, evaluateBacktest, type BacktestSampleRow } from '../src/queries/grade-model/index.js';
import {
  hydrateFrozenGradeCoefficients,
  type FrozenCoefficientRow,
} from '../src/queries/content-model/frozen-coefficients.js';
import {
  evaluateContentPriorShadow,
  parseContentPriorArtifactRecord,
  type ContentPriorCandidate,
} from '../src/queries/content-model/shadow-evaluator.js';
import { rowsOf } from '../src/queries/util/rows.js';

const DEFAULT_BACKTEST_LIMIT = 20_000;

interface CliOptions {
  inputPath: string;
  outputPath: string | null;
  coefficientVersion: string | null;
  backtestLimit: number;
}

type Db = ReturnType<typeof createScriptDb>['db'];

function parseOptions(argv: readonly string[]): CliOptions {
  const optionValue = (name: string): string | undefined =>
    argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  const inputPath = optionValue('--in');
  if (!inputPath) throw new Error('Missing required --in=<candidate.jsonl>.');
  const limitText = optionValue('--limit');
  const backtestLimit = limitText === undefined ? DEFAULT_BACKTEST_LIMIT : Number(limitText);
  if (!Number.isInteger(backtestLimit) || backtestLimit <= 0) {
    throw new Error(`--limit must be a positive integer, received ${limitText ?? ''}.`);
  }
  return {
    inputPath,
    outputPath: optionValue('--out') ?? null,
    coefficientVersion: optionValue('--coeff-version') ?? null,
    backtestLimit,
  };
}

async function loadCandidates(inputPath: string): Promise<ContentPriorCandidate[]> {
  const reader = createInterface({
    input: createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const candidates: ContentPriorCandidate[] = [];
  const seenKeys = new Set<string>();
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseContentPriorArtifactRecord(JSON.parse(trimmed) as unknown, lineNumber);
    if (seenKeys.has(parsed.key)) {
      throw new Error(`Duplicate candidate key at line ${lineNumber}.`);
    }
    seenKeys.add(parsed.key);
    if (parsed.candidate !== null) candidates.push(parsed.candidate);
  }
  if (candidates.length === 0) throw new Error(`No candidate rows found in ${inputPath}.`);
  return candidates;
}

async function loadFrozenCoefficients(db: Db, requestedVersion: string | null) {
  let coefficientVersion = requestedVersion;
  if (coefficientVersion === null) {
    const latestRows = rowsOf<{ coeff_version: string }>(
      await db.execute(sql`
        SELECT coeff_version
        FROM board_grade_coefficients
        WHERE kind <> 'gate_results'
        GROUP BY coeff_version
        ORDER BY MAX(created_at) DESC
        LIMIT 1
      `),
    );
    coefficientVersion = latestRows[0]?.coeff_version ?? null;
  }
  if (coefficientVersion === null) throw new Error('No persisted grade coefficient snapshot exists.');

  const coefficientRows = rowsOf<FrozenCoefficientRow>(
    await db.execute(sql`
      SELECT coeff_version, kind, key, payload
      FROM board_grade_coefficients
      WHERE coeff_version = ${coefficientVersion}
        AND kind <> 'gate_results'
    `),
  );
  const coefficients = hydrateFrozenGradeCoefficients(coefficientRows);
  if (coefficients === null) {
    throw new Error(`Coefficient snapshot ${coefficientVersion} has no model rows.`);
  }
  return coefficients;
}

function normalizeBacktestRows(rows: readonly BacktestSampleRow[]): BacktestSampleRow[] {
  return rows.map((row) => ({
    ...row,
    angle: Number(row.angle),
    snap_avg: Number(row.snap_avg),
    snap_display: row.snap_display === null ? null : Number(row.snap_display),
    snap_count: Number(row.snap_count),
    final_avg: Number(row.final_avg),
    sibling_states: (row.sibling_states ?? []).map((sibling) => ({
      angle: Number(sibling.angle),
      difficulty_average: sibling.difficulty_average === null ? null : Number(sibling.difficulty_average),
      display_difficulty: sibling.display_difficulty === null ? null : Number(sibling.display_difficulty),
      ascensionist_count: sibling.ascensionist_count === null ? null : Number(sibling.ascensionist_count),
    })),
  }));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const candidates = await loadCandidates(options.inputPath);
  const { db, close } = createScriptDb();
  let transactionOpen = false;
  try {
    await db.execute(sql`BEGIN TRANSACTION READ ONLY`);
    transactionOpen = true;
    await db.execute(sql`SET LOCAL statement_timeout = '5min'`);
    const coefficients = await loadFrozenCoefficients(db, options.coefficientVersion);
    const backtestSample = buildBacktestSampleSql(options.backtestLimit);
    const backtestRows = normalizeBacktestRows(
      rowsOf<BacktestSampleRow>(
        await db.execute(sql`
          SELECT sample.*
          FROM (${backtestSample}) sample
          JOIN board_climbs climb
            ON climb.board_type = sample.board_type
           AND climb.uuid = sample.climb_uuid
          WHERE climb.is_listed = true
            AND COALESCE(climb.is_draft, false) = false
        `),
      ),
    );
    const baseline = evaluateBacktest(backtestRows, coefficients);
    const report = {
      generatedAt: new Date().toISOString(),
      inputPath: options.inputPath,
      coeffVersion: coefficients.coeffVersion,
      backtestLimit: options.backtestLimit,
      ...evaluateContentPriorShadow(backtestRows, candidates, coefficients, baseline),
    };
    await db.execute(sql`COMMIT`);
    transactionOpen = false;

    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath !== null) await writeFile(options.outputPath, serialized, 'utf8');
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        await db.execute(sql`ROLLBACK`);
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[content-shadow] failed:', error);
  process.exit(1);
});
