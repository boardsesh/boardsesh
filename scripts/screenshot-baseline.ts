/// <reference types="node" />

/**
 * The stored App Store screenshot baseline: one zip per (locale, device) shard,
 * kept as assets on a rolling GitHub prerelease tagged `screenshots-baseline`.
 *
 * Captured screenshots are deliberately NOT committed (see .gitignore and
 * issue #2905) — they are 60+ large PNGs that change on every render tweak. But
 * the probe gate in mobile-screenshots-ios.yml needs last-known-good pixels to
 * compare a fresh capture against, and mobile-store-draft.yml needs the whole
 * set to attach to a newly created App Store version. A prerelease gives both a
 * durable, cheap home outside git history. The repo's tag ruleset covers only
 * `build-*`, `fingerprint-*` and `release/*`, so the plain `GITHUB_TOKEN` with
 * `contents: write` can create and update this one.
 *
 * Usage:
 *   vp run screenshot:baseline -- pack    --platform ios --tree <dir> --out <dir> \
 *                                         --commit <sha> --run-id <id>
 *   vp run screenshot:baseline -- publish --platform ios --tree <dir> \
 *                                         --commit <sha> --run-id <id>
 *   vp run screenshot:baseline -- fetch   --platform ios --asset <name> --out <dir>
 *   vp run screenshot:baseline -- fetch   --platform ios --all --out <dir>
 *
 * `pack` refuses an incomplete tree, so a run that lost a shard can never
 * overwrite a good baseline with a partial one. `publish` uploads the manifest
 * LAST, so a reader that sees `ios-manifest.json` is guaranteed to see every zip
 * it describes. `fetch` exits 0 when the release or the asset does not exist yet
 * (first run, or a pruned asset) and reports that through `found=false`.
 *
 * Shelling out goes through an injectable CommandRunner so the unit tests never
 * touch `gh`, `zip` or the network.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { EXPECTED_APP_STORE_DEVICE_SLUGS, EXPECTED_APP_STORE_LOCALES } from './assert-screenshot-dimensions';

const LOG = '[screenshot:baseline]';

/** The single rolling prerelease every baseline asset hangs off. */
export const BASELINE_TAG = 'screenshots-baseline';
export const BASELINE_TITLE = 'Screenshot baseline';

export type BaselinePlatform = 'ios';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string }): CommandResult;
}

export const systemCommandRunner: CommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, [...args], { cwd: options?.cwd, encoding: 'utf8' });
    if (result.error) {
      return { status: 127, stdout: '', stderr: result.error.message };
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};

/** `<locale>/<device-slug>/<file>.png` grouped by locale then device. */
export type ScreenshotShardTree = Record<string, Record<string, string[]>>;

export interface BaselineManifest {
  platform: BaselinePlatform;
  commit: string;
  runId: string;
  capturedAt: string;
  /** `<locale>/<slug>/<file>.png` -> sha256 of the file's bytes. */
  files: Record<string, string>;
}

/** Asset name for one shard, e.g. `ios-en-US-iphone-16-pro-max.zip`. */
export function assetNameFor(platform: BaselinePlatform, locale: string, deviceSlug: string): string {
  return `${platform}-${locale}-${deviceSlug}.zip`;
}

export function manifestNameFor(platform: BaselinePlatform): string {
  return `${platform}-manifest.json`;
}

/**
 * Inverse of assetNameFor. Both halves can contain dashes (`en-US`,
 * `iphone-16-pro-max`), so match against the known combinations instead of
 * splitting on a separator.
 */
export function parseAssetName(
  platform: BaselinePlatform,
  assetName: string,
): { locale: string; deviceSlug: string } | null {
  for (const locale of EXPECTED_APP_STORE_LOCALES) {
    for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      if (assetNameFor(platform, locale, deviceSlug) === assetName) return { locale, deviceSlug };
    }
  }
  return null;
}

