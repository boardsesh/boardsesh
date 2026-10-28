/**
 * Fold and unfold the iPhone Duo simulator from a script, with no Device Hub.
 *
 * The Duo has two displays: the outer one (simctl `--display=primary`,
 * 1398x2034) lights up while the phone is closed, the inner one
 * (`--display=primary-1`, 2007x2853 portrait / 2853x2007 landscape) while it is
 * open. A freshly booted Duo simulator is closed. Xcode only changes the pose
 * from Device Hub's buttons, which a headless CI runner cannot click, so this
 * module loads `scripts/ios-duo-hinge/duo-hinge.m` into the simulator's
 * SpringBoard and asks SpringBoard's own display-swap test service for the
 * sweep. See that file for why it has to run inside SpringBoard.
 *
 * Maestro's `takeScreenshot` always grabs the outer display (black while the
 * phone is open), so inner-display shots are captured here with
 * `simctl io screenshot --display=primary-1`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DuoPose = 'closed' | 'open';

export const DUO_HINGE_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../ios-duo-hinge/duo-hinge.m');
export const DUO_HINGE_SWAP_NOTIFICATION = 'com.boardsesh.duo-hinge.swap';
/** simctl display names: the outer display shows while closed, the inner one while open. */
export const DUO_DISPLAY_FOR_POSE: Readonly<Record<DuoPose, string>> = { closed: 'primary', open: 'primary-1' };

const LOG = '[duo-hinge]';
/** Brightest channel value that still counts as an unlit display. */
const UNLIT_CHANNEL_MAX = 8;

export function simulatorArch(hostArch: string = process.arch): 'arm64' | 'x86_64' {
  return hostArch === 'x64' ? 'x86_64' : 'arm64';
}

/** `xcrun` arguments that compile the hinge library for the simulator. */
export function duoHingeCompileArgs(source: string, output: string, arch = simulatorArch()): string[] {
  return [
    '-sdk',
    'iphonesimulator',
    'clang',
    '-arch',
    arch,
    '-mios-simulator-version-min=17.0',
    '-fobjc-arc',
    '-framework',
    'Foundation',
    '-dynamiclib',
    source,
    '-o',
    output,
  ];
}

/** SpringBoard's pid from the simulator's `launchctl list` output, or null. */
export function springBoardPid(launchctlList: string): number | null {
  for (const line of launchctlList.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label === 'com.apple.SpringBoard' && /^\d+$/.test(pid ?? '')) return Number.parseInt(pid, 10);
  }
  return null;
}

/**
 * True when an uncompressed BMP (what `sips -s format bmp` writes) holds no
 * lit pixel. 32-bit rows carry alpha in every fourth byte, which is skipped.
 */
export function isUnlitBmp(bmp: Buffer): boolean {
  if (bmp.length < 54 || bmp.toString('ascii', 0, 2) !== 'BM') throw new Error('not a BMP');
  const pixelOffset = bmp.readUInt32LE(10);
  const bitsPerPixel = bmp.readUInt16LE(28);
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) throw new Error(`unsupported BMP depth ${bitsPerPixel}`);
  const bytesPerPixel = bitsPerPixel / 8;
  for (let offset = pixelOffset; offset + bytesPerPixel <= bmp.length; offset += bytesPerPixel) {
    if (bmp[offset] > UNLIT_CHANNEL_MAX || bmp[offset + 1] > UNLIT_CHANNEL_MAX || bmp[offset + 2] > UNLIT_CHANNEL_MAX)
      return false;
  }
  return true;
}

/** The pose implied by which display is lit, or null while neither (or both) is. */
export function poseFromLitDisplays(outerLit: boolean, innerLit: boolean): DuoPose | null {
  if (outerLit === innerLit) return null;
  return innerLit ? 'open' : 'closed';
}

function run(command: string, args: string[], timeoutMs = 60_000): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sleepSeconds(seconds: number): void {
  spawnSync('sleep', [String(seconds)]);
}

