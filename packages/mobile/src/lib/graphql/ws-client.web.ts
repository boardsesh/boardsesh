import type { Client } from '@boardsesh/graphql-client';
import type {
  Event as WsEvent,
  EventListener as WsEventListener,
  FormattedExecutionResult,
  Sink,
  SubscribePayload,
} from 'graphql-ws';
import {
  captureAuthCredentialGeneration,
  getAuthToken,
  hasConfirmedAnonymousWebSession,
  isAuthCredentialGenerationCurrent,
  subscribeAuthCredentialGenerationChanges,
} from '../auth-store.web';
import { ensureFreshToken, recoverAuthRejection } from '../auth-interceptor.web';
import { isBrowserPageRetired, subscribeBrowserPageRetired } from '../browser-page-retirement.web';
import { SessionSupersededError } from '../browser-session-guard.web';
import { getClientIdentityHeaderValue } from '../client-identity.web';
import { createWsClientModule } from './ws-client-core';

const transport = createWsClientModule({
  // Browsers only support the standard two-argument WebSocket constructor. The
  // native client has a separate fork that suppresses its Origin header.
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  captureAuthCredentialGeneration,
  async getAuthToken() {
    const token = await getAuthToken();
    // A page that has not read its session yet, or lost it to an outage, is
    // not signed out: no anonymous handshake goes out on its behalf.
    if (!token && !hasConfirmedAnonymousWebSession())
      throw new Error('The browser session is not known yet, so the WebSocket stays closed');
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

function supersededIterator<Result = Record<string, unknown>, Extensions = unknown>() {
  const iterator: AsyncIterableIterator<FormattedExecutionResult<Result, Extensions>> = {
    next: () => Promise.reject(new SessionSupersededError()),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

const fencedClients = new WeakSet<Client>();

/** Preserve the actual client identity used by lifecycle listeners. Once the
 * login the client was handed out under is gone, it publishes nothing more:
 * every operation it still carries ends superseded. */
function fenceClient(client: Client, isCurrent: () => boolean): Client {
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
      sink.error(new SessionSupersededError());
      return () => {};
    }
    let stopped = false;
    let release = () => {};
    const refuse = () => {
      if (stopped) return;
      stopped = true;
      release();
      sink.error(new SessionSupersededError());
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
        sink.error(current() ? error : new SessionSupersededError());
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
    if (!current()) return supersededIterator<Result, Extensions>();
    const source = originalIterate<Result, Extensions>(payload);
    const iterator: AsyncIterableIterator<FormattedExecutionResult<Result, Extensions>> = {
      async next() {
        if (!current()) throw new SessionSupersededError();
        const next = await source.next();
        if (!current()) {
          await source.return?.();
          throw new SessionSupersededError();
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

/** A retired page opens no socket; every operation, pushed or pulled, ends superseded. */
const retiredPageClient: Client = {
  on: () => () => {},
  subscribe: (_payload, sink) => {
    sink.error(new SessionSupersededError());
    return () => {};
  },
  iterate: () => supersededIterator(),
  terminate: () => {},
  dispose: () => {},
};

// The generation the current socket was opened under. A socket belongs to one
// browser login: a generation change disposes it, so the next caller
// reconnects with the new credential and the old socket's late events are fenced.
let socketGeneration: number | undefined;

export function disposeWsClient(): void {
  socketGeneration = undefined;
  transport.disposeWsClient();
}

subscribeAuthCredentialGenerationChanges((generation) => {
  if (socketGeneration !== undefined && socketGeneration !== generation) disposeWsClient();
});
subscribeBrowserPageRetired(disposeWsClient);

export function getWsClient(): Client {
  // A retired page opens no socket, so a rate-limit retry inside
  // execute(getWsClient, ...) cannot go out as the account that replaced the
  // page's own. A sign-in on a page that had no account retires nothing
  // (#7596 D4): a retry held across it goes out as the new login, like
  // everything else the page sends after it.
  if (isBrowserPageRetired()) {
    disposeWsClient();
    return retiredPageClient;
  }
  const generation = captureAuthCredentialGeneration();
  if (socketGeneration !== undefined && socketGeneration !== generation) transport.disposeWsClient();
  socketGeneration = generation;
  return fenceClient(
    transport.getWsClient(),
    () => !isBrowserPageRetired() && isAuthCredentialGenerationCurrent(generation),
  );
}
