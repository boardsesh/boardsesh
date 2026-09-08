/// <reference types="node" />

/**
 * Resolve a ready Android dev-client APK for the local emulator screenshot flow.
 *
 * Order of preference:
 *   1. --app-path <apk>           (bring your own)
 *   2. cached/downloaded universal CI dev-client APK from the latest
 *      rn-android-dev-* release (no Java/Gradle needed), guarded so an arm64-only
 *      APK never gets installed on the x86_64 emulator
 *   3. local Gradle build (BOARDSESH_APP_VARIANT=dev, x86_64), cached by a hash of
 *      the native inputs — the offline / native-deps-changed fallback
 *
 * The APK has no bundled JS: it boots expo-dev-client and loads JS from Metro, so
 * the same cached APK serves every screenshot run.
 *
 * Usage:
 *   vp run mobile:android-apk                     # download (or build) and print the path
 *   vp run mobile:android-apk -- --build-local    # force a local Gradle build
 *   vp run mobile:android-apk -- --apk-tag rn-android-dev-42
 *   vp run mobile:android-apk -- --require-fresh  # build locally rather than use a stale release
 *
 * On GitHub Actions --require-fresh is the default: a downloaded release APK is
 * only used when its release commit is an ancestor of HEAD with no native-input
 * change since (see devApkFreshness), so a PR that moves the native tree
 * screenshots ITS native tree instead of main's.
 */

import { createHash, type Hash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandExists, runCapture, runInherit } from './lib/exec';
import { ensureAndroidSdk } from './lib/android-sdk';

const LOG = '[mobile:android-apk]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_CACHE = join(homedir(), '.cache', 'boardsesh', 'android');
const DOWNLOAD_DIR = join(ANDROID_CACHE, 'downloaded');
const LOCAL_BUILD_DIR = join(ANDROID_CACHE, 'local-build');
const APK_ASSET = 'boardsesh-dev-android.apk';
// The emulator is x86_64 (the KVM fast path); the APK must carry that ABI.
const REQUIRED_ABI = 'x86_64';

export interface EnsureApkOptions {
  buildLocal?: boolean;
  apkTag?: string;
  appPath?: string;
  /**
   * Refuse a downloaded release APK that predates a native change in this
   * checkout and build one locally instead. Defaults to on in GitHub Actions,
   * where "the screenshots show main's native tree, not this PR's" is a silent
   * wrong answer rather than a slow one.
   */
  requireFresh?: boolean;
  /** Commit the freshness check compares the release against (default: HEAD). */
  headSha?: string;
}

/** Where the APK came from, for the CI step output. */
export type AndroidApkSource = 'app-path' | `release:${string}` | 'local-build';

export interface ResolvedAndroidApk {
  apkPath: string;
  source: AndroidApkSource;
}

/**
 * Inputs that change the native build. `files` are hashed whole; `dirs` are
 * hashed recursively (minus node_modules/build/.cxx). Exported so the freshness
 * check below and the hash stay one list.
 */
export const NATIVE_INPUT_PATHS: { readonly files: readonly string[]; readonly dirs: readonly string[] } = {
  files: [
    'packages/mobile/app.config.ts',
    'packages/mobile/package.json',
    'package.json',
    'pnpm-lock.yaml',
    // Patched dependencies and overrides also change the native tree.
    'pnpm-workspace.yaml',
  ],
  dirs: ['packages/mobile/plugins', 'packages/mobile/modules', 'patches'],
};

/**
 * Paths `git diff` compares between a release APK's commit and HEAD to decide
 * whether the prebuilt APK still matches this checkout.
 *
 * The native inputs minus `pnpm-lock.yaml`, plus the workflow that produces the
 * APK. The lockfile is left out on purpose: the producer workflow's `paths:`
 * filter ignores it too, so a lockfile-only change never yields a new release
 * and treating it as staleness would rebuild locally (~30 min) on every
 * dependency bump. The iOS `.app` cache key makes the same trade — a
 * transitive-only native bump is an accepted blind spot.
 */
export const DEV_APK_FRESHNESS_PATHS: readonly string[] = [
  ...NATIVE_INPUT_PATHS.files.filter((path) => path !== 'pnpm-lock.yaml'),
  ...NATIVE_INPUT_PATHS.dirs,
  '.github/workflows/android-apk-dev-client.yml',
];

