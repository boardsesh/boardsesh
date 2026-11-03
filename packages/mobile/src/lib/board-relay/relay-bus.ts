import type { BoardClimbRelayRequested } from '@boardsesh/shared-schema';

/**
 * Relay mode (#7220): two app-wide buses between the board-presence provider
 * (which owns the subscription) and the providers below it.
 *
 * - Requests: another phone asked this one, as the board's holder, to light a
 *   climb (`BoardClimbRelayRequested`, delivered only to the holder). The
 *   Bluetooth provider, which owns the link, answers them.
 * - Echoes: a `BoardClimbSet` that carries a `relayRequestId`. The relaying
 *   phone matches it against the request it sent to know the climb lit.
 *
 * Module-level like the wall-confirm bus (`@boardsesh/play-view`), because the
 * presence provider sits above the Bluetooth provider and the drive watcher.
 */

type RelayRequestListener = (request: BoardClimbRelayRequested) => void;
type RelayEchoListener = (relayRequestId: string) => void;

const requestListeners = new Set<RelayRequestListener>();
const echoListeners = new Set<RelayEchoListener>();

export function publishRelayRequest(request: BoardClimbRelayRequested): void {
  for (const listener of requestListeners) listener(request);
}

export function subscribeRelayRequests(listener: RelayRequestListener): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

export function publishRelayEcho(relayRequestId: string): void {
  for (const listener of echoListeners) listener(relayRequestId);
}

export function subscribeRelayEchoes(listener: RelayEchoListener): () => void {
  echoListeners.add(listener);
  return () => {
    echoListeners.delete(listener);
  };
}
