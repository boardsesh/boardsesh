import { setTimeout as delay } from 'node:timers/promises';

/**
 * Run `body` with `process.on('uncaughtException')` swapped for a recorder, so a
 * stream error thrown out of a `nextTick` is captured instead of taking down the
 * worker. Node's own listeners are restored with `rawListeners`, which preserves
 * `once` wrappers.
 *
 * This is the oracle for #5307 and #5359: production has no
 * `uncaughtException` handler at all, so anything this records would have exited
 * the replica and dropped every graphql-ws session on it.
 */
export async function recordUncaughtExceptions(body: () => Promise<void>): Promise<Error[]> {
  const recorded: Error[] = [];
  const original = process.rawListeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error) => {
    recorded.push(error);
  });

  try {
    await body();
    // Let a queued `emitErrorNT` land before we hand the process back.
    await delay(100);
  } finally {
    process.removeAllListeners('uncaughtException');
    for (const listener of original) process.on('uncaughtException', listener);
  }

  return recorded;
}
