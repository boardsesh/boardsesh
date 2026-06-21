/// <reference types="node" />

/**
 * Idempotent Android SDK + JDK bootstrap for the local emulator screenshot flow.
 *
 * Everything installs under ~/.cache/boardsesh/ so a clean Linux box (no Android
 * Studio) becomes able to boot an emulator and run the RN dev-client with one
 * command. If a real SDK already exists at $ANDROID_HOME we reuse it and only add
 * the packages we need.
 *
 * Java note: sdkmanager/avdmanager (and the Gradle fallback build) are JVM tools
 * that want JDK 21 — this box ships only JDK 26, which Gradle/the RN plugin reject.
 * So we provision a Temurin 21 into the cache and point JAVA_HOME at it for every
 * Java invocation. The emulator and adb are native binaries and need no JDK.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandExists, runCapture, runInherit } from './exec';

const LOG = '[android-sdk]';

export const CACHE_ROOT = join(homedir(), '.cache', 'boardsesh');
export const DEFAULT_SDK_HOME = join(CACHE_ROOT, 'android-sdk');
export const JDK21_HOME = join(CACHE_ROOT, 'jdk-21');

// Pinned Android command-line tools (linux). Bump deliberately; the build number
// only gates sdkmanager itself, not which platform/image packages it can fetch.
const CMDLINE_TOOLS_VERSION = '11076708';
const CMDLINE_TOOLS_URL = `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip`;

// Latest Temurin 21 GA for linux/x64. Redirects to the actual tarball.
const ADOPTIUM_JDK21_URL = 'https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse';

// API level for the platform + system image. Matches CI (android-36).
export const ANDROID_API_LEVEL = 36;
export const SYSTEM_IMAGE = `system-images;android-${ANDROID_API_LEVEL};google_apis;x86_64`;
export const BUILD_TOOLS_VERSION = `${ANDROID_API_LEVEL}.0.0`;

// Core packages to boot an emulator and install/run an APK (no Java build needed).
const SDK_PACKAGES_CORE = ['platform-tools', 'emulator', `platforms;android-${ANDROID_API_LEVEL}`, SYSTEM_IMAGE];
// Extra packages the local Gradle fallback build needs.
const SDK_PACKAGES_BUILD = [`build-tools;${BUILD_TOOLS_VERSION}`];

export interface EnsureSdkOptions {
  /** Also install build-tools — only needed for the local Gradle fallback build. */
  includeBuildTools?: boolean;
}

