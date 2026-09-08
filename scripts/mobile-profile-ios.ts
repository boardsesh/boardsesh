/// <reference types="node" />

import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leaseEnvironment, resolveSimulatorUdid } from './lib/ios-simulator-lease';
import { assertMatchingIdentity, fileSha256, readAppIdentity, validateCaptureFiles } from './lib/ios-profile-identity';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ProfileOptions {
  udid: string;
  sourceRef: string;
  configuration: 'Debug' | 'Release';
  port: number;
  runDir: string;
  checkout: string | null;
  fixtureManifest: string;
}

export function parseProfileArgs(argv: readonly string[]): ProfileOptions {
  const options: ProfileOptions = {
    udid: process.env.BOARDSESH_IOS_SIMULATOR_UDID ?? '',
    sourceRef: 'HEAD',
    configuration: 'Release',
    port: 8097,
    runDir: join(ROOT, '.boardsesh', `ios-profile-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    checkout: null,
    fixtureManifest: join(ROOT, '.boardsesh/ios-performance-fixtures.json'),
  };
  const args = argv.filter((argument) => argument !== '--');
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (!argument || argument.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--udid') options.udid = argument;
    else if (flag === '--source-ref') options.sourceRef = argument;
    else if (flag === '--configuration' && (argument === 'Debug' || argument === 'Release'))
      options.configuration = argument;
    else if (flag === '--port') options.port = Number(argument);
    else if (flag === '--run-dir') options.runDir = resolve(argument);
    else if (flag === '--checkout') options.checkout = resolve(argument);
    else if (flag === '--fixtures') options.fixtureManifest = resolve(argument);
    else throw new Error(`Unknown option or invalid value: ${flag} ${argument}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(options.udid)) throw new Error('--udid must identify an explicitly owned simulator.');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid --port.');
  return options;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status ?? 1}.`);
}

export function assertCapturePrerequisites(env: NodeJS.ProcessEnv = process.env): void {
  const maestro = spawnSync('maestro', ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  if (maestro.status !== 0) {
    throw new Error(
      'Maestro is unavailable or cannot find Java. Set JAVA_HOME to an installed JDK and verify maestro --version before building.',
    );
  }
}

async function assertFreePort(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; refusing to reuse or stop another Metro.`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort()));
  });
}

