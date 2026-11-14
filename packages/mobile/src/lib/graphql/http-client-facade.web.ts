import { GraphQLClient } from 'graphql-request';
import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import {
  BROWSER_HTTP_VIEW_PREFIX,
  createBrowserBackendHttpViewRegistry,
  type BrowserHttpView,
} from '@boardsesh/auth-protocol/browser-backend-http-view';
import { captureBrowserHttpView } from './http-view.web';
import { createSelectedBrowserHttpClient } from './selected-http-client.web';
import { createGraphQLRequestGate } from './request-gate';
import { admitBrowserResponse } from '../browser-response-admission.web';
import type { WebAuthIdentity } from '../auth-store.web';
import { CLIENT_IDENTITY_HEADER } from '@boardsesh/shared-schema/client-identity';

const UNAVAILABLE_VIEW = `${BROWSER_HTTP_VIEW_PREFIX}unavailable`;
type HttpMode = 'interactive' | 'offline';
type Clients = Readonly<Record<HttpMode, GraphQLClient>>;

export function createBrowserHttpClientFacade(provided: {
  readonly backendClient: ReturnType<typeof createBrowserBackendClient>;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly captureIdentity: () => WebAuthIdentity | null;
  readonly confirmedAnonymous: () => boolean;
  readonly required: () => boolean;
  readonly namespace: () => string;
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly legacyFetch: typeof fetch;
  readonly timeoutMs: (mode: HttpMode) => number | null;
  readonly clientIdentity: () => string;
  readonly legacy: {
    readonly get: (mode: HttpMode) => GraphQLClient;
    readonly reset: () => void;
  };
}) {
  const options = Object.freeze({ ...provided, legacy: Object.freeze({ ...provided.legacy }) });
  type Registry = ReturnType<typeof createBrowserBackendHttpViewRegistry<Clients>>;
  let registry: Registry | undefined;
  let closed = false;
  let revision = 0;
  const listeners = new Set<() => void>();
  const required = () => options.required() || options.backendClient.isSelected();

  function createLegacy(view: BrowserHttpView, mode: HttpMode) {
    const controller = new AbortController();
    // Anonymous selected-mode requests carry no credential. Their actual
    // anonymous view, rather than legacy permission, supplies the guard.
    const assertPublicOrLegacy = () => {
      if (controller.signal.aborted || !view.isCurrent() || (view.kind === 'legacy' && required()))
        throw new BrowserBackendConsumerError('superseded');
    };
    const gated = createGraphQLRequestGate({
      async fetch(input, init) {
        assertPublicOrLegacy();
        let response: Response;
        if (view.kind === 'anonymous') {
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((contents, name) => headers.set(name, contents));
          headers.delete('Authorization');
          headers.set(CLIENT_IDENTITY_HEADER, options.clientIdentity());
          response = await options.fetch(input, { ...init, headers });
        } else response = await options.legacyFetch(input, init);
        assertPublicOrLegacy();
        return admitBrowserResponse(response, assertPublicOrLegacy);
      },
      composeSignal: (caller, deadline) => (caller ? AbortSignal.any([caller, deadline]) : deadline),
      ignoreFailure: (error) => error instanceof BrowserBackendConsumerError,
    });
    const client = new GraphQLClient(options.url, {
      fetch(input, init = {}) {
        assertPublicOrLegacy();
        const caller = init.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = AbortSignal.any(caller ? [caller, controller.signal] : [controller.signal]);
        return gated(input, { ...init, signal }, options.timeoutMs(mode));
      },
      responseMiddleware: assertPublicOrLegacy,
    });
    return {
      client,
      isCurrent: () => {
        try {
          assertPublicOrLegacy();
          return true;
        } catch {
          return false;
        }
      },
      // Ordinary legacy/public results retain their existing semantics. Only
      // selected results claim an actual original backend delivery receipt.
      isCurrentResult: (_result: unknown) => {
        try {
          assertPublicOrLegacy();
          return true;
        } catch {
          return false;
        }
      },
      captureResult: (_result: unknown) => {
        try {
          assertPublicOrLegacy();
          return assertPublicOrLegacy;
        } catch {
          return null;
        }
      },
      dispose: () => controller.abort(new BrowserBackendConsumerError('superseded')),
    };
  }

  function getRegistry(): Registry {
    if (closed) throw new BrowserBackendConsumerError('unavailable');
    return (registry ??= createBrowserBackendHttpViewRegistry<Clients>({
      namespace: options.namespace(),
      capture() {
        const view = captureBrowserHttpView(options);
        if (required() && view.kind === 'legacy') throw new BrowserBackendConsumerError('unavailable');
        return view;
      },
      create(view) {
        const create = (mode: HttpMode) =>
          view.kind === 'selected'
            ? createSelectedBrowserHttpClient({ ...options, timeoutMs: () => options.timeoutMs(mode) })
            : createLegacy(view, mode);
        const interactive = create('interactive');
        const offline = create('offline');
        return {
          client: Object.freeze({ interactive: interactive.client, offline: offline.client }),
          isCurrent: () => interactive.isCurrent() && offline.isCurrent(),
          isCurrentResult: (result) => interactive.isCurrentResult(result) || offline.isCurrentResult(result),
          captureResult: (result) => interactive.captureResult(result) ?? offline.captureResult(result),
          dispose() {
            interactive.dispose();
            offline.dispose();
          },
        };
      },
    }));
  }

  function resolve(mode: HttpMode, requested: readonly (string | null | undefined)[]): GraphQLClient {
    if (closed) throw new BrowserBackendConsumerError('unavailable');
    const handle = requested[0];
    if (typeof handle === 'string') {
      if (!handle.startsWith(BROWSER_HTTP_VIEW_PREFIX)) throw new BrowserBackendConsumerError('unavailable');
      return getRegistry().resolve(handle)[mode];
    }
    if (!required()) return options.legacy.get(mode);
    // An explicit missing auth label cannot adopt today's owner. Imperative
    // callers without a label must capture their view before their first await.
    if (requested.length) throw new BrowserBackendConsumerError('unavailable');
    return getRegistry().resolve(getRegistry().capture())[mode];
  }

  return Object.freeze({
    getHttpClient: (...requested: [handle?: string | null]) => resolve('interactive', requested),
    getOfflineSyncHttpClient: (...requested: [handle?: string | null]) => resolve('offline', requested),
    captureHandle: () => getRegistry().capture(),
    /** Capture original caller intent synchronously, including a refusal
     * marker when a required view is not yet known. No credential is read. */
    captureRequestView(...requested: [label?: string | null]): string | undefined {
      if (requested.length) {
        const label = requested[0];
        if (typeof label === 'string' && label.startsWith(BROWSER_HTTP_VIEW_PREFIX)) return label;
        return required() ? UNAVAILABLE_VIEW : undefined;
      }
      try {
        return getRegistry().capture();
      } catch {
        return required() ? UNAVAILABLE_VIEW : undefined;
      }
    },
    isCurrentView(handle: string | null | undefined): boolean {
      if (closed) return false;
      try {
        if (typeof handle === 'string' && handle.startsWith(BROWSER_HTTP_VIEW_PREFIX))
          return getRegistry().isCurrent(handle);
        return !required() && handle === undefined;
      } catch {
        return false;
      }
    },
    assertCurrentResult(handle: string | undefined, result: unknown): void {
      if (closed) throw new BrowserBackendConsumerError('superseded');
      if (handle === undefined && !required()) return;
      if (!handle || !getRegistry().isCurrentResult(handle, result))
        throw new BrowserBackendConsumerError('superseded');
    },
    captureResult(handle: string | undefined, result: unknown): (() => void) | null {
      if (closed) return null;
      if (handle === undefined && !required())
        return () => {
          if (closed || required()) throw new BrowserBackendConsumerError('superseded');
        };
      return handle ? getRegistry().captureResult(handle, result) : null;
    },
    queryKey<Key extends readonly unknown[]>(key: Key, handle: string | null | undefined): readonly unknown[] {
      return typeof handle === 'string' && handle.startsWith(BROWSER_HTTP_VIEW_PREFIX)
        ? [...key, 'browser-view', handle]
        : required()
          ? [...key, 'browser-view', UNAVAILABLE_VIEW]
          : key;
    },
    getRevision: () => revision,
    subscribe(listener: () => void) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      registry?.clear();
      options.legacy.reset();
      revision += 1;
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch {
          // Every observer must learn retirement independently.
        }
      }
    },
    dispose() {
      if (closed) return;
      closed = true;
      registry?.dispose();
      listeners.clear();
    },
  });
}
