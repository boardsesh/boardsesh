// Mobile board-presence transport: binds the mobile graphql-ws `Client` to the
// shared `createBoardPresenceClient` factory (see there for all semantics).
// A getter (not the client) so a graphql-ws-recreated client is read at call time.

import { type Client, execute, subscribe } from '@boardsesh/graphql-client';
import {
  createBoardPresenceClient,
  type BoardPresenceOperation,
  type BoardPresenceSink,
  type FullBoardPresenceClient,
  type SerialResolveArgs,
} from '@boardsesh/board-presence-react';

export type { SerialResolveArgs };

/**
 * The mobile board-presence client. Every method on `FullBoardPresenceClient`
 * is implemented by the shared factory, including the serial disambiguation
 * extension (`resolveBoardCandidatesForSerial`, `chooseBoardForSerial`) only
 * mobile's board picker calls today.
 */
export type MobileBoardPresenceClient = FullBoardPresenceClient;

/**
 * Build a `MobileBoardPresenceClient` over a mobile graphql-ws client.
 */
export function createMobileBoardPresenceClient(getClient: () => Client): MobileBoardPresenceClient {
  return createBoardPresenceClient({
    execute<TData>(operation: BoardPresenceOperation) {
      return execute<TData>(getClient, operation);
    },
    subscribe<TData>(operation: BoardPresenceOperation, sink: BoardPresenceSink<TData>) {
      return subscribe<TData>(getClient(), operation, sink);
    },
    onConnected(callback: () => void) {
      return getClient().on('connected', callback);
    },
  });
}
