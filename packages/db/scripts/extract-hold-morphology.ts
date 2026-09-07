import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOLD_MORPHOLOGY_FEATURE_NAMES,
  HOLD_MORPHOLOGY_VERSION,
  renderHoldMorphologyJsonl,
  type HoldMorphologyRecord,
} from '../src/queries/hold-morphology/index.js';
import {
  HOLD_MORPHOLOGY_BOARD_TYPES,
  extractCommittedHoldMorphology,
  type HoldMorphologyFailure,
  type HoldMorphologyBoardType,
} from './hold-morphology-art.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '../../..');
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, 'ml/climb2vec/artifacts', `${HOLD_MORPHOLOGY_VERSION}.jsonl`);

type CliOptions = {
  outputPath: string;
  failureOutputPath: string;
  check: boolean;
  strict: boolean;
  boardTypes: HoldMorphologyBoardType[];
};

function parseBoardTypes(value: string): HoldMorphologyBoardType[] {
  const requested = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = requested.filter((entry) => !HOLD_MORPHOLOGY_BOARD_TYPES.includes(entry as HoldMorphologyBoardType));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown --board value(s): ${invalid.join(', ')}. Expected ${HOLD_MORPHOLOGY_BOARD_TYPES.join(', ')}`,
    );
  }
  return requested as HoldMorphologyBoardType[];
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let outputPath = DEFAULT_OUTPUT_PATH;
  let failureOutputPath = `${DEFAULT_OUTPUT_PATH}.failures.json`;
  let failureOutputWasExplicit = false;
  let check = false;
  let strict = false;
  let boardTypes: HoldMorphologyBoardType[] = [...HOLD_MORPHOLOGY_BOARD_TYPES];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--strict') {
      strict = true;
      continue;
    }
    if (argument.startsWith('--out=')) {
      outputPath = path.resolve(REPO_ROOT, argument.slice('--out='.length));
      if (!failureOutputWasExplicit) failureOutputPath = `${outputPath}.failures.json`;
      continue;
    }
    if (argument === '--out') {
      const next = argv[index + 1];
      if (!next) throw new Error('--out requires a path');
      outputPath = path.resolve(REPO_ROOT, next);
      if (!failureOutputWasExplicit) failureOutputPath = `${outputPath}.failures.json`;
      index++;
      continue;
    }
    if (argument.startsWith('--failure-out=')) {
      failureOutputPath = path.resolve(REPO_ROOT, argument.slice('--failure-out='.length));
      failureOutputWasExplicit = true;
      continue;
    }
    if (argument === '--failure-out') {
      const next = argv[index + 1];
      if (!next) throw new Error('--failure-out requires a path');
      failureOutputPath = path.resolve(REPO_ROOT, next);
      failureOutputWasExplicit = true;
      index++;
      continue;
    }
    if (argument.startsWith('--board=')) {
      boardTypes = parseBoardTypes(argument.slice('--board='.length));
      continue;
    }
    if (argument === '--board') {
      const next = argv[index + 1];
      if (!next) throw new Error('--board requires a comma-separated board list');
      boardTypes = parseBoardTypes(next);
      index++;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (boardTypes.length === 0) throw new Error('--board must select at least one board');
  return { outputPath, failureOutputPath, check, strict, boardTypes };
}

function holdIdentity(boardType: HoldMorphologyBoardType, layoutId: number, holdId: number): string {
  return `${boardType}:${layoutId}:${holdId}`;
}

function coverageSummary(records: readonly HoldMorphologyRecord[], failures: readonly HoldMorphologyFailure[]) {
  const generatedByBoard = new Map<HoldMorphologyBoardType, Set<string>>(
    HOLD_MORPHOLOGY_BOARD_TYPES.map((boardType) => [boardType, new Set<string>()]),
  );
  const expectedByBoard = new Map<HoldMorphologyBoardType, Set<string>>(
    HOLD_MORPHOLOGY_BOARD_TYPES.map((boardType) => [boardType, new Set<string>()]),
  );
  for (const record of records) {
    const holdId = record.boardType === 'moonboard' ? record.gridCellId : record.placementId;
    const identity = holdIdentity(record.boardType, record.layoutId, holdId);
    generatedByBoard.get(record.boardType)!.add(identity);
    expectedByBoard.get(record.boardType)!.add(identity);
  }
  for (const failure of failures) {
    expectedByBoard.get(failure.boardType)!.add(holdIdentity(failure.boardType, failure.layoutId, failure.holdId));
  }

  const byBoard = Object.fromEntries(
    HOLD_MORPHOLOGY_BOARD_TYPES.map((boardType) => {
      const generated = generatedByBoard.get(boardType)!.size;
      const total = expectedByBoard.get(boardType)!.size;
      return [
        boardType,
        {
          generated,
          missing: total - generated,
          total,
          coverage: total > 0 ? Math.round((generated / total) * 1e8) / 1e8 : 0,
        },
      ];
    }),
  );
  const generated = [...generatedByBoard.values()].reduce((sum, identities) => sum + identities.size, 0);
  const total = [...expectedByBoard.values()].reduce((sum, identities) => sum + identities.size, 0);
  return {
    generated,
    missing: total - generated,
    total,
    coverage: total > 0 ? Math.round((generated / total) * 1e8) / 1e8 : 0,
    byBoard,
  };
}

function sourceVersionHash(records: readonly HoldMorphologyRecord[]): string {
  const assets = [...new Set(records.map((record) => `${record.sourceAsset}:${record.sourceAssetSha256}`))].sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        morphologyVersion: HOLD_MORPHOLOGY_VERSION,
        featureNames: HOLD_MORPHOLOGY_FEATURE_NAMES,
        assets,
      }),
    )
    .digest('hex');
}

function renderFailures(failures: readonly HoldMorphologyFailure[], records: readonly HoldMorphologyRecord[]): string {
  const sorted = [...failures].sort(
    (left, right) =>
      HOLD_MORPHOLOGY_BOARD_TYPES.indexOf(left.boardType) - HOLD_MORPHOLOGY_BOARD_TYPES.indexOf(right.boardType) ||
      left.layoutId - right.layoutId ||
      left.holdId - right.holdId ||
      left.reason.localeCompare(right.reason),
  );
  return `${JSON.stringify(
    {
      morphologyVersion: HOLD_MORPHOLOGY_VERSION,
      sourceVersionHash: sourceVersionHash(records),
      coverage: coverageSummary(records, failures),
      failures: sorted,
    },
    null,
    2,
  )}\n`;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await extractCommittedHoldMorphology({
    repoRoot: REPO_ROOT,
    boardTypes: options.boardTypes,
  });

  if (options.strict && result.failures.length > 0) {
    const preview = result.failures
      .slice(0, 20)
      .map(
        (failure) => `${failure.boardType}:${failure.layoutId}:${failure.holdId} ${failure.reason} — ${failure.detail}`,
      )
      .join('\n');
    const remaining = result.failures.length > 20 ? `\n...and ${result.failures.length - 20} more` : '';
    throw new Error(`Hold morphology extraction failed for ${result.failures.length} holds:\n${preview}${remaining}`);
  }

  const jsonl = renderHoldMorphologyJsonl(result.records);
  const failuresJson = renderFailures(result.failures, result.records);
  if (options.check) {
    const existing = await readFile(options.outputPath, 'utf8');
    const existingFailures = await readFile(options.failureOutputPath, 'utf8');
    if (existing !== jsonl) {
      throw new Error(
        `${path.relative(REPO_ROOT, options.outputPath)} is stale. Regenerate it with vp run db:extract-hold-morphology`,
      );
    }
    if (existingFailures !== failuresJson) {
      throw new Error(
        `${path.relative(REPO_ROOT, options.failureOutputPath)} is stale. Regenerate it with vp run db:extract-hold-morphology`,
      );
    }
    console.info(`✓ ${path.relative(REPO_ROOT, options.outputPath)} matches committed board art`);
  } else {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await mkdir(path.dirname(options.failureOutputPath), { recursive: true });
    await writeFile(options.outputPath, jsonl);
    await writeFile(options.failureOutputPath, failuresJson);
    console.info(`✓ Wrote ${path.relative(REPO_ROOT, options.outputPath)}`);
  }

  const counts = new Map<HoldMorphologyBoardType, number>(
    HOLD_MORPHOLOGY_BOARD_TYPES.map((boardType) => [boardType, 0]),
  );
  for (const record of result.records) counts.set(record.boardType, (counts.get(record.boardType) ?? 0) + 1);
  console.info(
    `${result.records.length} holds (${options.boardTypes
      .map((boardType) => `${boardType}=${counts.get(boardType) ?? 0}`)
      .join(', ')}), morphology=${HOLD_MORPHOLOGY_VERSION}`,
  );
  if (result.failures.length > 0) {
    console.warn(
      `⚠ ${result.failures.length} placements have no usable committed art; details: ${path.relative(
        REPO_ROOT,
        options.failureOutputPath,
      )}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('[extract-hold-morphology] failed:', error);
  process.exit(1);
});
