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
import { and, desc, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardGradeCoefficients } from '../src/schema/app/climb-grades.js';
import { boardClimbs } from '../src/schema/boards/unified.js';
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
const LISTED_CLIMB_LOOKUP_CHUNK = 10_000;

interface CliOptions {
  inputPath: string;
  outputPath: string | null;
  coefficientVersion: string | null;
  backtestLimit: number;
}

type Db = ReturnType<typeof createScriptDb>['db'];
type ReadDb = Pick<Db, 'select'>;

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
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });
  const candidates: ContentPriorCandidate[] = [];
  const seenKeys = new Set<string>();
  let lineNumber = 0;
  try {
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
  } finally {
    reader.close();
    input.destroy();
  }
  if (candidates.length === 0) throw new Error(`No candidate rows found in ${inputPath}.`);
  return candidates;
}

async function loadFrozenCoefficients(db: ReadDb, requestedVersion: string | null) {
  let coefficientVersion = requestedVersion;
  if (coefficientVersion === null) {
    const latestCreatedAt = max(boardGradeCoefficients.createdAt);
    const [latestRow] = await db
      .select({
        coeffVersion: boardGradeCoefficients.coeffVersion,
        latestCreatedAt,
      })
      .from(boardGradeCoefficients)
      .where(ne(boardGradeCoefficients.kind, 'gate_results'))
      .groupBy(boardGradeCoefficients.coeffVersion)
      .orderBy(desc(latestCreatedAt))
      .limit(1);
    coefficientVersion = latestRow?.coeffVersion ?? null;
  }
  if (coefficientVersion === null) throw new Error('No persisted grade coefficient snapshot exists.');

  const coefficientRows: FrozenCoefficientRow[] = (
    await db
      .select({
        coeffVersion: boardGradeCoefficients.coeffVersion,
        kind: boardGradeCoefficients.kind,
        key: boardGradeCoefficients.key,
        payload: boardGradeCoefficients.payload,
      })
      .from(boardGradeCoefficients)
      .where(
        and(
          eq(boardGradeCoefficients.coeffVersion, coefficientVersion),
          ne(boardGradeCoefficients.kind, 'gate_results'),
        ),
      )
  ).map((row) => ({
    coeff_version: row.coeffVersion,
    kind: row.kind,
    key: row.key,
    payload: row.payload,
  }));
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
  try {
    const report = await db.transaction(
      async (transaction) => {
        // SET LOCAL has no Drizzle query-builder equivalent and is scoped to
        // this read-only transaction.
        await transaction.execute(sql`SET LOCAL statement_timeout = '5min'`);
        const coefficients = await loadFrozenCoefficients(transaction, options.coefficientVersion);

        // This is the existing gate query: DISTINCT ON, a lateral join, and
        // JSON aggregation make raw SQL the appropriate representation.
        const backtestSample = buildBacktestSampleSql(options.backtestLimit);
        const sampledRows = normalizeBacktestRows(rowsOf<BacktestSampleRow>(await transaction.execute(backtestSample)));
        const climbUuids = [...new Set(sampledRows.map((row) => row.climb_uuid))];
        const listedKeys = new Set<string>();
        for (let offset = 0; offset < climbUuids.length; offset += LISTED_CLIMB_LOOKUP_CHUNK) {
          const uuidChunk = climbUuids.slice(offset, offset + LISTED_CLIMB_LOOKUP_CHUNK);
          const listedClimbs = await transaction
            .select({
              boardType: boardClimbs.boardType,
              climbUuid: boardClimbs.uuid,
            })
            .from(boardClimbs)
            .where(
              and(
                inArray(boardClimbs.uuid, uuidChunk),
                eq(boardClimbs.isListed, true),
                or(eq(boardClimbs.isDraft, false), isNull(boardClimbs.isDraft)),
              ),
            );
          for (const climb of listedClimbs) {
            listedKeys.add(`${climb.boardType}\0${climb.climbUuid}`);
          }
        }
        const backtestRows = sampledRows.filter((row) => listedKeys.has(`${row.board_type}\0${row.climb_uuid}`));
        const baseline = evaluateBacktest(backtestRows, coefficients);
        return {
          generatedAt: new Date().toISOString(),
          inputPath: options.inputPath,
          coeffVersion: coefficients.coeffVersion,
          backtestLimit: options.backtestLimit,
          ...evaluateContentPriorShadow(backtestRows, candidates, coefficients, baseline),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath !== null) await writeFile(options.outputPath, serialized, 'utf8');
    process.stdout.write(serialized);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error('[content-shadow] failed:', error);
  process.exit(1);
});