function readLog(logPath: string): string {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

/** Compile (once per source change) and ad-hoc sign the hinge library. Returns its path. */
export function buildDuoHingeLibrary(outputDir: string): string {
  mkdirSync(outputDir, { recursive: true });
  const library = join(outputDir, `duo-hinge-${simulatorArch()}.dylib`);
  if (existsSync(library) && statSync(library).mtimeMs >= statSync(DUO_HINGE_SOURCE).mtimeMs) return library;
  const compile = run('xcrun', duoHingeCompileArgs(DUO_HINGE_SOURCE, library), 180_000);
  if (compile.status !== 0) {
    throw new Error(`${LOG} could not compile ${DUO_HINGE_SOURCE}: ${compile.stderr.trim()}`);
  }
  const sign = run('codesign', ['--sign', '-', '--force', library]);
  if (sign.status !== 0) throw new Error(`${LOG} could not sign ${library}: ${sign.stderr.trim()}`);
  return library;
}

function simctlSpawn(udid: string, args: string[], timeoutMs?: number) {
  return run('xcrun', ['simctl', 'spawn', udid, ...args], timeoutMs);
}

/** True when the display shows anything at all. */
/** True when a saved screenshot shows anything at all. */
export function pngIsLit(png: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'boardsesh-duo-'));
  try {
    const bmp = join(scratch, 'display.bmp');
    if (run('sips', ['-s', 'format', 'bmp', '--resampleWidth', '96', png, '--out', bmp]).status !== 0) return false;
    return !isUnlitBmp(readFileSync(bmp));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** True when the display shows anything at all. */
export function duoDisplayLit(udid: string, display: string): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'boardsesh-duo-'));
  try {
    const png = join(scratch, 'display.png');
    if (run('xcrun', ['simctl', 'io', udid, 'screenshot', `--display=${display}`, png]).status !== 0) return false;
    return pngIsLit(png);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function currentDuoPose(udid: string): DuoPose | null {
  return poseFromLitDisplays(
    duoDisplayLit(udid, DUO_DISPLAY_FOR_POSE.closed),
    duoDisplayLit(udid, DUO_DISPLAY_FOR_POSE.open),
  );
}

function waitFor(condition: () => boolean, timeoutSeconds: number, intervalSeconds = 1): boolean {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (condition()) return true;
    sleepSeconds(intervalSeconds);
  }
  return condition();
}

/**
 * Load the hinge library into the booted simulator's SpringBoard. The
 * environment variable is set only long enough for the restarted SpringBoard to
 * pick it up, so the app launched afterwards never sees it.
 */
export function installDuoHinge(udid: string, library: string, logPath: string): void {
  writeFileSync(logPath, '');
  const previousPid = springBoardPid(simctlSpawn(udid, ['launchctl', 'list']).stdout);
  if (previousPid === null) throw new Error(`${LOG} SpringBoard is not running on ${udid}.`);
  const launchctl = (args: string[]): void => {
    const result = simctlSpawn(udid, ['launchctl', ...args]);
    if (result.status !== 0) {
      throw new Error(
        `${LOG} \`launchctl ${args.slice(0, 2).join(' ')}\` failed in simulator ${udid} (exit ${result.status}): ${result.stderr.trim() || '(no output)'}`,
      );
    }
  };
  let installError: unknown = null;
  try {
    launchctl(['setenv', 'DYLD_INSERT_LIBRARIES', library]);
    launchctl(['setenv', 'BOARDSESH_DUO_HINGE_LOG', logPath]);
    // Simulator processes are host processes, so the host can restart it.
    process.kill(previousPid, 'SIGKILL');
    if (!waitFor(() => readLog(logPath).includes('coordinator ready'), 90, 2)) {
      throw new Error(
        `${LOG} SpringBoard did not load the hinge library. Log: ${readLog(logPath).trim() || '(empty)'}`,
      );
    }
  } catch (error) {
    installError = error;
  }
  // Always try both, so one failure cannot leave the other variable behind.
  const unsetErrors: string[] = [];
  for (const name of ['DYLD_INSERT_LIBRARIES', 'BOARDSESH_DUO_HINGE_LOG']) {
    try {
      launchctl(['unsetenv', name]);
    } catch (error) {
      unsetErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (installError) throw installError;
  // A leftover DYLD_INSERT_LIBRARIES would load the library into the app too.
  if (unsetErrors.length > 0) throw new Error(unsetErrors.join('\n'));
  if (!waitFor(() => currentDuoPose(udid) !== null, 60, 2)) {
    throw new Error(`${LOG} no Duo display lit up after the SpringBoard restart.`);
  }
}

/** Fold or unfold to `pose`, verified by which display is lit afterwards. */
export function setDuoPose(udid: string, pose: DuoPose, logPath: string): void {
  if (currentDuoPose(udid) === pose) return;
  const swapsBefore = readLog(logPath).split('swap done').length;
  console.log(`${LOG} Moving the Duo to ${pose}...`);
  simctlSpawn(udid, ['notifyutil', '-p', DUO_HINGE_SWAP_NOTIFICATION]);
  const settled = waitFor(
    () => readLog(logPath).split('swap done').length > swapsBefore && currentDuoPose(udid) === pose,
    30,
    1,
  );
  if (!settled) {
    throw new Error(`${LOG} the Duo did not reach ${pose}. Log: ${readLog(logPath).trim() || '(empty)'}`);
  }
}

/** Screenshot the display that is lit in `pose`. */
export function captureDuoDisplay(udid: string, pose: DuoPose, outputPath: string): number {
  return run('xcrun', ['simctl', 'io', udid, 'screenshot', `--display=${DUO_DISPLAY_FOR_POSE[pose]}`, outputPath])
    .status;
}
