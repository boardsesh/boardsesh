/// <reference types="node" />
/** Temporary QA experiment. Never imported by production capture and never starts a session. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { guardSimulatorCommand } from './lib/ios-simulator-lease';
import { CriticalChildProcessGroup, criticalChildProcessSpawnOptions } from './lib/dev-child-process-lifecycle';
import {
  parseDarwinMemoryPressure,
  parseDarwinSwapUsage,
  parseDarwinVmStat,
  topResidentProcesses,
} from './store-video-measure';
import { countHomeReady } from './lib/showcase-video/record';
import {
  classifyAttempt,
  inspectVisibility,
  mayAttemptFreshLaunch,
  objectRecord,
  redactedTrace,
  singleTapFlow,
} from './lib/session-input-observation/guards';
import { applyObservationWrapper } from './lib/session-input-observation/wrapper';
import { startObservationProxy } from './lib/session-input-observation/proxy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.boardsesh/session-input-observation');
const PRIVATE = join(DIRECTORY, 'private');
const PUBLIC = join(DIRECTORY, 'public');
const BASE = '6e8c46f203385c6587dcf2669e29df1c9d611cf8';
const CACHE_KEY = 'macOS-ARM64-screenshot-sim-app-v1-9dd78a74eb71965f2e0876a147045ef8207d824eb936ee349170ddcd54a8082a';
const APP = join(ROOT, 'packages/mobile/.app-cache/Boardsesh.app');
const METRO_LOG = join(ROOT, '.boardsesh/mobile-metro.log');
const CONTROLLER = new AbortController();
const children = new Set<ChildProcess>();
const publicReport: Record<string, unknown> = {
  kind: 'observation-only-not-capture-proof',
  baseSha: BASE,
  attempts: [],
  confounds: [
    'one-primary-one-metro-one-worker-reduced-load',
    'live-read-proxy-blocks-application-writes',
    'no-secondary',
    'observation-logs-affect-timing',
  ],
};
let ownedUdid: string | null = null;
let proxy: Awaited<ReturnType<typeof startObservationProxy>> | null = null;
let activeAttempt = 0;
const snapshots: Record<string, unknown>[] = [];
class ObservationFailure extends Error {}
function fail(code: string): never {
  throw new ObservationFailure(code);
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function writePublic(name: string, payload: unknown): void {
  writeFileSync(join(PUBLIC, name), JSON.stringify(payload, null, 2) + '\n');
}
function sensor(command: string, args: string[], timeout = 1000): string | null {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  return result.status === 0 ? result.stdout : null;
}
function memorySnapshot(phase: 'before' | 'after') {
  const startedAt = new Date().toISOString();
  const processes = sensor('ps', ['-axo', 'pid=,ppid=,rss=,comm='], 2000);
  const vm = sensor('vm_stat', []),
    swap = sensor('sysctl', ['vm.swapusage']),
    pressure = sensor('memory_pressure', ['-Q']);
  const simulatorList = sensor('xcrun', ['simctl', 'list', 'devices', '--json'], 2000);
  let booted: string[] | null = null;
  try {
    const listing = JSON.parse(simulatorList ?? '{}') as {
      devices?: Record<string, { udid: string; state: string }[]>;
    };
    booted = Object.values(listing.devices ?? {})
      .flat()
      .filter((device) => device.state === 'Booted')
      .map((device) => device.udid);
  } catch {
    /* nullable unsupported sensor */
  }
  const snapshot = {
    attempt: activeAttempt,
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    totalMiB: totalmem() / 1024 ** 2,
    nonFreeMiB: (totalmem() - freemem()) / 1024 ** 2,
    vm: vm ? parseDarwinVmStat(vm) : null,
    swap: swap ? parseDarwinSwapUsage(swap) : null,
    pressureFreePercent: pressure ? parseDarwinMemoryPressure(pressure) : null,
    topProcesses: processes ? topResidentProcesses(processes) : null,
    topology: { primarySimulators: 1, metros: 1, metroWorkers: 1, secondary: false, bootedUdid: booted },
  };
  snapshots.push(snapshot);
  writePublic('memory.json', snapshots);
  return snapshot;
}
async function command(
  label: string,
  executable: string,
  args: string[],
  timeoutMs = 30_000,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (CONTROLLER.signal.aborted) fail('observation_deadline');
  guardSimulatorCommand(basename(executable) === 'maestro' ? 'maestro' : executable, args, ROOT);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(executable, args, {
    cwd: ROOT,
    env: environment,
    ...criticalChildProcessSpawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '',
    stderr = '';
  const outputFile = join(PRIVATE, `${label}.log`);
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString();
    appendFileSync(outputFile, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 4 * 1024 * 1024) stderr += chunk.toString();
    appendFileSync(outputFile, chunk);
  });
  let abortKill: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    abortKill ??= setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 2000);
  };
  const timer = setTimeout(stop, timeoutMs);
  const hardTimer = setTimeout(() => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, timeoutMs + 2000);
  CONTROLLER.signal.addEventListener('abort', stop, { once: true });
  try {
    const status = await new Promise<number>((resolveStatus) => {
      child.once('error', () => resolveStatus(-1));
      child.once('exit', (code) => resolveStatus(code ?? -1));
    });
    return {
      status,
      stdout,
      stderr,
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedSeconds: (Date.now() - started) / 1000,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    clearTimeout(abortKill);
    CONTROLLER.signal.removeEventListener('abort', stop);
    children.delete(child);
  }
}
async function checked(
  label: string,
  executable: string,
  args: string[],
  timeoutMs = 30_000,
  environment?: NodeJS.ProcessEnv,
) {
  const result = await command(label, executable, args, timeoutMs, environment);
  if (result.status !== 0) fail(`${label}_command_failed`);
  return result;
}
function privateFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? privateFiles(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
function nativeEvidence(since: string) {
  const logs = privateFiles(PRIVATE).filter(
    (path) =>
      basename(path).startsWith('xctest_runner') &&
      path.endsWith('.log') &&
      statSync(path).mtimeMs >= Date.parse(since),
  );
  const text = logs
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => {
      const timestamp = line.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\.(\d+)([+-]\d{4})/);
      return (
        timestamp &&
        Date.parse(`${timestamp[1]}T${timestamp[2]}.${timestamp[3].slice(0, 3)}${timestamp[4]}`) >= Date.parse(since)
      );
    })
    .join('\n');
  const foreground =
    [...text.matchAll(/\[Start\] View hierarchy snapshot for Application '([^']+)'/g)].at(-1)?.[1] ?? null;
  const points = [...text.matchAll(/^(\S+ \S+).*Tapping (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)/gm)].map((match) => ({
    nativeTimestamp: match[1],
    x: Number(match[2]),
    y: Number(match[3]),
  }));
  const synthesisElapsedSeconds = [...text.matchAll(/Tapping took (\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  return {
    foregroundBundle: foreground === 'com.boardsesh.app' ? foreground : 'unverified-or-other',
    points,
    synthesisElapsedSeconds,
    configuredPointerContactSeconds: 0.1,
    measuredPointerContactSeconds: null,
    source: 'Maestro cli-2.6.1 EventRecord.defaultTapDuration; request elapsed is separate',
  };
}
function maestroEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JAVA_OPTS: `-Duser.home=${join(PRIVATE, 'maestro-home')}`,
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_DRIVER_STARTUP_TIMEOUT: '300000',
  };
}
async function maestro(label: string, args: string[], timeout = 300_000) {
  if (!ownedUdid) fail('missing_owned_udid');
  return command(label, 'maestro', ['--device', ownedUdid, ...args], timeout, maestroEnvironment());
}
async function captureHierarchy(label: string, requireOn: boolean) {
  const result = await maestro(label, ['hierarchy']);
  if (result.status !== 0) fail(`${label}_failed`);
  const evidence = nativeEvidence(result.startedAt);
  if (evidence.foregroundBundle !== 'com.boardsesh.app') fail('foreground_bundle_unverified');
  const start = result.stdout.indexOf('{');
  let hierarchy: unknown;
  try {
    hierarchy = JSON.parse(result.stdout.slice(start));
  } catch {
    fail('hierarchy_invalid_json');
  }
  const visibility = inspectVisibility(hierarchy, requireOn);
  if (!visibility.screenBounds || visibility.screenBounds.right < 300 || visibility.screenBounds.bottom < 600)
    fail('screen_bounds_unverified');
  return { ...visibility, foregroundBundle: evidence.foregroundBundle, observedAt: result.completedAt };
}
async function redactedScreenshot(label: string, visibility: Awaited<ReturnType<typeof captureHierarchy>>) {
  const raw = join(PRIVATE, `${label}.png`);
  await checked(label, 'xcrun', ['simctl', 'io', ownedUdid!, 'screenshot', raw], 15_000);
  const image = sharp(raw);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !visibility.screenBounds) fail('screenshot_dimensions_missing');
  const screen = visibility.screenBounds;
  const left = Math.max(0, visibility.parentBounds.left - 16),
    top = Math.max(0, visibility.parentBounds.top - 8);
  const right = Math.min(screen.right, Math.max(visibility.parentBounds.right, visibility.thumbBounds.right) + 16),
    bottom = Math.min(screen.bottom, Math.max(visibility.parentBounds.bottom, visibility.thumbBounds.bottom) + 8);
  const rectangle = {
    left: Math.floor((left * metadata.width) / screen.right),
    top: Math.floor((top * metadata.height) / screen.bottom),
    width: Math.ceil(((right - left) * metadata.width) / screen.right),
    height: Math.ceil(((bottom - top) * metadata.height) / screen.bottom),
  };
  const cropped = await sharp(raw).extract(rectangle).png().toBuffer();
  await sharp({ create: { width: metadata.width, height: metadata.height, channels: 3, background: '#000000' } })
    .composite([{ input: cropped, left: rectangle.left, top: rectangle.top }])
    .png()
    .toFile(join(PUBLIC, `${label}.png`));
  return rectangle;
}
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !CONTROLLER.signal.aborted) {
    if (await predicate()) return;
    await sleep(1000, undefined, { signal: CONTROLLER.signal });
  }
  fail('readiness_timeout');
}
async function main(): Promise<number> {
  mkdirSync(PRIVATE, { recursive: true });
  mkdirSync(PUBLIC, { recursive: true });
  if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.SESSION_INPUT_OBSERVATION !== '1')
    fail('ci_observation_only');
  if (
    process.env.OBSERVATION_CACHE_HIT !== 'true' ||
    process.env.OBSERVATION_CACHE_KEY !== CACHE_KEY ||
    !existsSync(APP)
  )
    fail('exact_native_cache_required_no_build');
  if (!process.env.SCREENSHOT_USER_EMAIL || !process.env.SCREENSHOT_USER_PASSWORD)
    fail('live_account_credentials_missing');
  const deadline = setTimeout(() => CONTROLLER.abort(), 23 * 60_000);
  const interrupted = () => CONTROLLER.abort();
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const servers = new CriticalChildProcessGroup({
    onUnexpectedTermination: () => CONTROLLER.abort(),
    gracePeriodMs: 2000,
  });
  try {
    await checked('base-ancestor', 'git', ['merge-base', '--is-ancestor', BASE, 'HEAD']);
    const source = (await checked('source', 'git', ['rev-parse', 'HEAD'])).stdout.trim();
    const diff = (await checked('reviewed-diff', 'git', ['diff', '--no-ext-diff', BASE, 'HEAD'], 30_000)).stdout;
    writeFileSync(join(PUBLIC, 'reviewed-diagnostic.diff'), diff);
    const launcher = (
      await checked('launcher', 'plutil', [
        '-extract',
        'DEV_CLIENT_DEFAULT_LAUNCHER_URL',
        'raw',
        '-o',
        '-',
        join(APP, 'Info.plist'),
      ])
    ).stdout.trim();
    const metroUrl = new URL(launcher);
    if (
      metroUrl.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(metroUrl.hostname) ||
      !/^\d+$/.test(metroUrl.port)
    )
      fail('cached_launcher_not_loopback');
    const hashes = Object.fromEntries(
      ['Boardsesh', 'Boardsesh.debug.dylib', 'Info.plist']
        .filter((name) => existsSync(join(APP, name)))
        .map((name) => [name, hash(readFileSync(join(APP, name)))]),
    );
    const sdk = (await checked('app-metadata', 'plutil', ['-convert', 'json', '-o', '-', join(APP, 'Info.plist')]))
      .stdout;
    const metadata = objectRecord(JSON.parse(sdk)) ?? {};
    const runtime = (await checked('runtime', 'xcrun', ['simctl', 'list', 'runtimes', '--json'])).stdout;
    const version = await checked('maestro-version', 'maestro', ['--version'], 30_000, maestroEnvironment());
    if (version.stdout.trim().split('\n').at(-1)?.trim() !== '2.6.1') fail('maestro_version_mismatch');
    const wrapper = JSON.parse(
      readFileSync(join(ROOT, 'scripts/fixtures/session-input-observation/toggle-wrapper.json'), 'utf8'),
    ) as Record<string, { before: string; after: string }>;
    const wrapperHashes = applyObservationWrapper(ROOT, wrapper);
    writePublic('input-manifest.json', {
      source,
      base: BASE,
      cacheHit: true,
      cacheKey: CACHE_KEY,
      nativeHashes: hashes,
      sdk: Object.fromEntries(
        [
          'CFBundleIdentifier',
          'CFBundleVersion',
          'CFBundleShortVersionString',
          'DTSDKName',
          'DTXcodeBuild',
          'MinimumOSVersion',
        ].map((key) => [key, metadata[key]]),
      ),
      runtimes: JSON.parse(runtime).runtimes.map(
        (entry: { identifier: string; version: string; buildversion: string; isAvailable: boolean }) => ({
          identifier: entry.identifier,
          version: entry.version,
          build: entry.buildversion,
          available: entry.isAvailable,
        }),
      ),
      maestroVersion: '2.6.1',
      wrapperHashes,
      diffSha256: hash(diff),
      topology: { primarySimulators: 1, metros: 1, metroWorkers: 1 },
      confounds: publicReport.confounds,
    });
    proxy = await startObservationProxy(memorySnapshot);
    writeFileSync(
      join(ROOT, '.boardsesh/qa-notes.md'),
      '1. Open Session; the visibility switch starts ON.\n2. Tap the thumb; the invite-only subtitle should appear.\n3. Leave without pressing Start.\n',
    );
    const environment = {
      ...process.env,
      EXPO_NO_DOTENV: '1',
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8119',
      EXPO_PUBLIC_WS_URL: 'ws://127.0.0.1:8119/graphql',
      EXPO_PUBLIC_WEB_URL: 'http://127.0.0.1:8119',
      EXPO_PUBLIC_SCREENSHOT_MODE: '1',
      EXPO_PUBLIC_SCREENSHOT_FAKE_BLE: '1',
      EXPO_PUBLIC_SCREENSHOT_THEME: 'dark',
      EXPO_PUBLIC_SCREENSHOT_LOCALE: 'en-US',
      EXPO_PUBLIC_SCREENSHOT_USER_EMAIL: process.env.SCREENSHOT_USER_EMAIL,
      EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD: process.env.SCREENSHOT_USER_PASSWORD,
      EXPO_PUBLIC_NATIVE_INPUT_TRACE: '1',
    };
    const metro = spawn(
      'vp',
      ['run', 'dev:mobile', '--', '--port', metroUrl.port, '--host', 'localhost', '--max-workers', '1'],
      { cwd: ROOT, env: environment, ...criticalChildProcessSpawnOptions, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    servers.register('owned-observation-metro', metro);
    for (const stream of [metro.stdout, metro.stderr])
      stream.on('data', (chunk: Buffer) => appendFileSync(join(PRIVATE, 'metro-launch.log'), chunk));
    await waitFor(async () => {
      try {
        return (await fetch(`${metroUrl.origin}/status`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    }, 90_000);
    const manifest = (await fetch(metroUrl.origin, {
      headers: { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' },
      signal: AbortSignal.timeout(30_000),
    }).then((response) => response.json())) as { launchAsset?: { url?: string } };
    const bundle = new URL(manifest.launchAsset?.url ?? '');
    if (bundle.origin !== metroUrl.origin) fail('bundle_origin_changed');
    const bundleResponse = await fetch(bundle, { signal: AbortSignal.timeout(300_000) });
    if (!bundleResponse.ok) fail('prewarm_failed');
    for await (const _chunk of bundleResponse.body!) {
      /* drain without retaining secret-bearing bundle */
    }
    const initialDevices = JSON.parse(
      (await checked('initial-devices', 'xcrun', ['simctl', 'list', 'devices', '--json'])).stdout,
    ) as { devices: Record<string, { state: string }[]> };
    if (
      Object.values(initialDevices.devices)
        .flat()
        .some((device) => device.state === 'Booted')
    )
      fail('unexpected_existing_booted_simulator');
    ownedUdid = (
      await checked('create', 'xcrun', [
        'simctl',
        'create',
        `BoardseshInputObservation-${process.env.GITHUB_RUN_ID}`,
        'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max',
        'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      ])
    ).stdout.trim();
    process.env.BOARDSESH_IOS_SIMULATOR_UDID = ownedUdid;
    await checked('boot', 'xcrun', ['simctl', 'boot', ownedUdid]);
    await checked('bootstatus', 'xcrun', ['simctl', 'bootstatus', ownedUdid, '-b'], 180_000);
    await checked('install', 'xcrun', ['simctl', 'install', ownedUdid, APP], 60_000);
    for (activeAttempt = 1; activeAttempt <= 2; activeAttempt++) {
      if (activeAttempt > 1)
        await checked('fresh-terminate', 'xcrun', ['simctl', 'terminate', ownedUdid, 'com.boardsesh.app']);
      const logOffset = existsSync(METRO_LOG) ? statSync(METRO_LOG).size : 0;
      await checked(`launch-${activeAttempt}`, 'xcrun', ['simctl', 'launch', ownedUdid, 'com.boardsesh.app']);
      await waitFor(
        async () =>
          existsSync(METRO_LOG) && countHomeReady(readFileSync(METRO_LOG).subarray(logOffset).toString('utf8')) > 0,
        240_000,
      );
      const prime = join(PRIVATE, `prime-${activeAttempt}.yaml`);
      writeFileSync(
        prime,
        'appId: com.boardsesh.app\n---\n- openLink: com.boardsesh.app://home\n- tapOn:\n    text: Open\n    optional: true\n- openLink: com.boardsesh.app://climbs?screenshotOpenFirst=1&screenshotBoardIndex=0\n- waitForAnimationToEnd\n- openLink: com.boardsesh.app://home\n- openLink: com.boardsesh.app://record\n- waitForAnimationToEnd\n',
      );
      const primeResult = await maestro(`prime-${activeAttempt}`, [
        'test',
        '--debug-output',
        join(PRIVATE, `prime-${activeAttempt}`),
        prime,
      ]);
      if (primeResult.status !== 0) fail('prime_failed');
      const before = await captureHierarchy(`before-${activeAttempt}`, true);
      const mask = await redactedScreenshot(`before-${activeAttempt}`, before);
      writePublic(`before-${activeAttempt}.json`, { ...before, screenshotMask: mask });
      const tapFlow = join(PRIVATE, `tap-${activeAttempt}.yaml`);
      writeFileSync(tapFlow, singleTapFlow(before.point));
      const traceOffset = statSync(METRO_LOG).size;
      const tapResult = await maestro(`tap-${activeAttempt}`, [
        'test',
        '--debug-output',
        join(PRIVATE, `tap-${activeAttempt}`),
        tapFlow,
      ]);
      const evidence = nativeEvidence(tapResult.startedAt);
      await sleep(10_000, undefined, { signal: CONTROLLER.signal });
      const traces = readFileSync(METRO_LOG)
        .subarray(traceOffset)
        .toString('utf8')
        .split('\n')
        .flatMap((line) => {
          const trace = redactedTrace(line);
          return trace ? [trace] : [];
        });
      writePublic(`traces-${activeAttempt}.json`, traces);
      let after: Awaited<ReturnType<typeof captureHierarchy>> | null = null;
      let offConfirmed = false;
      try {
        after = await captureHierarchy(`after-${activeAttempt}`, false);
        offConfirmed = true;
      } catch {
        try {
          after = await captureHierarchy(`after-on-${activeAttempt}`, true);
        } catch {
          /* preserve the failed callback boundary even if the native row disappeared */
        }
      }
      let postScreenshot = 'omitted_unverified_control';
      if (after) {
        writePublic(`after-${activeAttempt}.json`, after);
        try {
          await redactedScreenshot(`after-${activeAttempt}`, after);
          postScreenshot = 'retained_redacted';
        } catch {
          postScreenshot = 'bounded_capture_failed';
        }
      }
      const validTap =
        evidence.points.length === 1 &&
        evidence.points[0].x === before.point.x &&
        evidence.points[0].y === before.point.y;
      const completeHooks = ['before', 'after'].every(
        (phase) =>
          snapshots.filter((snapshot) => snapshot.attempt === activeAttempt && snapshot.phase === phase).length === 1,
      );
      const result = validTap
        ? classifyAttempt(traces, offConfirmed)
        : { reproduced: false, boundary: 'input_delivery_unverified' };
      const attempt = {
        attempt: activeAttempt,
        ...result,
        tapCommandStatus: tapResult.status,
        commandElapsedSeconds: tapResult.elapsedSeconds,
        native: evidence,
        configuredPoint: before.point,
        observedForSeconds: 10,
        offConfirmed,
        validTap,
        completeHooks,
        postScreenshot,
      };
      (publicReport.attempts as unknown[]).push(attempt);
      writePublic('result.json', publicReport);
      if (
        !mayAttemptFreshLaunch({
          attempt: activeAttempt,
          reproduced: result.reproduced,
          validTap,
          completeHooks,
          offConfirmed,
          commandStatus: tapResult.status,
        })
      )
        break;
    }
    if (Object.entries(hashes).some(([name, digest]) => hash(readFileSync(join(APP, name))) !== digest))
      fail('cached_native_app_changed');
    publicReport.status = 'observation_completed';
    publicReport.reproduced = (publicReport.attempts as { reproduced: boolean }[]).some(
      (attempt) => attempt.reproduced,
    );
    return 0;
  } catch (error) {
    publicReport.status = 'observation_failed';
    publicReport.failure = error instanceof ObservationFailure ? error.message : 'unexpected_error_redacted';
    return 1;
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    // Cleanup uses its own deadlines even when the observation deadline fired.
    const cleanup: Record<string, unknown> = {};
    if (ownedUdid)
      for (const [name, args] of [
        ['terminate', ['simctl', 'terminate', ownedUdid, 'com.boardsesh.app']],
        ['shutdown', ['simctl', 'shutdown', ownedUdid]],
      ] as const) {
        try {
          guardSimulatorCommand('xcrun', args, ROOT);
          cleanup[name] = spawnSync('xcrun', [...args], {
            timeout: 15_000,
            killSignal: 'SIGKILL',
            stdio: 'ignore',
          }).status;
        } catch {
          cleanup[name] = 'failed_or_refused';
        }
      }
    for (const child of children)
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    try {
      await servers.terminate();
    } catch {
      cleanup.metro = 'failed';
    }
    try {
      await proxy?.close();
    } catch {
      cleanup.proxy = 'failed';
    }
    try {
      if (existsSync(METRO_LOG))
        writePublic(
          'traces-all.json',
          readFileSync(METRO_LOG, 'utf8')
            .split('\n')
            .flatMap((line) => {
              const trace = redactedTrace(line);
              return trace ? [trace] : [];
            }),
        );
    } catch {
      cleanup.traceHarvest = 'failed';
    }
    publicReport.cleanup = cleanup;
    publicReport.cleanupFailed = Object.values(cleanup).some((result) => result !== 0);
    publicReport.proxy = proxy?.counters;
    publicReport.snapshots = snapshots.length;
    publicReport.ownedUdid = ownedUdid;
    writePublic('result.json', publicReport);
    console.log(
      JSON.stringify({
        kind: 'session-input-observation',
        status: publicReport.status,
        attempts: (publicReport.attempts as unknown[]).length,
      }),
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .then((status) => {
      process.exitCode = publicReport.cleanupFailed === true ? 1 : status;
    })
    .catch(() => {
      console.error('observation_setup_failed_redacted');
      process.exitCode = 1;
    });