export interface AndroidToolchain {
  home: string;
  java21: string | null;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve which SDK dir to use. Honour an already-populated $ANDROID_HOME (e.g. a
 * contributor's Android Studio install); otherwise use our cache. The configured
 * default on this box points at a non-existent path, so the existsSync gate matters.
 */
export function resolveAndroidHome(): string {
  const configured = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (configured && (existsSync(join(configured, 'platform-tools')) || existsSync(join(configured, 'cmdline-tools')))) {
    return configured;
  }
  return DEFAULT_SDK_HOME;
}

export function sdkmanagerPath(home: string): string {
  return join(home, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
}

export function avdmanagerPath(home: string): string {
  return join(home, 'cmdline-tools', 'latest', 'bin', 'avdmanager');
}

export function adbPath(home: string): string {
  return join(home, 'platform-tools', 'adb');
}

export function emulatorPath(home: string): string {
  return join(home, 'emulator', 'emulator');
}

/** Locate a JDK 21 (override env, our cache, a system install) without downloading. */
function findJava21(): string | null {
  const override = process.env.JAVA21_HOME ?? process.env.JAVA_21_HOME;
  if (override && existsSync(join(override, 'bin', 'java'))) return override;
  if (existsSync(join(JDK21_HOME, 'bin', 'java'))) return JDK21_HOME;

  const searchDirs = ['/usr/lib/jvm', '/usr/java', join(homedir(), '.sdkman', 'candidates', 'java')];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.includes('21')) continue;
      const javaHome = join(dir, entry);
      const javaBin = join(javaHome, 'bin', 'java');
      if (!existsSync(javaBin)) continue;
      const version = runCapture(javaBin, ['-version']);
      if (/(version "21|openjdk 21|\b21\.\d)/.test(`${version.stderr}${version.stdout}`)) return javaHome;
    }
  }
  return null;
}

function downloadJava21(): string {
  console.log(
    `${LOG} Provisioning Temurin JDK 21 (~190MB; sdkmanager/avdmanager/Gradle need it, this box has only JDK 26)...`,
  );
  mkdirSync(JDK21_HOME, { recursive: true });
  const tarball = join(CACHE_ROOT, 'jdk-21.tar.gz');
  const download = runCapture('curl', ['-fLs', '-o', tarball, ADOPTIUM_JDK21_URL]);
  if (download.status !== 0) throw new Error(`Failed to download JDK 21: ${download.stderr || download.status}`);
  // --strip-components=1 drops the tarball's top-level jdk-21.x dir so JDK21_HOME
  // directly contains bin/, lib/, ...
  const extract = runCapture('tar', ['-xzf', tarball, '-C', JDK21_HOME, '--strip-components=1']);
  if (extract.status !== 0) throw new Error(`Failed to extract JDK 21: ${extract.stderr || extract.status}`);
  rmSync(tarball, { force: true });
  if (!existsSync(join(JDK21_HOME, 'bin', 'java'))) throw new Error('JDK 21 extracted but bin/java is missing');
  return JDK21_HOME;
}

/** JDK 21 path, downloading a Temurin build into the cache when none is found. */
export function resolveJava21(autoInstall = true): string | null {
  const found = findJava21();
  if (found) return found;
  if (!autoInstall) return null;
  return downloadJava21();
}

/** Augmented env: SDK paths on PATH, ANDROID_HOME/SDK_ROOT set, JAVA_HOME at JDK 21. */
export function androidEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = resolveAndroidHome();
  const java21 = findJava21();
  const pathParts = [
    join(home, 'cmdline-tools', 'latest', 'bin'),
    join(home, 'platform-tools'),
    join(home, 'emulator'),
  ];
  if (java21) pathParts.unshift(join(java21, 'bin'));
  const env: NodeJS.ProcessEnv = {
    ...base,
    ANDROID_HOME: home,
    ANDROID_SDK_ROOT: home,
    PATH: `${pathParts.join(':')}:${base.PATH ?? ''}`,
  };
  if (java21) env.JAVA_HOME = java21;
  return env;
}

function ensureCmdlineTools(home: string): void {
  if (existsSync(sdkmanagerPath(home))) return;
  if (!commandExists('unzip')) {
    throw new Error('`unzip` is required to install the Android command-line tools but is not on PATH.');
  }
  console.log(`${LOG} Installing Android command-line tools (${CMDLINE_TOOLS_VERSION})...`);
  mkdirSync(home, { recursive: true });
  const zip = join(CACHE_ROOT, `cmdline-tools-${CMDLINE_TOOLS_VERSION}.zip`);
  if (!existsSync(zip)) {
    const download = runCapture('curl', ['-fLs', '-o', zip, CMDLINE_TOOLS_URL]);
    if (download.status !== 0)
      throw new Error(`Failed to download cmdline-tools: ${download.stderr || download.status}`);
  }
  const tmp = join(home, 'cmdline-tools', '.unzip-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const unzip = runCapture('unzip', ['-q', zip, '-d', tmp]);
  if (unzip.status !== 0) throw new Error(`Failed to unzip cmdline-tools: ${unzip.stderr || unzip.status}`);
  // The zip nests everything under a top-level `cmdline-tools/`; sdkmanager needs
  // the layout cmdline-tools/latest/bin/sdkmanager.
  const latest = join(home, 'cmdline-tools', 'latest');
  rmSync(latest, { recursive: true, force: true });
  renameSync(join(tmp, 'cmdline-tools'), latest);
  rmSync(tmp, { recursive: true, force: true });
  if (!existsSync(sdkmanagerPath(home))) throw new Error('cmdline-tools installed but sdkmanager is missing');
}

/** Map an sdkmanager package id to the on-disk path that proves it's installed. */
function packageInstallPath(home: string, pkg: string): string {
  if (pkg === 'platform-tools') return join(home, 'platform-tools', 'adb');
  if (pkg === 'emulator') return join(home, 'emulator', 'emulator');
  // `a;b;c` -> a/b/c
  return join(home, ...pkg.split(';'));
}

function acceptLicenses(home: string, env: NodeJS.ProcessEnv): void {
  // `yes` floods "y" to accept every license; its SIGPIPE exit is expected, so the
  // status is ignored.
  runCapture('sh', ['-c', `yes | "${sdkmanagerPath(home)}" --sdk_root="${home}" --licenses`], { env });
}

/**
 * Ensure the SDK is present: cmdline-tools, platform-tools, emulator, platform, and
 * an x86_64 system image (plus build-tools when includeBuildTools is set). No-op when
 * everything is already installed.
 */
export function ensureAndroidSdk(options: EnsureSdkOptions = {}): AndroidToolchain {
  const home = resolveAndroidHome();
  mkdirSync(home, { recursive: true });

  const wanted = [...SDK_PACKAGES_CORE, ...(options.includeBuildTools ? SDK_PACKAGES_BUILD : [])];
  const needCmdlineTools = !existsSync(sdkmanagerPath(home));
  const missing = wanted.filter((pkg) => !existsSync(packageInstallPath(home, pkg)));

  // sdkmanager/avdmanager are Java tools — provision JDK 21 only when we must run
  // them (a fresh install or missing packages). The download-only happy path on an
  // already-bootstrapped box needs no JDK, so don't pull one just to build the env.
  const java21 = needCmdlineTools || missing.length > 0 ? resolveJava21(true) : resolveJava21(false);

  if (needCmdlineTools) ensureCmdlineTools(home);
  const env = androidEnv(process.env);
  if (java21) env.JAVA_HOME = java21;

  if (missing.length > 0) {
    acceptLicenses(home, env);
    console.log(`${LOG} Installing SDK packages: ${missing.join(', ')}`);
    const status = runInherit(sdkmanagerPath(home), [`--sdk_root=${home}`, ...missing], { env });
    if (status !== 0) throw new Error(`sdkmanager failed installing: ${missing.join(', ')}`);
  } else {
    console.log(`${LOG} SDK packages already present.`);
  }

  return { home, java21, env };
}
