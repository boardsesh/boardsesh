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
 * key, their CONTENT must be identical — a conflict is a CONTENT difference,
 * never a `recordedAt` difference. Every `graphql/<Op>/<hash>.json` fixture
 * carries its own top-level `recordedAt`, and two shards that recorded the
 * same key minutes apart always disagree on that even when the response
 * underneath is byte-for-byte identical, so `recordedAt` is per-file
 * bookkeeping and never counts toward a conflict. A genuine content
 * difference, though, is real nondeterminism: the shards were recorded
 * minutes apart from the same account against the same backend, so a live
 * feed someone wrote to between shards, or a counter that moved, will make a
 * replay capture drift. The default (`--on-conflict fail`) throws naming the
 * key, so that difference is always seen once instead of silently taking
 * whichever shard sorted first. `--on-conflict newest` is the documented
 * resolution for a real conflict: it keeps whichever shard's copy was
 * recorded LATER, since the newest data sits closest to the merged set's
 * frozen instant (itself the maximum `frozenNow` across every shard — see
 * `mergeFixtureSets` below).
 *
 * See docs/mobile-screenshot-fixtures.md for the recording runbook.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listFixtureFiles, readScreenshotFixtureManifest, MANIFEST_FILENAME } from './lib/screenshot-backend';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  canonicalJson,
  finalizeRecordingFrozenNow,
  sortManifestEntries,
  type GraphqlFixtureFile,
  type GraphqlManifestEntry,
  type ScreenshotFixtureManifest,
  type StaticManifestEntry,
} from './lib/screenshot-fixtures';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = '[screenshot-fixtures-merge]';

/**
 * One recorded fixture set, ready to merge. `contentHashes` is keyed by the
 * manifest's own relative `file` path, so the pure merge below can compare
 * CONTENT without touching the filesystem. This is not a byte hash: a
 * graphql fixture's hash is taken over the parsed fixture with `recordedAt`
 * removed (see `readFixtureSet`), so two shards that recorded the identical
 * response minutes apart hash the same. A static asset has no such per-file
 * bookkeeping, so its hash is the raw bytes.
 */
export interface FixtureSetForMerge {
  /** Where this set came from. Only ever used in an error message. */
  label: string;
  manifest: ScreenshotFixtureManifest;
  contentHashes: ReadonlyMap<string, string>;
  /**
   * Each graphql fixture's own `recordedAt`, keyed by the same manifest `file`
   * path as `contentHashes`. Belt and braces on top of the backend's own
   * finalization (screenshot-backend.ts's `rewriteManifest`): re-derives the
   * floor here too, in case an input set's `manifest.frozenNow` predates one of
   * its own entries (a pre-fix or hand-edited set). Also doubles as the
   * "which copy is newer" signal `--on-conflict newest` resolves real
   * conflicts with. Optional so a caller that doesn't have this handy (or a
   * test that doesn't care about it) can omit it.
   */
  graphqlRecordedAt?: ReadonlyMap<string, string>;
}

/**
 * How `mergeFixtureSets` resolves a REAL conflict — two shards holding the
 * same key with different content. `'fail'` (the default) throws, naming the
 * key, so the difference is always seen once. `'newest'` keeps whichever
 * shard's copy was recorded later and records the resolution in
 * `MergedFixtureSet.conflicts`.
 */
export type MergeConflictPolicy = 'fail' | 'newest';

/** One real conflict `--on-conflict newest` resolved, for logging. */
export interface MergeConflict {
  /** The same key an error message would have named, e.g. `GetProfile (variables aaaa)`. */
  key: string;
  /** Label of the shard whose copy was kept. */
  took: string;
  /** Label of the shard whose copy was discarded. */
  over: string;
  /** `recordedAt` of the kept copy, or `''` when neither side had one to compare. */
  tookRecordedAt: string;
  /** `recordedAt` of the discarded copy, or `''` when neither side had one to compare. */
  overRecordedAt: string;
}

export interface MergedFixtureSet {
  manifest: ScreenshotFixtureManifest;
  /** Manifest `file` → the label of the input set its bytes must be copied from. */
  sources: Map<string, string>;
  /** Every real conflict `--on-conflict newest` resolved. Empty under the default `'fail'` policy (it would have thrown instead). */
  conflicts: MergeConflict[];
}

