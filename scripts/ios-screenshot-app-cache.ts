/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ScreenshotAppToolchain {
  xcodeBuild: string;
  sdkVersion: string;
  sdkBuild: string;
}
export interface ScreenshotAppCacheIdentity extends ScreenshotAppToolchain {
  os: string;
  arch: string;
  nativeHash: string;
}
export interface ScreenshotAppMetadata {
  xcodeBuild: unknown;
  sdkName: unknown;
  sdkBuild: unknown;
  platformName: unknown;
  supportedPlatforms: unknown;
  executable: unknown;
  bundleIdentifier: unknown;
  launcherUrl: unknown;
  executableArchitectures: string[];
  debugArchitectures: string[];
  hasDebugLibrary: boolean;
  hasEmbeddedBundle: boolean;
}
const KEY_PATTERN =
  /^([A-Za-z0-9]+)-([A-Za-z0-9_]+)-screenshot-sim-app-v2-Debug-([A-Za-z0-9]+)-(\d+(?:\.\d+){1,2})-([A-Za-z0-9]+)-([a-f0-9]{64})$/;

export function screenshotAppCacheKey(identity: ScreenshotAppCacheIdentity): string {
  const { os, arch, xcodeBuild, sdkVersion, sdkBuild, nativeHash } = identity;
  const key = `${os}-${arch}-screenshot-sim-app-v2-Debug-${xcodeBuild}-${sdkVersion}-${sdkBuild}-${nativeHash}`;
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid screenshot app cache identity');
  if (os !== 'macOS' || arch !== 'ARM64') throw new Error('Screenshot builds require macOS ARM64');
  return key;
}
export function parseScreenshotAppCacheKey(key: string): ScreenshotAppCacheIdentity {
  const match = KEY_PATTERN.exec(key);
  if (!match) throw new Error('Expected a toolchain-aware v2 Debug screenshot app key');
  const [, os, arch, xcodeBuild, sdkVersion, sdkBuild, nativeHash] = match;
  const identity = { os, arch, xcodeBuild, sdkVersion, sdkBuild, nativeHash };
  screenshotAppCacheKey(identity);
  return identity;
}
export function sdkAtLeast(version: string, minimum: string): boolean {
  if (!/^\d+(?:\.\d+){1,2}$/.test(version) || !/^\d+(?:\.\d+){1,2}$/.test(minimum))
    throw new Error('Invalid simulator SDK version');
  const parts = version.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(parts.length, minimumParts.length); index += 1) {
    const difference = (parts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
export function validateScreenshotAppMetadata(
  metadata: ScreenshotAppMetadata,
  identity: ScreenshotAppCacheIdentity,
  minimumSdk?: string,
): void {
  screenshotAppCacheKey(identity);
  if (minimumSdk && !sdkAtLeast(identity.sdkVersion, minimumSdk))
    throw new Error(`Screenshot device requires simulator SDK ${minimumSdk} or newer`);
  const expectedSdk = `iphonesimulator${identity.sdkVersion}`;
  if (
    metadata.xcodeBuild !== identity.xcodeBuild ||
    metadata.sdkName !== expectedSdk ||
    metadata.sdkBuild !== identity.sdkBuild
  )
    throw new Error('Cached app compiler or SDK metadata does not match its cache key');
  if (
    metadata.platformName !== 'iphonesimulator' ||
    !Array.isArray(metadata.supportedPlatforms) ||
    !metadata.supportedPlatforms.includes('iPhoneSimulator')
  )
    throw new Error('Cached app is not an iOS simulator product');
  if (metadata.executable !== 'Boardsesh' || metadata.bundleIdentifier !== 'com.boardsesh.app')
    throw new Error('Cached app identity is not Boardsesh');
  if (
    !metadata.hasDebugLibrary ||
    metadata.hasEmbeddedBundle ||
    typeof metadata.launcherUrl !== 'string' ||
    !/^http:\/\/localhost:\d+$/.test(metadata.launcherUrl)
  )
    throw new Error('Cached app is not the Metro Debug screenshot dev-client');
  for (const architectures of [metadata.executableArchitectures, metadata.debugArchitectures])
    if (!architectures.includes('arm64')) throw new Error('Cached app lacks the ARM64 simulator slice');
}
function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
  if (result.status !== 0) throw new Error(`Could not inspect screenshot app identity with ${command}`);
  return result.stdout.trim();
}
export function selectedScreenshotToolchain(): ScreenshotAppToolchain {
  const xcodeVersion = capture('xcodebuild', ['-version']);
  const xcodeBuild = /^Build version ([A-Za-z0-9]+)$/m.exec(xcodeVersion)?.[1];
  if (!xcodeBuild) throw new Error('Could not identify the selected Xcode build');
  return {
    xcodeBuild,
    sdkVersion: capture('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']),
    sdkBuild: capture('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-build-version']),
  };
}
export function readScreenshotAppMetadata(app: string): ScreenshotAppMetadata {
  const plist: unknown = JSON.parse(capture('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]));
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) throw new Error('Invalid cached app Info.plist');
  const properties = plist as Record<string, unknown>;
  const hasDebugLibrary = existsSync(join(app, 'Boardsesh.debug.dylib'));
  return {
    xcodeBuild: properties.DTXcodeBuild,
    sdkName: properties.DTSDKName,
    sdkBuild: properties.DTSDKBuild,
    platformName: properties.DTPlatformName,
    supportedPlatforms: properties.CFBundleSupportedPlatforms,
    executable: properties.CFBundleExecutable,
    bundleIdentifier: properties.CFBundleIdentifier,
    launcherUrl: properties.DEV_CLIENT_DEFAULT_LAUNCHER_URL,
    executableArchitectures: capture('lipo', ['-archs', join(app, 'Boardsesh')]).split(/\s+/),
    debugArchitectures: hasDebugLibrary
      ? capture('lipo', ['-archs', join(app, 'Boardsesh.debug.dylib')]).split(/\s+/)
      : [],
    hasDebugLibrary,
    hasEmbeddedBundle: existsSync(join(app, 'main.jsbundle')),
  };
}
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  try {
    if (process.platform !== 'darwin') throw new Error('Screenshot app cache inspection requires macOS');
    const [command, ...argumentsList] = argv;
    const options = new Map<string, string>();
    if (argumentsList.length % 2 !== 0) throw new Error('Expected named cache identity arguments');
    for (let index = 0; index < argumentsList.length; index += 2) {
      const name = argumentsList[index];
      if (!['--native-hash', '--key', '--app', '--minimum-sdk'].includes(name) || options.has(name))
        throw new Error(`Invalid cache identity argument ${name}`);
      options.set(name, argumentsList[index + 1]);
    }
    if (command === 'key') {
      const nativeHash = options.get('--native-hash');
      if (!nativeHash) throw new Error('A native input hash is required');
      const identity = {
        os: process.env.RUNNER_OS ?? 'macOS',
        arch: process.env.RUNNER_ARCH ?? 'ARM64',
        nativeHash,
        ...selectedScreenshotToolchain(),
      };
      const minimumSdk = options.get('--minimum-sdk');
      if (minimumSdk && !sdkAtLeast(identity.sdkVersion, minimumSdk))
        throw new Error(`Screenshot producer requires simulator SDK ${minimumSdk} or newer`);
      const key = screenshotAppCacheKey(identity);
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
      appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
      console.log(JSON.stringify({ key, toolchain: identity }));
      return 0;
    }
    if (command === 'validate') {
      const key = options.get('--key');
      const app = options.get('--app');
      if (!key || !app) throw new Error('Cache validation requires --key and --app');
      const identity = parseScreenshotAppCacheKey(key);
      validateScreenshotAppMetadata(readScreenshotAppMetadata(resolve(app)), identity, options.get('--minimum-sdk'));
      console.log(`Verified Debug simulator app: ${key}`);
      return 0;
    }
    throw new Error('Expected key or validate command');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