/**
 * Refuse a tree that is short a locale, a device folder or a PNG. A baseline is
 * only useful if it is the whole store set — publishing a partial one would make
 * the next probe compare against a hole and report a false change (or worse,
 * make the store-draft attach step upload an incomplete listing).
 */
export function assertCompleteTree(tree: ScreenshotShardTree): void {
  const problems: string[] = [];
  for (const locale of EXPECTED_APP_STORE_LOCALES) {
    const devices = tree[locale];
    if (!devices) {
      problems.push(`missing locale directory ${locale}`);
      continue;
    }
    for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      const files = devices[deviceSlug];
      if (!files) {
        problems.push(`missing device directory ${locale}/${deviceSlug}`);
        continue;
      }
      if (files.length === 0) problems.push(`no PNGs in ${locale}/${deviceSlug}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`incomplete screenshot tree: ${problems.join('; ')}`);
  }
}

export interface BuildManifestOptions {
  platform: BaselinePlatform;
  commit: string;
  runId: string;
  capturedAt: string;
  files: ReadonlyArray<{ relativePath: string; sha256: string }>;
}

/** Pure: the manifest object written alongside the shard zips. */
export function buildManifest(options: BuildManifestOptions): BaselineManifest {
  const files: Record<string, string> = {};
  for (const { relativePath, sha256 } of [...options.files].sort((first, second) =>
    first.relativePath.localeCompare(second.relativePath),
  )) {
    files[relativePath] = sha256;
  }
  return {
    platform: options.platform,
    commit: options.commit,
    runId: options.runId,
    capturedAt: options.capturedAt,
    files,
  };
}

/** Read `<tree>/<locale>/<slug>/*.png` into the shape assertCompleteTree checks. */
export function readShardTree(treeDir: string): ScreenshotShardTree {
  const tree: ScreenshotShardTree = {};
  if (!existsSync(treeDir) || !statSync(treeDir).isDirectory()) return tree;
  for (const localeEntry of readdirSync(treeDir, { withFileTypes: true })) {
    if (!localeEntry.isDirectory()) continue;
    const devices: Record<string, string[]> = {};
    const localeDir = join(treeDir, localeEntry.name);
    for (const deviceEntry of readdirSync(localeDir, { withFileTypes: true })) {
      if (!deviceEntry.isDirectory()) continue;
      devices[deviceEntry.name] = readdirSync(join(localeDir, deviceEntry.name))
        .filter((name) => name.toLowerCase().endsWith('.png'))
        .sort();
    }
    tree[localeEntry.name] = devices;
  }
  return tree;
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function runOrThrow(runner: CommandRunner, command: string, args: readonly string[]): CommandResult {
  const result = runner.run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result;
}

export interface PackOptions {
  platform: BaselinePlatform;
  treeDir: string;
  outDir: string;
  commit: string;
  runId: string;
  capturedAt?: string;
  runner?: CommandRunner;
}

export interface PackResult {
  zipFiles: string[];
  manifestFile: string;
  manifest: BaselineManifest;
}

/**
 * One flat zip per shard (`zip -j` drops the directory prefix), so unzipping a
 * shard anywhere yields the bare `NN-name.png` files the compare step pairs on.
 * `-X` drops the extra file attributes that would otherwise make two zips of
 * identical pixels differ byte for byte.
 */
export function packBaseline(options: PackOptions): PackResult {
  const runner = options.runner ?? systemCommandRunner;
  const treeDir = resolve(options.treeDir);
  const outDir = resolve(options.outDir);
  const tree = readShardTree(treeDir);
  assertCompleteTree(tree);
  mkdirSync(outDir, { recursive: true });

  const zipFiles: string[] = [];
  const manifestFiles: Array<{ relativePath: string; sha256: string }> = [];
  for (const locale of EXPECTED_APP_STORE_LOCALES) {
    for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      const shardDir = join(treeDir, locale, deviceSlug);
      const pngNames = tree[locale][deviceSlug];
      const zipFile = join(outDir, assetNameFor(options.platform, locale, deviceSlug));
      runOrThrow(runner, 'zip', ['-j', '-X', '-q', zipFile, ...pngNames.map((name) => join(shardDir, name))]);
      zipFiles.push(zipFile);
      for (const name of pngNames) {
        manifestFiles.push({
          relativePath: `${locale}/${deviceSlug}/${name}`,
          sha256: sha256Of(join(shardDir, name)),
        });
      }
    }
  }

  const manifest = buildManifest({
    platform: options.platform,
    commit: options.commit,
    runId: options.runId,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    files: manifestFiles,
  });
  const manifestFile = join(outDir, manifestNameFor(options.platform));
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { zipFiles, manifestFile, manifest };
}

export interface PublishOptions extends Omit<PackOptions, 'outDir'> {
  outDir?: string;
}

export function publishBaseline(options: PublishOptions): PackResult {
  const runner = options.runner ?? systemCommandRunner;
  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), 'screenshot-baseline-'));
  const packed = packBaseline({ ...options, outDir, runner });

  const existing = runner.run('gh', ['release', 'view', BASELINE_TAG]);
  if (existing.status !== 0) {
    runOrThrow(runner, 'gh', [
      'release',
      'create',
      BASELINE_TAG,
      '--prerelease',
      '--title',
      BASELINE_TITLE,
      '--notes',
      baselineNotes(packed.manifest),
    ]);
  }

  // Zips first, manifest last: a reader that sees the manifest is guaranteed to
  // see every asset it lists.
  runOrThrow(runner, 'gh', ['release', 'upload', BASELINE_TAG, ...packed.zipFiles, '--clobber']);
  runOrThrow(runner, 'gh', ['release', 'upload', BASELINE_TAG, packed.manifestFile, '--clobber']);
  console.log(`${LOG} published ${packed.zipFiles.length} shard zip(s) for ${options.commit} to ${BASELINE_TAG}.`);
  return packed;
}