/** Minimal `git` surface devApkFreshness needs, injected so tests never spawn git. */
export type GitRunner = (args: string[]) => { status: number; stdout: string };

const defaultGitRunner: GitRunner = (args) => {
  const { status, stdout } = runCapture('git', args, { cwd: ROOT_DIR });
  return { status, stdout };
};

export type DevApkFreshness =
  | { fresh: true }
  | { fresh: false; reason: 'not-an-ancestor' | 'native-inputs-changed' | 'unknown' };

/** Latest rn-android-dev-N tag by build number (not list order). Null if none/unreachable. */
export function resolveLatestDevTag(): string | null {
  const result = runCapture('gh', ['release', 'list', '--limit', '50']);
  if (result.status !== 0) return null;
  const tags = result.stdout
    .split(/\r?\n/)
    .flatMap((line) => line.split(/\s+/))
    .filter((token) => /^rn-android-dev-\d+$/.test(token))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  return tags[tags.length - 1] ?? null;
}

/** True if the APK ships native libs for `abi` (lib/<abi>/...). */
function apkHasAbi(apkPath: string, abi: string): boolean {
  const listing = runCapture('unzip', ['-l', apkPath]);
  if (listing.status !== 0) return false;
  return listing.stdout.includes(`lib/${abi}/`);
}

function downloadDevApk(tag: string): string {
  const dir = join(DOWNLOAD_DIR, tag);
  const apk = join(dir, APK_ASSET);
  if (existsSync(apk)) {
    console.log(`${LOG} Using cached ${tag} APK: ${apk}`);
    return apk;
  }
  if (!commandExists('gh')) throw new Error('gh is not on PATH; cannot download the dev-client APK');
  mkdirSync(dir, { recursive: true });
  console.log(`${LOG} Downloading ${tag} dev-client APK...`);
  const status = runInherit('gh', ['release', 'download', tag, '--pattern', APK_ASSET, '--dir', dir], {
    env: process.env,
  });
  if (status !== 0) throw new Error(`gh release download ${tag} failed`);
  if (!existsSync(apk)) throw new Error(`Downloaded ${tag} but ${APK_ASSET} is missing`);
  // Guard against a truncated/corrupt download being cached forever: a valid APK is
  // a readable zip. If not, delete it so the next run re-downloads (or falls back).
  if (runCapture('unzip', ['-l', apk]).status !== 0) {
    rmSync(apk, { force: true });
    throw new Error(`Downloaded ${tag} APK is not a valid archive (removed); retry or use --build-local`);
  }
  return apk;
}

function hashDir(dir: string, root: string, hash: Hash): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === '.cxx') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) hashDir(abs, root, hash);
    else if (entry.isFile()) hash.update(relative(root, abs)).update(readFileSync(abs));
  }
}

/** Short hash over the inputs that change the native build (mirrors CI's cache key, broadened). */
function nativeInputHash(): string {
  const hash = createHash('sha256');
  const { files, dirs } = NATIVE_INPUT_PATHS;
  for (const rel of files) {
    const abs = join(ROOT_DIR, rel);
    if (existsSync(abs)) hash.update(rel).update(readFileSync(abs));
  }
  for (const rel of dirs) {
    const abs = join(ROOT_DIR, rel);
    if (existsSync(abs)) hashDir(abs, ROOT_DIR, hash);
  }
  return hash.digest('hex').slice(0, 16);
}

