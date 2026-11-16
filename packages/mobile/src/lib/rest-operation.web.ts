import { useMemo, useSyncExternalStore } from 'react';
import { CLIENT_IDENTITY_HEADER } from '@boardsesh/shared-schema/client-identity';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { createBrowserBackendRequestAuthority } from '@boardsesh/auth-protocol/browser-backend-request-authority';
import type { BrowserBackendLease } from '@boardsesh/auth-protocol/browser-backend-lease';
import {
  captureAuthCredentialGeneration,
  captureConfirmedWebAuthIdentity,
  hasConfirmedAnonymousWebSession,
  isAuthCredentialGenerationCurrent,
  isRequiredBrowserDispatch,
  subscribeAuthTokenChanges,
} from './auth-store.web';
import { expoBrowserBackendClient } from './browser-backend-client.web';
import { browserHttpClients } from './graphql/client.web';
import { captureBrowserHttpView } from './graphql/http-view.web';
import { authenticatedFetchForOriginalLegacyRequest } from './auth-interceptor.web';
import { admitBrowserResponse, captureBrowserResponseCurrent } from './browser-response-admission.web';
import { getClientIdentityHeaderValue } from './client-identity.web';
import { BACKEND_URL } from './env';
import type {
  RestBody,
  RestGetPath,
  RestJsonDelivery,
  RestOperation,
  RestOperationOptions,
  RestReadView,
} from './rest-operation';
export type {
  RestBody,
  RestGetPath,
  RestJsonDelivery,
  RestOperation,
  RestOperationOptions,
  RestReadOutcome,
  RestReadMode,
  RestReadView,
} from './rest-operation';

function abortError(): Error {
  const error = new Error('REST operation aborted');
  error.name = 'AbortError';
  return error;
}

function captureView() {
  return captureBrowserHttpView({
    backendClient: expoBrowserBackendClient,
    captureGeneration: captureAuthCredentialGeneration,
    isGenerationCurrent: isAuthCredentialGenerationCurrent,
    captureIdentity: captureConfirmedWebAuthIdentity,
    confirmedAnonymous: hasConfirmedAnonymousWebSession,
  });
}

/** No credential acquisition occurs here. Labels only identify original intent;
 * actual view and private authority are captured independently before any await. */