export function baselineNotes(manifest: BaselineManifest): string {
  return [
    'Rolling App Store screenshot baseline. Assets are replaced in place by the',
    'screenshot workflow; there is nothing to install here.',
    '',
    `Last refreshed from ${manifest.commit} (run ${manifest.runId}) at ${manifest.capturedAt}.`,
  ].join('\n');
}

export interface FetchOptions {
  platform: BaselinePlatform;
  outDir: string;
  /** One shard asset (probe gate), or every shard (store-draft attach). */
  asset: string | null;
  all: boolean;
  runner?: CommandRunner;
  downloadDir?: string;
}

export interface FetchResult {
  found: boolean;
  commit: string;
  unzipped: string[];
}

export function fetchBaseline(options: FetchOptions): FetchResult {
  const runner = options.runner ?? systemCommandRunner;
  const outDir = resolve(options.outDir);
  const downloadDir = options.downloadDir
    ? resolve(options.downloadDir)
    : mkdtempSync(join(tmpdir(), 'screenshot-baseline-download-'));
  mkdirSync(downloadDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const manifestName = manifestNameFor(options.platform);
  const pattern = options.all ? `${options.platform}-*.zip` : (options.asset ?? '');
  const download = runner.run('gh', [
    'release',
    'download',
    BASELINE_TAG,
    '--pattern',
    pattern,
    '--pattern',
    manifestName,
    '--dir',
    downloadDir,
    '--clobber',
  ]);

  if (download.status !== 0) {
    // No release yet, or no matching asset. That is the first-run state, not an
    // error: the caller falls back to a full capture.
    console.log(`${LOG} no baseline available for ${pattern} (${download.stderr.trim() || 'no matching asset'}).`);
    return { found: false, commit: '', unzipped: [] };
  }

  const downloaded = readdirSync(downloadDir).filter((name) => name.endsWith('.zip'));
  if (downloaded.length === 0) {
    console.log(`${LOG} baseline release exists but carries no ${pattern} asset.`);
    return { found: false, commit: '', unzipped: [] };
  }

  const unzipped: string[] = [];
  for (const zipName of downloaded.sort()) {
    const shard = parseAssetName(options.platform, zipName);
    // `--all` rebuilds the <locale>/<slug>/ tree fastlane reads; a single-asset
    // fetch stays flat so it can be compared against one capture directory.
    const target = options.all && shard ? join(outDir, shard.locale, shard.deviceSlug) : outDir;
    mkdirSync(target, { recursive: true });
    runOrThrow(runner, 'unzip', ['-o', '-q', join(downloadDir, zipName), '-d', target]);
    unzipped.push(target);
  }

  let commit = '';
  const manifestFile = join(downloadDir, manifestName);
  if (existsSync(manifestFile)) {
    const parsed: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'commit' in parsed) {
      const parsedCommit = (parsed as { commit: unknown }).commit;
      if (typeof parsedCommit === 'string') commit = parsedCommit;
    }
  }

  console.log(
    `${LOG} restored ${downloaded.length} shard zip(s) from ${BASELINE_TAG} (commit ${commit || 'unknown'}).`,
  );
  return { found: true, commit, unzipped };
}

