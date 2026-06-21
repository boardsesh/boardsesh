/// <reference types="node" />

/**
 * Android AVD + emulator lifecycle for the local screenshot flow. Boots headless
 * (works on a display-less Linux box; `adb exec-out screencap` captures correctly
 * without a window) and reuses an already-running emulator so an agent can take
 * many shots without rebooting.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandExists, runCapture, runInherit, sleepSeconds } from './exec';
import { SYSTEM_IMAGE, adbPath, avdmanagerPath, emulatorPath, resolveAndroidHome } from './android-sdk';

const LOG = '[android-emulator]';
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOARDSESH_DIR = join(ROOT_DIR, '.boardsesh');
const EMULATOR_LOG = join(BOARDSESH_DIR, 'android-emulator.log');

export const AVD_NAME = 'boardsesh-pixel';
const AVD_DEVICE_PROFILE = 'pixel_6';
const EMULATOR_PORT = 5554;
export const EMULATOR_SERIAL = `emulator-${EMULATOR_PORT}`;

export function avdExists(name: string, env: NodeJS.ProcessEnv): boolean {
  const result = runCapture(avdmanagerPath(resolveAndroidHome()), ['list', 'avd', '-c'], { env });
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(name);
}

export function ensureAvd(env: NodeJS.ProcessEnv, name = AVD_NAME): void {
  if (avdExists(name, env)) return;
  const home = resolveAndroidHome();
  console.log(`${LOG} Creating AVD ${name} (${SYSTEM_IMAGE}, ${AVD_DEVICE_PROFILE})...`);
  // `echo no` declines the "create a custom hardware profile?" prompt.
  const status = runInherit(
    'sh',
    [
      '-c',
      `echo no | "${avdmanagerPath(home)}" create avd -n "${name}" -k "${SYSTEM_IMAGE}" -d ${AVD_DEVICE_PROFILE} --force`,
    ],
    { env },
  );
  if (status !== 0) throw new Error(`Failed to create AVD ${name}`);
}

/** Serial of the first ready `emulator-*` device, or null. */
export function resolveRunningEmulator(env: NodeJS.ProcessEnv): string | null {
  const result = runCapture(adbPath(resolveAndroidHome()), ['devices'], { env });
  if (result.status !== 0) return null;
  const serial = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === 'device' && parts[0].startsWith('emulator-'))
    .map((parts) => parts[0])[0];
  return serial ?? null;
}

function waitForBoot(serial: string, env: NodeJS.ProcessEnv, timeoutSeconds = 300): boolean {
  const adb = adbPath(resolveAndroidHome());
  runCapture(adb, ['-s', serial, 'wait-for-device'], { env });
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const booted = runCapture(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { env });
    if (booted.stdout.trim() === '1') {
      // Dismiss the lock screen so the first screenshot isn't of the keyguard.
      runCapture(adb, ['-s', serial, 'shell', 'input', 'keyevent', '82'], { env });
      runCapture(adb, ['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { env });
      return true;
    }
    sleepSeconds(2);
  }
  return false;
}

export interface BootOptions {
  /** Reuse an already-running emulator instead of booting a new one (default true). */
  reuse?: boolean;
  /** Boot with `-no-window` (default true). */
  headless?: boolean;
}

/** AVD to use — override with BOARDSESH_AVD_NAME to point at a pre-made AVD. */
export function resolveAvdName(): string {
  const override = process.env.BOARDSESH_AVD_NAME;
  return override && override.length > 0 ? override : AVD_NAME;
}

function bootTimeoutSeconds(): number {
  const raw = Number.parseInt(process.env.BOARDSESH_EMULATOR_BOOT_TIMEOUT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

/** Boot (or reuse) the emulator and return its adb serial. */
export function bootEmulator(env: NodeJS.ProcessEnv, options: BootOptions = {}): string {
  const reuse = options.reuse ?? true;
  const headless = options.headless ?? true;
  const avdName = resolveAvdName();

  if (reuse) {
    const running = resolveRunningEmulator(env);
    if (running) {
      console.log(`${LOG} Reusing running emulator ${running}.`);
      if (!waitForBoot(running, env, bootTimeoutSeconds()))
        throw new Error(`Emulator ${running} did not finish booting`);
      return running;
    }
  }

  ensureAvd(env, avdName);
  mkdirSync(BOARDSESH_DIR, { recursive: true });
  const logFd = openSync(EMULATOR_LOG, 'w');

  // GPU renderer is the most host-sensitive knob: swiftshader_indirect is the CI
  // default, but a quirky headless host can override it (e.g. `guest` → lavapipe).
  const gpu = process.env.BOARDSESH_EMULATOR_GPU || 'swiftshader_indirect';
  const args = ['-avd', avdName, '-port', String(EMULATOR_PORT), '-no-snapshot', '-no-audio', '-no-boot-anim'];
  args.push('-gpu', gpu, '-accel', 'auto');
  if (headless) args.push('-no-window');
  const extra = (process.env.BOARDSESH_EMULATOR_EXTRA_ARGS ?? '').trim();
  if (extra) args.push(...extra.split(/\s+/));

  // Headless swiftshader's GL context is steadier under a virtual X server; wrap
  // with xvfb-run when there's no display and it's available.
  let command = emulatorPath(resolveAndroidHome());
  let commandArgs = args;
  const useXvfb = headless && process.platform === 'linux' && !env.DISPLAY && commandExists('xvfb-run');
  if (useXvfb) {
    command = 'xvfb-run';
    commandArgs = ['-a', emulatorPath(resolveAndroidHome()), ...args];
  }

  console.log(
    `${LOG} Booting ${avdName} (headless=${headless}, gpu=${gpu}${useXvfb ? ', xvfb' : ''}); log: ${EMULATOR_LOG}`,
  );
  // Detached + unref so the emulator survives this process (keep-alive default).
  const child = spawn(command, commandArgs, { env, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();

  if (!waitForBoot(EMULATOR_SERIAL, env, bootTimeoutSeconds())) {
    throw new Error(`Emulator did not finish booting within ${bootTimeoutSeconds()}s; see ${EMULATOR_LOG}`);
  }
  console.log(`${LOG} Emulator ${EMULATOR_SERIAL} booted.`);
  return EMULATOR_SERIAL;
}

export function shutdownEmulator(serial: string, env: NodeJS.ProcessEnv): void {
  console.log(`${LOG} Shutting down ${serial}...`);
  runCapture(adbPath(resolveAndroidHome()), ['-s', serial, 'emu', 'kill'], { env });
}

export { EMULATOR_LOG };