export function createRestOperation(
  originalView: string | undefined,
  options: RestOperationOptions = {},
): RestOperation {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let used = false;
  let disposed = false;
  let safeRefusal = false;
  let view: ReturnType<typeof captureView> | undefined;
  let authority: ReturnType<typeof createBrowserBackendRequestAuthority> | undefined;
  let lease: BrowserBackendLease | undefined;
  try {
    // Undefined compatibility labels are not proof of an accepted web identity.
    if (typeof originalView !== 'string' || !browserHttpClients.isCurrentView(originalView))
      throw new BrowserBackendConsumerError('unavailable');
    view = captureView();
    if (view.kind === 'selected')
      authority = createBrowserBackendRequestAuthority({
        client: expoBrowserBackendClient,
        captureGeneration: captureAuthCredentialGeneration,
        isGenerationCurrent: isAuthCredentialGenerationCurrent,
      });
  } catch {
    authority?.dispose();
    authority = undefined;
    view = undefined;
    // Keep an unavailable operation object so invalid invocation still consumes it.
  }
  const assertView = () => {
    if (signal.aborted || disposed) throw abortError();
    if (
      !view ||
      (view.kind === 'legacy' && isRequiredBrowserDispatch()) ||
      !browserHttpClients.isCurrentView(originalView) ||
      !view.isCurrent()
    )
      throw new BrowserBackendConsumerError('superseded');
  };
  const assertOriginal = () => {
    assertView();
    if (authority && lease) authority.assertCurrent(lease);
  };
  return Object.freeze({
    assertView,
    assertAttemptCurrent() {
      // Only our fixed-code refusal may survive its own deliberate retirement.
      // An arbitrary transport/decoder error never supplies accepting evidence.
      if (!safeRefusal) assertOriginal();
    },
    async getJson<T>(path: RestGetPath): Promise<RestJsonDelivery<T>> {
      if (used) throw new BrowserBackendConsumerError('unavailable');
      used = true;
      let raw: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancel: Promise<void> | undefined;
      let bodySettled = false;
      let interrupted = false;
      const cancelOwned = () => {
        if (!cancel) {
          // Observe rejection immediately and await this same settlement below.
          cancel = Promise.resolve()
            .then(() => (reader ? reader.cancel() : raw?.body?.cancel()))
            .then(
              () => {},
              () => {},
            );
        }
        return cancel;
      };
      const onAbort = () => {
        interrupted = true;
        void cancelOwned();
      };
      try {
        if (path !== '/api/aurora-credentials' && path !== '/api/aurora-credentials/unsynced')
          throw new BrowserBackendConsumerError('unavailable');
        assertOriginal();
        const url = `${BACKEND_URL.replace(/\/+$/, '')}${path}`;
        if (view?.kind === 'legacy') {
          raw = await authenticatedFetchForOriginalLegacyRequest(url, { signal }, assertView);
        } else {
          const headers = new Headers();
          headers.set(CLIENT_IDENTITY_HEADER, getClientIdentityHeaderValue());
          if (authority) {
            lease = await authority.acquire();
            assertOriginal();
            headers.set('Authorization', `Bearer ${lease.token}`);
          }
          assertOriginal();
          raw = await fetch(url, { headers, signal });
        }
        // Own raw before every post-fetch refusal, including already-aborted headers.
        assertOriginal();
        if (authority && raw.status === 401) {
          authority.invalidate();
          throw new BrowserBackendConsumerError('denied');
        }
        const response = admitBrowserResponse(raw, assertOriginal);
        const original = captureBrowserResponseCurrent(response);
        if (!original) throw new BrowserBackendConsumerError('unavailable');
        const chunks: Uint8Array[] = [];
        let length = 0;
        reader = raw.body?.getReader();
        signal.addEventListener('abort', onAbort, { once: true });
        original();
        if (reader) {
          for (;;) {
            original();
            const next = await reader.read();
            original();
            if (next.done) break;
            chunks.push(next.value);
            length += next.value.byteLength;
          }
        }
        bodySettled = true;
        original();
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let body: RestBody<T>;
        try {
          // Decoder-only carrier, never admitted or used as response authority.
          const parsed = (await new Response(bytes.buffer).json()) as T;
          original();
          body = { kind: 'json', value: parsed };
        } catch (error) {
          original();
          body = { kind: 'decode-error', error };
        }
        original();
        return Object.freeze({ response, body, assertCurrent: original });
      } catch (error) {
        if (signal.aborted || interrupted || disposed) {
          safeRefusal = true;
          throw abortError();
        }
        if (error instanceof BrowserBackendConsumerError) {
          safeRefusal = true;
          const status = error.status;
          throw new BrowserBackendConsumerError(
            status === 'superseded' || status === 'denied' || status === 'conflict' ? status : 'unavailable',
          );
        }
        assertOriginal();
        throw error;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (raw && !bodySettled) await cancelOwned();
        if (cancel) await cancel;
        reader?.releaseLock();
      }
    },
    dispose() {
      disposed = true;
      controller.abort();
      authority?.dispose();
    },
  });
}

export function captureRestOperation(options?: RestOperationOptions): RestOperation {
  return createRestOperation(browserHttpClients.captureRequestView(), options);
}

function subscribe(listener: () => void): () => void {
  const releases = [
    subscribeAuthTokenChanges(listener),
    expoBrowserBackendClient.subscribe(listener),
    browserHttpClients.subscribe(listener),
  ];
  return () => {
    for (const release of releases) release();
  };
}
function snapshot(): string {
  const current = expoBrowserBackendClient.getSnapshot();
  return JSON.stringify([
    captureAuthCredentialGeneration(),
    current.revision,
    current.closed,
    current.selected,
    current.anonymous,
    browserHttpClients.getRevision(),
    isRequiredBrowserDispatch(),
  ]);
}

/** Mode/key capture is a no-I/O veto descriptor, never response authority. */
export function captureRestReadView(): RestReadView {
  const scope = browserHttpClients.captureRequestView();
  let actual: ReturnType<typeof captureView> | undefined;
  try {
    actual = captureView();
  } catch {
    /* Unknown remains unavailable. */
  }
  const isCurrent = () =>
    typeof scope === 'string' &&
    browserHttpClients.isCurrentView(scope) &&
    Boolean(actual?.isCurrent()) &&
    (actual?.kind !== 'legacy' || !isRequiredBrowserDispatch());
  const scoped = isRequiredBrowserDispatch() || actual?.kind !== 'legacy';
  const namespace = browserHttpClients.queryKey([], scope);
  const prefix = scoped ? (namespace.length ? namespace : ['browser-view', 'unavailable']) : [];
  return Object.freeze({
    mode: actual?.kind ?? 'unavailable',
    scope,
    scoped,
    ready: isCurrent(),
    isCurrent,
    key: (logical: readonly unknown[]) => (scoped ? [...prefix, ...logical] : logical),
  });
}

/** A cache observer does not acquire a token or a lease. */
export function useRestView(): RestReadView {
  const revision = useSyncExternalStore(subscribe, snapshot, () => 'server-unavailable');
  return useMemo(() => captureRestReadView(), [revision]);
}
