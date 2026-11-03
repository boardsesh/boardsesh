// Mobile board-presence transport: binds the mobile graphql-ws `Client` to the
// shared `createBoardPresenceClient` factory (see there for all semantics).
// A getter (not the client) so a graphql-ws-recreated client is read at call time.

import { type Client, execute, subscribe } from '@boardsesh/graphql-client';
import { publishRelayEcho } from '../board-relay/relay-bus';
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
 *
 * `relayMode` (Relay mode, #7220, behind `moonboard-relay-mode`) subscribes
 * with the relay document. Every phone needs it, the relaying one included:
 * only that document carries `BoardClimbSet.relayRequestId`, the echo a
 * relaying phone confirms its climb by. Each echo is handed to the relay bus
 * (`publishRelayEcho`) before the event reaches the presence reducer.
 */
export function createMobileBoardPresenceClient(
  getClient: () => Client,
  { relayMode = false }: { relayMode?: boolean } = {},
): MobileBoardPresenceClient {
  const client = createBoardPresenceClient(
    {
      execute<TData>(operation: BoardPresenceOperation) {
        return execute<TData>(getClient, operation);
      },
      subscribe<TData>(operation: BoardPresenceOperation, sink: BoardPresenceSink<TData>) {
        return subscribe<TData>(getClient(), operation, sink);
      },
      onConnected(callback: () => void) {
        return getClient().on('connected', callback);
      },
    },
    { relayMode },
  );
  if (!relayMode) return client;
  return {
    ...client,
    subscribeNowPlaying(boardId, onEvent, onError, onComplete, boardUuid) {
      return client.subscribeNowPlaying(
        boardId,
        (event) => {
          if (event.__typename === 'BoardClimbSet' && event.relayRequestId) publishRelayEcho(event.relayRequestId);
          onEvent(event);
        },
        onError,
        onComplete,
        boardUuid,
      );
    },
  };
}
