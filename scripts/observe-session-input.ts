/// <reference types="node" />
/** Temporary QA experiment. Never imported by production capture and never starts a session. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { guardSimulatorCommand } from './lib/ios-simulator-lease';
import { CriticalChildProcessGroup, criticalChildProcessSpawnOptions } from './lib/dev-child-process-lifecycle';
import { observationMemorySnapshot } from './lib/session-input-observation/sensors';
import {
  commandOutcome,
  commandReceipt,
  deadlineFlags,
  firstAbortRecorder,
  firstFailureRecorder,
  observedErrno,
  waitForCommandSettlement,
  type AbortSource,
  type CommandReceipt,
} from './lib/session-input-observation/commands';
import { startInputObservationChannel } from './lib/session-input-observation/channel';
import {
  assertOriginalCachedIdentity,
  assertObservationViewport,
  classifyAttempt,
  inspectVisibility,
  mayAttemptFreshLaunch,
  objectRecord,
  singleTapFlow,
} from './lib/session-input-observation/guards';
import { applyObservationWrapper } from './lib/session-input-observation/wrapper';
import { startPinnedObservationReplay } from './lib/session-input-observation/replay';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, '.boardsesh/session-input-observation');
const PRIVATE = join(DIRECTORY, 'private');
const PUBLIC = join(DIRECTORY, 'public');
const BASE = '6e8c46f203385c6587dcf2669e29df1c9d611cf8';
const CACHE_KEY = 'macOS-ARM64-screenshot-sim-app-v1-9dd78a74eb71965f2e0876a147045ef8207d824eb936ee349170ddcd54a8082a';
const APP = join(ROOT, 'packages/mobile/.app-cache/Boardsesh.app');
const CONTROLLER = new AbortController();
const children = new Set<ChildProcess>();
const aborts = firstAbortRecorder();
const failures = firstFailureRecorder();
const receipts: CommandReceipt[] = [];
let ownedMetro: ChildProcess | null = null;
function abortObservation(source: AbortSource, child?: Parameters<typeof aborts.record>[1]) {
  aborts.record(source, child);
  CONTROLLER.abort();
}
function retainReceipt(receipt: CommandReceipt) {
  receipts.push(receipt);
  try {
    writePublic('command-receipts.json', receipts);
  } catch {
    publicReport.commandReceiptWriteFailed = true;
  }
}
function passiveMetro() {
  return ownedMetro
    ? { pid: ownedMetro.pid ?? null, exitCode: ownedMetro.exitCode, signal: ownedMetro.signalCode }
    : null;
}
const publicReport: Record<string, unknown> = {
  kind: 'observation-only-not-capture-proof',
  baseSha: BASE,
  attempts: [],
  confounds: [
    'one-primary-one-metro-one-worker-reduced-load',
    'pinned-replay-account-backend-differ-from-failed-live-crew-run',
    'pinned-clock-and-prime-match-successful-local-control',
    'no-secondary',
    'observation-logs-affect-timing',
  ],
};
let ownedUdid: string | null = null;
let replay: Awaited<ReturnType<typeof startPinnedObservationReplay>> | null = null;
let channel: Awaited<ReturnType<typeof startInputObservationChannel>> | undefined;
let activeAttempt = 0;
const snapshots: Record<string, unknown>[] = [];
class ObservationFailure extends Error {}
function fail(code: string, receipt?: CommandReceipt): never {
  if (receipt) failures.freeze(code, receipt);
  throw new ObservationFailure(code);
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function writePublic(name: string, payload: unknown): void {
  writeFileSync(join(PUBLIC, name), JSON.stringify(payload, null, 2) + '\n');
}
async function memorySnapshot(phase: 'initial' | 'failure' | 'before' | 'after') {
  const snapshot = await observationMemorySnapshot(phase, activeAttempt);
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
  const started = performance.now();
  const flags = deadlineFlags();
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
      flags.stopEscalationFired = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 2000);
  };
  const timer = setTimeout(() => {
    flags.timeoutFired = true;
    stop();
  }, timeoutMs);
  const hardTimer = setTimeout(() => {
    flags.hardTimeoutFired = true;
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
    const outcome = await waitForCommandSettlement(child);
    const completedAt = new Date().toISOString();
    const elapsedSeconds = (performance.now() - started) / 1000;
    const receipt = commandReceipt({
      label,
      executable,
      operation: args[0] === 'simctl' ? args[1] : null,
      ownedUdid,
      startedAt,
      completedAt,
      elapsedSeconds,
      timeoutMs,
      outcome,
      flags,
      abort: aborts.current(),
      controllerAborted: CONTROLLER.signal.aborted,
      stdout,
      stderr,
      metro: passiveMetro(),
    });
    retainReceipt(receipt);
    return { status: outcome.status, stdout, stderr, startedAt, completedAt, elapsedSeconds, receipt };
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
  if (result.status !== 0) fail(`${label}_command_failed`, result.receipt);
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
  let visibility: ReturnType<typeof inspectVisibility>;
  try {
    visibility = inspectVisibility(hierarchy, requireOn);
  } catch {
    fail('visibility_geometry_unverified');
  }
  if (!visibility.screenBounds || visibility.screenBounds.right < 300 || visibility.screenBounds.bottom < 600)
    fail('screen_bounds_unverified');
  return { ...visibility, foregroundBundle: evidence.foregroundBundle, observedAt: result.completedAt };
}
async function redactedScreenshot(label: string, visibility: Awaited<ReturnType<typeof captureHierarchy>>) {
  const raw = join(PRIVATE, `${label}.png`);
  const capture = await checked(label, 'xcrun', ['simctl', 'io', ownedUdid!, 'screenshot', raw], 15_000);
  const image = sharp(raw);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) fail('screenshot_dimensions_missing');
  let viewport: ReturnType<typeof assertObservationViewport>;
  try {
    viewport = assertObservationViewport({
      pixelWidth: metadata.width,
      pixelHeight: metadata.height,
      screenBounds: visibility.screenBounds,
      foregroundBundle: visibility.foregroundBundle,
      ownedUdid,
    });
  } catch {
    fail('portrait_viewport_unverified');
  }
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
  return {
    rectangle,
    viewport: {
      ...viewport,
      ownedUdid,
      foregroundObservedAt: visibility.observedAt,
      pngCapturedAt: capture.completedAt,
    },
  };
}
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, failure = 'readiness_timeout') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !CONTROLLER.signal.aborted) {
    if (await predicate()) return;
    await sleep(1000, undefined, { signal: CONTROLLER.signal });
  }
  fail(failure);
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
  const deadline = setTimeout(() => abortObservation('observation_deadline'), 23 * 60_000);
  const interruptedInt = () => abortObservation('SIGINT');
  const interruptedTerm = () => abortObservation('SIGTERM');
  process.once('SIGINT', interruptedInt);
  process.once('SIGTERM', interruptedTerm);
  const servers = new CriticalChildProcessGroup({
    onUnexpectedTermination: (termination) => abortObservation('critical_server_exit', termination),
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
    try {
      assertOriginalCachedIdentity(hashes, metadata, process.arch);
    } catch {
      fail('original_native_identity_unverified');
    }
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
    channel = await startInputObservationChannel();
    replay = await startPinnedObservationReplay(
      join(PRIVATE, 'replay.log'),
      join(PRIVATE, 'fixtures'),
      async (phase) => {
        const snapshot = await memorySnapshot(phase);
        if (phase === 'before') {
          const challenge = `contact-${activeAttempt}`;
          channel!.beginContact(challenge);
          await waitFor(async () => channel!.contactAcknowledged(challenge), 5000, 'trace_transport_unverified');
          channel!.releaseContact(challenge);
        }
        return snapshot;
      },
    );
    writePublic('fixture-manifest.json', {
      reference: replay.reference,
      frozenNow: replay.frozenNow,
      account: 'synthetic-pinned-fixture-account',
      matchesLocalBaseline: true,
      mode: 'replay',
      upstream: null,
      backendStats: replay.stats(),
    });
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
      EXPO_PUBLIC_SCREENSHOT_USER_EMAIL: 'test@boardsesh.com',
      EXPO_PUBLIC_SCREENSHOT_USER_PASSWORD: 'test',
      EXPO_PUBLIC_SCREENSHOT_NOW: replay.frozenNow,
      EXPO_PUBLIC_NATIVE_INPUT_TRACE: '1',
      EXPO_PUBLIC_NATIVE_INPUT_TRACE_URL: channel.traceUrl,
      EXPO_PUBLIC_SCREENSHOT_READY_URL: channel.readinessUrl,
    };
    const metro = spawn(
      'vp',
      ['run', 'dev:mobile', '--', '--port', metroUrl.port, '--host', 'localhost', '--max-workers', '1'],
      { cwd: ROOT, env: environment, ...criticalChildProcessSpawnOptions, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    ownedMetro = metro;
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
    if (
      bundle.protocol !== 'http:' ||
      !['localhost', '127.0.0.1'].includes(bundle.hostname) ||
      bundle.port !== metroUrl.port
    )
      fail('bundle_origin_changed');
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
      channel.beginLaunch();
      await memorySnapshot('initial');
      publicReport.phase = `launch-${activeAttempt}`;
      await checked(`launch-${activeAttempt}`, 'xcrun', ['simctl', 'launch', ownedUdid, 'com.boardsesh.app']);
      await waitFor(async () => channel!.homeReady(), 240_000, 'direct_home_readiness_unverified');
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
      await waitFor(
        async () => {
          try {
            channel!.baseline();
            return true;
          } catch {
            return false;
          }
        },
        15_000,
        'trace_transport_unverified',
      );
      channel.requestAcknowledgement(`baseline-${activeAttempt}`);
      await waitFor(async () => channel!.acknowledged(`baseline-${activeAttempt}`), 5000, 'trace_transport_unverified');
      const traceBaseline = channel.freezeBaseline(`baseline-${activeAttempt}`);
      writePublic(`trace-baseline-${activeAttempt}.json`, traceBaseline);
      const before = await captureHierarchy(`before-${activeAttempt}`, true);
      const mask = await redactedScreenshot(`before-${activeAttempt}`, before);
      writePublic(`before-${activeAttempt}.json`, {
        ...before,
        screenshotMask: mask.rectangle,
        viewport: mask.viewport,
      });
      const tapFlow = join(PRIVATE, `tap-${activeAttempt}.yaml`);
      writeFileSync(tapFlow, singleTapFlow(before.point));
      publicReport.phase = `contact-${activeAttempt}`;
      const tapResult = await maestro(`tap-${activeAttempt}`, [
        'test',
        '--debug-output',
        join(PRIVATE, `tap-${activeAttempt}`),
        tapFlow,
      ]);
      const evidence = nativeEvidence(tapResult.startedAt);
      await sleep(10_000, undefined, { signal: CONTROLLER.signal });
      let transportVerified = false;
      let traces: Record<string, unknown>[] = [];
      channel.closeWindow(`window-${activeAttempt}`);
      try {
        await waitFor(async () => channel!.acknowledged(`window-${activeAttempt}`), 5000, 'trace_transport_unverified');
        traces = channel.finishWindow(`window-${activeAttempt}`);
        transportVerified = true;
      } catch {
        /* Unverified transport never becomes a missing-application-event verdict. */
      }
      writePublic(`traces-${activeAttempt}.json`, traces);
      writePublic(`trace-channel-${activeAttempt}.json`, channel.snapshot());
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
      const result = !transportVerified
        ? { reproduced: false, boundary: 'trace_transport_unverified' }
        : validTap
          ? classifyAttempt(traces, offConfirmed, traceBaseline)
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
        transportVerified,
        postScreenshot,
      };
      (publicReport.attempts as unknown[]).push(attempt);
      writePublic('result.json', publicReport);
      if (
        !mayAttemptFreshLaunch({
          attempt: activeAttempt,
          reproduced: result.reproduced,
          validTap,
          completeHooks: completeHooks && transportVerified,
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
    const failure = failures.freeze(error instanceof ObservationFailure ? error.message : 'unexpected_error_redacted');
    publicReport.firstFailure = failure;
    try {
      writePublic('first-failure.json', failure);
    } catch {
      publicReport.commandReceiptWriteFailed = true;
    }
    try {
      await memorySnapshot('failure');
    } catch {
      publicReport.failurePressure = 'unavailable';
    }
    publicReport.status = 'observation_failed';
    publicReport.failure = error instanceof ObservationFailure ? error.message : 'unexpected_error_redacted';
    return 1;
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', interruptedInt);
    process.off('SIGTERM', interruptedTerm);
    // Cleanup uses its own deadlines even when the observation deadline fired.
    const cleanup: Record<string, unknown> = {};
    if (ownedUdid)
      for (const [name, args] of [
        ['terminate', ['simctl', 'terminate', ownedUdid, 'com.boardsesh.app']],
        ['shutdown', ['simctl', 'shutdown', ownedUdid]],
      ] as const) {
        const startedAt = new Date().toISOString();
        const started = performance.now();
        try {
          guardSimulatorCommand('xcrun', args, ROOT);
          const result = spawnSync('xcrun', [...args], {
            timeout: 15_000,
            killSignal: 'SIGKILL',
            stdio: 'ignore',
          });
          cleanup[name] = result.status;
          const receipt = commandReceipt({
            label: `cleanup-${name}`,
            executable: 'xcrun',
            operation: args[1],
            ownedUdid,
            startedAt,
            completedAt: new Date().toISOString(),
            elapsedSeconds: (performance.now() - started) / 1000,
            timeoutMs: 15_000,
            outcome: commandOutcome(result.status, result.signal, 'sync', result.error),
            flags: { ...deadlineFlags(), timeoutFired: observedErrno(result.error) === 'ETIMEDOUT' },
            abort: aborts.current(),
            controllerAborted: CONTROLLER.signal.aborted,
            stdout: '',
            stderr: '',
            metro: passiveMetro(),
          });
          retainReceipt(receipt);
          if (result.status !== 0) failures.freeze(`cleanup-${name}_command_failed`, receipt);
        } catch (error) {
          cleanup[name] = 'failed_or_refused';
          const receipt = commandReceipt({
            label: `cleanup-${name}`,
            executable: 'xcrun',
            operation: args[1],
            ownedUdid,
            startedAt,
            completedAt: new Date().toISOString(),
            elapsedSeconds: (performance.now() - started) / 1000,
            timeoutMs: 15_000,
            outcome: commandOutcome(null, null, 'caught', error),
            flags: deadlineFlags(),
            abort: aborts.current(),
            controllerAborted: CONTROLLER.signal.aborted,
            stdout: '',
            stderr: '',
            metro: passiveMetro(),
          });
          retainReceipt(receipt);
          failures.freeze(`cleanup-${name}_command_failed`, receipt);
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
      await replay?.close();
    } catch {
      cleanup.replay = 'failed';
    }
    try {
      if (channel) {
        writePublic('trace-channel-final.json', channel.snapshot());
        writePublic('traces-all.json', channel.allTraces());
      }
    } catch {
      cleanup.traceHarvest = 'failed';
    }
    try {
      await channel?.close();
    } catch {
      cleanup.traceChannel = 'failed';
    }
    publicReport.firstAbort = aborts.current();
    publicReport.firstFailure = failures.current();
    publicReport.passiveMetroChild = passiveMetro();
    publicReport.cleanup = cleanup;
    publicReport.cleanupFailed = Object.values(cleanup).some((result) => result !== 0);
    publicReport.replay = replay?.stats();
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
