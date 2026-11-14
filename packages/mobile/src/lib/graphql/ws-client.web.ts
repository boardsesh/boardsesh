import { registerClientOperationScope, type Client } from '@boardsesh/graphql-client';
import type {
  Event as WsEvent,
  EventListener as WsEventListener,
  FormattedExecutionResult,
  Sink,
  SubscribePayload,
} from 'graphql-ws';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { sameBrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import {
  captureAuthCredentialGeneration,
  getAuthToken,
  hasConfirmedAnonymousWebSession,
  isAuthCredentialGenerationCurrent,
  subscribeAuthCredentialGenerationChanges,
} from '../auth-store.web';
import { ensureFreshToken, recoverAuthRejection } from '../auth-interceptor.web';
import { getClientIdentityHeaderValue } from '../client-identity.web';
import { expoBrowserBackendClient } from '../browser-backend-client.web';
import { BACKEND_URL } from '../env';
import { createWsClientModule } from './ws-client-core';
import { notifyWsClientDisposed, notifyWsConnectionEnded } from './ws-client-lifecycle';
import { createSelectedBrowserWsClient, unavailableSelectedBrowserIterator } from './selected-ws-client.web';

const legacy = createWsClientModule({
  // Browsers only support the standard two-argument WebSocket constructor. The
  // native client has a separate fork that suppresses its Origin header.
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  captureAuthCredentialGeneration,
  async getAuthToken() {
    // A legacy socket created before first selected admission cannot acquire
    // that later account through this module's current-token getter.
    if (expoBrowserBackendClient.isSelected()) throw new BrowserBackendConsumerError('superseded');
    const token = await getAuthToken();
    if (expoBrowserBackendClient.isSelected()) throw new BrowserBackendConsumerError('superseded');
    if (!token && !hasConfirmedAnonymousWebSession()) throw new BrowserBackendConsumerError('unavailable');
    return token;
  },
  isAuthCredentialGenerationCurrent,
  ensureFreshToken,
  recoverAuthRejection,
  // Expo web draws no offline-mode row and persists no setting behind one, so
  // there is nothing here for the gate to read.
  isOfflineModeOn: () => false,
  getClientIdentity: getClientIdentityHeaderValue,
});

const fencedClients = new WeakSet<Client>();

/** Preserve the actual client identity used by lifecycle listeners. A client
 * from the legacy/anonymous view must not publish data or adopt another view
 * when a previously unresolved central observation becomes selected. */
function fenceClient(client: Client, isCurrent: () => boolean, allowIteration: boolean): Client {
  if (fencedClients.has(client)) return client;
  fencedClients.add(client);
  let retired = false;
  const current = () => {
    if (!isCurrent()) retired = true;
    return !retired;
  };
  const originalSubscribe = client.subscribe.bind(client);
  client.subscribe = <Result = Record<string, unknown>, Extensions = unknown>(
    payload: SubscribePayload,
    sink: Sink<FormattedExecutionResult<Result, Extensions>>,
  ) => {
    if (!current()) {
      sink.error(new BrowserBackendConsumerError('superseded'));
      return () => {};
    }
    let stopped = false;
    let release = () => {};
    const refuse = () => {
      if (stopped) return;
      stopped = true;
      release();
      sink.error(new BrowserBackendConsumerError('superseded'));
    };
    release = originalSubscribe<Result, Extensions>(payload, {
      next(result) {
        if (stopped) return;
        if (!current()) return refuse();
        sink.next(result);
      },
      error(error) {
        if (stopped) return;
        stopped = true;
        sink.error(current() ? error : new BrowserBackendConsumerError('superseded'));
      },
      complete() {
        if (stopped) return;
        if (!current()) return refuse();
        stopped = true;
        sink.complete();
      },
    });
    if (stopped) release();
    return () => {
      stopped = true;
      release();
    };
  };
  const originalIterate = client.iterate.bind(client);
  client.iterate = <Result = Record<string, unknown>, Extensions = unknown>(payload: SubscribePayload) => {
    if (!allowIteration || !current()) return unavailableSelectedBrowserIterator<Result, Extensions>();
    const source = originalIterate<Result, Extensions>(payload);
    const iterator: AsyncIterableIterator<FormattedExecutionResult<Result, Extensions>> = {
      async next() {
        if (!current()) throw new BrowserBackendConsumerError('superseded');
        const next = await source.next();
        if (!current()) {
          await source.return?.();
          throw new BrowserBackendConsumerError('superseded');
        }
        return next;
      },
      return: () => source.return?.() ?? Promise.resolve({ done: true, value: undefined }),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  };
  const originalOn = client.on.bind(client);
  client.on = <EventType extends WsEvent>(event: EventType, listener: WsEventListener<EventType>) => {
    const guarded = ((...arguments_: unknown[]) => {
      if (event !== 'closed' && !current()) return;
      Reflect.apply(listener, undefined, arguments_);
    }) as WsEventListener<EventType>;
    return originalOn(event, guarded);
  };
  return client;
}

const unavailable: Client = {
  on: () => () => {},
  subscribe: (_payload, sink) => {
    sink.error(new BrowserBackendConsumerError('unavailable'));
    return () => {};
  },
  iterate: () => unavailableSelectedBrowserIterator(),
  terminate: () => {},
  dispose: () => {},
};

let selected: ReturnType<typeof createSelectedBrowserWsClient> | null = null;
type AnonymousClient = { client: Client; isCurrent: () => boolean; dispose: () => void };
let anonymous: AnonymousClient | null = null;

function createAnonymousClient(): AnonymousClient {
  const generation = captureAuthCredentialGeneration();
  const revision = expoBrowserBackendClient.getSnapshot().revision;
  let disposed = false;
  const isCurrent = () =>
    !disposed &&
    !expoBrowserBackendClient.getSnapshot().closed &&
    isAuthCredentialGenerationCurrent(generation) &&
    expoBrowserBackendClient.getSnapshot().revision === revision &&
    expoBrowserBackendClient.isAnonymous() &&
    hasConfirmedAnonymousWebSession();
  const assertCurrent = () => {
    if (!isCurrent()) throw new BrowserBackendConsumerError('superseded');
  };
  const anonymousTransport = createWsClientModule({
    createSocket: (url, protocols) => new WebSocket(url, protocols),
    captureAuthCredentialGeneration: () => generation,
    isAuthCredentialGenerationCurrent: (expected) => expected === generation && isCurrent(),
    async ensureFreshToken() {
      assertCurrent();
      return false;
    },
    async getAuthToken() {
      assertCurrent();
      return null;
    },
    recoverAuthRejection: async () => (isCurrent() ? 'anonymous' : 'superseded'),
    isOfflineModeOn: () => false,
    getClientIdentity: getClientIdentityHeaderValue,
  });
  const client = fenceClient(anonymousTransport.getWsClient(), isCurrent, false);
  let unsubscribeOwner = () => {};
  let unsubscribeGeneration = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (anonymous?.client === client) anonymous = null;
    unsubscribeOwner();
    unsubscribeGeneration();
    anonymousTransport.disposeWsClient();
  };
  const retire = () => {
    if (!isCurrent()) dispose();
  };
  unsubscribeOwner = expoBrowserBackendClient.subscribe(retire);
  unsubscribeGeneration = subscribeAuthCredentialGenerationChanges(retire);
  if (!isCurrent()) dispose();
  return { client, isCurrent, dispose };
}

export function getWsClient(): Client {
  if (!expoBrowserBackendClient.isSelected())
    return fenceClient(legacy.getWsClient(), () => !expoBrowserBackendClient.isSelected(), true);

  // Selection uncertainty is exclusive: neither an old legacy token nor a
  // missing proof is evidence that a public anonymous socket may be opened.
  legacy.disposeWsClient();
  if (expoBrowserBackendClient.getSnapshot().closed) return unavailable;
  if (!expoBrowserBackendClient.getSnapshot().owner) {
    if (!expoBrowserBackendClient.isAnonymous() || !hasConfirmedAnonymousWebSession()) return unavailable;
    if (anonymous?.isCurrent()) return anonymous.client;
    anonymous?.dispose();
    anonymous = createAnonymousClient();
    return anonymous.isCurrent() ? anonymous.client : unavailable;
  }
  anonymous?.dispose();
  if (selected?.isCurrent()) return selected.client;
  const previous = selected;
  selected = null;
  previous?.dispose();
  try {
    const entry = createSelectedBrowserWsClient({
      backendClient: expoBrowserBackendClient,
      url: process.env.EXPO_PUBLIC_WS_URL ?? BACKEND_URL.replace(/^http(s?):\/\//, 'ws$1://') + '/graphql',
      Socket: WebSocket,
      clientIdentity: getClientIdentityHeaderValue,
      captureGeneration: captureAuthCredentialGeneration,
      isGenerationCurrent: isAuthCredentialGenerationCurrent,
      subscribeGeneration: (listener) => subscribeAuthCredentialGenerationChanges(listener),
      closeEvent: (code, reason, wasClean) => new CloseEvent('close', { code, reason, wasClean }),
      schedule(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
      onRetiring(client) {
        if (selected?.client === client) selected = null;
      },
      onConnectionEnded: notifyWsConnectionEnded,
      onDisposed: notifyWsClientDisposed,
    });
    if (!entry.isCurrent()) {
      entry.dispose();
      return unavailable;
    }
    selected = entry;
    return entry.client;
  } catch {
    return unavailable;
  }
}

// execute(getWsClient, ...) retries only confirmed rate-limit refusals. Pin the
// intent's view once, so a wait may replace its socket but cannot choose a later
// account, same-account login, or A -> B -> A revision. Actual socket delivery
// still requires its own original lease receipt; this metadata guard cannot
// extend one or replace callers' post-await publication checks.
registerClientOperationScope(getWsClient, () => {
  const initial = expoBrowserBackendClient.getSnapshot();
  const initialOwner = initial.owner ? { ...initial.owner, cursor: { ...initial.owner.cursor } } : null;
  const selectedAtStart = expoBrowserBackendClient.isSelected();
  const generation = captureAuthCredentialGeneration();
  return {
    getClient: getWsClient,
    assertCurrent() {
      const current = expoBrowserBackendClient.getSnapshot();
      if (
        current.closed ||
        !isAuthCredentialGenerationCurrent(generation) ||
        current.revision !== initial.revision ||
        expoBrowserBackendClient.isSelected() !== selectedAtStart ||
        (initialOwner === null
          ? current.owner !== null
          : current.owner === null || !sameBrowserBackendLeaseOwner(initialOwner, current.owner))
      )
        throw new BrowserBackendConsumerError('superseded');
    },
  };
});

export function disposeWsClient(): void {
  const previousSelected = selected;
  const previousAnonymous = anonymous;
  selected = null;
  anonymous = null;
  legacy.disposeWsClient();
  previousSelected?.dispose();
  previousAnonymous?.dispose();
}
