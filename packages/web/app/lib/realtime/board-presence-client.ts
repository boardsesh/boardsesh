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

/**
 * Thrown when kiosk/embed code calls a write or board-binding method on the
 * read-only presence client the display routes use. Those routes run with no
 * session at all, so the call could only ever fail server-side on an
 * unattended screen — failing here names the caller instead.
 */
export class KioskReadOnlyPresenceError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`${method} is not available on the read-only kiosk presence client`);
    this.name = 'KioskReadOnlyPresenceError';
    this.method = method;
  }
}

function rejectAsReadOnly(method: string): () => Promise<never> {
  return () => Promise.reject(new KioskReadOnlyPresenceError(method));
}

/**
 * A `WebBoardPresenceClient` with every write / board-binding method replaced
 * by a rejecting stub. The kiosk and embed routes only ever read (subscribe,
 * backfill, stats), and since #4408 they connect anonymously — so a stray
 * `reportClimb` from a future widget would silently bounce off the backend's
 * auth gate on a TV nobody is watching. This makes that a named failure.
 *
 * The stubs REJECT rather than throw synchronously so an unattended screen
 * degrades instead of white-screening, and the return type stays
 * `WebBoardPresenceClient` so `BoardPresenceProvider`'s prop type — and the
 * shared `@boardsesh/board-presence-react` package the mobile app also
 * consumes — are untouched.
 */
export function createReadOnlyWebBoardPresenceClient(getClient: () => Client): WebBoardPresenceClient {
  return {
    ...createWebBoardPresenceClient(getClient),
    reportClimb: rejectAsReadOnly('reportClimb'),
    reportDisconnect: rejectAsReadOnly('reportDisconnect'),
    resolveBoardForSerial: rejectAsReadOnly('resolveBoardForSerial'),
    resolveBoardForConfig: rejectAsReadOnly('resolveBoardForConfig'),
    resolveBoardForUuid: rejectAsReadOnly('resolveBoardForUuid'),
    chooseBoardForSerial: rejectAsReadOnly('chooseBoardForSerial'),
  };
}
