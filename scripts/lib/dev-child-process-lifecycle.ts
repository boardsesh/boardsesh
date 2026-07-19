/// <reference types="node" />

import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export type CriticalChildProcess = Pick<ChildProcess, 'exitCode' | 'kill' | 'once' | 'pid' | 'signalCode'>;

/** Unix children lead their own process group so shutdown can include descendants. */
export const criticalChildProcessSpawnOptions = {
  detached: process.platform !== 'win32',
} satisfies Pick<SpawnOptions, 'detached'>;

export type CriticalChildTermination =
  | {
      type: 'error';
      name: string;
      error: Error;
    }
  | {
      type: 'exit';
      name: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    };

type CriticalChildProcessGroupOptions = {
  onUnexpectedTermination: (termination: CriticalChildTermination) => void;
  gracePeriodMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function isChildProcessRunning(childProcess: CriticalChildProcess): boolean {
  return childProcess.exitCode === null && childProcess.signalCode === null;
}

/**
 * Coordinates critical development servers as one lifecycle. Once any child
 * terminates unexpectedly, further child exits are considered part of the
 * coordinated shutdown rather than separate failures.
 */
export class CriticalChildProcessGroup {
  readonly #children: CriticalChildProcess[] = [];
  readonly #gracePeriodMs: number;
  readonly #onUnexpectedTermination: (termination: CriticalChildTermination) => void;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #shutdownExitCode: number | null = null;

  constructor({ onUnexpectedTermination, gracePeriodMs = 1_000, sleep = delay }: CriticalChildProcessGroupOptions) {
    this.#onUnexpectedTermination = onUnexpectedTermination;
    this.#gracePeriodMs = gracePeriodMs;
    this.#sleep = sleep;
  }

  register(name: string, childProcess: CriticalChildProcess): boolean {
    childProcess.once('error', (error) => {
      this.#reportUnexpectedTermination({ type: 'error', name, error });
    });
    childProcess.once('exit', (code, signal) => {
      this.#reportUnexpectedTermination({ type: 'exit', name, code, signal });
    });

    if (this.isShuttingDown) {
      // A child created after the startup barrier closed must not outlive the
      // orchestrator. This is a defensive fallback for callers that miss a
      // pre-spawn barrier check.
      this.#tryKill(childProcess, 'SIGTERM');
      if (childProcess.pid !== undefined || isChildProcessRunning(childProcess)) {
        this.#tryKill(childProcess, 'SIGKILL');
      }
      return false;
    }

    this.#children.push(childProcess);
    return true;
  }

  get isShuttingDown(): boolean {
    return this.#shutdownExitCode !== null;
  }

  get shutdownExitCode(): number {
    return this.#shutdownExitCode ?? 0;
  }

  beginShutdown(exitCode = 0): boolean {
    if (this.isShuttingDown) return false;

    this.#shutdownExitCode = exitCode;
    return true;
  }

  async terminate(): Promise<void> {
    this.beginShutdown();

    // A wrapper can exit while a descendant keeps its process group and port
    // alive. Retained PIDs therefore remain shutdown targets even after the
    // direct ChildProcess reports an exit; pid-less test doubles keep the old
    // running-state behavior.
    const managedChildren = this.#children.filter(
      (childProcess) => childProcess.pid !== undefined || isChildProcessRunning(childProcess),
    );
    for (const childProcess of managedChildren) {
      this.#tryKill(childProcess, 'SIGTERM');
    }

    if (managedChildren.length === 0) return;

    await this.#sleep(this.#gracePeriodMs);

    for (const childProcess of managedChildren) {
      // `child.killed` only records that kill() was called. It does not mean
      // the OS process has exited, so inspect the exit state before falling
      // back to SIGKILL.
      if (childProcess.pid !== undefined || isChildProcessRunning(childProcess)) {
        this.#tryKill(childProcess, 'SIGKILL');
      }
    }
  }

  #reportUnexpectedTermination(termination: CriticalChildTermination): void {
    if (!this.beginShutdown(1)) return;

    this.#onUnexpectedTermination(termination);
  }

  #tryKill(childProcess: CriticalChildProcess, signal: NodeJS.Signals): void {
    if (childProcess.pid !== undefined) {
      if (process.platform === 'win32') {
        // Windows has no Unix-style process groups. taskkill's /T flag walks the
        // descendant tree; /F is the closest equivalent to the SIGKILL fallback.
        spawnSync('taskkill.exe', ['/PID', String(childProcess.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
          stdio: 'ignore',
          windowsHide: true,
        });
        return;
      }

      try {
        // Detached Unix children are process-group leaders, so the negative PID
        // reaches wrappers plus Next/Metro/backend descendants. This must still
        // run after the wrapper exits because a grandchild may ignore SIGTERM.
        process.kill(-childProcess.pid, signal);
        return;
      } catch {
        // Fall back to the direct child below when a caller registered a process
        // that was not launched with the detached group option.
      }
    }

    try {
      childProcess.kill(signal);
    } catch {
      // The child may have exited between the state check and kill().
    }
  }
}
