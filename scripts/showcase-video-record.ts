/// <reference types="node" />

/**
 * Records every simulator take the homepage showcase video uses, with no manual
 * steps: `vp run video:record`. Runbook: docs/showcase-video.md.
 *
 *   vp run video:record                                  # every take, prod backend
 *   vp run video:record -- --only crew --backend local   # one take, seeded dev DB
 *   vp run video:record -- --dry-run                     # print the plan, touch nothing
 *
 * Flags: --only <take[,take]> (repeatable), --backend prod|local (default prod),
 * --app-path <Boardsesh.app>, --boards "<kilter>|<tension>|<moonboard>",
 * --env-file <path> (default ~/.config/boardsesh/showcase-secrets.env),
 * --keep-raw, --skip-anchor-check, --dry-run.
 *
 * Per take it relaunches the app, primes the take's deep links, starts
 * `simctl io recordVideo`, runs the take's Maestro flow while stamping the app's
 * `[showcase-anchor]` lines (Metro's output, tee'd to a log), stops the
 * recording with SIGINT, trims Maestro's attach time off the head, and writes
 * `work/footage/<take>/%05d.jpg` + `work/anchors/<take>.json`. It then checks
 * each take and fails naming the take and the fix. Everything it starts is torn
 * down on exit and on Ctrl-C, including the crew take's live session.
 *
 * The take registry (scripts/lib/showcase-video/takes.ts) and the flows in
 * packages/mobile/.maestro/showcase/ say what each take does; the pure logic
 * lives in scripts/lib/showcase-video/record.ts. macOS only.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { resolveMediaBinary } from './lib/help-clips';
import { guardSimulatorCommand } from './lib/ios-simulator-lease';
import { DEFAULT_SCREENSHOT_FIXTURES_DIR } from './lib/screenshot-fixtures';
import {
  SHOWCASE_ANCHORS_DIR,
  SHOWCASE_FOOTAGE_DIR,
  SHOWCASE_RAW_DIR,
  SHOWCASE_STAGE_DIR,
  SHOWCASE_TAKE_IDS,
  SHOWCASE_WORK_ROOT,
  type ShowcaseAnchorsFile,
  type ShowcaseTakeId,
} from './lib/showcase-video/contract';
import {
  FLOW_START_MARK,
  REFERENCE_CHANNEL_TOLERANCE,
  SHOWCASE_DEFAULT_BOARDS,
  SHOWCASE_DEVICES,
  anchorArrivalsFromChunk,
  buildAnchorsFile,
  buildFootageFrameArgs,
  checkTake,
  countHomeReady,
  differingPixelRatio,
  findBoardSlotProblem,
  isBlankFrame,
  isRecordingStartedLine,
  parseEnvFile,
  parseRecordArgs,
  parseSessionIdFromInviteUrl,
  parseSignalRequest,
  resolveTrimSeconds,
  sessionStarted,
  sessionVisibilityIsOff,
  type AnchorArrival,
  type ShowcaseBackend,
  type ShowcaseDevice,
  type ShowcaseRecordArgs,
} from './lib/showcase-video/record';
import {
  SHOWCASE_TAKES,
  assertShowcaseTakesComplete,
  showcaseFlowPath,
  type ShowcaseTake,
} from './lib/showcase-video/takes';
import {
  applyCleanStatusBar,
  bootDevice,
  buildScreenshotEnv,
  clearStatusBar,
  findOrCreateIosDevice,
  resolveAppPath,
  type DeviceInfo,
  type ScreenshotOptions,
} from './mobile-screenshots';

const LOG = '[video:record]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const BACKEND_DIR = resolve(ROOT_DIR, 'packages', 'backend');
const WORK_DIR = resolve(SHOWCASE_WORK_ROOT, 'work');
const LOG_DIR = resolve(WORK_DIR, 'logs');
const FLOW_SCRATCH_DIR = resolve(WORK_DIR, 'flows');
const SECONDARY_APP_DIR = resolve(WORK_DIR, 'secondary-app');
const SECONDARY_METRO_TMP = resolve(WORK_DIR, 'secondary-metro-tmp');
const REFERENCE_DIR = resolve(SHOWCASE_STAGE_DIR, 'reference');
const JDK_HOME = join(homedir(), '.cache', 'boardsesh', 'jdk-21');
const MAESTRO_BIN_DIR = join(homedir(), '.maestro', 'bin');

const APP_ID = 'com.boardsesh.app';
const APP_SCHEME = 'com.boardsesh.app';
// The cached dev-client bakes DEV_CLIENT_DEFAULT_LAUNCHER_URL=http://localhost:8081
// (packages/mobile/plugins/with-screenshot-dev-menu.js); the secondary gets a
// patched copy pointing at its own Metro.
const PRIMARY_METRO_PORT = 8081;
const SECONDARY_METRO_PORTS = [8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089] as const;
const LOCAL_BACKEND_PORTS = [8180, 8181, 8182, 8183, 8184, 8185] as const;
const SAFE_ROUTE = /^[A-Za-z0-9?=&_.:/%-]+$/;
const HOME_READY_TIMEOUT_MS = 180_000;

/** Local dev DB accounts. Prod credentials only ever come from the environment. */
const LOCAL_PRIMARY = { email: 'test@boardsesh.com', password: 'test' } as const;
const LOCAL_SECONDARY = { email: 'showcase-crew@fake.boardsesh.com', password: 'showcase-crew', name: 'Sam' } as const;
/** The only keys --env-file may set. A secrets file must not be able to redirect PATH. */
const ENV_FILE_KEYS = [
  'SCREENSHOT_USER_EMAIL',
  'SCREENSHOT_USER_PASSWORD',
  'SHOWCASE_SECONDARY_EMAIL',
  'SHOWCASE_SECONDARY_PASSWORD',
] as const;

type Credentials = Readonly<{ email: string; password: string }>;

// ---------------------------------------------------------------------------
// Process plumbing

