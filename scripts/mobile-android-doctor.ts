/// <reference types="node" />

/**
 * Bootstrap the Android SDK + JDK 21 and report what's ready for the local
 * emulator screenshot flow (vp run mobile:android-shots).
 *
 * Usage:
 *   vp run mobile:android-doctor               # bootstrap (download path tools)
 *   vp run mobile:android-doctor -- --build    # also install build-tools (Gradle fallback)
 *   vp run mobile:android-doctor -- --check    # report only, don't install anything
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commandExists, runCapture } from './lib/exec';
import {
  ANDROID_API_LEVEL,
  adbPath,
  androidEnv,
  avdmanagerPath,
  emulatorPath,
  ensureAndroidSdk,
  resolveAndroidHome,
  resolveJava21,
} from './lib/android-sdk';
import { avdExists, resolveAvdName } from './lib/android-emulator';
import { resolveLatestDevTag } from './mobile-android-apk';

const LOG = '[mobile:android-doctor]';

function ok(label: string, detail: string): void {
  console.log(`  ✓ ${label.padEnd(22)} ${detail}`);
}

function warn(label: string, detail: string): void {
  console.log(`  ✗ ${label.padEnd(22)} ${detail}`);
}

function reportLatestDevRelease(): void {
  if (!commandExists('gh')) {
    warn('dev-client release', 'gh not on PATH — cannot resolve the cached APK (use --build-local)');
    return;
  }
  const tag = resolveLatestDevTag();
  if (tag) ok('dev-client release', `${tag} (latest)`);
  else warn('dev-client release', 'gh unauthenticated/offline or no rn-android-dev-* release found');
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = argv.filter((argument) => argument !== '--');
  const checkOnly = args.includes('--check');
  const includeBuildTools = args.includes('--build');

  console.log(`${LOG} Android emulator screenshot environment\n`);

  // Host capabilities (read-only).
  const kvm = existsSync('/dev/kvm');
  if (kvm) ok('KVM', '/dev/kvm present — hardware-accelerated x86_64 emulation');
  else warn('KVM', '/dev/kvm missing — x86_64 emulation will be slow (TCG)');

  const systemJava = runCapture('java', ['-version']);
  ok('system java', (systemJava.stderr || systemJava.stdout).split(/\r?\n/)[0] || 'unknown');

  if (!checkOnly) {
    try {
      ensureAndroidSdk({ includeBuildTools });
    } catch (error) {
      warn('bootstrap', error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const home = resolveAndroidHome();
  ok('ANDROID_HOME', home);
  ok('API level', String(ANDROID_API_LEVEL));

  const java21 = resolveJava21(false);
  if (java21) ok('JDK 21', java21);
  else warn('JDK 21', checkOnly ? 'not provisioned (run without --check)' : 'missing');

  for (const [label, path] of [
    ['adb', adbPath(home)],
    ['emulator', emulatorPath(home)],
    ['avdmanager', avdmanagerPath(home)],
  ] as const) {
    if (existsSync(path)) ok(label, path);
    else warn(label, checkOnly ? 'not installed (run without --check)' : 'missing');
  }

  const avdName = resolveAvdName();
  if (avdExists(avdName, androidEnv())) ok('AVD', `${avdName} ready`);
  else warn('AVD', `${avdName} not created yet (created on first \`vp run mobile:android-shots\`)`);

  if (commandExists('maestro')) ok('maestro', 'on PATH (--flow runs available)');
  else warn('maestro', 'not on PATH (only needed for --flow Maestro runs)');

  reportLatestDevRelease();

  console.log(`\n${LOG} Done. Take screenshots with: vp run mobile:android-shots`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
