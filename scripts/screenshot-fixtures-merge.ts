/// <reference types="node" />

/**
 * Merge the fixture sets a fan-out recording produced into the one set the repo
 * commits.
 *
 *   vp run mobile:screenshot-fixtures-merge -- --out packages/mobile/screenshot-fixtures \
 *     ./artifacts/screenshot-fixtures-en-US-iphone-16-pro-max ./artifacts/screenshot-fixtures-android
 *
 * A recording run is sharded — the iOS workflow records one shard per (locale,
 * device), Android records its own — so each shard comes back holding only the
 * traffic ITS capture produced. The union is the set a replay run needs.
 *
 * The interesting part is the conflict rule: when two shards recorded the same
 * key, the bytes must be identical. They were recorded minutes apart from the
 * same account against the same backend, so a difference is real
 * nondeterminism (a resolver that reads the clock, a feed someone else wrote
 * to) and it will make a replay capture drift. Failing here, naming the key, is
 * how that gets seen instead of silently taking whichever shard sorted first.
 *
 * See docs/mobile-screenshot-fixtures.md for the recording runbook.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listFixtureFiles, readScreenshotFixtureManifest, MANIFEST_FILENAME } from './lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  canonicalJson,
  sortManifestEntries,
  type GraphqlManifestEntry,
  type ScreenshotFixtureManifest,
  type StaticManifestEntry,
} from './lib/screenshot-fixtures';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = '[screenshot-fixtures-merge]';

/**
 * One recorded fixture set, ready to merge. `fileHashes` is keyed by the
 * manifest's own relative `file` path, so the pure merge below can compare
 * bytes without touching the filesystem.
 */
export interface FixtureSetForMerge {
  /** Where this set came from. Only ever used in an error message. */
  label: string;
  manifest: ScreenshotFixtureManifest;
  fileHashes: ReadonlyMap<string, string>;
}

export interface MergedFixtureSet {
  manifest: ScreenshotFixtureManifest;
  /** Manifest `file` → the label of the input set its bytes must be copied from. */
  sources: Map<string, string>;
}

/**
 * The provenance fields every shard of one recording must agree on.
 *
 * `accountEmail` above all: replay only answers the recorded account, so a set
 * merged across two accounts would half-work and the failing half would look
 * like a plain auth miss. `upstream` matters for the same reason at one remove —
 * two shards recorded against different backends are not one fixture set.
 */
function assertProvenanceAgrees(sets: readonly FixtureSetForMerge[]): void {
  const [first, ...rest] = sets;
  for (const other of rest) {
    if (other.manifest.accountEmail !== first.manifest.accountEmail) {
      throw new Error(
        `fixture sets were recorded as different accounts: ${first.label} used ${first.manifest.accountEmail}, ` +
          `${other.label} used ${other.manifest.accountEmail}. Re-record both with the screenshots account.`,
      );
    }
    if (other.manifest.upstream !== first.manifest.upstream) {
      throw new Error(
        `fixture sets were recorded against different upstreams: ${first.label} used ${first.manifest.upstream}, ` +
          `${other.label} used ${other.manifest.upstream}.`,
      );
    }
  }
}

/**
 * Fold one manifest entry into the merged set, or throw naming the key when it
 * conflicts with an entry another shard already contributed.
 */
function foldEntry<Entry extends GraphqlManifestEntry | StaticManifestEntry>(
  entry: Entry,
  set: FixtureSetForMerge,
  key: string,
  merged: Map<string, { entry: Entry; label: string }>,
  fileHashes: Map<string, string>,
): void {
  const existing = merged.get(entry.file);
  const hash = set.fileHashes.get(entry.file);
  if (hash === undefined) {
    throw new Error(`${set.label} lists ${entry.file} in its manifest but the file is missing from the set.`);
  }
  if (!existing) {
    merged.set(entry.file, { entry, label: set.label });
    fileHashes.set(entry.file, hash);
    return;
  }
  if (fileHashes.get(entry.file) !== hash) {
    throw new Error(
      `${key} was recorded differently in ${existing.label} and ${set.label} (${entry.file} differs byte-for-byte). ` +
        `Something behind that response is not deterministic — look at it before merging.`,
    );
  }
  if (canonicalJson(existing.entry) !== canonicalJson(entry)) {
    throw new Error(
      `${key} has the same bytes but a different manifest entry in ${existing.label} and ${set.label} (${entry.file}).`,
    );
  }
}

/**
 * The union of every input set: one manifest, and where each file's bytes come
 * from. Provenance (`frozenNow`, `recordedAt`, `upstream`, `accountEmail`,
 * `flow`) is taken from the FIRST input — a merged set replays as one run, so it
 * gets one frozen instant, and the shards all recorded within minutes of each
 * other.
 */
