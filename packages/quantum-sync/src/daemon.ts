import { sleepWithAbort, type DaemonLoopRuntime } from '@boardsesh/sync-runtime';
import { QUANTUM_DAEMON_INTERVAL_MINUTES } from './constants';
import { QuantumSyncError } from './errors';

export type QuantumDaemonOptions = {
  intervalMinutes?: number;
  standbyPollMs?: number;
};

export async function runQuantumSyncDaemon(
  runCycle: () => Promise<void>,
  options: QuantumDaemonOptions = {},
  runtime: DaemonLoopRuntime = {},
): Promise<void> {
  const intervalMinutes = options.intervalMinutes ?? QUANTUM_DAEMON_INTERVAL_MINUTES;
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new QuantumSyncError('CONFIG_INVALID', 'Quantum daemon intervalMinutes must be a positive safe integer.');
  }
  const standbyPollMs = options.standbyPollMs ?? 30_000;
  if (!Number.isSafeInteger(standbyPollMs) || standbyPollMs <= 0) {
    throw new QuantumSyncError('CONFIG_INVALID', 'Quantum daemon standbyPollMs must be a positive safe integer.');
  }
  const sleep = runtime.sleep ?? sleepWithAbort;
  const signal = runtime.signal;
  const log = runtime.onLog ?? (() => {});
  const onCycleError = runtime.onCycleError ?? (() => {});

  while (!signal?.aborted) {
    let acquired = true;
    if (runtime.acquireSlot) {
      try {
        acquired = await runtime.acquireSlot();
      } catch (error) {
        acquired = false;
        onCycleError(error);
      }
    }
    if (!acquired) {
      try {
        await sleep(standbyPollMs, signal);
      } catch (error) {
        if (isAbortError(error)) return;
        throw error;
      }
      continue;
    }

    try {
      await runCycle();
    } catch (error) {
      onCycleError(error);
    }
    const delayMs = intervalMinutes * 60_000;
    log(`[QuantumSync] waiting ${intervalMinutes} minute(s) before the next catalog refresh`);
    try {
      await sleep(delayMs, signal);
    } catch (error) {
      if (isAbortError(error)) return;
      throw error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
