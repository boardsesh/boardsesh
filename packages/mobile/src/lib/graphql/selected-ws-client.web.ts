import { createGraphQLClient, type Client, type ExtendedClient } from '@boardsesh/graphql-client';
import { CLIENT_PLATFORM_CONNECTION_PARAM } from '@boardsesh/shared-schema';
import { CLIENT_IDENTITY_CONNECTION_PARAM } from '@boardsesh/shared-schema/client-identity';
import { parse } from 'graphql';
import type { FormattedExecutionResult, Sink, SubscribePayload } from 'graphql-ws';
import type { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { BrowserBackendConsumerError } from '@boardsesh/auth-protocol/browser-backend-consumer';
import { createBrowserBackendRequestAuthority } from '@boardsesh/auth-protocol/browser-backend-request-authority';
import {
  browserSubscriptionReplayPolicy,
  createBrowserBackendSocketController,
} from '@boardsesh/auth-protocol/browser-backend-socket-controller';

/** Pull results need their own buffered-result receipts before qualification. */
export function unavailableSelectedBrowserIterator<Result = Record<string, unknown>, Extensions = unknown>() {
  const iterator: AsyncIterableIterator<FormattedExecutionResult<Result, Extensions>> = {
    next: () => Promise.reject(new BrowserBackendConsumerError('unavailable')),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

/** Platform I/O and the existing lifecycle buses are injected. No source proof,
 * persistent bearer, anonymous fallback or current-login getter enters this
 * fixed client: its authority belongs to the construction-time view. */
export function createSelectedBrowserWsClient(options: {
  readonly backendClient: ReturnType<typeof createBrowserBackendClient>;
  readonly url: string;
  readonly Socket: typeof WebSocket;
  readonly clientIdentity: () => string;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly subscribeGeneration: (listener: () => void) => () => void;
  readonly closeEvent: (code: number, reason: string, wasClean: boolean) => CloseEvent;
  readonly schedule: (callback: () => void, milliseconds: number) => () => void;
  readonly onRetiring: (client: Client) => void;
  readonly onConnectionEnded: () => void;
  readonly onDisposed: (client: Client) => void;
}) {
  const authority = createBrowserBackendRequestAuthority({
    client: options.backendClient,
    captureGeneration: options.captureGeneration,
    isGenerationCurrent: options.isGenerationCurrent,
  });
  let createdClient: ExtendedClient | undefined;
  let disposed = false;
  let disposeAfterCreation = false;
  let dispose: (() => void) | undefined;
  const controller = createBrowserBackendSocketController({
    Socket: options.Socket,
    authority,
    closeEvent: options.closeEvent,
    schedule: options.schedule,
    terminate: () => createdClient?.terminate(),
  });
  const retireIfNeeded = () => {
    if (authority.isCurrent()) return;
    if (dispose) dispose();
    else disposeAfterCreation = true;
  };
  const safely = (callback: () => void) => {
    try {
      callback();
    } catch {
      // Lifecycle observers cannot keep this retired transport usable.
    }
  };
  const client = createGraphQLClient({
    url: options.url,
    webSocketImpl: controller.Socket,
    lazyCloseTimeoutMs: 3000,
    connectionParams: async () => ({
      authToken: await controller.connectionToken(),
      [CLIENT_IDENTITY_CONNECTION_PARAM]: options.clientIdentity(),
      [CLIENT_PLATFORM_CONNECTION_PARAM]: 'web',
    }),
    onClientCreated(created) {
      createdClient = created;
      const unsubscribeClosed = created.on('closed', () => safely(options.onConnectionEnded));
      const unsubscribeOwner = options.backendClient.subscribe(retireIfNeeded);
      const unsubscribeGeneration = options.subscribeGeneration(retireIfNeeded);
      return () => {
        if (disposed) return;
        disposed = true;
        controller.dispose();
        authority.dispose();
        safely(unsubscribeOwner);
        safely(unsubscribeGeneration);
        safely(unsubscribeClosed);
        // Clear the platform cache before another lifecycle observer asks for
        // a replacement. An old entry may never clear a later account's entry.
        safely(() => options.onRetiring(created));
        safely(options.onConnectionEnded);
        safely(() => options.onDisposed(created));
      };
    },
  });
  const subscribe = client.subscribe.bind(client);
  client.subscribe = <Result = Record<string, unknown>, Extensions = unknown>(
    payload: SubscribePayload,
    sink: Sink<FormattedExecutionResult<Result, Extensions>>,
  ) => {
    const { query, operationName, variables, extensions } = payload;
    const bufferedPayload = Object.freeze({ query, operationName, variables, extensions });
    let replay: 'never' | 'subscription' = 'never';
    try {
      replay = browserSubscriptionReplayPolicy(parse(bufferedPayload.query), bufferedPayload.operationName);
    } catch {
      // Only the parsed selected subscription may opt into reconnect replay.
    }
    return controller.subscribe((guarded) => subscribe<Result, Extensions>(bufferedPayload, guarded), sink, { replay });
  };
  client.iterate = <Result = Record<string, unknown>, Extensions = unknown>(_payload: SubscribePayload) => {
    // graphql-ws iterate uses its private subscribe and bypasses the wrapper.
    // No current app calls it. Refuse until queued pull-result receipts have
    // their own qualification; do not expose an unguarded alternate transport.
    return unavailableSelectedBrowserIterator<Result, Extensions>();
  };
  dispose = () => {
    if (!disposed) void client.dispose();
  };
  if (disposeAfterCreation || !authority.isCurrent()) dispose();
  return {
    client,
    isCurrent: () => !disposed && authority.isCurrent(),
    dispose,
  };
}