async function waitForOwnedMetro(port: number, checkout: string, metro: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (metro.exitCode !== null) throw new Error('Owned Metro exited before becoming ready.');
    try {
      const response = await fetch(`http://localhost:${port}/_boardsesh/metro-info`, {
        signal: AbortSignal.timeout(2000),
      });
      const metadata = (await response.json()) as { rootDir?: string };
      if (metadata.rootDir === checkout) return;
      if (response.ok) throw new Error('Metro source identity differs from the profiling checkout.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('source identity')) throw error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error('Metro readiness timed out.');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseProfileArgs(argv);
  if (process.platform !== 'darwin') throw new Error('iOS profiling requires macOS and Xcode.');
  // Local fixtures only. Never silently send the screenshot account to production.
  const apiUrl = process.env.EXPO_PUBLIC_BACKEND_URL ?? '';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(apiUrl)) {
    throw new Error('Set EXPO_PUBLIC_BACKEND_URL to the seeded local backend before profiling.');
  }
  if (!existsSync(options.fixtureManifest))
    throw new Error('Seed local profiling fixtures and pass their manifest with --fixtures.');
  const fixtures = JSON.parse(readFileSync(options.fixtureManifest, 'utf8')) as {
    owned?: number;
    community?: number;
    climbs?: unknown[];
  };
  if (
    (fixtures.owned ?? 0) < 200 ||
    (fixtures.community ?? 0) < 200 ||
    !Array.isArray(fixtures.climbs) ||
    fixtures.climbs.length === 0
  ) {
    throw new Error('Profiling requires at least 200 owned and 200 community playlists with real climbs.');
  }
  assertCapturePrerequisites();
  if (existsSync(join(options.runDir, 'manifest.json')))
    throw new Error('Run directory already has a manifest. Use a fresh run directory.');
  mkdirSync(options.runDir, { recursive: true });
  const checkout = options.checkout ?? join(options.runDir, 'source');
  const udid = resolveSimulatorUdid(options.udid);
  const lease = leaseEnvironment(udid, ROOT);
  const env: NodeJS.ProcessEnv = {
    ...lease.env,
    BOARDSESH_PROFILE_BUILD: '1',
    BOARDSESH_PROFILE_SOURCE_DIR: checkout,
    BOARDSESH_SCREENSHOT_BUILD: undefined,
    EXPO_PUBLIC_PROFILE_STARTUP: '1',
    BOARDSESH_METRO_PORT: String(options.port),
    TAILSCALE_HOSTNAME: 'localhost',
    REACT_NATIVE_PACKAGER_HOSTNAME: 'localhost',
    CI: '1',
    BOARDSESH_IOS_BUILD_CACHE_DIR: join(options.runDir, 'native-cache', 'build'),
  };
  const manifest: Record<string, unknown> = {
    version: 1,
    startedAt: new Date().toISOString(),
    sourceCheckout: checkout,
    configuration: options.configuration,
    udid,
    metroPort: options.configuration === 'Debug' ? options.port : null,
    clocks: {
      host: 'host monotonic observation; command overhead included',
      js: 'runtime performance.now; never subtract from host timestamps',
    },
    fixtureManifestSha256: fileSha256(options.fixtureManifest),
    fixtureManifest: options.fixtureManifest,
    fixtureEnvironment: Object.fromEntries(
      [
        'EXPO_PUBLIC_BACKEND_URL',
        'EXPO_PUBLIC_SCREENSHOT_MODE',
        'EXPO_PUBLIC_SCREENSHOT_THEME',
        'EXPO_PUBLIC_SCREENSHOT_LOCALE',
        'EXPO_PUBLIC_SCREENSHOT_BOARDS',
        'EXPO_PUBLIC_SCREENSHOT_RENDER_MODE',
      ].map((name) => [name, env[name] ?? null]),
    ),
    fallbackCaptures: ['React renderer commit profile', 'native sample'],
    status: 'preparing',
    ownedPids: [],
  };
  const save = () => writeFileSync(join(options.runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  let metro: ChildProcess | undefined;
  try {
    save();
    if (!options.checkout) run('git', ['worktree', 'add', '--detach', checkout, options.sourceRef], ROOT, env);
    if (!existsSync(join(checkout, 'packages/mobile/src/lib/profiling/startup-profile.ts'))) {
      throw new Error(
        'This source needs the companion startup instrumentation (src/lib/profiling/startup-profile.ts) before native profiling builds.',
      );
    }
    // Profiling must never reuse a previously generated native project.
    if (existsSync(join(checkout, 'packages/mobile/ios')))
      throw new Error('Profiling checkout already has ios/. Use a fresh dedicated checkout.');
    manifest.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
    manifest.sourceDiff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    manifest.sourceStatus = execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' });
    const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: checkout,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    manifest.untrackedSourceHashes = Object.fromEntries(
      untrackedPaths.map((path) => [path, fileSha256(join(checkout, path))]),
    );
    if (options.configuration === 'Debug') {
      const packagePath = join(checkout, 'packages/mobile/package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        expo: { autolinking: { ios?: { exclude?: string[] } } };
      };
      const iosOptions = packageJson.expo.autolinking.ios ?? {};
      const excludedModules = ['expo-dev-client', 'expo-dev-launcher', 'expo-dev-menu', 'expo-dev-menu-interface'];
      packageJson.expo.autolinking.ios = {
        ...iosOptions,
        exclude: [...new Set([...(iosOptions.exclude ?? []), ...excludedModules])],
      };
      writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      manifest.debugAutolinkingExclusions = excludedModules;
    }
    if (!existsSync(join(checkout, 'node_modules'))) run('vp', ['install'], checkout, env);
    // Compute through the installed API, preserving the full source attribution artifact.
    const fingerprintPath = join(options.runDir, 'native-fingerprint.json');
    run(
      'vp',
      [
        'exec',
        'node',
        '-e',
        'require("@expo/fingerprint").createFingerprintAsync(process.cwd(), { platforms: ["ios"] }).then(result => require("node:fs").writeFileSync(process.argv[1], JSON.stringify(result)))',
        fingerprintPath,
      ],
      join(checkout, 'packages/mobile'),
      env,
    );
    manifest.nativeFingerprint = (JSON.parse(readFileSync(fingerprintPath, 'utf8')) as { hash: string }).hash;
    manifest.status = 'building';
    save();
    run(
      'vp',
      [
        'exec',
        'tsx',
        join(ROOT, 'scripts/mobile-build-sim-app.ts'),
        '--app-out',
        join(options.runDir, 'app'),
        '--configuration',
        options.configuration,
      ],
      checkout,
      {
        ...env,
        BOARDSESH_PROFILE_SOURCE_DIR: checkout,
      },
    );
    manifest.generatedInputs = Object.fromEntries(
      [
        'packages/mobile/package.json',
        'packages/mobile/ios/Boardsesh/AppDelegate.swift',
        'packages/mobile/ios/Podfile.lock',
        'packages/mobile/ios/Podfile.properties.json',
      ]
        .filter((path) => existsSync(join(checkout, path)))
        .map((path) => [path, fileSha256(join(checkout, path))]),
    );
    writeFileSync(
      join(options.runDir, 'build-inputs.patch'),
      execFileSync('git', ['diff', '--binary', 'HEAD'], {
        cwd: checkout,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    if (options.configuration === 'Debug') {
      const pods = readFileSync(join(checkout, 'packages/mobile/ios/Podfile.lock'), 'utf8');
      if (/ExpoDevLauncher|EXDevLauncher|expo-dev-launcher|ExpoDevMenu|EXDevMenu|expo-dev-menu/.test(pods)) {
        throw new Error('Profiling Debug build still contains Expo launcher/menu native modules.');
      }
    }
    const appPath = join(options.runDir, 'app/Boardsesh.app');
    const identity = readAppIdentity(appPath, options.configuration);
    manifest.appIdentity = identity;
    const simctl = (args: string[]) => execFileSync('xcrun', ['simctl', ...args], { env, encoding: 'utf8' }).trim();
    const deviceListing = simctl(['list', 'devices', '--json']);
    manifest.deviceListing = JSON.parse(deviceListing) as unknown;
    const listing = JSON.parse(deviceListing) as { devices: Record<string, { udid: string; state: string }[]> };
    if (
      Object.values(listing.devices)
        .flat()
        .find((device) => device.udid === udid)?.state !== 'Booted'
    )
      simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b']);
    simctl(['install', udid, appPath]);
    const installedPath = simctl(['get_app_container', udid, identity.bundleIdentifier, 'app']);
    assertMatchingIdentity(identity, readAppIdentity(installedPath, options.configuration));
    if (options.configuration === 'Debug') {
      await assertFreePort(options.port);
      const log = openSync(join(options.runDir, 'metro.log'), 'w');
      try {
        metro = spawn(
          'vp',
          [
            'exec',
            'tsx',
            join(ROOT, 'scripts/mobile-dev-start.ts'),
            '--host',
            'localhost',
            '--port',
            String(options.port),
          ],
          {
            cwd: checkout,
            env,
            stdio: ['ignore', log, log],
            detached: true,
          },
        );
      } finally {
        closeSync(log);
      }
      manifest.ownedPids = [metro.pid];
      save();
      await waitForOwnedMetro(options.port, checkout, metro);
    }
    manifest.status = 'capturing';
    save();
    run(
      'vp',
      [
        'exec',
        'tsx',
        join(ROOT, 'scripts/mobile-profile-capture.ts'),
        '--run-dir',
        options.runDir,
        '--udid',
        udid,
        '--app-id',
        identity.bundleIdentifier,
        '--configuration',
        options.configuration,
        '--port',
        String(options.port),
        '--app-path',
        appPath,
      ],
      checkout,
      env,
    );
    assertMatchingIdentity(
      identity,
      readAppIdentity(simctl(['get_app_container', udid, identity.bundleIdentifier, 'app']), options.configuration),
    );
    validateCaptureFiles(
      JSON.parse(readFileSync(join(options.runDir, 'measurements.json'), 'utf8')) as unknown,
      JSON.parse(readFileSync(join(options.runDir, 'capture-validity.json'), 'utf8')) as unknown,
    );
    manifest.status = 'complete';
    return 0;
  } catch (error) {
    manifest.status = 'invalid';
    manifest.failure = error instanceof Error ? error.message : String(error);
    console.error(manifest.failure);
    return 1;
  } finally {
    if (metro?.pid && metro.exitCode === null && metro.signalCode === null) {
      try {
        process.kill(-metro.pid, 'SIGTERM');
      } catch {
        /* Owned process already exited. */
      }
    }
    lease.release();
    manifest.finishedAt = new Date().toISOString();
    save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
