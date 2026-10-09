/** Serializes native OTA work, including work whose caller has timed out. */
export interface OtaOperationLease {
  readonly signal: AbortSignal;
  assertActive(): void;
  native<Result>(start: () => Promise<Result>): Promise<Result>;
  waitFor<Result>(work: Promise<Result>): Promise<Result>;
  reload(start: () => Promise<void>): Promise<void>;
  /** A header restore failed: no further work may trust the native configuration. */
  quarantine(cause: unknown): void;
}

export type OtaOperationOptions = { timeoutMs?: number; signal?: AbortSignal };
export type OtaOperationRunner = <Result>(
  task: (lease: OtaOperationLease) => Promise<Result>,
  options?: OtaOperationOptions,
) => Promise<Result>;

export const OTA_OPERATION_TIMEOUT_MS = 30_000;

function cancellationError(): Error {
  return new Error('The update operation was cancelled or took too long.');
}

/** Separate instances are useful for pure recovery tests; production uses the singleton below. */
export function createOtaOperationOwner(): { run: OtaOperationRunner; resetForTests(): void } {
  let tail: Promise<void> = Promise.resolve();
  let quarantined: Error | undefined;
  let terminalReload = false;

  const run: OtaOperationRunner = <Result>(
    task: (lease: OtaOperationLease) => Promise<Result>,
    options: OtaOperationOptions = {},
  ): Promise<Result> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(onAbort, options.timeoutMs ?? OTA_OPERATION_TIMEOUT_MS);
    const assertActive = () => {
      if (controller.signal.aborted) throw cancellationError();
      if (quarantined) throw quarantined;
      if (terminalReload) throw new Error('An update restart is already in progress.');
    };
    const waitFor = <Value>(work: Promise<Value>): Promise<Value> => {
      try {
        assertActive();
      } catch (cause) {
        // The work was supplied as a promise and may already have started.
        void work.catch(() => undefined);
        return Promise.reject(cause);
      }
      return new Promise<Value>((resolve, reject) => {
        const abort = () => reject(cancellationError());
        controller.signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
      });
    };
    const lease: OtaOperationLease = {
      signal: controller.signal,
      assertActive,
      async native(start) {
        assertActive();
        // Never race this promise: changing headers before it settles would
        // stamp its eventual download with another operation's headers.
        const result = await start();
        assertActive();
        return result;
      },
      waitFor,
      async reload(start) {
        assertActive();
        terminalReload = true;
        // Network cancellation has no authority to restore headers once a
        // native restart was accepted. Keep the owner latched until reload.
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        try {
          await start();
        } catch (cause) {
          terminalReload = false;
          throw cause;
        }
      },
      quarantine(cause) {
        quarantined = new Error('Update headers could not be restored.', { cause });
      },
    };

    return new Promise<Result>((resolve, reject) => {
      const abort = () => reject(cancellationError());
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      const execute = async () => {
        try {
          assertActive();
          resolve(await task(lease));
        } catch (cause) {
          reject(cause);
        } finally {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', onAbort);
          controller.signal.removeEventListener('abort', abort);
        }
      };
      tail = tail.then(execute, execute);
    });
  };

  return {
    run,
    resetForTests() {
      tail = Promise.resolve();
      quarantined = undefined;
      terminalReload = false;
    },
  };
}

const owner = createOtaOperationOwner();
export const runOtaOperation: OtaOperationRunner = owner.run;
let headerRevision = 0;
export function readOtaHeaderRevision(): number {
  return headerRevision;
}
export function noteOtaHeadersChanged(): void {
  headerRevision += 1;
}
export function resetOtaOperationOwnerForTests(): void {
  owner.resetForTests();
  headerRevision = 0;
}
