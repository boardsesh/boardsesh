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
 */

import { createHash, type Hash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
}

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
  const files = ['packages/mobile/app.config.ts', 'packages/mobile/package.json', 'package.json', 'bun.lock'];
  const dirs = ['packages/mobile/plugins', 'packages/mobile/modules', 'patches'];
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
  const toolchain = ensureAndroidSdk({ includeBuildTools: true });
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
    runInherit('bunx', ['expo', 'prebuild', '--platform', 'android', '--clean'], { env: buildEnv, cwd: mobileDir }) !==
    0
  ) {
    throw new Error('expo prebuild --platform android failed');
  }

  const androidDir = join(mobileDir, 'android');
  const gradlew = join(androidDir, 'gradlew');
  const gradleArgs = [
    'assembleDebug',
    `-PreactNativeArchitectures=${REQUIRED_ABI}`,
    `-PboardseshAbiFilters=${REQUIRED_ABI}`,
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

/** Resolve a ready APK path per the preference order above. */
export function ensureAndroidApk(options: EnsureApkOptions = {}): string {
  if (options.appPath) {
    if (!existsSync(options.appPath)) throw new Error(`--app-path not found: ${options.appPath}`);
    return options.appPath;
  }
  if (options.buildLocal) return buildDevApkLocally();

  try {
    const tag = options.apkTag ?? resolveLatestDevTag();
    if (!tag) throw new Error('no rn-android-dev-* release found');
    const apk = downloadDevApk(tag);
    if (apkHasAbi(apk, REQUIRED_ABI)) return apk;
    console.warn(
      `${LOG} ${tag} APK has no ${REQUIRED_ABI} ABI (the CI dev-client build is not universal yet). Building locally instead.`,
    );
  } catch (error) {
    console.warn(
      `${LOG} download path unavailable (${error instanceof Error ? error.message : String(error)}); building locally instead.`,
    );
  }
  return buildDevApkLocally();
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = argv.filter((argument) => argument !== '--');
  const buildLocal = args.includes('--build-local');
  const tagIndex = args.indexOf('--apk-tag');
  const apkTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  const pathIndex = args.indexOf('--app-path');
  const appPath = pathIndex >= 0 ? resolve(args[pathIndex + 1]) : undefined;
  try {
    const apk = ensureAndroidApk({ buildLocal, apkTag, appPath });
    console.log(`${LOG} APK ready: ${apk}`);
    return 0;
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
