import { authenticatedFetch } from './auth-interceptor';
import { captureAuthenticatedResponse } from './authenticated-response-scope';
import { BACKEND_URL } from './env';

export type RestGetPath = '/api/aurora-credentials' | '/api/aurora-credentials/unsynced';

export type RestBody<T> = Readonly<{ kind: 'json'; value: T }> | Readonly<{ kind: 'decode-error'; error: unknown }>;

export type RestJsonDelivery<T> = Readonly<{
  response: Response;
  body: RestBody<T>;
  assertCurrent(): void;
}>;

export type RestReadOutcome<T> =
  | Readonly<{ ok: true; result: T; assertCurrent(): void }>
  | Readonly<{ ok: false; error: unknown; assertCurrent(): void }>;

export type RestOperationOptions = Readonly<{ signal?: AbortSignal }>;

export type RestOperation = Readonly<{
  assertView(): void;
  assertAttemptCurrent(): void;
  getJson<T>(path: RestGetPath): Promise<RestJsonDelivery<T>>;
  dispose(): void;
}>;

export type RestReadView = Readonly<{
  scope: string | undefined;
  scoped: boolean;
  ready: boolean;
  isCurrent(): boolean;
  key(logical: readonly unknown[]): readonly unknown[];
}>;

const nativeRestView: RestReadView = Object.freeze({
  scope: undefined,
  scoped: false,
  ready: true,
  isCurrent: () => true,
  key: (logical: readonly unknown[]) => logical,
});

/** Observing a native cache does not read credentials or establish authority. */
export function useRestView(): RestReadView {
  return nativeRestView;
}

function createRestAbortError(): Error & { code: string } {
  const error = new Error('REST operation aborted') as Error & { code: string };
  error.name = 'AbortError';
  error.code = 'REST_OPERATION_ABORTED';
  return error;
}

async function discardUnreadResponse(response: Response | undefined): Promise<void> {
  if (!response?.body || response.bodyUsed || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // Cancellation has settled; retain the failure that required disposal.
  }
}

/** Native delegates authentication and its existing 401 recovery unchanged. */
export function createRestOperation(
  _originalView: string | undefined,
  options: RestOperationOptions = {},
): RestOperation {
  const controller = new AbortController();
  const callerSignal = options.signal;
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let consumed = false;
  const assertActive = () => {
    if (signal.aborted) throw createRestAbortError();
  };

  return Object.freeze({
    assertView: assertActive,
    // A veto only: native adds no account-generation or response policy.
    assertAttemptCurrent: assertActive,
    async getJson<T>(path: RestGetPath): Promise<RestJsonDelivery<T>> {
      if (consumed) throw new Error('REST operation already used');
      consumed = true;
      assertActive();
      if (path !== '/api/aurora-credentials' && path !== '/api/aurora-credentials/unsynced') {
        throw new TypeError('Unsupported REST read path');
      }

      let response: Response | undefined;
      try {
        response = await authenticatedFetch(`${BACKEND_URL.replace(/\/+$/, '')}${path}`, {
          headers: new Headers(),
          // Native queries previously ignored TanStack cancellation. Only an
          // explicit operation caller opts into forwarding a fetch signal.
          ...(callerSignal ? { signal } : {}),
        });
        // Own the original response before a post-await cancellation check.
        assertActive();
        const assertResponse = captureAuthenticatedResponse(response);
        const assertCurrent = () => {
          assertActive();
          assertResponse();
        };
        assertCurrent();
        let body: RestBody<T>;
        try {
          const decoded = (await response.json()) as T;
          assertCurrent();
          body = Object.freeze({ kind: 'json', value: decoded });
        } catch (error) {
          assertCurrent();
          body = Object.freeze({ kind: 'decode-error', error });
        }
        return Object.freeze({ response, body, assertCurrent });
      } catch (error) {
        await discardUnreadResponse(response);
        assertActive();
        throw error;
      }
    },
    dispose: () => controller.abort(),
  });
}

export function captureRestOperation(options?: RestOperationOptions): RestOperation {
  return createRestOperation(undefined, options);
}