export function mergeFixtureSets(sets: readonly FixtureSetForMerge[]): MergedFixtureSet {
  if (sets.length === 0) throw new Error('nothing to merge: pass at least one recorded fixture directory.');
  assertProvenanceAgrees(sets);

  const graphqlEntries = new Map<string, { entry: GraphqlManifestEntry; label: string }>();
  const staticEntries = new Map<string, { entry: StaticManifestEntry; label: string }>();
  const fileHashes = new Map<string, string>();

  for (const set of sets) {
    for (const entry of set.manifest.graphql) {
      foldEntry(entry, set, `${entry.operationName} (variables ${entry.variablesHash})`, graphqlEntries, fileHashes);
    }
    for (const entry of set.manifest.static) {
      foldEntry(entry, set, `${entry.path}${entry.query ? `?${entry.query}` : ''}`, staticEntries, fileHashes);
    }
  }

  const first = sets[0].manifest;
  const sources = new Map<string, string>();
  for (const [file, { label }] of [...graphqlEntries, ...staticEntries]) sources.set(file, label);

  return {
    manifest: sortManifestEntries({
      formatVersion: first.formatVersion,
      recordedAt: first.recordedAt,
      frozenNow: first.frozenNow,
      upstream: first.upstream,
      accountEmail: first.accountEmail,
      accountUserId: first.accountUserId,
      flow: first.flow,
      graphql: [...graphqlEntries.values()].map(({ entry }) => entry),
      static: [...staticEntries.values()].map(({ entry }) => entry),
    }),
    sources,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage: tsx scripts/screenshot-fixtures-merge.ts --out <dir> <input-dir> [<input-dir> ...]',
  '',
  `  --out <dir>   where the merged set is written (default ${DEFAULT_SCREENSHOT_FIXTURES_DIR})`,
  '',
  'Every input must be a recorded fixture set (a directory holding manifest.json).',
].join('\n');

export interface MergeCliOptions {
  outDir: string;
  inputDirs: string[];
}

function fail(message: string): never {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

function toAbsolute(pathArgument: string): string {
  return isAbsolute(pathArgument) ? pathArgument : resolve(REPO_ROOT, pathArgument);
}

export function parseMergeArguments(argv: readonly string[]): MergeCliOptions {
  const args = argv.filter((argument) => argument !== '--');
  let outDir: string | null = null;
  const inputDirs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--out') {
      const requested = args[index + 1];
      if (requested === undefined || requested.startsWith('--')) throw new Error(`--out needs a value\n\n${USAGE}`);
      outDir = requested;
      index += 1;
      continue;
    }
    if (flag === '--help' || flag === '-h') throw new Error(USAGE);
    if (flag.startsWith('--')) throw new Error(`unknown argument ${flag}\n\n${USAGE}`);
    inputDirs.push(flag);
  }

  if (inputDirs.length === 0) throw new Error(`at least one input directory is required\n\n${USAGE}`);
  const resolvedOut = toAbsolute(outDir ?? DEFAULT_SCREENSHOT_FIXTURES_DIR);
  const resolvedInputs = inputDirs.map(toAbsolute);
  // Reading a set while writing into it would leave the result depending on the
  // order files happened to be copied, so refuse it outright.
  if (resolvedInputs.includes(resolvedOut)) throw new Error(`--out ${resolvedOut} is also one of the inputs.`);
  return { outDir: resolvedOut, inputDirs: resolvedInputs };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readFixtureSet(dir: string): FixtureSetForMerge {
  const manifest = readScreenshotFixtureManifest(dir);
  if (!manifest) throw new Error(`${dir} holds no ${MANIFEST_FILENAME} — it is not a recorded fixture set.`);
  const fileHashes = new Map<string, string>();
  for (const file of listFixtureFiles(dir)) {
    if (file === MANIFEST_FILENAME) continue;
    fileHashes.set(file, sha256File(join(dir, file)));
  }
  return { label: dir, manifest, fileHashes };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let options: MergeCliOptions;
  try {
    options = parseMergeArguments(argv);
  } catch (parseError) {
    fail(parseError instanceof Error ? parseError.message : String(parseError));
  }

  let merged: MergedFixtureSet;
  const sets: FixtureSetForMerge[] = [];
  try {
    for (const dir of options.inputDirs) {
      const set = readFixtureSet(dir);
      console.log(
        `${LOG} ${dir}: ${set.manifest.graphql.length} graphql + ${set.manifest.static.length} static fixture(s)`,
      );
      sets.push(set);
    }
    merged = mergeFixtureSets(sets);
  } catch (mergeError) {
    fail(mergeError instanceof Error ? mergeError.message : String(mergeError));
  }

  const setsByLabel = new Map(sets.map((set) => [set.label, set]));
  mkdirSync(options.outDir, { recursive: true });
  for (const [file, label] of merged.sources) {
    const source = setsByLabel.get(label);
    if (!source) fail(`internal: no input set labelled ${label}`);
    const target = join(options.outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source.label, file), target);
  }
  writeFileSync(join(options.outDir, MANIFEST_FILENAME), `${JSON.stringify(merged.manifest, null, 2)}\n`);

  console.log(
    `${LOG} Merged ${sets.length} set(s) into ${options.outDir}: ` +
      `${merged.manifest.graphql.length} graphql + ${merged.manifest.static.length} static fixture(s), ` +
      `frozen at ${merged.manifest.frozenNow}.`,
  );
  return 0;
}

// Guarded so importing this module (e.g. from Vitest, to reach mergeFixtureSets)
// never runs the CLI — same pattern as screenshot-backend.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
