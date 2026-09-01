/// <reference types="node" />

/**
 * Uploads the iOS dSYMs from a finished `.xcarchive` to Sentry.
 *
 * The `@sentry/react-native` "Upload Debug Symbols to Sentry" Xcode build phase
 * runs INSIDE the app target's build, before `GenerateDSYMFile` produces
 * `Boardsesh.app.dSYM` (measured 2.4s apart in run 30781376709). It therefore
 * scans `$DWARF_DSYM_FOLDER_PATH` while it still holds only the stripped
 * executables and uploads those: a symbol table gives Sentry function names,
 * but only DWARF gives file and line, so every native frame arrived as
 * `(<unknown>)`. See issue #4202.
 *
 * The archive's `dSYMs/` directory is assembled at the end of the archive
 * action and IS complete, so the fix is to upload from there once xcodebuild
 * has finished. This wrapper validates that directory before spending a network
 * round trip, so a build-order regression fails loudly instead of silently
 * uploading nothing useful again.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSentryUploadEnvironment } from './mobile-upload-sourcemaps';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MOBILE_DIR = resolve(REPO_ROOT, 'packages', 'mobile');
/** Matches ARCHIVE_PATH in .github/workflows/ios-testflight-rn.yml. */
const DEFAULT_ARCHIVE_PATH = resolve(DEFAULT_MOBILE_DIR, 'ios', 'build', 'Boardsesh.xcarchive');

/**
 * Bound the upload. This step gates the TestFlight export, so a sentry-cli that
 * hangs on a network stall would otherwise hold the release until the job's own
 * 60-minute timeout. Ten minutes is far longer than the ~1.4s the real upload
 * takes (run 30781376709) while still leaving room for a slow-but-alive run.
 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Node's 1 MB default would kill a healthy upload whose listing grew past it. */
const UPLOAD_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

type SpawnSentryCli = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; maxBuffer: number },
) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