type Cleanup = Readonly<{ label: string; run: () => Promise<void> | void }>;
const cleanups: Cleanup[] = [];
const liveChildren = new Set<ChildProcess>();
let tearingDown = false;

function onCleanup(label: string, run: () => Promise<void> | void): void {
  cleanups.push({ label, run });
}

async function teardown(): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  for (const child of liveChildren) {
    try {
      child.kill('SIGINT');
    } catch {
      // already gone
    }
  }
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (!cleanup) break;
    try {
      await cleanup.run();
    } catch (error) {
      console.warn(
        `${LOG} teardown: ${cleanup.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (existsSync(join(JDK_HOME, 'bin', 'java'))) env.JAVA_HOME = JDK_HOME;
  const extra = [env.JAVA_HOME ? join(env.JAVA_HOME, 'bin') : null, MAESTRO_BIN_DIR].filter(Boolean);
  env.PATH = [...extra, env.PATH ?? ''].join(':');
  return env;
}

function commandExists(command: string, env: NodeJS.ProcessEnv = toolEnv()): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`], { env, stdio: 'ignore' }).status === 0;
}

function simctl(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  guardSimulatorCommand('xcrun', ['simctl', ...args], ROOT_DIR);
  const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function portInUse(port: number): boolean {
  return spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Spawn in its own process group so teardown can stop every descendant. */
function spawnGroup(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, { ...options, stdio: 'ignore', detached: true });
}

function stopGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

/** Reads what a growing log file gained since the last read. */
class LogTail {
  private offset = 0;
  constructor(private readonly path: string) {}
  skipToEnd(): void {
    this.offset = existsSync(this.path) ? statSync(this.path).size : 0;
  }
  read(): string {
    if (!existsSync(this.path)) return '';
    const size = statSync(this.path).size;
    if (size <= this.offset) return '';
    const buffer = Buffer.alloc(size - this.offset);
    const handle = openSync(this.path, 'r');
    try {
      readSync(handle, buffer, 0, buffer.length, this.offset);
    } finally {
      closeSync(handle);
    }
    this.offset = size;
    return buffer.toString('utf8');
  }
}

/** Everything a device has logged since a point, accumulated as it is read. */
class LogWindow {
  private readonly tail: LogTail;
  text = '';
  constructor(path: string) {
    this.tail = new LogTail(path);
    this.tail.skipToEnd();
  }
  pull(): string {
    const chunk = this.tail.read();
    this.text += chunk;
    return chunk;
  }
}

// ---------------------------------------------------------------------------
// Signal server: flows mark steps and wake each other through it (see record.ts)

type SignalServer = Readonly<{
  url: string;
  marks: Map<string, number>;
  raise(name: string): void;
  reset(): void;
  close(): Promise<void>;
}>;

async function startSignalServer(): Promise<SignalServer> {
  const marks = new Map<string, number>();
  const raised = new Set<string>();
  const server: Server = createServer((request, response) => {
    const parsed = parseSignalRequest(request.url ?? '');
    response.setHeader('content-type', 'text/plain');
    if (parsed.kind === 'unknown') {
      response.statusCode = 404;
      response.end('unknown');
      return;
    }
    if (parsed.kind === 'mark') marks.set(parsed.name, Date.now());
    if (parsed.kind === 'set') raised.add(parsed.name);
    response.end(parsed.kind === 'signal' ? (raised.has(parsed.name) ? 'go' : 'wait') : 'ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    marks,
    raise: (name) => raised.add(name),
    reset: () => {
      marks.clear();
      raised.clear();
    },
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

// ---------------------------------------------------------------------------
// Maestro

let maestroRunCounter = 0;

async function runMaestro(
  options: Readonly<{
    udid: string;
    flowFile: string;
    label: string;
    signalUrl: string;
    env?: Readonly<Record<string, string>>;
    child?: (process: ChildProcess) => void;
  }>,
): Promise<number> {
  guardSimulatorCommand('maestro', ['--device', options.udid], ROOT_DIR);
  maestroRunCounter += 1;
  const runName = `${String(maestroRunCounter).padStart(3, '0')}-${options.label}`;
  const debugDir = resolve(LOG_DIR, 'maestro', runName);
  mkdirSync(debugDir, { recursive: true });
  const variables = { SHOWCASE_SIGNAL_URL: options.signalUrl, ...options.env };
  const args = [
    '--device',
    options.udid,
    'test',
    options.flowFile,
    '--debug-output',
    debugDir,
    ...Object.entries(variables).flatMap(([key, variable]) => ['-e', `${key}=${variable}`]),
  ];
  const logFile: WriteStream = createWriteStream(resolve(debugDir, 'console.log'));
  const child = spawn('maestro', args, { env: toolEnv(), cwd: debugDir, stdio: ['ignore', 'pipe', 'pipe'] });
  liveChildren.add(child);
  options.child?.(child);
  // Maestro prints a step's name, then its outcome once it returns; hold the
  // partial line so the console shows them together.
  let pending = '';
  const forward = (chunk: Buffer): void => {
    logFile.write(chunk);
    const lines = (pending + chunk.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`${LOG}   [${options.label}] ${line}`);
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  const [code] = (await once(child, 'exit')) as [number | null];
  liveChildren.delete(child);
  logFile.end();
  if (pending.trim()) console.log(`${LOG}   [${options.label}] ${pending}`);
  // Maestro's debug output is a screenshot per step, ~10 MB a run: keep it only
  // for a failure, where it is the evidence.
  if (code === 0) rmSync(debugDir, { recursive: true, force: true });
  return code ?? 1;
}

function writeNavigationFlow(name: string, links: readonly string[], settleMs: number): string {
  const steps: string[] = [`appId: ${APP_ID}`, '---'];
  for (const link of links) {
    if (!SAFE_ROUTE.test(link)) throw new Error(`Unsafe deep link in the take registry: ${link}`);
    steps.push(
      `- openLink: "${APP_SCHEME}://${link}"`,
      '- tapOn:',
      "    text: 'Open'",
      '    optional: true',
      '- waitForAnimationToEnd',
    );
  }
  steps.push(
    '- extendedWaitUntil:',
    "    visible: 'zzz-showcase-pause'",
    `    timeout: ${settleMs}`,
    '    optional: true',
    '',
  );
  mkdirSync(FLOW_SCRATCH_DIR, { recursive: true });
  const file = resolve(FLOW_SCRATCH_DIR, `${name}.yaml`);
  writeFileSync(file, steps.join('\n'));
  return file;
}

/**
 * iOS asks "Open in 'Boardsesh'?" on the first custom-scheme links after an
 * install and blocks until tapped. Dismiss it on throwaway links first (the
 * same prime `mobile:ios-shots` and app-store.yaml do), so no take catches it.
 */
function writeSchemePrimeFlow(): string {
  const file = resolve(FLOW_SCRATCH_DIR, 'prime-scheme-dialog.yaml');
  mkdirSync(FLOW_SCRATCH_DIR, { recursive: true });
  writeFileSync(
    file,
    [
      `appId: ${APP_ID}`,
      '---',
      `- openLink: "${APP_SCHEME}://home"`,
      '- extendedWaitUntil:',
      "    visible: 'Open'",
      '    timeout: 12000',
      '    optional: true',
      '- tapOn:',
      "    text: 'Open'",
      '    optional: true',
      '- waitForAnimationToEnd',
      '- repeat:',
      '    times: 2',
      '    commands:',
      `      - openLink: "${APP_SCHEME}://home"`,
      '      - tapOn:',
      "          text: 'Open'",
      '          optional: true',
      '      - waitForAnimationToEnd',
      '',
    ].join('\n'),
  );
  return file;
}

// ---------------------------------------------------------------------------
// Devices and Metro

type Phone = {
  role: 'primary' | 'secondary';
  spec: ShowcaseDevice;
  device: DeviceInfo;
  appPath: string;
  metroPort: number;
  metroLog: string;
  metro: ChildProcess | null;
};

function screenshotOptions(args: ShowcaseRecordArgs, appPath: string | null): ScreenshotOptions {
  return {
    platform: 'ios',
    flow: 'app-store',
    backend: args.backend,
    devices: [SHOWCASE_DEVICES.primary.name],
    androidDevice: 'Pixel 6',
    appLocales: [],
    variant: null,
    theme: 'dark',
    workout: null,
    renderMode: null,
    boards: args.boards ?? SHOWCASE_DEFAULT_BOARDS[args.backend],
    appPath,
    devClient: false,
    // Live backends only: the crew take needs real subscriptions, which a
    // fixture replay cannot animate.
    fixtures: 'off',
    fixturesDir: DEFAULT_SCREENSHOT_FIXTURES_DIR,
    fresh: false,
    pseudonymise: true,
    frozenNow: null,
    shutdown: false,
    orientation: null,
  };
}

function metroEnv(
  args: ShowcaseRecordArgs,
  credentials: Credentials,
  backendUrl: string | null,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ['EXPO_PUBLIC_BACKEND_URL', 'EXPO_PUBLIC_WS_URL', 'EXPO_PUBLIC_WEB_URL']) delete base[key];
  if (backendUrl) base.EXPO_PUBLIC_BACKEND_URL = backendUrl;
  base.SCREENSHOT_USER_EMAIL = credentials.email;
  base.SCREENSHOT_USER_PASSWORD = credentials.password;
  const env = buildScreenshotEnv(screenshotOptions(args, null), base);
  env.EXPO_PUBLIC_SCREENSHOT_FAKE_BLE = '1';
  return env;
}

function startMetro(port: number, env: NodeJS.ProcessEnv, logPath: string): ChildProcess {
  mkdirSync(dirname(logPath), { recursive: true });
  // `| tee` keeps Metro's stdout a line-buffered pipe; a plain `>` block-buffers
  // and the anchor lines would arrive in bursts (see lib/metro-dev-server.ts).
  const child = spawnGroup('sh', ['-c', `vp exec expo start --port ${port} 2>&1 | tee ${shellQuote(logPath)}`], {
    cwd: MOBILE_DIR,
    env: { ...env, CI: '1' },
  });
  onCleanup(`Metro on ${port}`, () => stopGroup(child));
  return child;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

/**
 * Build the bundle the dev-client will ask for before launching it: a cold
 * build (4600+ modules) outlasts the dev-client's load timeout.
 */
async function prewarmBundle(port: number): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const manifest = await fetch(`http://localhost:${port}/`, {
        headers: { 'expo-platform': 'ios', accept: 'application/expo+json,application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      const bundleUrl = ((await manifest.json()) as { launchAsset?: { url?: string } }).launchAsset?.url;
      if (bundleUrl) {
        const bundle = await fetch(bundleUrl, { signal: AbortSignal.timeout(300_000) });
        await bundle.arrayBuffer();
        if (bundle.ok) return;
      }
    } catch {
      // Metro not ready to serve yet
    }
    console.log(`${LOG} Metro on ${port} not ready to serve the bundle (attempt ${attempt}/6)...`);
    await sleep(5000);
  }
  throw new Error(`Metro on ${port} never served the iOS bundle; see ${relative(ROOT_DIR, LOG_DIR)}`);
}

/** A copy of the dev-client whose baked launcher URL points at another Metro port. */
function patchedSecondaryApp(appPath: string, port: number): string {
  rmSync(SECONDARY_APP_DIR, { recursive: true, force: true });
  mkdirSync(SECONDARY_APP_DIR, { recursive: true });
  const target = resolve(SECONDARY_APP_DIR, 'Boardsesh.app');
  cpSync(appPath, target, { recursive: true });
  const plist = resolve(target, 'Info.plist');
  const replaced = spawnSync('plutil', [
    '-replace',
    'DEV_CLIENT_DEFAULT_LAUNCHER_URL',
    '-string',
    `http://localhost:${port}`,
    plist,
  ]);
  if (replaced.status !== 0) throw new Error(`Could not patch ${plist}`);
  // Editing Info.plist breaks the seal; re-sign ad hoc, keeping the keychain
  // entitlements SecureStore needs.
  const signed = spawnSync('codesign', [
    '--force',
    '--sign',
    '-',
    '--preserve-metadata=entitlements,identifier,flags',
    target,
  ]);
  if (signed.status !== 0) throw new Error(`Could not re-sign ${target}: ${signed.stderr?.toString() ?? ''}`);
  return target;
}

async function preparePhone(
  role: 'primary' | 'secondary',
  appPath: string,
  metroPort: number,
  env: NodeJS.ProcessEnv,
  signal: SignalServer,
): Promise<Phone> {
  const spec = SHOWCASE_DEVICES[role];
  const device = findOrCreateIosDevice({ name: spec.name, typeId: spec.typeId, orientation: 'PORTRAIT' });
  console.log(`${LOG} ${role}: ${device.name} (${device.udid})`);
  bootDevice(device);
  applyCleanStatusBar(device.udid);
  onCleanup(`${role} simulator`, () => {
    clearStatusBar(device.udid);
    simctl(['shutdown', device.udid]);
  });
  // The shared keychain group survives an uninstall; a stale token would sign in
  // against the wrong backend.
  simctl(['keychain', device.udid, 'reset']);
  simctl(['uninstall', device.udid, APP_ID]);
  const install = simctl(['install', device.udid, appPath]);
  if (install.status !== 0) throw new Error(`simctl install on ${device.name} failed: ${install.stderr.trim()}`);

  const metroLog = resolve(LOG_DIR, `metro-${role}.log`);
  console.log(`${LOG} ${role}: starting Metro on ${metroPort} (log ${relative(ROOT_DIR, metroLog)})...`);
  const phone: Phone = { role, spec, device, appPath, metroPort, metroLog, metro: null };
  phone.metro = startMetro(metroPort, env, metroLog);
  if (!(await waitForHttp(`http://localhost:${metroPort}/status`, 120_000))) {
    throw new Error(`Metro on ${metroPort} never answered /status; see ${metroLog}`);
  }
  await prewarmBundle(metroPort);
  await relaunch(phone);
  const primed = await runMaestro({
    udid: device.udid,
    flowFile: writeSchemePrimeFlow(),
    label: `${role}-prime-dialog`,
    signalUrl: signal.url,
  });
  if (primed !== 0) console.warn(`${LOG} ${role}: scheme-dialog prime exited ${primed}; later links still tap "Open".`);
  return phone;
}

/** Cold-start the app (fresh JS state, so one-shot deep-link params fire again) and wait for home. */
async function relaunch(phone: Phone): Promise<LogWindow> {
  const window = new LogWindow(phone.metroLog);
  simctl(['terminate', phone.device.udid, APP_ID]);
  // SIMCTL_CHILD_TZ pins the app to UTC, like every screenshot capture.
  const launch = simctl(['launch', phone.device.udid, APP_ID], { ...process.env, SIMCTL_CHILD_TZ: 'UTC' });
  if (launch.status !== 0) throw new Error(`simctl launch on ${phone.device.name} failed: ${launch.stderr.trim()}`);
  const deadline = Date.now() + HOME_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    window.pull();
    if (countHomeReady(window.text) > 0) return window;
    await sleep(1000);
  }
  throw new Error(
    `${phone.role} never reached home within ${HOME_READY_TIMEOUT_MS / 1000}s. Last Metro lines:\n` +
      window.text.split('\n').slice(-25).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Recording

type Recording = Readonly<{ child: ChildProcess; startedAt: Promise<number>; file: string }>;

function startRecording(udid: string, file: string): Recording {
  mkdirSync(dirname(file), { recursive: true });
  guardSimulatorCommand('xcrun', ['simctl', 'io', udid], ROOT_DIR);
  const spawnedAt = Date.now();
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--force', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);
  const startedAt = new Promise<number>((resolvePromise) => {
    const fallback = setTimeout(() => {
      console.warn(`${LOG} recordVideo never said "Recording started"; assuming it did 1s after spawn.`);
      resolvePromise(spawnedAt + 1000);
    }, 8000);
    const watch = (chunk: Buffer): void => {
      if (chunk.toString('utf8').split('\n').some(isRecordingStartedLine)) {
        clearTimeout(fallback);
        resolvePromise(Date.now());
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
  });
  return { child, startedAt, file };
}

/** SIGINT is the only stop that finalises the container; anything harder leaves an unplayable file. */
async function stopRecording(recording: Recording): Promise<number> {
  const stoppedAt = Date.now();
  recording.child.kill('SIGINT');
  const exited = once(recording.child, 'exit');
  const timeout = sleep(20_000).then(() => 'timeout' as const);
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    recording.child.kill('SIGKILL');
    throw new Error(`recordVideo did not finalise ${recording.file} within 20s`);
  }
  liveChildren.delete(recording.child);
  return stoppedAt;
}

type TakeResult = Readonly<{ takeId: ShowcaseTakeId; problems: string[]; frames: number; seconds: number }>;

async function frameStdevs(file: string): Promise<number[]> {
  const stats = await sharp(file).stats();
  return stats.channels.slice(0, 3).map((channel) => channel.stdev);
}

async function referenceDiff(takeId: ShowcaseTakeId, firstFrame: string): Promise<number | null> {
  const reference = resolve(REFERENCE_DIR, `${takeId}.jpg`);
  if (!existsSync(reference)) return null;
  const thumbnail = (file: string): Promise<Buffer> =>
    sharp(file).resize(100, 217, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [baseline, candidate] = await Promise.all([thumbnail(reference), thumbnail(firstFrame)]);
  return differingPixelRatio(baseline, candidate, 3, REFERENCE_CHANNEL_TOLERANCE);
}

async function processTake(
  options: Readonly<{
    take: ShowcaseTake;
    args: ShowcaseRecordArgs;
    rawFile: string;
    recordStartMs: number;
    stoppedAtMs: number;
    flowStartMs: number | null;
    arrivals: readonly AnchorArrival[];
    logText: string;
    extraProblems: readonly string[];
  }>,
): Promise<TakeResult> {
  const { take, args } = options;
  const trimSeconds = resolveTrimSeconds({
    recordStartMs: options.recordStartMs,
    flowStartMs: options.flowStartMs,
    fallbackSeconds: take.trimSeconds,
  });
  const durationSeconds = Math.floor(((options.stoppedAtMs - options.recordStartMs) / 1000 - trimSeconds) * 30) / 30;
  const footageDir = resolve(SHOWCASE_FOOTAGE_DIR, take.id);
  rmSync(footageDir, { recursive: true, force: true });
  mkdirSync(footageDir, { recursive: true });
  const ffmpeg = spawnSync(
    resolveMediaBinary('ffmpeg'),
    buildFootageFrameArgs({
      input: options.rawFile,
      outputPattern: resolve(footageDir, '%05d.jpg'),
      trimSeconds,
      durationSeconds: Math.max(durationSeconds, 0),
    }),
    { encoding: 'utf8' },
  );
  // Raw takes run 5-50 MB each; keep them only on request (the frames are the product).
  if (!args.keepRaw) rmSync(options.rawFile, { force: true });
  if (ffmpeg.status !== 0) {
    return {
      takeId: take.id,
      problems: [
        ...options.extraProblems,
        `[${take.id}] ffmpeg could not extract frames from ${options.rawFile}: ${ffmpeg.stderr.trim()}`,
      ],
      frames: 0,
      seconds: 0,
    };
  }
  const frames = readdirSync(footageDir).filter((file) => file.endsWith('.jpg')).length;
  const seconds = frames / 30;
  const firstFrame = resolve(footageDir, '00001.jpg');
  const firstFrameBlank = frames > 0 ? isBlankFrame(await frameStdevs(firstFrame)) : true;
  const referenceDiffRatio = frames > 0 ? await referenceDiff(take.id, firstFrame) : null;

  const anchors: ShowcaseAnchorsFile = buildAnchorsFile({
    takeId: take.id,
    arrivals: options.arrivals,
    recordStartMs: options.recordStartMs,
    trimSeconds,
    durationSeconds: seconds,
    screen: SHOWCASE_DEVICES.primary.screen,
  });
  mkdirSync(SHOWCASE_ANCHORS_DIR, { recursive: true });
  writeFileSync(resolve(SHOWCASE_ANCHORS_DIR, `${take.id}.json`), `${JSON.stringify(anchors, null, 2)}\n`);

  const problems = [
    ...options.extraProblems,
    ...checkTake({
      takeId: take.id,
      expectedAnchors: take.expectedAnchors,
      anchors,
      footageSeconds: seconds,
      minSeconds: take.minSeconds,
      firstFrameBlank,
      referenceDiffRatio,
      boardProblem: take.board ? findBoardSlotProblem(options.logText, take.board.slot, take.board.kind) : null,
      skipAnchorCheck: args.skipAnchorCheck,
    }),
  ];
  console.log(
    `${LOG} [${take.id}] trim ${trimSeconds.toFixed(2)}s -> ${frames} frames (${seconds.toFixed(2)}s), ` +
      `anchors: ${Object.keys(anchors.anchors).join(', ') || 'none'}`,
  );
  return { takeId: take.id, problems, frames, seconds };
}

// ---------------------------------------------------------------------------
// Takes

type RunContext = {
  args: ShowcaseRecordArgs;
  primary: Phone;
  secondary: Phone | null;
  signal: SignalServer;
};

async function recordTake(context: RunContext, take: ShowcaseTake): Promise<TakeResult> {
  const { primary, signal } = context;
  console.log(`\n${LOG} === ${take.id}: ${take.summary}`);
  signal.reset();
  const window = await relaunch(primary);
  const primeStatus = await runMaestro({
    udid: primary.device.udid,
    flowFile: writeNavigationFlow(`prime-${take.id}`, take.primeLinks, 3000),
    label: `${take.id}-prime`,
    signalUrl: signal.url,
  });
  if (primeStatus !== 0) {
    return {
      takeId: take.id,
      problems: [`[${take.id}] could not open its deep links (Maestro exit ${primeStatus})`],
      frames: 0,
      seconds: 0,
    };
  }

  let secondaryRun: Promise<number> | null = null;
  let secondaryChild: ChildProcess | null = null;
  if (take.secondary) {
    const prepared = await prepareCrew(context, take);
    if (typeof prepared === 'string') return { takeId: take.id, problems: [prepared], frames: 0, seconds: 0 };
    secondaryRun = runMaestro({
      udid: prepared.udid,
      flowFile: showcaseFlowPath(take.secondary.flow),
      label: `${take.id}-secondary`,
      signalUrl: signal.url,
      child: (child) => {
        secondaryChild = child;
      },
    });
    const readyBy = Date.now() + 60_000;
    while (!signal.marks.has('secondary-ready') && Date.now() < readyBy) await sleep(250);
    if (!signal.marks.has('secondary-ready')) {
      return {
        takeId: take.id,
        problems: [`[${take.id}] the second phone's flow never started (no secondary-ready mark within 60s)`],
        frames: 0,
        seconds: 0,
      };
    }
  }

  const rawFile = resolve(SHOWCASE_RAW_DIR, `${take.id}.mov`);
  // Anchors logged while the take was being set up (the invite sheet laid out
  // before recording, say) are in force when the footage starts: stamp them
  // "before the start" and buildAnchorsFile pins them to t = 0.
  window.pull();
  const arrivals: AnchorArrival[] = [...anchorArrivalsFromChunk(window.text, 0)];
  const recording = startRecording(primary.device.udid, rawFile);
  const poll = setInterval(() => {
    arrivals.push(...anchorArrivalsFromChunk(window.pull(), Date.now()));
  }, 100);
  let recordStartMs = 0;
  let stoppedAtMs = 0;
  const extraProblems: string[] = [];
  try {
    recordStartMs = await recording.startedAt;
    const flowStatus = await runMaestro({
      udid: primary.device.udid,
      flowFile: showcaseFlowPath(take.flow),
      label: take.id,
      signalUrl: signal.url,
    });
    if (flowStatus !== 0) {
      extraProblems.push(
        `[${take.id}] its flow ${take.flow} failed (Maestro exit ${flowStatus}); see ${relative(ROOT_DIR, LOG_DIR)}/maestro`,
      );
    }
    if (secondaryRun) {
      const secondaryStatus = await Promise.race([secondaryRun, sleep(30_000).then(() => 'timeout' as const)]);
      if (secondaryStatus === 'timeout') {
        (secondaryChild as ChildProcess | null)?.kill('SIGINT');
        extraProblems.push(`[${take.id}] the second phone's flow did not finish within 30s of the take`);
      } else if (secondaryStatus !== 0) {
        extraProblems.push(`[${take.id}] the second phone's flow failed (Maestro exit ${secondaryStatus})`);
      }
    }
    // A beat of tail so the last pause is not cut by the stop.
    await sleep(500);
  } finally {
    stoppedAtMs = await stopRecording(recording);
    clearInterval(poll);
    arrivals.push(...anchorArrivalsFromChunk(window.pull(), Date.now()));
  }
  if (take.teardownFlows.length > 0) await runTeardownFlows(context, take);

  return processTake({
    take,
    args: context.args,
    rawFile,
    recordStartMs,
    stoppedAtMs,
    flowStartMs: signal.marks.get(FLOW_START_MARK) ?? null,
    arrivals,
    logText: window.text,
    extraProblems,
  });
}

let crewSessionOpen = false;

async function runTeardownFlows(context: RunContext, take: ShowcaseTake): Promise<void> {
  if (!crewSessionOpen) return;
  const window = new LogWindow(context.primary.metroLog);
  for (const flow of take.teardownFlows) {
    await runMaestro({
      udid: context.primary.device.udid,
      flowFile: showcaseFlowPath(flow),
      label: `${take.id}-teardown`,
      signalUrl: context.signal.url,
    });
  }
  await sleep(2000);
  window.pull();
  if (window.text.includes('[analytics] Session Ended')) {
    crewSessionOpen = false;
    console.log(`${LOG} [${take.id}] live session ended.`);
  } else {
    console.warn(
      `${LOG} [${take.id}] could not confirm the live session ended. End it by hand: ` +
        `Session tab -> Stop -> End session on "${SHOWCASE_DEVICES.primary.name}".`,
    );
  }
}

/**
 * Crew setup: a hidden session on the primary, its id from the copied invite
 * link, and the second phone joined and on Climbs. Returns the secondary's
 * UDID, or the problem.
 */
async function prepareCrew(context: RunContext, take: ShowcaseTake): Promise<{ udid: string } | string> {
  const { primary, secondary, signal } = context;
  if (!secondary || !take.secondary) return `[${take.id}] needs the second phone, which was not set up`;
  const [privateFlow, startFlow] = take.setupFlows;
  const window = new LogWindow(primary.metroLog);
  await runMaestro({
    udid: primary.device.udid,
    flowFile: showcaseFlowPath(privateFlow),
    label: `${take.id}-private`,
    signalUrl: signal.url,
  });
  await sleep(1000);
  window.pull();
  if (!sessionVisibilityIsOff(window.text)) {
    return (
      `[${take.id}] "Show this session live" was not switched off before Start, so no session was started. ` +
      `Check the switch's point in ${privateFlow}, and that no session is already running on the account.`
    );
  }
  simctl(['pbcopy', primary.device.udid], process.env);
  await runMaestro({
    udid: primary.device.udid,
    flowFile: showcaseFlowPath(startFlow),
    label: `${take.id}-start`,
    signalUrl: signal.url,
  });
  window.pull();
  if (sessionStarted(window.text)) {
    crewSessionOpen = true;
    onCleanup('end the crew live session', () => runTeardownFlows(context, take));
  }
  const invite = simctl(['pbpaste', primary.device.udid]).stdout;
  const sessionId = parseSessionIdFromInviteUrl(invite);
  if (!crewSessionOpen || !sessionId) {
    return (
      `[${take.id}] the session did not start or its invite link was not copied (clipboard: ` +
      `${invite.trim() ? 'no session link' : 'empty'}). Check the Start / Invite / Copy link points in ${startFlow}.`
    );
  }
  console.log(`${LOG} [${take.id}] hidden session ${sessionId} started; sending the second phone in.`);

  await relaunch(secondary);
  const joinStatus = await runMaestro({
    udid: secondary.device.udid,
    flowFile: writeNavigationFlow(`${take.id}-join-link`, [`join/${sessionId}`], 1500),
    label: `${take.id}-join-link`,
    signalUrl: signal.url,
  });
  const joined =
    joinStatus === 0 &&
    (await runMaestro({
      udid: secondary.device.udid,
      flowFile: showcaseFlowPath(take.secondary.joinFlow),
      label: `${take.id}-join`,
      signalUrl: signal.url,
    })) === 0;
  if (!joined) return `[${take.id}] the second phone could not join session ${sessionId}; see its Maestro log`;
  const toClimbs = await runMaestro({
    udid: secondary.device.udid,
    flowFile: writeNavigationFlow(`${take.id}-secondary-climbs`, ['home', 'climbs'], 2500),
    label: `${take.id}-secondary-climbs`,
    signalUrl: signal.url,
  });
  if (toClimbs !== 0) return `[${take.id}] the second phone could not open Climbs`;
  return { udid: secondary.device.udid };
}

// ---------------------------------------------------------------------------
// Local backend

async function signIn(backendUrl: string, credentials: Credentials): Promise<string | null> {
  const response = await fetch(`${backendUrl}/auth/native/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { jwt?: string }).jwt ?? null;
}

async function graphql<TData>(backendUrl: string, jwt: string, query: string, variables: object = {}): Promise<TData> {
  const response = await fetch(`${backendUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { data?: TData; errors?: { message: string }[] };
  if (body.errors?.length || !body.data)
    throw new Error(body.errors?.map((error) => error.message).join('; ') ?? 'no data');
  return body.data;
}

/**
 * Seed what the takes need on the LOCAL dev DB only, idempotently: a MoonBoard
 * on the test account (the image follows two Kilters and a Tension, no
 * MoonBoard) and the second account the crew take signs in as. The test
 * account already has thousands of ticks, so the log take needs none. Nothing
 * here ever runs against prod.
 */
async function seedLocal(backendUrl: string): Promise<void> {
  const jwt = await signIn(backendUrl, LOCAL_PRIMARY);
  if (!jwt) throw new Error(`Could not sign in ${LOCAL_PRIMARY.email} on the local backend; is the dev DB seeded?`);
  const { myBoards } = await graphql<{ myBoards: { boards: { name: string; boardType: string }[] } }>(
    backendUrl,
    jwt,
    '{ myBoards { boards { name boardType } } }',
  );
  if (!myBoards.boards.some((board) => board.boardType === 'moonboard')) {
    console.log(`${LOG} local: adding a MoonBoard 2016 to ${LOCAL_PRIMARY.email}...`);
    await graphql(backendUrl, jwt, 'mutation($input: CreateBoardInput!) { createBoard(input: $input) { uuid } }', {
      input: {
        boardType: 'moonboard',
        layoutId: 2,
        sizeId: 1,
        setIds: '2,3,4',
        name: 'MoonBoard 2016',
        angle: 40,
        isPublic: false,
      },
    });
  }
  if (!(await signIn(backendUrl, LOCAL_SECONDARY))) {
    console.log(`${LOG} local: registering the crew account ${LOCAL_SECONDARY.email}...`);
    const registered = await fetch(`${backendUrl}/auth/native/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LOCAL_SECONDARY),
      signal: AbortSignal.timeout(15_000),
    });
    if (!registered.ok) throw new Error(`Could not register ${LOCAL_SECONDARY.email}: HTTP ${registered.status}`);
  }
}

async function backendHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await response.json()) as { database?: { reachable?: boolean } };
    return response.ok && body.database?.reachable === true;
  } catch {
    return false;
  }
}

/**
 * The seeded dev DB (`vp run db:up`, which reuses another worktree's DB when
 * one is up) plus a backend of our own on a free port, so this run never talks
 * to a backend built from another branch. SHOWCASE_LOCAL_BACKEND_URL reuses a
 * running one instead.
 */
async function ensureLocalBackend(): Promise<string> {
  const reuse = process.env.SHOWCASE_LOCAL_BACKEND_URL;
  if (reuse) {
    if (!(await backendHealthy(reuse))) throw new Error(`SHOWCASE_LOCAL_BACKEND_URL=${reuse} is not healthy`);
    return reuse;
  }
  console.log(`${LOG} local: vp run db:up...`);
  if (spawnSync('vp', ['run', 'db:up'], { cwd: ROOT_DIR, stdio: 'inherit' }).status !== 0) {
    throw new Error('vp run db:up failed; is Docker running?');
  }
  const port = LOCAL_BACKEND_PORTS.find((candidate) => !portInUse(candidate));
  if (!port) throw new Error(`No free port for the local backend among ${LOCAL_BACKEND_PORTS.join(', ')}`);
  const logPath = resolve(LOG_DIR, 'backend.log');
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`${LOG} local: starting the backend on ${port} (log ${relative(ROOT_DIR, logPath)})...`);
  const child = spawnGroup('sh', ['-c', `vp exec tsx src/index.ts > ${shellQuote(logPath)} 2>&1`], {
    cwd: BACKEND_DIR,
    env: { ...process.env, NODE_ENV: 'development', DOTENV_CONFIG_PATH: '.env.development', PORT: String(port) },
  });
  onCleanup('local backend', () => stopGroup(child));
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await backendHealthy(url)) return url;
    if (child.exitCode !== null) break;
    await sleep(2000);
  }
  throw new Error(`The local backend never became healthy on ${port}; see ${logPath}`);
}

// ---------------------------------------------------------------------------
// Main

function loadEnvFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  for (const key of ENV_FILE_KEYS) {
    if (parsed[key] && !process.env[key]) process.env[key] = parsed[key];
  }
  return true;
}

function resolveCredentials(
  backend: ShowcaseBackend,
  needsSecondary: boolean,
): { primary: Credentials; secondary: Credentials | null } {
  if (backend === 'local') return { primary: LOCAL_PRIMARY, secondary: needsSecondary ? LOCAL_SECONDARY : null };
  const password = process.env.SCREENSHOT_USER_PASSWORD;
  if (!password) {
    throw new Error(
      'Prod needs the App Store account password: set SCREENSHOT_USER_PASSWORD (or put it in the --env-file). ' +
        'Or record against the dev DB with --backend local.',
    );
  }
  const primary = { email: process.env.SCREENSHOT_USER_EMAIL || 'test@boardsesh.com', password };
  if (!needsSecondary) return { primary, secondary: null };
  const email = process.env.SHOWCASE_SECONDARY_EMAIL;
  const secondaryPassword = process.env.SHOWCASE_SECONDARY_PASSWORD;
  if (!email || !secondaryPassword) {
    throw new Error(
      'The crew take on prod needs a second account: set SHOWCASE_SECONDARY_EMAIL and SHOWCASE_SECONDARY_PASSWORD ' +
        '(the runbook shows the op:// env file), or run it locally: --only crew --backend local.',
    );
  }
  return { primary, secondary: { email, password: secondaryPassword } };
}

function printPlan(args: ShowcaseRecordArgs, takes: readonly ShowcaseTake[], envFileFound: boolean): void {
  console.log(`${LOG} backend: ${args.backend}; boards: ${args.boards ?? SHOWCASE_DEFAULT_BOARDS[args.backend]}`);
  console.log(`${LOG} env file: ${args.envFile} (${envFileFound ? 'found' : 'not found'})`);
  for (const key of ENV_FILE_KEYS) console.log(`${LOG}   ${key}: ${process.env[key] ? 'set' : 'unset'}`);
  console.log(
    `${LOG} devices: ${SHOWCASE_DEVICES.primary.name}${takes.some((take) => take.secondary) ? `, ${SHOWCASE_DEVICES.secondary.name}` : ''}`,
  );
  for (const take of takes) {
    const flows = [
      ...take.setupFlows,
      take.flow,
      ...(take.secondary ? [take.secondary.joinFlow, take.secondary.flow] : []),
      ...take.teardownFlows,
    ];
    const missing = flows.filter((flow) => !existsSync(showcaseFlowPath(flow)));
    console.log(
      `${LOG} ${take.id.padEnd(17)} ${take.minSeconds.toFixed(1)}s min | links ${take.primeLinks.join(' -> ')} | ` +
        `flows ${flows.join(', ')}${missing.length ? ` | MISSING ${missing.join(', ')}` : ''}` +
        `${take.expectedAnchors.length ? ` | anchors ${take.expectedAnchors.join(', ')}` : ''}`,
    );
  }
  console.log(
    `${LOG} footage -> ${SHOWCASE_FOOTAGE_DIR}/<take>/%05d.jpg, anchors -> ${SHOWCASE_ANCHORS_DIR}/<take>.json`,
  );
}

function preflight(): void {
  if (process.platform !== 'darwin') throw new Error('The showcase recorder drives iOS simulators: macOS only.');
  if (!commandExists('xcrun')) throw new Error('xcrun is missing: install Xcode and its command line tools.');
  if (!commandExists('maestro')) {
    throw new Error(
      'Maestro is not installed: curl -Ls "https://get.maestro.mobile.dev" | bash (and a JDK 21 at ~/.cache/boardsesh/jdk-21).',
    );
  }
  if (!commandExists('java')) throw new Error(`Maestro needs a JDK: put Temurin 21 at ${JDK_HOME} or set JAVA_HOME.`);
  if (spawnSync(resolveMediaBinary('ffmpeg'), ['-version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('ffmpeg is missing: brew install ffmpeg (or set FFMPEG_BIN).');
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: ShowcaseRecordArgs;
  try {
    args = parseRecordArgs(argv);
    assertShowcaseTakesComplete();
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const selected = args.only ?? SHOWCASE_TAKE_IDS;
  const takes = SHOWCASE_TAKES.filter((take) => selected.includes(take.id));
  const envFileFound = loadEnvFile(args.envFile);
  printPlan(args, takes, envFileFound);
  if (args.dryRun) return 0;

  const onSignal = (): void => {
    console.warn(`\n${LOG} interrupted; tearing down...`);
    void teardown().then(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const results: TakeResult[] = [];
  try {
    preflight();
    // The recorder picks its own simulators; a selection meant for another tool
    // must not redirect it.
    delete process.env.BOARDSESH_IOS_SIMULATOR_UDID;
    const needsSecondary = takes.some((take) => take.secondary);
    const credentials = resolveCredentials(args.backend, needsSecondary);
    mkdirSync(LOG_DIR, { recursive: true });

    const backendUrl = args.backend === 'local' ? await ensureLocalBackend() : null;
    if (backendUrl) await seedLocal(backendUrl);

    const signal = await startSignalServer();
    onCleanup('signal server', () => signal.close());

    if (portInUse(PRIMARY_METRO_PORT)) {
      throw new Error(
        `Port ${PRIMARY_METRO_PORT} is taken (another Metro?). The dev-client .app loads its bundle from ` +
          `localhost:${PRIMARY_METRO_PORT}, so stop that one first.`,
      );
    }
    const appPath = resolveAppPath(screenshotOptions(args, args.appPath ? resolve(args.appPath) : null));
    const primary = await preparePhone(
      'primary',
      appPath,
      PRIMARY_METRO_PORT,
      metroEnv(args, credentials.primary, backendUrl),
      signal,
    );

    let secondary: Phone | null = null;
    if (credentials.secondary) {
      const port = SECONDARY_METRO_PORTS.find((candidate) => !portInUse(candidate));
      if (!port) throw new Error(`No free Metro port for the second phone among ${SECONDARY_METRO_PORTS.join(', ')}`);
      // Its own TMPDIR keeps the second account's bundle (credentials inlined)
      // out of the shared Metro cache; teardown deletes it, and the app with it.
      mkdirSync(SECONDARY_METRO_TMP, { recursive: true });
      onCleanup('second phone bundle cache', () => rmSync(SECONDARY_METRO_TMP, { recursive: true, force: true }));
      secondary = await preparePhone(
        'secondary',
        patchedSecondaryApp(appPath, port),
        port,
        metroEnv(args, credentials.secondary, backendUrl, { TMPDIR: SECONDARY_METRO_TMP }),
        signal,
      );
      const secondaryUdid = secondary.device.udid;
      onCleanup('second phone app', () => {
        simctl(['uninstall', secondaryUdid, APP_ID]);
        simctl(['keychain', secondaryUdid, 'reset']);
      });
    }

    const context: RunContext = { args, primary, secondary, signal };
    for (const take of takes) {
      try {
        results.push(await recordTake(context, take));
      } catch (error) {
        results.push({
          takeId: take.id,
          problems: [`[${take.id}] ${error instanceof Error ? error.message : String(error)}`],
          frames: 0,
          seconds: 0,
        });
      }
    }
  } catch (error) {
    console.error(`${LOG} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    await teardown();
    return 1;
  }
  await teardown();

  console.log(`\n${LOG} Summary`);
  for (const result of results) {
    console.log(
      `${LOG}   ${result.takeId.padEnd(17)} ${result.problems.length ? 'FAIL' : 'ok  '} ${result.frames} frames (${result.seconds.toFixed(2)}s)`,
    );
  }
  const problems = results.flatMap((result) => result.problems);
  if (problems.length > 0) {
    console.error(`\n${LOG} ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`${LOG}   ${problem}`);
    return 1;
  }
  console.log(`${LOG} Footage: ${SHOWCASE_FOOTAGE_DIR}`);
  console.log(`${LOG} Next: vp run video:render`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