type Subcommand = 'pack' | 'publish' | 'fetch';

interface CliOptions {
  subcommand: Subcommand;
  platform: BaselinePlatform;
  treeDir: string | null;
  outDir: string | null;
  commit: string;
  runId: string;
  asset: string | null;
  all: boolean;
}

export function parseBaselineArguments(argv: readonly string[]): CliOptions {
  const args = argv.filter((argument) => argument !== '--');
  const subcommand = args[0];
  if (subcommand !== 'pack' && subcommand !== 'publish' && subcommand !== 'fetch') {
    throw new Error(`First argument must be one of: pack, publish, fetch (got "${subcommand ?? ''}")`);
  }

  const values = new Map<string, string>();
  let all = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--all') {
      all = true;
      continue;
    }
    const value = args[index + 1];
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index++;
  }

  const known = ['--platform', '--tree', '--out', '--commit', '--run-id', '--asset'];
  for (const flag of values.keys()) {
    if (!known.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  }

  const platform = values.get('--platform') ?? 'ios';
  if (platform !== 'ios') throw new Error(`--platform must be ios (got "${platform}")`);

  if (subcommand !== 'fetch' && !values.get('--tree')) throw new Error('--tree is required');
  if (subcommand === 'pack' && !values.get('--out')) throw new Error('--out is required');
  if (subcommand === 'fetch') {
    if (!values.get('--out')) throw new Error('--out is required');
    if (!all && !values.get('--asset')) throw new Error('fetch needs --asset <name> or --all');
  }

  return {
    subcommand,
    platform,
    treeDir: values.get('--tree') ?? null,
    outDir: values.get('--out') ?? null,
    commit: values.get('--commit') ?? '',
    runId: values.get('--run-id') ?? '',
    asset: values.get('--asset') ?? null,
    all,
  };
}

function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseBaselineArguments(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    if (options.subcommand === 'pack') {
      const packed = packBaseline({
        platform: options.platform,
        treeDir: options.treeDir ?? '',
        outDir: options.outDir ?? '',
        commit: options.commit,
        runId: options.runId,
      });
      console.log(`${LOG} packed ${packed.zipFiles.length} shard zip(s) into ${options.outDir}.`);
      return 0;
    }

    if (options.subcommand === 'publish') {
      publishBaseline({
        platform: options.platform,
        treeDir: options.treeDir ?? '',
        commit: options.commit,
        runId: options.runId,
      });
      return 0;
    }

    const fetched = fetchBaseline({
      platform: options.platform,
      outDir: options.outDir ?? '',
      asset: options.asset,
      all: options.all,
    });
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      appendFileSync(githubOutput, `found=${fetched.found}\ncommit=${fetched.commit}\n`);
    }
    return 0;
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