function buildDevApkLocally(): string {
  const hash = nativeInputHash();
  const outDir = join(LOCAL_BUILD_DIR, hash);
  const cachedApk = join(outDir, 'app-debug.apk');
  if (existsSync(cachedApk)) {
    console.log(`${LOG} Using cached local build (${hash}): ${cachedApk}`);
    return cachedApk;
  }

  // The local build needs build-tools + JDK 21 (the gradle/RN toolchain).
  // buildOnly: true skips the emulator + system-image packages — a Gradle build
  // never boots an emulator, and in CI reactivecircus/android-emulator-runner
  // installs the system image itself, so the ~2GB image was downloaded for
  // nothing before.
  const toolchain = ensureAndroidSdk({ includeBuildTools: true, buildOnly: true });
  if (!toolchain.java21) {
    throw new Error('Local APK build needs JDK 21; run `vp run mobile:android-doctor -- --build` first.');
  }
  const buildEnv: NodeJS.ProcessEnv = {
    ...toolchain.env,
    BOARDSESH_APP_VARIANT: 'dev',
    JAVA_HOME: toolchain.java21,
    // The Sentry Gradle upload task is incompatible with the Expo-generated Gradle
    // version; keep runtime Sentry but never let the upload task fail the build.
    SENTRY_DISABLE_AUTO_UPLOAD: 'true',
  };

  const mobileDir = join(ROOT_DIR, 'packages', 'mobile');
  console.log(`${LOG} expo prebuild (android, dev variant)...`);
  if (
    runInherit('vp', ['exec', 'expo', 'prebuild', '--platform', 'android', '--clean'], {
      env: buildEnv,
      cwd: mobileDir,
    }) !== 0
  ) {
    throw new Error('expo prebuild --platform android failed');
  }

  const androidDir = join(mobileDir, 'android');
  const gradlew = join(androidDir, 'gradlew');
  const gradleArgs = [
    'assembleDebug',
    `-PreactNativeArchitectures=${REQUIRED_ABI}`,
    `-PboardseshAbiFilters=${REQUIRED_ABI}`,
    // Reuse task outputs from ~/.gradle/caches across runs (CI restores it via
    // actions/cache; see mobile-screenshots-android.yml).
    '--build-cache',
    '--no-daemon',
    '--console=plain',
  ];
  console.log(`${LOG} gradlew assembleDebug (${REQUIRED_ABI}); first build is slow (NDK + Hermes)...`);
  let status = runInherit(gradlew, gradleArgs, { env: buildEnv, cwd: androidDir });
  if (status !== 0) {
    // A cold New-Architecture codegen race can fail the first build; retry once.
    console.log(`${LOG} gradle build failed once; retrying...`);
    status = runInherit(gradlew, gradleArgs, { env: buildEnv, cwd: androidDir });
    if (status !== 0) throw new Error('gradlew assembleDebug failed');
  }

  const built = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!existsSync(built)) throw new Error(`gradle reported success but ${built} is missing`);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, cachedApk);
  console.log(`${LOG} Cached local build: ${cachedApk}`);
  return cachedApk;
}

/**
 * Commit a `rn-android-dev-*` tag points at, peeling an annotated tag object.
 * Null on any failure (no gh, no network, unknown tag) — the caller degrades to
 * "unknown freshness" rather than failing the run.
 */
export function resolveDevTagCommit(tag: string): string | null {
  const ref = runCapture('gh', ['api', `repos/{owner}/{repo}/git/ref/tags/${tag}`, '--jq', '.object.sha,.object.type']);
  if (ref.status !== 0) return null;
  const [sha, type] = ref.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!sha) return null;
  // A lightweight tag already points at the commit; an annotated one points at a
  // tag object that has to be peeled.
  if (type !== 'tag') return sha;
  const peeled = runCapture('gh', ['api', `repos/{owner}/{repo}/git/tags/${sha}`, '--jq', '.object.sha']);
  if (peeled.status !== 0) return null;
  const commit = peeled.stdout.trim();
  return commit.length > 0 ? commit : null;
}

/**
 * Does the release APK built at `tagCommit` still match `headSha`'s native tree?
 *
 * Pure over an injected git runner. `not-an-ancestor` means the release was cut
 * from a commit this checkout doesn't contain (a PR branched before it, or a
 * different line of history) — the diff would then be two-way and unreadable, so
 * it's reported rather than measured.
 */
export function devApkFreshness(
  headSha: string,
  tagCommit: string,
  runGit: GitRunner = defaultGitRunner,
): DevApkFreshness {
  const haveTagCommit = (): boolean => runGit(['cat-file', '-e', `${tagCommit}^{commit}`]).status === 0;
  if (!haveTagCommit()) {
    // A shallow CI checkout won't have the release commit; GitHub allows
    // fetching a reachable SHA directly.
    runGit(['fetch', '--quiet', 'origin', tagCommit]);
    if (!haveTagCommit()) return { fresh: false, reason: 'unknown' };
  }
  if (runGit(['merge-base', '--is-ancestor', tagCommit, headSha]).status !== 0) {
    return { fresh: false, reason: 'not-an-ancestor' };
  }
  const diff = runGit(['diff', '--quiet', tagCommit, headSha, '--', ...DEV_APK_FRESHNESS_PATHS]);
  if (diff.status === 0) return { fresh: true };
  if (diff.status === 1) return { fresh: false, reason: 'native-inputs-changed' };
  return { fresh: false, reason: 'unknown' };
}