/**
 * The provenance fields every shard of one recording must agree on.
 *
 * `accountEmail` above all: replay only answers the recorded account, so a set
 * merged across two accounts would half-work and the failing half would look
 * like a plain auth miss. `accountUserId` for the same reason, one level down:
 * the app reads its own id back out of the session token to decide what is
 * "yours" while offline, so two shards recorded under different ids merged into
 * one set would leave that classification depending on which shard answered —
 * and a shard that never signed in at all (an empty id) never recorded anything
 * worth merging. `flow` picks the capture flow a replay run stamps into its logs
 * and re-record command, so two shards from different flows are not one
 * recording either. `upstream` matters for the same reason at one more remove —
 * two shards recorded against different backends are not one fixture set.
 */
function assertProvenanceAgrees(fixtureSets: readonly FixtureSetForMerge[]): void {
  for (const fixtureSet of fixtureSets) {
    if (fixtureSet.manifest.accountUserId === '') {
      throw new Error(`shard ${fixtureSet.label} never signed in — re-record it.`);
    }
  }

  const [firstSet, ...otherSets] = fixtureSets;
  for (const otherSet of otherSets) {
    if (otherSet.manifest.accountEmail !== firstSet.manifest.accountEmail) {
      throw new Error(
        `fixture sets were recorded as different accounts: ${firstSet.label} used ${firstSet.manifest.accountEmail}, ` +
          `${otherSet.label} used ${otherSet.manifest.accountEmail}. Re-record both with the screenshots account.`,
      );
    }
    if (otherSet.manifest.accountUserId !== firstSet.manifest.accountUserId) {
      throw new Error(
        `fixture sets were recorded as different accounts: ${firstSet.label} recorded user id ${firstSet.manifest.accountUserId}, ` +
          `${otherSet.label} recorded ${otherSet.manifest.accountUserId}. Re-record both with the screenshots account.`,
      );
    }
    if (otherSet.manifest.flow !== firstSet.manifest.flow) {
      throw new Error(
        `fixture sets were recorded from different flows: ${firstSet.label} used ${firstSet.manifest.flow}, ` +
          `${otherSet.label} used ${otherSet.manifest.flow}.`,
      );
    }
    if (otherSet.manifest.upstream !== firstSet.manifest.upstream) {
      throw new Error(
        `fixture sets were recorded against different upstreams: ${firstSet.label} used ${firstSet.manifest.upstream}, ` +
          `${otherSet.label} used ${otherSet.manifest.upstream}.`,
      );
    }
  }
}

/**
 * The later of two ISO instants, compared by parsed time (not lexicographically
 * — two manifests can carry different precisions, e.g. whole seconds vs
 * milliseconds, where a string compare would pick the wrong one). Returns the
 * original string of whichever instant wins, never a reformatted one.
 */
