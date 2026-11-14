import {
  browserCoordinatorCommandSchema,
  browserCoordinatorObservationSchema,
  browserCoordinatorResultSchema,
  type BrowserCoordinatorCommand,
  type BrowserCoordinatorResult,
} from './browser-coordinator-v1';
import { browserRenewalBrowserResultSchema } from './browser-renewal-browser-v1';

export interface CoordinatorRequestContext {
  readonly signal: AbortSignal;
  readonly credentials: 'include';
  readonly keepalive: false;
  readonly cache: 'no-store';
}
export type CoordinatorTimer = (callback: () => void, milliseconds: number) => () => void;
export interface BrowserCoordinatorTransport {
  /** Return only control metadata; the transport keeps credentials in HttpOnly cookies. */
  observe(context: CoordinatorRequestContext): Promise<unknown>;
  /** Unmounted seam. Only a canonical lock owner may initialize a missing binding. */
  initialize?(context: CoordinatorRequestContext): Promise<void>;
  prepare?(
    command: Extract<BrowserCoordinatorCommand, { operation: 'prepare' }>,
    context: CoordinatorRequestContext,
  ): Promise<unknown>;
  renew?(
    command: Extract<BrowserCoordinatorCommand, { operation: 'renew' }>,
    context: CoordinatorRequestContext,
  ): Promise<unknown>;
}
export interface BrowserCoordinatorRunnerOptions {
  readonly transport: BrowserCoordinatorTransport;
  readonly withExclusiveLock: <Result>(operation: () => Promise<Result>, signal: AbortSignal) => Promise<Result>;
  readonly schedule: CoordinatorTimer;
  readonly timeoutMs: number;
}

/** The lock covers network settlement, including cancellation. Never race the
 * fetch against a timer and release the lock while headers can still arrive. */
export function createBrowserCoordinatorRunner(options: BrowserCoordinatorRunnerOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)
    throw new Error('COORDINATOR_DEADLINE_INVALID');
  const { transport, withExclusiveLock, schedule, timeoutMs } = options;
  const observe = transport.observe.bind(transport);
  const initialize = transport.initialize?.bind(transport);
  const prepare = transport.prepare?.bind(transport);
  const renew = transport.renew?.bind(transport);
  return async (input: BrowserCoordinatorCommand, signal?: AbortSignal): Promise<BrowserCoordinatorResult> => {
    const command = browserCoordinatorCommandSchema.parse(input);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const cancelTimeout = schedule(abort, timeoutMs);
    const context: CoordinatorRequestContext = {
      signal: controller.signal,
      credentials: 'include',
      keepalive: false,
      cache: 'no-store',
    };
    try {
      return await withExclusiveLock(async () => {
        if (controller.signal.aborted) return { status: 'unavailable' };
        let reply: unknown;
        if (command.operation === 'read') {
          let observed = browserCoordinatorObservationSchema.parse(await observe(context));
          if (controller.signal.aborted) return { status: 'unavailable' };
          if (observed.status === 'missing-binding') {
            if (!initialize) return { status: 'unavailable' };
            await initialize(context);
            if (controller.signal.aborted) return { status: 'unavailable' };
            // Headers may have installed a cookie even when an earlier body
            // failed. Every retry observes first; initialization is never cached.
            observed = browserCoordinatorObservationSchema.parse(await observe(context));
          }
          reply = observed.status === 'missing-binding' ? { status: 'unavailable' } : observed;
        } else if (command.operation === 'prepare') {
          reply = await prepare?.(command, context);
        } else {
          reply = await renew?.(command, context);
        }
        if (controller.signal.aborted) return { status: 'unavailable' };
        if (command.operation === 'renew') {
          const renewal = browserRenewalBrowserResultSchema.parse(reply);
          if (renewal.status !== 'ready') return renewal;
          const expectedVersion = command.expectedCursor.version + (renewal.renewal === 'renewed' ? 1 : 0);
          if (
            renewal.cursor.bindingId !== command.expectedCursor.bindingId ||
            renewal.cursor.version !== expectedVersion
          )
            return { status: 'conflict' };
          return { status: 'ready', cursor: renewal.cursor };
        }
        const result = browserCoordinatorResultSchema.parse(reply);
        if (
          result.status === 'ready' &&
          command.operation !== 'read' &&
          (result.cursor.bindingId !== command.expectedCursor.bindingId ||
            result.cursor.version !== command.expectedCursor.version)
        )
          return { status: 'conflict' };
        return result;
      }, controller.signal);
    } catch {
      return { status: 'unavailable' };
    } finally {
      cancelTimeout();
      signal?.removeEventListener('abort', abort);
    }
  };
}
