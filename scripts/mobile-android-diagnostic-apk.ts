/// <reference types="node" />

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandExists, runCapture, runInherit } from './lib/exec';
import { ensureAndroidSdk } from './lib/android-sdk';

const LOG = '[mobile:android-diagnostic-apk]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = join(ROOT_DIR, 'packages', 'mobile');
const ANDROID_DIR = join(MOBILE_DIR, 'android');
const OUTPUT_DIR = process.env.BOARDSESH_DIAGNOSTIC_APK_DIR ?? '/private/tmp/boardsesh-diagnostic-apks';
const REQUIRED_ABI = 'arm64-v8a';
const EXPO_ENV_PATH = join(MOBILE_DIR, '.env');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to build a remote-logging diagnostic APK`);
  return value;
}

function writeExpoEnv(): string | null {
  const posthogKey = requireEnv('EXPO_PUBLIC_POSTHOG_KEY');
  const previousEnv = existsSync(EXPO_ENV_PATH) ? readFileSync(EXPO_ENV_PATH, 'utf8') : null;
  const lines = [
    'EXPO_PUBLIC_BACKEND_URL=https://ws.boardsesh.com',
    'EXPO_PUBLIC_WS_URL=wss://ws.boardsesh.com/graphql',
    'EXPO_PUBLIC_WEB_URL=https://www.boardsesh.com',
    'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=401523882502-0f6d7te1vekvkpmg18t8di6l0ig560q7.apps.googleusercontent.com',
    'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=401523882502-h92kdkck1qhmdbgq7ltek87g4rg8rg3h.apps.googleusercontent.com',
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=401523882502-hvfhh79p4q1qq0md7lk646c6sgmsi9q0.apps.googleusercontent.com',
    `EXPO_PUBLIC_POSTHOG_KEY=${posthogKey}`,
    'EXPO_PUBLIC_BOARDSESH_DIAGNOSTIC_LOGGING=1',
    '',
  ];
  writeFileSync(EXPO_ENV_PATH, lines.join('\n'));
  return previousEnv;
}

function restoreExpoEnv(previousEnv: string | null): void {
  if (previousEnv === null) {
    rmSync(EXPO_ENV_PATH, { force: true });
    return;
  }
  writeFileSync(EXPO_ENV_PATH, previousEnv);
}

function shortSha(): string {
  const gitHead = process.env.GITHUB_SHA;
  if (gitHead) return gitHead.slice(0, 12);
  const result = runCapture('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT_DIR });
  if (result.status !== 0) return 'local';
  return result.stdout.trim() || 'local';
}

function findBuiltApk(): string {
  const releaseDir = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release');
  const apks = readdirSync(releaseDir)
    .filter((name) => name.endsWith('.apk'))
    .map((name) => join(releaseDir, name));
  if (apks.length !== 1) throw new Error(`Expected exactly one release APK in ${releaseDir}, found ${apks.length}`);
  return apks[0];
}

function main(): number {
  let previousEnv: string | null | undefined;
  try {
    if (!commandExists('bunx')) throw new Error('bunx is not on PATH; run `vp install` first.');
    previousEnv = writeExpoEnv();

    const toolchain = ensureAndroidSdk({ includeBuildTools: true, includeEmulator: false });
    if (!toolchain.java21) {
      throw new Error('Diagnostic APK build needs JDK 21; run `vp run mobile:android-doctor -- --build` first.');
    }

    const buildEnv: NodeJS.ProcessEnv = {
      ...toolchain.env,
      BOARDSESH_APP_VARIANT: 'dev',
      EXPO_PUBLIC_BOARDSESH_DIAGNOSTIC_LOGGING: '1',
      EXPO_PUBLIC_POSTHOG_KEY: requireEnv('EXPO_PUBLIC_POSTHOG_KEY'),
      JAVA_HOME: toolchain.java21,
      SENTRY_DISABLE_AUTO_UPLOAD: 'true',
    };

    console.log(`${LOG} expo prebuild (android, Boardsesh Dev diagnostic variant)...`);
    rmSync(ANDROID_DIR, { recursive: true, force: true });
    if (
      runInherit('bunx', ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'], {
        env: buildEnv,
        cwd: MOBILE_DIR,
      }) !== 0
    ) {
      throw new Error('expo prebuild --platform android failed');
    }

    console.log(`${LOG} gradlew assembleRelease (${REQUIRED_ABI}, debug-signed release)...`);
    const gradleStatus = runInherit(
      join(ANDROID_DIR, 'gradlew'),
      [
        'assembleRelease',
        `-PreactNativeArchitectures=${REQUIRED_ABI}`,
        `-PboardseshAbiFilters=${REQUIRED_ABI}`,
        '--no-daemon',
        '--console=plain',
        '--stacktrace',
      ],
      { env: buildEnv, cwd: ANDROID_DIR },
    );
    if (gradleStatus !== 0) throw new Error('gradlew assembleRelease failed');

    const builtApk = findBuiltApk();
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const targetApk = join(OUTPUT_DIR, `boardsesh-dev-diagnostics-${shortSha()}-${REQUIRED_ABI}.apk`);
    copyFileSync(builtApk, targetApk);
    console.log(`${LOG} APK ready: ${targetApk}`);
    return 0;
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (previousEnv !== undefined) restoreExpoEnv(previousEnv);
  }
}

process.exit(main());
