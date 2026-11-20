import type { BleScheduler, BleTransport } from './types';

export type BleErrorCode =
  | 'cancelled'
  | 'disconnected'
  | 'timeout'
  | 'invalid-input'
  | 'unsupported'
  | 'service-missing';
export class BleError extends Error {
  constructor(
    public readonly code: BleErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = code === 'cancelled' ? 'AbortError' : 'BleError';
  }
}

export const defaultBleScheduler: BleScheduler = {
  now: () => Date.now(),
  setTimeout(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    return () => clearTimeout(handle);
  },
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new BleError('cancelled');
}

/** Retains handlers on a late native promise; cancellation never leaves an unhandled rejection. */
export function raceAbort<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function bounded<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
  timeoutMs: number,
  scheduler: BleScheduler = defaultBleScheduler,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimeout = () => {};
    const finish = (outcome: { success: true; result: Result } | { success: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal.removeEventListener('abort', abort);
      if (outcome.success) resolve(outcome.result);
      else reject(outcome.error);
    };
    const abort = () => finish({ success: false, error: abortReason(signal) });
    cancelTimeout = scheduler.setTimeout(() => finish({ success: false, error: new BleError('timeout') }), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (result) => finish({ success: true, result }),
      (error: unknown) => finish({ success: false, error }),
    );
  });
}

/** One queue and one connection lifetime. Platform radio ownership ends at disconnect settlement. */
export class BleSessionRuntime {
  private readonly lifetime = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private unsubscribe: () => void = () => {};
  private readonly listeners = new Set<() => void>();
  readonly signal = this.lifetime.signal;

  constructor(
    private readonly transport: BleTransport,
    readonly scheduler: BleScheduler = defaultBleScheduler,
  ) {
    this.unsubscribe = transport.onDisconnect((error) => {
      void this.disconnect(error).catch(() => undefined);
    });
    if (this.signal.aborted) this.unsubscribe();
  }

  run<Result>(operation: (signal: AbortSignal) => Promise<Result>, callerSignal?: AbortSignal): Promise<Result> {
    if (this.signal.aborted) return Promise.reject(new BleError('disconnected'));
    const controller = new AbortController();
    const abort = () => controller.abort(new BleError('cancelled'));
    const close = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', close, { once: true });
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (callerSignal?.aborted) abort();
    const pending = this.tail.then(() => {
      throwIfAborted(controller.signal);
      return Promise.resolve().then(() => {
        throwIfAborted(controller.signal);
        return operation(controller.signal);
      });
    });
    this.tail = pending.catch(() => undefined);
    return raceAbort(pending, controller.signal).finally(() => {
      this.signal.removeEventListener('abort', close);
      callerSignal?.removeEventListener('abort', abort);
    });
  }

  disconnect(reason?: unknown): Promise<void> {
    if (this.closing) return this.closing;
    // Assign first: abort callbacks can themselves call disconnect.
    this.closing = Promise.resolve().then(() => this.transport.disconnect());
    this.lifetime.abort(reason ?? new BleError('disconnected'));
    this.unsubscribe();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot prevent radio cleanup. */
      }
    }
    this.listeners.clear();
    return this.closing;
  }

  onDisconnect(listener: () => void): () => void {
    if (this.signal.aborted) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
