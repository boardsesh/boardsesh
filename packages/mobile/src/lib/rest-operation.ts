import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
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

export type RestOperationOptions = Readonly<{
  signal?: AbortSignal;
  /** Restrictive original caller veto at browser GET sends only. Native and
   * the closed DELETE port retain their existing transport policy. */
  assertBrowserGetDispatch?: () => void;
}>;

export type RestOperation = Readonly<{
  assertView(): void;
  assertAttemptCurrent(): void;
  getJson<T>(path: RestGetPath): Promise<RestJsonDelivery<T>>;
  dispose(): void;
}>;

export type RestReadMode = 'native' | 'legacy' | 'selected' | 'anonymous' | 'unavailable';

export type RestReadView = Readonly<{
  mode: RestReadMode;
  scope: string | undefined;
  scoped: boolean;
  ready: boolean;
  isCurrent(): boolean;
  key(logical: readonly unknown[]): readonly unknown[];
}>;

const nativeRestView: RestReadView = Object.freeze({
  mode: 'native',
  scope: undefined,
  scoped: false,
  ready: true,
  isCurrent: () => true,
  key: (logical: readonly unknown[]) => logical,
});

/** Observing a native cache does not read credentials or establish authority. */
export function captureRestReadView(): RestReadView {
  return nativeRestView;
}

export function useRestView(): RestReadView {
  return captureRestReadView();
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

/** Closed one-use unlink dispatch. Its physical proof has the same original
 * response policy as reads; ownership/retention belongs to its caller. */
export type RestUnlinkOperation = Readonly<{
  assertView(): void;
  assertAttemptCurrent(): void;
  unlinkJson<T>(boardType: AuroraBoardName): Promise<RestJsonDelivery<T>>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}>;

export function createUnlinkRestOperation(
  _originalView: string | undefined,
  options: RestOperationOptions = {},
): RestUnlinkOperation {
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
    async unlinkJson<T>(boardType: AuroraBoardName): Promise<RestJsonDelivery<T>> {
      if (consumed) throw new Error('REST operation already used');
      consumed = true;
      assertActive();
      if (!AURORA_BOARDS.includes(boardType)) {
        throw new TypeError('Unsupported unlink board');
      }

      let response: Response | undefined;
      try {
        response = await authenticatedFetch(`${BACKEND_URL.replace(/\/+$/, '')}/api/aurora-credentials`, {
          method: 'DELETE',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ boardType }),
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
    subscribe: () => () => {},
    dispose: () => controller.abort(),
  });
}