function resolveHeadSha(): string {
  const head = runCapture('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR });
  return head.status === 0 ? head.stdout.trim() : '';
}

/**
 * True if the downloaded `tag` APK may be used. Warns (and answers false, so the
 * caller builds locally) when it can't be shown to match this checkout and
 * `requireFresh` is set. Never throws: a broken freshness check must not fail a
 * capture that would otherwise work.
 */
function downloadedApkIsUsable(tag: string, options: EnsureApkOptions, requireFresh: boolean): boolean {
  let headSha = options.headSha ?? '';
  let verdict: DevApkFreshness;
  try {
    headSha = headSha || resolveHeadSha();
    const tagCommit = resolveDevTagCommit(tag);
    verdict = headSha && tagCommit ? devApkFreshness(headSha, tagCommit) : { fresh: false, reason: 'unknown' };
  } catch (error) {
    console.warn(
      `${LOG} freshness check for ${tag} failed (${error instanceof Error ? error.message : String(error)})`,
    );
    verdict = { fresh: false, reason: 'unknown' };
  }
  if (verdict.fresh) return true;

  const detail = `${tag} does not match this checkout (${verdict.reason}; head ${headSha || 'unknown'})`;
  if (requireFresh) {
    console.warn(`::warning::${LOG} ${detail}; building the dev-client APK locally instead.`);
    return false;
  }
  console.warn(`${LOG} ${detail}; using it anyway (pass --require-fresh to force a local build).`);
  return true;
}

/** Resolve a ready APK per the preference order above, with where it came from. */
export function resolveAndroidApk(options: EnsureApkOptions = {}): ResolvedAndroidApk {
  if (options.appPath) {
    if (!existsSync(options.appPath)) throw new Error(`--app-path not found: ${options.appPath}`);
    return { apkPath: options.appPath, source: 'app-path' };
  }
  if (options.buildLocal) return { apkPath: buildDevApkLocally(), source: 'local-build' };

  const requireFresh = options.requireFresh ?? process.env.GITHUB_ACTIONS === 'true';
  try {
    const tag = options.apkTag ?? resolveLatestDevTag();
    if (!tag) throw new Error('no rn-android-dev-* release found');
    const apk = downloadDevApk(tag);
    if (apkHasAbi(apk, REQUIRED_ABI)) {
      if (downloadedApkIsUsable(tag, options, requireFresh)) return { apkPath: apk, source: `release:${tag}` };
    } else {
      console.warn(
        `${LOG} ${tag} APK has no ${REQUIRED_ABI} ABI (the CI dev-client build is not universal yet). Building locally instead.`,
      );
    }
  } catch (error) {
    console.warn(
      `${LOG} download path unavailable (${error instanceof Error ? error.message : String(error)}); building locally instead.`,
    );
  }
  return { apkPath: buildDevApkLocally(), source: 'local-build' };
}

/** Resolve a ready APK path per the preference order above. */
export function ensureAndroidApk(options: EnsureApkOptions = {}): string {
  return resolveAndroidApk(options).apkPath;
}

/** GITHUB_OUTPUT lines the screenshot workflow reads to install the resolved APK. */
export function formatApkOutputs(resolved: ResolvedAndroidApk): string {
  return `apk_path=${resolved.apkPath}\napk_source=${resolved.source}\n`;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = argv.filter((argument) => argument !== '--');
  const buildLocal = args.includes('--build-local');
  const tagIndex = args.indexOf('--apk-tag');
  const apkTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  const pathIndex = args.indexOf('--app-path');
  const appPath = pathIndex >= 0 ? resolve(args[pathIndex + 1]) : undefined;
  const requireFresh = args.includes('--require-fresh') ? true : undefined;
  try {
    const resolved = resolveAndroidApk({ buildLocal, apkTag, appPath, requireFresh });
    const apk = resolve(resolved.apkPath);
    console.log(`${LOG} APK ready: ${apk}`);
    // The screenshot workflow installs the APK this resolved, so hand it back as
    // a step output rather than making the caller re-derive it.
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, formatApkOutputs({ apkPath: apk, source: resolved.source }));
    }
    return 0;
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
