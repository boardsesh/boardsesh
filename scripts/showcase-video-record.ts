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
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { resolveMediaBinary } from './lib/help-clips';
import { guardSimulatorCommand } from './lib/ios-simulator-lease';
import { DEFAULT_SCREENSHOT_FIXTURES_DIR } from './lib/screenshot-fixtures';
import {
  SHOWCASE_STAGE_DIR,
  SHOWCASE_TAKE_IDS,
  SHOWCASE_WORK_ROOT,
  showcaseWorkDirs,
  type ShowcaseAnchorsFile,
  type ShowcasePlatform,
  type ShowcaseTakeId,
  type ShowcaseWorkDirs,
} from './lib/showcase-video/contract';
import {
  SHOWCASE_ANDROID_DEVICE,
  SHOWCASE_ANDROID_PACKAGE,
  androidDevClientUrl,
  androidSerial,
  buildConcatArgs,
  buildConcatList,
  buildDemoModeCommands,
  buildDemoModeExitCommand,
  buildSnoozeSystemNotificationsArgs,
  buildEmulatorArgs,
  buildScreenrecordArgs,
  isScreenrecordStartedLine,
  screenrecordRemotePath,
  showcaseAvdConfig,
  showcaseSystemImage,
} from './lib/showcase-video/android';
import {
  adbPath,
  androidEnv,
  avdmanagerPath,
  emulatorPath,
  resolveAndroidHome,
  sdkmanagerPath,
} from './lib/android-sdk';
import { resolveAndroidApk } from './mobile-android-apk';
import {
  FLOW_START_MARK,
  REFERENCE_CHANNEL_TOLERANCE,
  SHOWCASE_DEFAULT_BOARDS,
  SHOWCASE_DEVICES,
  anchorArrivalsFromChunk,
  anchorTapValues,
  buildAnchorsFile,
  buildFootageFrameArgs,
  buildMarksFile,
  checkTake,
  countHomeReady,
  differingPixelRatio,
  findBoardHandoffProblem,
  findKeychainTeamProblem,
  findBoardSlotProblem,
  isBlankFrame,
  isRecordingStartedLine,
  parseEnvFile,
  macOsOnlyMessage,
  parseRecordArgs,
  recordRunMode,
  parseSessionIdFromInviteUrl,
  parseSignalRequest,
  resolveTrimSeconds,
  restoredSessionId,
  sessionStarted,
  sessionVisibilityIsOff,
  splitCompleteLines,
  type AnchorArrival,
  type ShowcaseBackend,
  type ShowcaseDevice,
  type ShowcaseRecordArgs,
} from './lib/showcase-video/record';
import {
  SHOWCASE_BOARD_CONFIG_LINKS,
  SHOWCASE_TAKES,
  isShowcaseFlow,
  assertShowcaseTakesComplete,
  showcaseFlowPathFor,
  takeForPlatform,
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
/** The screenshot simulator build's entitlements (see scripts/mobile-build-sim-app.ts). */
const SIM_ENTITLEMENTS = resolve(ROOT_DIR, 'scripts', 'screenshot-sim.entitlements');
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

/** On PATH? `which` with an argument array, so no name is ever shell-interpolated. */
function commandExists(command: string, env: NodeJS.ProcessEnv = toolEnv()): boolean {
  return spawnSync('which', [command], { env, stdio: 'ignore' }).status === 0;
}

function simctl(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  guardSimulatorCommand('xcrun', ['simctl', ...args], ROOT_DIR);
  const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function readPlistString(plistPath: string, key: string): string | null {
  const result = spawnSync('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
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

/**
 * Reads the complete lines a growing log file gained since the last read.
 * An unterminated tail stays buffered until its newline arrives, so a line
 * Metro or tee flushed across two reads is returned once, whole.
 */
class LogTail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly path: string) {}
  skipToEnd(): void {
    this.offset = existsSync(this.path) ? statSync(this.path).size : 0;
    this.pending = Buffer.alloc(0);
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
    const { lines, rest } = splitCompleteLines(this.pending, buffer);
    this.pending = rest;
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
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
  values: Map<string, string>;
  raise(name: string): void;
  reset(): void;
  close(): Promise<void>;
}>;

async function startSignalServer(): Promise<SignalServer> {
  const marks = new Map<string, number>();
  const values = new Map<string, string>();
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
    if (parsed.kind === 'value') {
      response.end(values.get(parsed.name) ?? '');
      return;
    }
    response.end(parsed.kind === 'signal' ? (raised.has(parsed.name) ? 'go' : 'wait') : 'ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    marks,
    values,
    raise: (name) => raised.add(name),
    reset: () => {
      marks.clear();
      values.clear();
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

function writeNavigationFlow(
  name: string,
  links: readonly string[],
  settleMs: number,
  platform: ShowcasePlatform = 'ios',
): string {
  const steps: string[] = [`appId: ${platform === 'android' ? SHOWCASE_ANDROID_PACKAGE : APP_ID}`, '---'];
  for (const link of links) {
    if (!SAFE_ROUTE.test(link)) throw new Error(`Unsafe deep link in the take registry: ${link}`);
    steps.push(`- openLink: "${APP_SCHEME}://${link}"`);
    // iOS asks "Open in 'Boardsesh'?" now and then; Android opens the link directly.
    if (platform === 'ios') steps.push('- tapOn:', "    text: 'Open'", '    optional: true');
    steps.push('- waitForAnimationToEnd');
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
  /** iOS simulator (`device.udid` is its UDID) or Android emulator (`device.udid` is its adb serial). */
  platform: ShowcasePlatform;
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
async function prewarmBundle(port: number, platform: ShowcasePlatform = 'ios'): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const manifest = await fetch(`http://localhost:${port}/`, {
        headers: { 'expo-platform': platform, accept: 'application/expo+json,application/json' },
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
  throw new Error(`Metro on ${port} never served the ${platform} bundle; see ${relative(ROOT_DIR, LOG_DIR)}`);
}

/** A copy of the dev-client whose baked launcher URL points at another Metro port. */
function patchedSecondaryApp(appPath: string, port: number): string {
  rmSync(SECONDARY_APP_DIR, { recursive: true, force: true });
  mkdirSync(SECONDARY_APP_DIR, { recursive: true });
  const target = resolve(SECONDARY_APP_DIR, 'Boardsesh.app');
  // `cp -c` clones on APFS: the 190 MB bundle costs no disk until a file in it
  // changes (only Info.plist and the signature do).
  if (spawnSync('cp', ['-cR', appPath, target]).status !== 0) cpSync(appPath, target, { recursive: true });
  onCleanup('second phone app copy', () => rmSync(SECONDARY_APP_DIR, { recursive: true, force: true }));
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
  // Dark system appearance: the lock-screen take films the home screen behind
  // the Dynamic Island, and the dark wallpaper keeps it from reading as a white flash.
  simctl(['ui', device.udid, 'appearance', 'dark']);
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
  const phone: Phone = { platform: 'ios', role, spec, device, appPath, metroPort, metroLog, metro: null };
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
  if (phone.platform === 'android') return relaunchAndroid(phone);
  const window = new LogWindow(phone.metroLog);
  // A brand-new simulator's first launch can sit on the dev-client launcher
  // ("Searching for development servers") instead of loading the baked URL;
  // the next launch loads it. So try a few times inside the overall budget.
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    simctl(['terminate', phone.device.udid, APP_ID]);
    // SIMCTL_CHILD_TZ pins the app to UTC, like every screenshot capture.
    const launch = simctl(['launch', phone.device.udid, APP_ID], { ...process.env, SIMCTL_CHILD_TZ: 'UTC' });
    if (launch.status !== 0) throw new Error(`simctl launch on ${phone.device.name} failed: ${launch.stderr.trim()}`);
    const deadline = Date.now() + HOME_READY_TIMEOUT_MS / attempts;
    while (Date.now() < deadline) {
      window.pull();
      if (countHomeReady(window.text) > 0) return window;
      await sleep(1000);
    }
    console.warn(`${LOG} ${phone.role}: app not home after launch ${attempt}/${attempts}.`);
  }
  const screenshot = resolve(LOG_DIR, `${phone.role}-not-home.png`);
  deviceScreenshot(phone, screenshot);
  throw new Error(
    `${phone.role} never reached home within ${HOME_READY_TIMEOUT_MS / 1000}s (screen: ${relative(ROOT_DIR, screenshot)}). ` +
      `Last Metro lines:\n${window.text.split('\n').slice(-25).join('\n')}`,
  );
}

/** A still of what the phone shows, for a failure message. */
function deviceScreenshot(phone: Phone, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (phone.platform === 'ios') {
    simctl(['io', phone.device.udid, 'screenshot', file]);
    return;
  }
  const capture = spawnSync(adbBinary(), ['-s', phone.device.udid, 'exec-out', 'screencap', '-p'], {
    env: androidEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (capture.status === 0) writeFileSync(file, capture.stdout);
}

// ---------------------------------------------------------------------------
// Android emulator

function adbBinary(): string {
  return adbPath(resolveAndroidHome());
}

function adb(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(adbBinary(), args, { encoding: 'utf8', env: androidEnv(), maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The dedicated "Boardsesh_Showcase" AVD: created once from the Pixel 7
 * profile on this host's system image, its screen set to a Pixel 9-class
 * 1080x2424 (config.ini is rewritten every run, so a hand edit can't drift it).
 */
function ensureShowcaseAvd(): void {
  const home = resolveAndroidHome();
  const env = androidEnv();
  const image = showcaseSystemImage(process.arch);
  const imageDir = resolve(home, ...image.split(';'));
  if (!existsSync(imageDir)) {
    console.log(`${LOG} android: installing ${image} (one-time, ~1.5 GB)...`);
    const installed = spawnSync(sdkmanagerPath(home), [`--sdk_root=${home}`, image], { stdio: 'inherit', env });
    if (installed.status !== 0)
      throw new Error(`sdkmanager could not install ${image}; run vp run mobile:android-doctor`);
  }
  const avdDir = join(homedir(), '.android', 'avd', `${SHOWCASE_ANDROID_DEVICE.avdName}.avd`);
  if (!existsSync(avdDir)) {
    console.log(`${LOG} android: creating AVD ${SHOWCASE_ANDROID_DEVICE.avdName}...`);
    const created = spawnSync(
      avdmanagerPath(home),
      [
        'create',
        'avd',
        '-n',
        SHOWCASE_ANDROID_DEVICE.avdName,
        '-k',
        image,
        '-d',
        SHOWCASE_ANDROID_DEVICE.deviceProfile,
        '--force',
      ],
      { input: 'no\n', encoding: 'utf8', env },
    );
    if (created.status !== 0) throw new Error(`avdmanager could not create the AVD: ${created.stderr ?? ''}`);
  }
  const configPath = join(avdDir, 'config.ini');
  writeFileSync(configPath, showcaseAvdConfig(readFileSync(configPath, 'utf8')));
}

async function bootShowcaseEmulator(windowed: boolean): Promise<string> {
  const serial = androidSerial(SHOWCASE_ANDROID_DEVICE.port);
  const alreadyUp = adb(['devices'])
    .stdout.split('\n')
    .some((line) => line.startsWith(`${serial}\t`));
  if (!alreadyUp) {
    ensureShowcaseAvd();
    const logPath = resolve(LOG_DIR, 'android-emulator.log');
    mkdirSync(LOG_DIR, { recursive: true });
    console.log(
      `${LOG} android: booting ${SHOWCASE_ANDROID_DEVICE.avdName} on ${serial} (log ${relative(ROOT_DIR, logPath)})...`,
    );
    const args = buildEmulatorArgs({
      avdName: SHOWCASE_ANDROID_DEVICE.avdName,
      port: SHOWCASE_ANDROID_DEVICE.port,
      windowed,
    });
    const command = [emulatorPath(resolveAndroidHome()), ...args].map(shellQuote).join(' ');
    const emulator = spawnGroup('sh', ['-c', `${command} > ${shellQuote(logPath)} 2>&1`], {
      cwd: ROOT_DIR,
      env: androidEnv(),
    });
    onCleanup('android emulator', async () => {
      adb(['-s', serial, 'emu', 'kill']);
      await sleep(3000);
      stopGroup(emulator);
    });
  }
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).stdout.trim() === '1') return serial;
    await sleep(2000);
  }
  throw new Error(
    `The emulator ${serial} did not finish booting in 300s; see ${relative(ROOT_DIR, LOG_DIR)}/android-emulator.log`,
  );
}

async function prepareAndroidPhone(
  args: ShowcaseRecordArgs,
  metroPort: number,
  env: NodeJS.ProcessEnv,
  backendUrl: string | null,
): Promise<Phone> {
  const serial = await bootShowcaseEmulator(false);
  // Dark system UI, which the notification shade the island take films follows.
  adb(['-s', serial, 'shell', 'cmd', 'uimode', 'night', 'yes']);
  onCleanup('android demo mode', () => {
    adb(buildDemoModeExitCommand(serial));
  });
  const apk = args.appPath ? resolve(args.appPath) : resolveAndroidApk().apkPath;
  console.log(`${LOG} android: installing ${apk}...`);
  adb(['-s', serial, 'uninstall', SHOWCASE_ANDROID_PACKAGE]);
  const install = adb(['-s', serial, 'install', '-r', '-g', apk]);
  if (install.status !== 0) throw new Error(`adb install failed: ${install.stderr.trim() || install.stdout.trim()}`);
  // Notifications allowed without a prompt (the island take films the session notification).
  adb(['-s', serial, 'shell', 'pm', 'grant', SHOWCASE_ANDROID_PACKAGE, 'android.permission.POST_NOTIFICATIONS']);
  // The emulator's localhost is its own: map Metro (and a local backend) onto the host's.
  const ports = [metroPort, ...(backendUrl ? [Number(new URL(backendUrl).port)] : [])];
  for (const port of ports) {
    const reverse = adb(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
    if (reverse.status !== 0) throw new Error(`adb reverse tcp:${port} failed: ${reverse.stderr.trim()}`);
  }

  const metroLog = resolve(LOG_DIR, 'metro-primary.log');
  console.log(`${LOG} android: starting Metro on ${metroPort} (log ${relative(ROOT_DIR, metroLog)})...`);
  const phone: Phone = {
    platform: 'android',
    role: 'primary',
    spec: { name: SHOWCASE_ANDROID_DEVICE.avdName, typeId: '', screen: SHOWCASE_ANDROID_DEVICE.screen },
    device: { udid: serial, name: SHOWCASE_ANDROID_DEVICE.avdName, state: 'Booted' },
    appPath: apk,
    metroPort,
    metroLog,
    metro: null,
  };
  phone.metro = startMetro(metroPort, env, metroLog);
  if (!(await waitForHttp(`http://localhost:${metroPort}/status`, 120_000))) {
    throw new Error(`Metro on ${metroPort} never answered /status; see ${metroLog}`);
  }
  await prewarmBundle(metroPort, 'android');
  await relaunch(phone);
  cleanAndroidStatusBar(serial);
  return phone;
}

/**
 * A clean status bar (09:41, full bars and battery) and a shade without the
 * system's own notifications. SystemUI drops a demo-mode broadcast that lands
 * while it is still settling after boot, and nothing reports whether one took,
 * so every take re-sends them (idempotent, well under a second).
 */
function cleanAndroidStatusBar(serial: string): void {
  for (const command of buildDemoModeCommands(serial)) adb(command);
  adb(buildSnoozeSystemNotificationsArgs(serial));
}

/** Cold-start the dev-client against its Metro and wait for home. */
async function relaunchAndroid(phone: Phone): Promise<LogWindow> {
  const window = new LogWindow(phone.metroLog);
  const attempts = 3;
  // A take that ends in the notification shade leaves it open over the app,
  // where it would swallow the next flow's taps (the session-end Stop first).
  adb(['-s', phone.device.udid, 'shell', 'cmd', 'statusbar', 'collapse']);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    adb(['-s', phone.device.udid, 'shell', 'am', 'force-stop', SHOWCASE_ANDROID_PACKAGE]);
    adb([
      '-s',
      phone.device.udid,
      'shell',
      `am start -a android.intent.action.VIEW -d '${androidDevClientUrl(phone.metroPort)}' ${SHOWCASE_ANDROID_PACKAGE}`,
    ]);
    const deadline = Date.now() + HOME_READY_TIMEOUT_MS / attempts;
    while (Date.now() < deadline) {
      window.pull();
      if (countHomeReady(window.text) > 0) return window;
      await sleep(1000);
    }
    console.warn(`${LOG} android: app not home after launch ${attempt}/${attempts}.`);
  }
  const screenshot = resolve(LOG_DIR, `${phone.role}-not-home.png`);
  deviceScreenshot(phone, screenshot);
  throw new Error(
    `The Android app never reached home (screen: ${relative(ROOT_DIR, screenshot)}). ` +
      `Last Metro lines:\n${window.text.split('\n').slice(-25).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Recording

/** One take being filmed: when frames started, and a stop that leaves `file` finalised on this machine. */
type Recording = Readonly<{ startedAt: Promise<number>; file: string; stop: () => Promise<number> }>;

function startRecording(phone: Phone, file: string): Recording {
  mkdirSync(dirname(file), { recursive: true });
  return phone.platform === 'ios' ? startIosRecording(phone.device.udid, file) : startAndroidRecording(phone, file);
}

function startIosRecording(udid: string, file: string): Recording {
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
  // SIGINT is the only stop that finalises the container; anything harder
  // leaves an unplayable file.
  const stop = async (): Promise<number> => {
    const stoppedAt = Date.now();
    child.kill('SIGINT');
    const exited = once(child, 'exit');
    const timeout = sleep(20_000).then(() => 'timeout' as const);
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`recordVideo did not finalise ${file} within 20s`);
    }
    liveChildren.delete(child);
    return stoppedAt;
  };
  return { startedAt, file, stop };
}

/**
 * `adb shell screenrecord` stops itself after 180 s, so a longer take records
 * in parts: when one part ends on the cap, the next starts. Stop sends SIGINT
 * to screenrecord ON THE DEVICE (killing the local adb client leaves the mp4
 * without its index), pulls every part and joins them.
 */
function startAndroidRecording(phone: Phone, file: string): Recording {
  const serial = phone.device.udid;
  const takeKey = basename(file).replace(/\.[a-z0-9]+$/, '');
  const parts: string[] = [];
  const state: { current: ChildProcess | null; stopping: boolean; started: boolean } = {
    current: null,
    stopping: false,
    started: false,
  };
  let resolveStarted: (atMs: number) => void = () => {};
  const startedAt = new Promise<number>((resolvePromise) => {
    resolveStarted = resolvePromise;
  });
  const startPart = (): void => {
    const remote = screenrecordRemotePath(takeKey, parts.length);
    parts.push(remote);
    const spawnedAt = Date.now();
    const child = spawn(adbBinary(), buildScreenrecordArgs(serial, remote), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: androidEnv(),
    });
    state.current = child;
    liveChildren.add(child);
    if (!state.started) {
      const fallback = setTimeout(() => {
        if (state.started) return;
        state.started = true;
        console.warn(`${LOG} screenrecord printed no start line; assuming it started 1s after spawn.`);
        resolveStarted(spawnedAt + 1000);
      }, 8000);
      const watch = (chunk: Buffer): void => {
        if (!state.started && chunk.toString('utf8').split('\n').some(isScreenrecordStartedLine)) {
          state.started = true;
          clearTimeout(fallback);
          resolveStarted(Date.now());
        }
      };
      child.stdout?.on('data', watch);
      child.stderr?.on('data', watch);
    }
    child.on('exit', () => {
      liveChildren.delete(child);
      if (!state.stopping) startPart();
    });
  };
  startPart();
  const stop = async (): Promise<number> => {
    const stoppedAt = Date.now();
    state.stopping = true;
    adb(['-s', serial, 'shell', 'pkill', '-INT', 'screenrecord']);
    const running = state.current;
    if (running && running.exitCode === null) {
      const exited = once(running, 'exit');
      const timeout = sleep(20_000).then(() => 'timeout' as const);
      if ((await Promise.race([exited, timeout])) === 'timeout') running.kill('SIGKILL');
    }
    // screenrecord finalises the file a beat after it exits on SIGINT.
    await sleep(1000);
    const localParts: string[] = [];
    for (const [index, remote] of parts.entries()) {
      const local = parts.length === 1 ? file : `${file}.part${index}.mp4`;
      const pulled = adb(['-s', serial, 'pull', remote, local]);
      adb(['-s', serial, 'shell', 'rm', '-f', remote]);
      if (pulled.status !== 0) throw new Error(`adb pull ${remote} failed: ${pulled.stderr.trim()}`);
      localParts.push(local);
    }
    if (localParts.length > 1) {
      const listFile = `${file}.parts.txt`;
      writeFileSync(listFile, buildConcatList(localParts));
      const joined = spawnSync(resolveMediaBinary('ffmpeg'), buildConcatArgs(listFile, file), { encoding: 'utf8' });
      for (const part of [...localParts, listFile]) rmSync(part, { force: true });
      if (joined.status !== 0) throw new Error(`ffmpeg could not join the parts of ${file}: ${joined.stderr.trim()}`);
    }
    return stoppedAt;
  };
  return { startedAt, file, stop };
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
    marks: ReadonlyMap<string, number>;
    arrivals: readonly AnchorArrival[];
    logText: string;
    extraProblems: readonly string[];
    dirs: ShowcaseWorkDirs;
    screen: Readonly<{ width: number; height: number }>;
  }>,
): Promise<TakeResult> {
  const { take, args, dirs } = options;
  const trimSeconds = resolveTrimSeconds({
    recordStartMs: options.recordStartMs,
    flowStartMs: options.marks.get(FLOW_START_MARK) ?? null,
    fallbackSeconds: take.trimSeconds,
  });
  const durationSeconds = Math.floor(((options.stoppedAtMs - options.recordStartMs) / 1000 - trimSeconds) * 30) / 30;
  const footageDir = resolve(dirs.footage, take.id);
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
    return failed(take, [
      ...options.extraProblems,
      `[${take.id}] ffmpeg could not extract frames from ${options.rawFile}: ${ffmpeg.stderr.trim()}`,
    ]);
  }
  const frames = readdirSync(footageDir).filter((file) => file.endsWith('.jpg')).length;
  const seconds = frames / 30;
  const firstFrame = resolve(footageDir, '00001.jpg');
  const firstFrameBlank = frames > 0 ? isBlankFrame(await frameStdevs(firstFrame)) : true;
  const referenceDiffRatio = frames > 0 ? await referenceDiff(take.id, firstFrame) : null;

  const staticAnchors = take.staticAnchors.flatMap((staticAnchor) => {
    const markMs = options.marks.get(staticAnchor.fromMark);
    return markMs === undefined ? [] : [{ ...staticAnchor, markMs }];
  });
  const anchors: ShowcaseAnchorsFile = buildAnchorsFile({
    takeId: take.id,
    arrivals: options.arrivals,
    recordStartMs: options.recordStartMs,
    trimSeconds,
    durationSeconds: seconds,
    screen: options.screen,
    staticAnchors,
  });
  mkdirSync(dirs.anchors, { recursive: true });
  writeFileSync(resolve(dirs.anchors, `${take.id}.json`), `${JSON.stringify(anchors, null, 2)}\n`);
  const marksFile = buildMarksFile({
    takeId: take.id,
    marks: options.marks,
    arrivals: options.arrivals,
    anchorMarks: take.anchorMarks,
    recordStartMs: options.recordStartMs,
    trimSeconds,
    durationSeconds: seconds,
  });
  mkdirSync(dirs.marks, { recursive: true });
  writeFileSync(resolve(dirs.marks, `${take.id}.json`), `${JSON.stringify(marksFile, null, 2)}\n`);

  let boardProblem: string | null = null;
  if (take.board?.slot !== undefined && take.board.slot !== null) {
    boardProblem = findBoardSlotProblem(options.logText, take.board.slot, take.board.kind);
  } else if (take.board) {
    const link = SHOWCASE_BOARD_CONFIG_LINKS[take.board.kind] ?? take.board.kind;
    boardProblem = findBoardHandoffProblem(options.logText, link);
  }

  const problems = [
    ...options.extraProblems,
    ...checkTake({
      takeId: take.id,
      expectedAnchors: [...take.expectedAnchors, ...take.staticAnchors.map((staticAnchor) => staticAnchor.name)],
      anchors,
      footageSeconds: seconds,
      minSeconds: take.minSeconds,
      firstFrameBlank,
      referenceDiffRatio,
      boardProblem,
      skipAnchorCheck: args.skipAnchorCheck,
    }),
  ];
  console.log(
    `${LOG} [${take.id}] trim ${trimSeconds.toFixed(2)}s -> ${frames} frames (${seconds.toFixed(2)}s), ` +
      `anchors: ${Object.keys(anchors.anchors).join(', ') || 'none'}; ` +
      `marks: ${
        Object.entries(marksFile.marks)
          .map(([name, at]) => `${name}@${at}s`)
          .join(', ') || 'none'
      }`,
  );
  return { takeId: take.id, problems, frames, seconds };
}

const failed = (take: ShowcaseTake, problems: string[]): TakeResult => ({
  takeId: take.id,
  problems,
  frames: 0,
  seconds: 0,
});

// ---------------------------------------------------------------------------
// Takes

type RunContext = {
  args: ShowcaseRecordArgs;
  /** Where this platform's footage, anchors and marks go. */
  dirs: ShowcaseWorkDirs;
  primary: Phone;
  secondary: Phone | null;
  signal: SignalServer;
  /** Whether a take left a live session running on the account that the teardown must end. */
  session: { open: boolean; cleanupRegistered: boolean };
};

/** The flow that switches "Show this session live" off before a session take starts one. */
const SESSION_PRIVATE_FLOW = 'session-private.yaml';
/** The flows that end a live session (the crew teardown). */
const SESSION_END_FLOWS = ['session-end.yaml'] as const;

function noteSessionStarted(context: RunContext, logText: string): void {
  const { session } = context;
  if (!sessionStarted(logText) || session.open) return;
  session.open = true;
  if (!session.cleanupRegistered) {
    session.cleanupRegistered = true;
    onCleanup('end the live session', () => endSession(context, 'teardown'));
  }
}

async function runFlow(context: RunContext, flow: string, label: string): Promise<number> {
  return runMaestro({
    udid: context.primary.device.udid,
    flowFile: showcaseFlowPathFor(flow, context.primary.platform),
    label,
    signalUrl: context.signal.url,
  });
}

async function recordTake(context: RunContext, take: ShowcaseTake): Promise<TakeResult> {
  const { primary, signal } = context;
  console.log(`\n${LOG} === ${take.id}: ${take.summary}`);
  signal.reset();
  let window = await relaunch(primary);
  if (primary.platform === 'android') cleanAndroidStatusBar(primary.device.udid);
  const leftover = take.privateSession ? restoredSessionId(window.text) : null;
  if (leftover) {
    // An earlier run died before its teardown; end that session first, or the
    // Record tab opens in-session and the setup flows tap the wrong things.
    console.warn(`${LOG} [${take.id}] ending session ${leftover} left over from an earlier run...`);
    context.session.open = true;
    await endSession(context, take.id);
    if (context.session.open) {
      return failed(take, [
        `[${take.id}] a session left over from an earlier run (${leftover}) would not end; run --end-session ${leftover}`,
      ]);
    }
    window = await relaunch(primary);
  }
  const primeStatus = await runMaestro({
    udid: primary.device.udid,
    flowFile: writeNavigationFlow(`prime-${take.id}`, take.primeLinks, 3000, primary.platform),
    label: `${take.id}-prime`,
    signalUrl: signal.url,
  });
  if (primeStatus !== 0)
    return failed(take, [`[${take.id}] could not open its deep links (Maestro exit ${primeStatus})`]);

  if (take.privateSession) {
    await runFlow(context, SESSION_PRIVATE_FLOW, `${take.id}-private`);
    await sleep(1000);
    window.pull();
    if (!sessionVisibilityIsOff(window.text)) {
      return failed(take, [
        `[${take.id}] "Show this session live" was not switched off, so no session was started. ` +
          `Check the switch's point in ${SESSION_PRIVATE_FLOW}, and that no session is running on the account.`,
      ]);
    }
  }

  let secondaryRun: Promise<number> | null = null;
  let secondaryChild: ChildProcess | null = null;
  if (take.secondary) {
    const prepared = await prepareCrew(context, take);
    if (typeof prepared === 'string') return failed(take, [prepared]);
    secondaryRun = runMaestro({
      udid: prepared.udid,
      flowFile: showcaseFlowPathFor(take.secondary.flow, context.secondary?.platform ?? 'ios'),
      label: `${take.id}-secondary`,
      signalUrl: signal.url,
      child: (child) => {
        secondaryChild = child;
      },
    });
    const readyBy = Date.now() + 60_000;
    while (!signal.marks.has('secondary-ready') && Date.now() < readyBy) await sleep(250);
    if (!signal.marks.has('secondary-ready')) {
      return failed(take, [`[${take.id}] the second phone's flow never started (no secondary-ready mark within 60s)`]);
    }
  } else {
    for (const flow of take.setupFlows) {
      if (!isShowcaseFlow(flow)) {
        await relaunch(primary);
        continue;
      }
      const status = await runFlow(context, flow, `${take.id}-setup`);
      window.pull();
      noteSessionStarted(context, window.text);
      if (status !== 0) return failed(take, [`[${take.id}] setup flow ${flow} failed (Maestro exit ${status})`]);
    }
  }

  const rawFile = resolve(context.dirs.raw, `${take.id}.${primary.platform === 'ios' ? 'mov' : 'mp4'}`);
  // Anchors logged while the take was being set up (the invite sheet laid out
  // before recording, say) are in force when the footage starts: stamp them
  // "before the start" and buildAnchorsFile pins them to t = 0.
  window.pull();
  const arrivals: AnchorArrival[] = [...anchorArrivalsFromChunk(window.text, 0)];
  const recording = startRecording(primary, rawFile);
  const poll = setInterval(() => {
    const fresh = anchorArrivalsFromChunk(window.pull(), Date.now());
    arrivals.push(...fresh);
    for (const arrival of fresh) {
      for (const [name, value] of Object.entries(anchorTapValues(arrival.line, primary.spec.screen))) {
        signal.values.set(name, value);
      }
    }
  }, 100);
  let recordStartMs = 0;
  let stoppedAtMs = 0;
  const extraProblems: string[] = [];
  try {
    recordStartMs = await recording.startedAt;
    const flowStatus = await runFlow(context, take.flow, take.id);
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
    stoppedAtMs = await recording.stop();
    clearInterval(poll);
    arrivals.push(...anchorArrivalsFromChunk(window.pull(), Date.now()));
  }
  // The workouts take starts its session on camera.
  noteSessionStarted(context, window.text);
  const marks = new Map(signal.marks);
  if (context.session.open) await endSession(context, take.id);

  return processTake({
    take,
    args: context.args,
    rawFile,
    recordStartMs,
    stoppedAtMs,
    marks,
    arrivals,
    logText: window.text,
    extraProblems,
    dirs: context.dirs,
    screen: primary.spec.screen,
  });
}

/** End the live session a take started. Relaunches first so no open sheet swallows the Stop tap. */
async function endSession(context: RunContext, label: string): Promise<void> {
  if (!context.session.open) return;
  // The app restores the session on launch, so the Record tab comes back in-session.
  await relaunch(context.primary);
  const window = new LogWindow(context.primary.metroLog);
  for (const flow of SESSION_END_FLOWS) await runFlow(context, flow, `${label}-end-session`);
  const endedBy = Date.now() + 10_000;
  while (!window.text.includes('[analytics] Session Ended') && Date.now() < endedBy) {
    window.pull();
    await sleep(500);
  }
  if (window.text.includes('[analytics] Session Ended')) {
    context.session.open = false;
    console.log(`${LOG} [${label}] live session ended.`);
  } else {
    console.warn(
      `${LOG} [${label}] could not confirm the live session ended; teardown retries once on exit, ` +
        `or run: vp run video:record -- --end-session <id>`,
    );
  }
}

/**
 * `--end-session <id>`: end a session a crashed run left running. A fresh
 * install forgets which session the app was in, so rejoin it by link first (the
 * primary account created it, so the server lets it end it), then end it.
 */
async function endStraySession(context: RunContext, sessionId: string): Promise<void> {
  const crew = SHOWCASE_TAKES.find((take) => take.secondary);
  if (!crew?.secondary) throw new Error('No take in the registry knows how to join a session');
  const { primary, signal } = context;
  const window = await relaunch(primary);
  await runMaestro({
    udid: primary.device.udid,
    flowFile: writeNavigationFlow('end-session-link', [`join/${sessionId}`], 1500, primary.platform),
    label: 'end-session-link',
    signalUrl: signal.url,
  });
  await runFlow(context, crew.secondary.joinFlow, 'end-session-join');
  const joinedBy = Date.now() + 15_000;
  while (!window.text.includes('[analytics] Session Joined') && Date.now() < joinedBy) {
    window.pull();
    await sleep(500);
  }
  if (!window.text.includes('[analytics] Session Joined')) {
    const screenshot = resolve(LOG_DIR, 'end-session.png');
    deviceScreenshot(primary, screenshot);
    throw new Error(
      `Could not rejoin session ${sessionId}: already ended ("Session not found"), or the Join point moved ` +
        `(screen: ${relative(ROOT_DIR, screenshot)}).`,
    );
  }
  context.session.open = true;
  await endSession(context, 'end-session');
}

/**
 * Crew setup (after the private-session switch): start the session and copy
 * its invite link on the primary, then join the second phone and park it on
 * Climbs. Returns the secondary's UDID, or the problem.
 */
async function prepareCrew(context: RunContext, take: ShowcaseTake): Promise<{ udid: string } | string> {
  const { primary, secondary, signal } = context;
  if (!secondary || !take.secondary) return `[${take.id}] needs the second phone, which was not set up`;
  const [startFlow, ...inviteFlows] = take.setupFlows;
  const window = new LogWindow(primary.metroLog);
  let sessionId: string | null = null;
  if (primary.platform === 'ios') {
    simctl(['pbcopy', primary.device.udid], process.env);
    await runFlow(context, startFlow, `${take.id}-start`);
    window.pull();
    noteSessionStarted(context, window.text);
    const invite = simctl(['pbpaste', primary.device.udid]).stdout;
    sessionId = parseSessionIdFromInviteUrl(invite);
    if (!context.session.open || !sessionId) {
      return (
        `[${take.id}] the session did not start or its invite link was not copied (clipboard: ` +
        `${invite.trim() ? 'no session link' : 'empty'}). Check the Start / Invite / Copy link points in ${startFlow}.`
      );
    }
  } else {
    // No clipboard to read back on the emulator. A relaunch restores the
    // session and logs its id; then the remaining setup flows open the invite.
    await runFlow(context, startFlow, `${take.id}-start`);
    window.pull();
    noteSessionStarted(context, window.text);
    if (!context.session.open) return `[${take.id}] the session did not start; check the Start point in ${startFlow}`;
    const relaunched = await relaunch(primary);
    const idBy = Date.now() + 10_000;
    while (!restoredSessionId(relaunched.text) && Date.now() < idBy) {
      relaunched.pull();
      await sleep(250);
    }
    sessionId = restoredSessionId(relaunched.text);
    if (!sessionId) return `[${take.id}] the app did not log the session it restored after a relaunch`;
    for (const flow of inviteFlows) await runFlow(context, flow, `${take.id}-invite`);
  }
  console.log(`${LOG} [${take.id}] hidden session ${sessionId} started; sending the second phone in.`);

  const secondaryWindow = await relaunch(secondary);
  const joinStatus = await runMaestro({
    udid: secondary.device.udid,
    flowFile: writeNavigationFlow(`${take.id}-join-link`, [`join/${sessionId}`], 1500, secondary.platform),
    label: `${take.id}-join-link`,
    signalUrl: signal.url,
  });
  const joined =
    joinStatus === 0 &&
    (await runMaestro({
      udid: secondary.device.udid,
      flowFile: showcaseFlowPathFor(take.secondary.joinFlow, secondary.platform),
      label: `${take.id}-join`,
      signalUrl: signal.url,
    })) === 0;
  if (!joined) return `[${take.id}] the second phone could not join session ${sessionId}; see its Maestro log`;
  // The Join tap is a coordinate; prove it landed before filming a take whose
  // whole point is the second account's row.
  const joinDeadline = Date.now() + 15_000;
  while (!secondaryWindow.text.includes('[analytics] Session Joined') && Date.now() < joinDeadline) {
    secondaryWindow.pull();
    await sleep(500);
  }
  if (!secondaryWindow.text.includes('[analytics] Session Joined')) {
    const screenshot = resolve(LOG_DIR, 'crew-secondary-join.png');
    simctl(['io', secondary.device.udid, 'screenshot', screenshot]);
    return (
      `[${take.id}] the second phone never logged "Session Joined" (screen: ${relative(ROOT_DIR, screenshot)}). ` +
      `Check the Join point in ${take.secondary.joinFlow}.`
    );
  }
  const toClimbs = await runMaestro({
    udid: secondary.device.udid,
    flowFile: writeNavigationFlow(`${take.id}-secondary-climbs`, ['home', 'climbs'], 2500, secondary.platform),
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
  const dirs = showcaseWorkDirs(args.platform);
  console.log(
    `${LOG} platform: ${args.platform}; backend: ${args.backend}; boards: ${args.boards ?? SHOWCASE_DEFAULT_BOARDS[args.backend]}`,
  );
  console.log(`${LOG} env file: ${args.envFile} (${envFileFound ? 'found' : 'not found'})`);
  for (const key of ENV_FILE_KEYS) console.log(`${LOG}   ${key}: ${process.env[key] ? 'set' : 'unset'}`);
  const primaryName = args.platform === 'android' ? SHOWCASE_ANDROID_DEVICE.avdName : SHOWCASE_DEVICES.primary.name;
  console.log(
    `${LOG} devices: ${primaryName}${takes.some((take) => take.secondary) ? `, ${SHOWCASE_DEVICES.secondary.name} (iOS)` : ''}`,
  );
  for (const take of takes) {
    const flows = [
      ...take.deviceSetupFlows,
      ...(take.privateSession ? [SESSION_PRIVATE_FLOW] : []),
      ...take.setupFlows,
      take.flow,
      ...(take.secondary ? [take.secondary.joinFlow, take.secondary.flow] : []),
      ...take.teardownFlows,
    ];
    const missing = flows.filter(
      (flow) => isShowcaseFlow(flow) && !existsSync(showcaseFlowPathFor(flow, args.platform)),
    );
    console.log(
      `${LOG} ${take.id.padEnd(17)} ${take.minSeconds.toFixed(1)}s min | links ${take.primeLinks.join(' -> ')} | ` +
        `flows ${flows.join(', ')}${missing.length ? ` | MISSING ${missing.join(', ')}` : ''}` +
        `${take.expectedAnchors.length ? ` | anchors ${take.expectedAnchors.join(', ')}` : ''}` +
        `${take.staticAnchors.length ? ` | static ${take.staticAnchors.map((anchor) => anchor.name).join(', ')}` : ''}`,
    );
  }
  console.log(
    `${LOG} footage -> ${dirs.footage}/<take>/%05d.jpg, anchors -> ${dirs.anchors}/<take>.json, marks -> ${dirs.marks}/<take>.json`,
  );
}

function preflight(platform: ShowcasePlatform): void {
  if (process.platform !== 'darwin') throw new Error(macOsOnlyMessage(platform));
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
  const wanted = SHOWCASE_TAKES.filter((take) => selected.includes(take.id)).map((take) =>
    takeForPlatform(take, args.platform),
  );
  const takes = wanted.filter((take) => !take.unavailable[args.backend]);
  for (const take of wanted) {
    const reason = take.unavailable[args.backend];
    if (reason) console.warn(`${LOG} skipping ${take.id} on ${args.backend}: ${reason}`);
  }
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
    preflight(args.platform);
    // The recorder picks its own simulators; a selection meant for another tool
    // must not redirect it.
    delete process.env.BOARDSESH_IOS_SIMULATOR_UDID;
    const needsSecondary = !args.endSession && takes.some((take) => take.secondary);
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
    // The iOS dev-client: the primary phone on iOS, and the crew take's second
    // phone on either platform (see "Android" in docs/showcase-video.md).
    const needsIosApp = args.platform === 'ios' || Boolean(credentials.secondary);
    // --app-path, else the cached dev-client, else build one (~30 min, once).
    const cachedApp = resolve(MOBILE_DIR, '.app-cache', 'Boardsesh.app');
    const requestedApp =
      args.appPath && args.platform === 'ios' ? resolve(args.appPath) : existsSync(cachedApp) ? cachedApp : null;
    const appPath = needsIosApp ? resolveAppPath(screenshotOptions(args, requestedApp)) : '';
    if (args.platform === 'ios') {
      const keychainProblem = findKeychainTeamProblem(
        readPlistString(resolve(appPath, 'Info.plist'), 'BoardseshKeychainAccessGroup'),
        readFileSync(SIM_ENTITLEMENTS, 'utf8'),
        relative(ROOT_DIR, SIM_ENTITLEMENTS),
      );
      if (keychainProblem) {
        // Only the island take reads the shared keychain; the rest are unaffected.
        if (takes.some((take) => take.id === 'lock-screen')) throw new Error(keychainProblem);
        console.warn(`${LOG} ${keychainProblem}`);
      }
    }
    const primaryEnv = metroEnv(args, credentials.primary, backendUrl);
    const primary =
      args.platform === 'android'
        ? await prepareAndroidPhone(args, PRIMARY_METRO_PORT, primaryEnv, backendUrl)
        : await preparePhone('primary', appPath, PRIMARY_METRO_PORT, primaryEnv, signal);

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

    const context: RunContext = {
      args,
      dirs: showcaseWorkDirs(args.platform),
      primary,
      secondary,
      signal,
      session: { open: false, cleanupRegistered: false },
    };
    for (const flow of new Set(takes.flatMap((take) => take.deviceSetupFlows))) {
      console.log(`${LOG} device setup: ${flow}`);
      const status = await runFlow(context, flow, 'device-setup');
      if (status !== 0)
        console.warn(`${LOG} device setup ${flow} exited ${status}; the takes that need it may show it.`);
    }
    const mode = recordRunMode(args);
    if (mode === 'hold') {
      console.log(
        `${LOG} Holding ${primary.device.name} (${primary.device.udid}) with Metro on ${primary.metroPort}; ` +
          'calibrate flows, then Ctrl-C to tear down.',
      );
      await new Promise<never>(() => {});
    }
    if (mode === 'end-session' && args.endSession) {
      await endStraySession(context, args.endSession);
      await teardown();
      return context.session.open ? 1 : 0;
    }
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
  console.log(`${LOG} Footage: ${showcaseWorkDirs(args.platform).footage}`);
  console.log(`${LOG} Next: vp run video:render${args.platform === 'ios' ? '' : ` -- --platform ${args.platform}`}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