export interface UploadDsymsOptions {
  archivePath?: string;
  mobileDir?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface UploadDsymsDependencies {
  resolveSentryCli?: (mobileDir: string) => string;
  spawnSentryCli?: SpawnSentryCli;
}

export interface ArchiveDsyms {
  /** Absolute path to `<archive>/dSYMs`, the directory handed to sentry-cli. */
  dsymsDir: string;
  /** Every `*.dSYM` bundle in it that actually carries a DWARF payload. */
  bundleNames: string[];
  /** The subset named `*.app.dSYM` — the main app, where statically linked pods' DWARF lives. */
  appBundleNames: string[];
}

export interface UploadSummary {
  /** `Found N debug information files` — everything sentry-cli discovered locally. */
  found: number;
  /** `Uploaded N missing debug information files` — the subset Sentry did not already have. */
  uploaded: number;
  /** How many of the uploaded entries were real dSYMs (`arm64 debug companion`). */
  debugCompanions: number;
}

export interface UploadDsymsResult extends UploadSummary {
  archiveDsyms: ArchiveDsyms;
}

function assertRealDirectoryWithoutSymbolicLinks(candidatePath: string, label: string): string {
  if (!existsSync(candidatePath)) {
    throw new Error(`${label} does not exist: ${candidatePath}`);
  }
  if (lstatSync(candidatePath).isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link path for ${label}: ${candidatePath}`);
  }
  if (!statSync(candidatePath).isDirectory()) {
    throw new Error(`${label} is not a directory: ${candidatePath}`);
  }
  return realpathSync(candidatePath);
}

/**
 * True when the bundle holds at least one non-empty `Contents/Resources/DWARF/*`
 * payload. Symlinked entries don't count — same posture as the directory checks
 * above, so a link can't stand in for the debug information we're asserting on.
 */
function hasDwarfPayload(bundlePath: string): boolean {
  const dwarfDir = join(bundlePath, 'Contents', 'Resources', 'DWARF');
  if (!existsSync(dwarfDir) || lstatSync(dwarfDir).isSymbolicLink() || !statSync(dwarfDir).isDirectory()) return false;
  return readdirSync(dwarfDir).some((entryName) => {
    const entryStats = lstatSync(join(dwarfDir, entryName));
    return entryStats.isFile() && entryStats.size > 0;
  });
}

/**
 * Validate `<archive>/dSYMs` and enumerate the bundles worth uploading.
 *
 * Requiring an `*.app.dSYM` is the regression guard for #4202: the appex dSYMs
 * were already being produced early enough to be uploaded, but the app's — which
 * is the only place the DWARF for statically linked pods like `libRNScreens.a`
 * ends up — was not. Its absence means we are looking at the wrong directory or
 * at a mid-build snapshot again.
 */
export function collectArchiveDsyms(archivePathInput: string): ArchiveDsyms {
  const archivePath = resolve(archivePathInput);
  assertRealDirectoryWithoutSymbolicLinks(archivePath, 'Xcode archive');
  const dsymsDir = assertRealDirectoryWithoutSymbolicLinks(join(archivePath, 'dSYMs'), "Archive's dSYMs directory");

  const bundleNames = readdirSync(dsymsDir)
    .filter((entryName) => entryName.endsWith('.dSYM'))
    .filter((entryName) => {
      const bundlePath = join(dsymsDir, entryName);
      return !lstatSync(bundlePath).isSymbolicLink() && statSync(bundlePath).isDirectory();
    })
    .filter((entryName) => hasDwarfPayload(join(dsymsDir, entryName)))
    .sort();

  if (bundleNames.length === 0) {
    throw new Error(
      `No dSYM bundles with a DWARF payload in ${dsymsDir}. The archive carries no debug information — ` +
        'check that DEBUG_INFORMATION_FORMAT is dwarf-with-dsym and that xcodebuild archive completed.',
    );
  }

  const appBundleNames = bundleNames.filter((entryName) => entryName.endsWith('.app.dSYM'));
  if (appBundleNames.length === 0) {
    throw new Error(
      `No *.app.dSYM in ${dsymsDir} (found: ${bundleNames.join(', ')}). The main app's dSYM is the only place ` +
        'the DWARF for statically linked pods lives, so without it native frames stay unsymbolicated (#4202).',
    );
  }

  return { dsymsDir, bundleNames, appBundleNames };
}

/**
 * Resolve the sentry-cli binary the same way the iOS build phase does: from
 * packages/mobile, where `@sentry/cli` is a direct dependency so pnpm's isolated
 * linker actually surfaces it (guarded by scripts/mobile-native-deps-check.ts).
 */
export function resolveSentryCli(mobileDirInput: string): string {
  const mobileDir = resolve(mobileDirInput);
  if (!existsSync(mobileDir) || !statSync(mobileDir).isDirectory()) {
    throw new Error(`Mobile directory does not exist or is not a directory: ${mobileDir}`);
  }
  const requireFromMobile = createRequire(join(realpathSync(mobileDir), 'package.json'));
  let sentryCliModule: unknown;
  try {
    sentryCliModule = requireFromMobile('@sentry/cli');
  } catch {
    throw new Error(
      `Could not resolve @sentry/cli from ${mobileDir}. It must stay a direct dependency in ` +
        "packages/mobile/package.json (pnpm's isolated linker does not surface transitive deps there).",
    );
  }
  const getPath = (sentryCliModule as { getPath?: () => string }).getPath;
  if (typeof getPath !== 'function') {
    throw new Error('The installed @sentry/cli does not expose getPath(); cannot locate the sentry-cli binary.');
  }
  const executablePath = getPath();
  if (!executablePath || !existsSync(executablePath) || !statSync(executablePath).isFile()) {
    throw new Error(`@sentry/cli reported a sentry-cli binary that does not exist: ${executablePath}`);
  }
  return executablePath;
}

/**
 * Read the counts out of `sentry-cli debug-files upload` output.
 *
 * `debug companion` is the line an actual dSYM produces; `executable` is the
 * stripped binary that #4202 was uploading instead. Note that a re-run against
 * an archive Sentry already has legitimately reports zero of both — the command
 * only lists what it newly uploaded — so this is reported, not asserted.
 */
export function parseUploadSummary(output: string): UploadSummary {
  const foundMatch = output.match(/Found (\d+) debug information file/);
  const uploadedMatch = output.match(/Uploaded (\d+) missing debug information file/);
  return {
    found: foundMatch ? Number(foundMatch[1]) : 0,
    uploaded: uploadedMatch ? Number(uploadedMatch[1]) : 0,
    debugCompanions: (output.match(/debug companion\)/g) ?? []).length,
  };
}

export function uploadArchiveDsyms(
  options: UploadDsymsOptions = {},
  dependencies: UploadDsymsDependencies = {},
): UploadDsymsResult {
  const mobileDir = resolve(options.mobileDir ?? DEFAULT_MOBILE_DIR);
  // Validate the archive BEFORE the token check so a local run without
  // SENTRY_AUTH_TOKEN still exercises every local assertion.
  const archiveDsyms = collectArchiveDsyms(options.archivePath ?? DEFAULT_ARCHIVE_PATH);
  const uploadEnvironment = createSentryUploadEnvironment(options.environment ?? process.env);
  const executablePath = (dependencies.resolveSentryCli ?? resolveSentryCli)(mobileDir);

  console.log(
    `[mobile:upload-dsyms] Uploading ${archiveDsyms.bundleNames.length} dSYM bundle(s) from ${archiveDsyms.dsymsDir}: ` +
      archiveDsyms.bundleNames.join(', '),
  );

  const spawnSentryCli: SpawnSentryCli =
    dependencies.spawnSentryCli ?? ((executable, args, spawnOptions) => spawnSync(executable, args, spawnOptions));
  const uploadResult = spawnSentryCli(executablePath, ['debug-files', 'upload', archiveDsyms.dsymsDir], {
    cwd: mobileDir,
    env: uploadEnvironment,
    encoding: 'utf8',
    timeout: UPLOAD_TIMEOUT_MS,
    maxBuffer: UPLOAD_MAX_BUFFER_BYTES,
  });
  if (uploadResult.error) {
    const { code } = uploadResult.error as NodeJS.ErrnoException;
    throw new Error(
      code === 'ETIMEDOUT'
        ? `sentry-cli did not finish within ${UPLOAD_TIMEOUT_MS / 60_000} minutes and was killed: ${uploadResult.error.message}`
        : `Could not run sentry-cli: ${uploadResult.error.message}`,
    );
  }
  // Echo stderr on stderr (and first) so a failure is the thing you see in the
  // CI log, not something buried under the upload listing.
  if (uploadResult.stderr) console.error(uploadResult.stderr.trimEnd());
  if (uploadResult.stdout) console.log(uploadResult.stdout.trimEnd());
  const output = `${uploadResult.stdout ?? ''}${uploadResult.stderr ?? ''}`;
  if (uploadResult.status !== 0) {
    throw new Error(`sentry-cli debug-files upload failed with exit code ${uploadResult.status ?? 'unknown'}.`);
  }

  const summary = parseUploadSummary(output);
  if (summary.found < 1) {
    throw new Error(
      `sentry-cli found no debug information files in ${archiveDsyms.dsymsDir}, but the directory holds ` +
        `${archiveDsyms.bundleNames.length} dSYM bundle(s). Something is wrong with the archive or the CLI invocation.`,
    );
  }

  // Everything fed to sentry-cli here came out of `<archive>/dSYMs`, so EVERY
  // file it newly uploads should be a debug companion — a partial count is as
  // much of a red flag as none at all. Uploading something that isn't one is the
  // #4202 signature (stripped executables reaching Sentry instead of DWARF).
  // It's a warning rather than a failure on purpose: this step gates the
  // TestFlight upload, and unlike the structural checks above, this one depends
  // on sentry-cli's exact output wording — a cosmetic change upstream must not
  // be able to block a release.
  if (summary.uploaded > summary.debugCompanions) {
    console.warn(
      `::warning::sentry-cli uploaded ${summary.uploaded} file(s) from ${archiveDsyms.dsymsDir} but only ` +
        `${summary.debugCompanions} were reported as a debug companion. Native crashes may again arrive without ` +
        'file/line — check the output above against #4202 before trusting the next crash report.',
    );
  }

  console.log(
    `[mobile:upload-dsyms] sentry-cli found ${summary.found} debug information file(s), uploaded ${summary.uploaded} ` +
      `missing (${summary.debugCompanions} debug companion). Zero uploaded means Sentry already had them.`,
  );
  return { ...summary, archiveDsyms };
}

export function parseUploadDsymsArgs(args: string[]): { archivePath: string } {
  let archivePath: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--archive') {
      const nextArgument = args[++index];
      if (nextArgument === undefined) {
        throw new Error('--archive requires a path to an .xcarchive.');
      }
      archivePath = nextArgument;
      continue;
    }
    if (argument.startsWith('--archive=')) {
      archivePath = argument.slice('--archive='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (archivePath !== null && archivePath.trim() === '') {
    throw new Error('--archive requires a path to an .xcarchive.');
  }
  return { archivePath: archivePath ?? DEFAULT_ARCHIVE_PATH };
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    uploadArchiveDsyms(parseUploadDsymsArgs(process.argv.slice(2)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mobile:upload-dsyms] ${reason}`);
    process.exitCode = 1;
  }
}
