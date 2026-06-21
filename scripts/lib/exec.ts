/// <reference types="node" />

/**
 * Tiny spawn helpers shared by the Android emulator tooling (scripts/lib/android-*,
 * scripts/mobile-android-*). Kept dependency-free so the lib layer never imports a
 * sibling orchestrator script.
 */

import { spawnSync } from 'node:child_process';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Run a command, capturing stdout/stderr. Never throws on a non-zero exit. */
export function runCapture(command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env,
    cwd: options.cwd,
    // sdkmanager listings / `unzip -l` on a big APK overflow the 1MB default.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Run a command streaming its stdio to the console. Returns the exit code. */
export function runInherit(command: string, args: string[], options: RunOptions = {}): number {
  const result = spawnSync(command, args, { stdio: 'inherit', env: options.env, cwd: options.cwd });
  return result.status ?? 1;
}

/** True if `command` resolves on PATH (or is an absolute path that exists/executes). */
export function commandExists(command: string): boolean {
  return spawnSync('command', ['-v', command], { shell: true, stdio: 'ignore' }).status === 0;
}

export function sleepSeconds(seconds: number): void {
  spawnSync('sleep', [String(seconds)]);
}