function maxIsoInstant(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/** One key's current winner while folding: which entry, from which shard, and when that shard recorded it (if known). */
interface FoldedEntry<Entry> {
  entry: Entry;
  label: string;
  recordedAt: string | undefined;
}

/** `graphqlRecordedAt` doesn't exist for static entries — a graphql fixture's own top-level `recordedAt`. */
function graphqlRecordedAtOf(entry: GraphqlManifestEntry, fixtureSet: FixtureSetForMerge): string | undefined {
  return fixtureSet.graphqlRecordedAt?.get(entry.file);
}

/**
 * A static manifest entry never declares `recordedAt` today (see
 * `StaticManifestEntry`), but a future or hand-edited manifest might, so this
 * tolerates one without widening the type everyone else reads. Returns
 * `undefined` when absent, which `foldEntry` treats as "keep the first".
 */
function staticRecordedAtOf(entry: StaticManifestEntry): string | undefined {
  const withOptionalRecordedAt = entry as StaticManifestEntry & { recordedAt?: unknown };
  return typeof withOptionalRecordedAt.recordedAt === 'string' ? withOptionalRecordedAt.recordedAt : undefined;
}

/**
 * Fold one manifest entry into the merged set. Two shards agreeing on a key's
 * CONTENT keep one copy silently. Two shards disagreeing is a real conflict:
 * under `'fail'` (the default) this throws, naming the key; under `'newest'`
 * it keeps whichever copy was recorded later (or the first, when neither side
 * has a `recordedAt` to compare) and pushes the resolution onto `conflicts`.
 */
function foldEntry<Entry extends GraphqlManifestEntry | StaticManifestEntry>(
  entry: Entry,
  fixtureSet: FixtureSetForMerge,
  key: string,
  merged: Map<string, FoldedEntry<Entry>>,
  contentHashes: Map<string, string>,
  onConflict: MergeConflictPolicy,
  conflicts: MergeConflict[],
  recordedAtOf: (entry: Entry, fixtureSet: FixtureSetForMerge) => string | undefined,
): void {
  const existing = merged.get(entry.file);
  const contentHash = fixtureSet.contentHashes.get(entry.file);
  if (contentHash === undefined) {
    throw new Error(`${fixtureSet.label} lists ${entry.file} in its manifest but the file is missing from the set.`);
  }
  const recordedAt = recordedAtOf(entry, fixtureSet);

  if (!existing) {
    merged.set(entry.file, { entry, label: fixtureSet.label, recordedAt });
    contentHashes.set(entry.file, contentHash);
    return;
  }

  if (contentHashes.get(entry.file) === contentHash) {
    if (canonicalJson(existing.entry) !== canonicalJson(entry)) {
      throw new Error(
        `${key} has the same content but a different manifest entry in ${existing.label} and ${fixtureSet.label} (${entry.file}).`,
      );
    }
    return;
  }

  // A real conflict: the same key, different content.
  if (onConflict === 'fail') {
    throw new Error(
      `${key} was recorded differently in ${existing.label} and ${fixtureSet.label} (${entry.file} differs). ` +
        `Something behind that response is not deterministic — look at it before merging. ` +
        `Re-run with --on-conflict newest to keep the later recording of each such key.`,
    );
  }

  const existingMs = existing.recordedAt !== undefined ? Date.parse(existing.recordedAt) : undefined;
  const incomingMs = recordedAt !== undefined ? Date.parse(recordedAt) : undefined;
  const incomingIsNewer = existingMs !== undefined && incomingMs !== undefined && incomingMs > existingMs;

  conflicts.push({
    key,
    took: incomingIsNewer ? fixtureSet.label : existing.label,
    over: incomingIsNewer ? existing.label : fixtureSet.label,
    tookRecordedAt: (incomingIsNewer ? recordedAt : existing.recordedAt) ?? '',
    overRecordedAt: (incomingIsNewer ? existing.recordedAt : recordedAt) ?? '',
  });

  if (incomingIsNewer) {
    merged.set(entry.file, { entry, label: fixtureSet.label, recordedAt });
    contentHashes.set(entry.file, contentHash);
  }
  // else: keep the existing (first) copy as-is.
}

/**
 * The union of every input set: one manifest, and where each file's bytes come
 * from.
 *
 * `frozenNow` and `recordedAt` are the MAXIMUM across every input, not the
 * first's — a merged set replays as one run pretending to be one instant, and
 * taking anything earlier than the latest shard's clock would render that
 * shard's own recorded data as being from the future. Before taking that max,
 * each input's `frozenNow` is itself re-finalized against its own entries
 * (`finalizeRecordingFrozenNow`, belt and braces on top of what the backend
 * already did while recording), so a pre-fix or hand-edited input whose
 * `frozenNow` predates one of its own recorded responses still can't slip a
 * "renders in the future" fixture through the merge. `upstream`,
 * `accountEmail`, `accountUserId` and `flow` are taken from the first input:
 * `assertProvenanceAgrees` above already required every shard to agree on them,
 * so "first" and "any" are the same value.
 */
export function mergeFixtureSets(
  fixtureSets: readonly FixtureSetForMerge[],
  options: { onConflict?: MergeConflictPolicy } = {},
): MergedFixtureSet {
  if (fixtureSets.length === 0) throw new Error('nothing to merge: pass at least one recorded fixture directory.');
  assertProvenanceAgrees(fixtureSets);
  const onConflict = options.onConflict ?? 'fail';

  const graphqlEntries = new Map<string, FoldedEntry<GraphqlManifestEntry>>();
  const staticEntries = new Map<string, FoldedEntry<StaticManifestEntry>>();
  const contentHashes = new Map<string, string>();
  const conflicts: MergeConflict[] = [];

  for (const fixtureSet of fixtureSets) {
    for (const entry of fixtureSet.manifest.graphql) {
      foldEntry(
        entry,
        fixtureSet,
        `${entry.operationName} (variables ${entry.variablesHash})`,
        graphqlEntries,
        contentHashes,
        onConflict,
        conflicts,
        graphqlRecordedAtOf,
      );
    }
    for (const entry of fixtureSet.manifest.static) {
      foldEntry(
        entry,
        fixtureSet,
        `${entry.path}${entry.query ? `?${entry.query}` : ''}`,
        staticEntries,
        contentHashes,
        onConflict,
        conflicts,
        staticRecordedAtOf,
      );
    }
  }

  const firstSet = fixtureSets[0].manifest;
  let frozenNow = firstSet.frozenNow;
  let recordedAt = firstSet.recordedAt;
  for (const fixtureSet of fixtureSets) {
    // Belt and braces on top of the backend's own finalization
    // (screenshot-backend.ts's rewriteManifest): re-derive the floor from this
    // set's OWN entries too, rather than trusting `manifest.frozenNow` as
    // already-correct — a pre-fix or hand-edited input could still carry a
    // frozenNow earlier than one of its own recorded responses.
    const recordedAtInThisSet = [...(fixtureSet.graphqlRecordedAt?.values() ?? [])];
    const finalizedFrozenNow = finalizeRecordingFrozenNow(fixtureSet.manifest.frozenNow, recordedAtInThisSet);
    frozenNow = maxIsoInstant(frozenNow, finalizedFrozenNow);
    recordedAt = maxIsoInstant(recordedAt, fixtureSet.manifest.recordedAt);
    // …and past every fixture the set actually holds. An input recorded before
    // the backend started stamping `recordedAt` from its newest entry carries a
    // START instant, which reads as older than most of what it names.
    for (const entryRecordedAt of recordedAtInThisSet) recordedAt = maxIsoInstant(recordedAt, entryRecordedAt);
  }

  const sources = new Map<string, string>();
  for (const [file, { label }] of [...graphqlEntries, ...staticEntries]) sources.set(file, label);

  return {
    manifest: sortManifestEntries({
      formatVersion: firstSet.formatVersion,
      recordedAt,
      frozenNow,
      upstream: firstSet.upstream,
      accountEmail: firstSet.accountEmail,
      accountUserId: firstSet.accountUserId,
      flow: firstSet.flow,
      graphql: [...graphqlEntries.values()].map(({ entry }) => entry),
      static: [...staticEntries.values()].map(({ entry }) => entry),
    }),
    sources,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage: tsx scripts/screenshot-fixtures-merge.ts --out <dir> [--on-conflict fail|newest] <input-dir> [<input-dir> ...]',
  '',
  `  --out <dir>           where the merged set is written (default ${DEFAULT_SCREENSHOT_FIXTURES_DIR})`,
  '  --on-conflict <mode>  fail (default) or newest — how to resolve two shards',
  '                        holding the same key with different content. `newest`',
  "                        compares each graphql fixture's own recordedAt; a",
  '                        static asset has no recordedAt to compare, so a',
  '                        conflicting one keeps the copy seen first.',
  '',
  'Every input must be a recorded fixture set (a directory holding manifest.json).',
  'The two fixture subtrees and manifest.json under --out are cleared first, so a',
  'key a re-record stopped producing does not linger.',
].join('\n');

/**
 * Remove what a previous merge left under `--out`.
 *
 * The merged set REPLACES what was there. Writing into the directory without
 * clearing it first leaves an orphan behind whenever a re-record stops
 * producing a key: the file is not in the new manifest, so nothing replays it,
 * but it is still committed, still read by the drift test, and still stat'd by
 * the backend's startup check.
 *
 * Bounded to the two subtrees this tool owns plus the manifest — exactly what
 * the backend's `--fresh` removes — so pointing `--out` at a directory holding
 * anything else can never delete it.
 */
export function clearMergedFixtureOutput(outDir: string): void {
  rmSync(join(outDir, 'graphql'), { recursive: true, force: true });
  rmSync(join(outDir, 'static'), { recursive: true, force: true });
  rmSync(join(outDir, MANIFEST_FILENAME), { force: true });
}

export interface MergeCliOptions {
  outDir: string;
  inputDirs: string[];
  onConflict: MergeConflictPolicy;
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
  let onConflict: MergeConflictPolicy = 'fail';
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
    if (flag === '--on-conflict') {
      const requested = args[index + 1];
      if (requested !== 'fail' && requested !== 'newest') {
        throw new Error(`--on-conflict must be "fail" or "newest"\n\n${USAGE}`);
      }
      onConflict = requested;
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
  return { outDir: resolvedOut, inputDirs: resolvedInputs, onConflict };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `fixture` with its per-file `recordedAt` bookkeeping stripped, for content hashing. Never mutates the input. */
function graphqlContentForHashing(fixture: GraphqlFixtureFile): unknown {
  const withoutRecordedAt: Partial<GraphqlFixtureFile> = { ...fixture };
  delete withoutRecordedAt.recordedAt;
  return withoutRecordedAt;
}

/**
 * A graphql fixture's identity for merge purposes: every field EXCEPT
 * `recordedAt`. Exported so a test can prove two fixtures differing only in
 * `recordedAt` hash identically, without going through the filesystem.
 */
export function graphqlFixtureContentHash(fixture: GraphqlFixtureFile): string {
  return sha256Text(canonicalJson(graphqlContentForHashing(fixture)));
}

function readFixtureSet(dir: string): FixtureSetForMerge {
  const manifest = readScreenshotFixtureManifest(dir);
  if (!manifest) throw new Error(`${dir} holds no ${MANIFEST_FILENAME} — it is not a recorded fixture set.`);
  const contentHashes = new Map<string, string>();
  const graphqlRecordedAt = new Map<string, string>();
  for (const file of listFixtureFiles(dir)) {
    if (file === MANIFEST_FILENAME) continue;
    if (file.startsWith('graphql/')) {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as GraphqlFixtureFile;
      // Each graphql fixture's own recordedAt, for the belt-and-braces
      // frozenNow re-check in mergeFixtureSets AND for --on-conflict newest —
      // not in the manifest entry itself, only the file.
      if (typeof fixture.recordedAt === 'string') graphqlRecordedAt.set(file, fixture.recordedAt);
      // Identity is CONTENT, not bytes: two shards that recorded the same
      // response minutes apart always disagree on `recordedAt` alone, so it
      // is excluded before hashing.
      contentHashes.set(file, graphqlFixtureContentHash(fixture));
    } else {
      // A static asset carries no per-file bookkeeping to strip — its raw
      // bytes ARE its content.
      contentHashes.set(file, sha256File(join(dir, file)));
    }
  }
  return { label: dir, manifest, contentHashes, graphqlRecordedAt };
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
      const fixtureSet = readFixtureSet(dir);
      console.log(
        `${LOG} ${dir}: ${fixtureSet.manifest.graphql.length} graphql + ${fixtureSet.manifest.static.length} static fixture(s)`,
      );
      sets.push(fixtureSet);
    }
    merged = mergeFixtureSets(sets, { onConflict: options.onConflict });
  } catch (mergeError) {
    fail(mergeError instanceof Error ? mergeError.message : String(mergeError));
  }

  for (const conflict of merged.conflicts) {
    console.log(
      `${LOG} CONFLICT ${conflict.key}: kept ${conflict.took} (recorded ${conflict.tookRecordedAt}) over ${conflict.over} (recorded ${conflict.overRecordedAt})`,
    );
  }
  console.log(`${LOG} ${merged.conflicts.length} conflict(s) resolved with --on-conflict ${options.onConflict}.`);

  const setsByLabel = new Map(sets.map((fixtureSet) => [fixtureSet.label, fixtureSet]));
  clearMergedFixtureOutput(options.outDir);
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
