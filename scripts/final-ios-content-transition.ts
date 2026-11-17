/** One reviewed campaign transition; the general content gate is unchanged. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CandidateFile, ContentGateOptions, ContentOffender } from './assert-screenshot-content';

const SOURCE = 'd5855045ff8170e4e72f9f2edfd1a2d5d396390d';
const BASELINE = 'c080874f59b59f222c162e8936ad93f06019e73d';
export interface ReviewedRatio {
  path: string;
  currentSha256: string;
  baselineSha256: string;
  currentRawBytes: number;
  baselineRawBytes: number;
  reason: string;
}
export interface ReviewedTransition {
  source: string;
  baselineSource: string;
  inventory: string[];
  exceptions: ReviewedRatio[];
}
interface OriginalClassifier {
  DEFAULT_MIN_BYTES: number;
  DEFAULT_MIN_RATIO: number;
  findContentOffenders(
    candidates: readonly CandidateFile[],
    baseline: ReadonlyMap<string, number>,
    options: ContentGateOptions,
  ): ContentOffender[];
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function samePaths(actual: Iterable<string>, expected: Set<string>): boolean {
  const paths = [...actual];
  return (
    paths.length === expected.size && new Set(paths).size === expected.size && paths.every((path) => expected.has(path))
  );
}

/** The original classifier runs first, including a separate unconditional floor pass. */
export function assertReviewedTransition(
  candidates: readonly CandidateFile[],
  baseline: ReadonlyMap<string, number>,
  currentHashes: ReadonlyMap<string, string>,
  baselineHashes: ReadonlyMap<string, string>,
  review: ReviewedTransition,
  classifier: OriginalClassifier,
): void {
  requireCondition(review.source === SOURCE && review.baselineSource === BASELINE, 'Unreviewed source transition');
  const inventory = new Set(review.inventory);
  requireCondition(inventory.size === 228 && review.inventory.length === 228, 'Invalid reviewed inventory');
  requireCondition(
    samePaths(
      candidates.map((file) => file.relativePath),
      inventory,
    ),
    'Current inventory differs from reviewed 228',
  );
  requireCondition(
    samePaths(baseline.keys(), inventory),
    'Baseline must contain the same complete 228-image inventory',
  );
  const options = { minBytes: classifier.DEFAULT_MIN_BYTES, minRatio: classifier.DEFAULT_MIN_RATIO };
  requireCondition(
    classifier.findContentOffenders(candidates, new Map(), options).length === 0,
    'Absolute content floor failed',
  );
  const offenders = classifier.findContentOffenders(candidates, baseline, options);
  const records = new Map(review.exceptions.map((record) => [record.path, record]));
  requireCondition(
    review.exceptions.length === 40 && records.size === 40,
    'Expected exactly 40 unique reviewed ratios',
  );
  requireCondition(
    offenders.length === 40 && offenders.every((offender) => records.has(offender.file)),
    'Unexpected ratio failures or changed baseline',
  );
  for (const offender of offenders) {
    const record = records.get(offender.file)!;
    requireCondition(
      inventory.has(record.path) && typeof record.reason === 'string' && record.reason.length > 20,
      'Missing reviewed rationale',
    );
    requireCondition(
      /^[a-f0-9]{64}$/.test(record.currentSha256) && /^[a-f0-9]{64}$/.test(record.baselineSha256),
      'Invalid reviewed checksums',
    );
    requireCondition(
      currentHashes.get(record.path) === record.currentSha256 &&
        baselineHashes.get(record.path) === record.baselineSha256,
      `Unreviewed image bytes: ${record.path}`,
    );
    requireCondition(
      offender.size === record.currentRawBytes && offender.baselineSize === record.baselineRawBytes,
      `Unreviewed raw measurement: ${record.path}`,
    );
  }
}

async function main(): Promise<void> {
  const [directory, baselineDirectory] = process.argv.slice(2);
  requireCondition(
    directory && baselineDirectory,
    'Usage: final-ios-content-transition.ts <current tree> <baseline tree>',
  );
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireCondition(source === SOURCE, 'Content classifier must come from the frozen application checkout');
  const gatePath = resolve('scripts/assert-screenshot-content.ts');
  const gate = (await import(pathToFileURL(gatePath).href)) as typeof import('./assert-screenshot-content');
  const candidates = gate.readPngSizesRecursively(directory);
  const baseline = gate.readBaselineSizeMap(baselineDirectory);
  const hashes = (root: string, paths: Iterable<string>) =>
    new Map(
      [...paths].map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex'),
      ]),
    );
  const review = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'final-ios-content-transition.json'), 'utf8'),
  ) as ReviewedTransition;
  assertReviewedTransition(
    candidates,
    baseline,
    hashes(
      directory,
      candidates.map((file) => file.relativePath),
    ),
    hashes(baselineDirectory, baseline.keys()),
    review,
    gate,
  );
  console.log(
    'Content verified: all 228 clear the original absolute floor; exactly 40 hash-bound, reviewed layout transitions explain the original ratio failures.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
