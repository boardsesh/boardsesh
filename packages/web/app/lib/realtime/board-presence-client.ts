// Web transport for the board-presence ("now on the wall") feature.
//
// A thin wrapper around the shared `createBoardPresenceClient` factory
// (`@boardsesh/board-presence-react`) — the operation strings, response
// unwrapping, and reconnect-catch-up semantics all live there now, shared with
// the mobile adapter (`packages/mobile/src/lib/board-presence/board-presence-client.ts`),
// so a fix in one place (e.g. the reconnect catch-up) lands on both platforms
// instead of drifting. This file only supplies the web graphql-ws `Client`
// (the same one the persistent-session provider uses) as the three transport
// primitives the factory needs — reusing the shared `execute`/`subscribe`
// helpers re-exported from the web `app/lib/realtime/graphql-client` client.
//
// Web now implements the full client, including `onReconnect` (reconnect
// catch-up — web's `ExtendedClient` supports `.on('connected', ...)` the same
// as mobile), `fetchConnection` (cold-join holder seed), and `fetchHistory`.

import { type Client, execute, subscribe } from './graphql-client';
import {
  createBoardPresenceClient,
  type BoardPresenceOperation,
  type BoardPresenceSink,
  type FullBoardPresenceClient,
} from '@boardsesh/board-presence-react';

export type WebBoardPresenceClient = FullBoardPresenceClient;

/**
 * Build a `BoardPresenceClient` over a web graphql-ws client. Pass a getter
 * (not the client itself) so the live client — which graphql-ws may dispose and
 * recreate, and which the provider builds lazily on first use — is read at call
 * time, matching how the queue provider passes `getClient: () => getWsClient()`.
 */
export function createWebBoardPresenceClient(getClient: () => Client): WebBoardPresenceClient {
  return createBoardPresenceClient({
    execute<TData>(operation: BoardPresenceOperation) {
      return execute<TData>(getClient(), operation);
    },
    subscribe<TData>(operation: BoardPresenceOperation, sink: BoardPresenceSink<TData>) {
      return subscribe<TData>(getClient(), operation, sink);
    },
    onConnected(callback: () => void) {
      return getClient().on('connected', callback);
    },
  });
}
