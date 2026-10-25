import type { Client } from '@boardsesh/graphql-client';
import { reportHandledError } from '../error-reporting';

/**
 * Tells long-lived WebSocket consumers that the client they hold was disposed.
 *
 * `disposeWsClient()` (offline mode going on, sign-out, a browser credential
 * change) drops the cached client, and the next `getWsClient()` builds a new
 * one. A consumer that took the client once and kept it — listeners, streams,
 * a join bound to its connection — is left on a client that will never
 * reconnect, while every new caller talks to the replacement. The party
 * session did exactly that after offline mode on → off: its streams stayed on
 * the dead client and each session mutation went out on a fresh connection
 * that had never joined.
 *
 * Kept apart from `ws-client.ts` so the many tests that mock that module with
 * only `getWsClient` keep working: the bus here is always real, and with a
 * mocked client nothing ever publishes on it.
 */
type DisposedListener = (disposedClient: Client) => void;

const listeners = new Set<DisposedListener>();

/**
 * Called by `ws-client-core` after it drops a live client. A listener that
 * throws is reported and skipped: dispose runs inside sign-out and the offline
 * switch, and one consumer's bug must not stop the others from letting go.
 */
export function notifyWsClientDisposed(disposedClient: Client): void {
  for (const listener of listeners) {
    try {
      listener(disposedClient);
    } catch (error) {
      reportHandledError(error);
    }
  }
}

/**
 * Runs `listener` synchronously inside `disposeWsClient()`, after the cached
 * client is gone, so a `getWsClient()` from the listener already gets the next
 * client (or the inert one while offline mode is on).
 */
export function subscribeWsClientDisposed(listener: DisposedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type ConnectionEndedListener = () => void;

const connectionEndedListeners = new Set<ConnectionEndedListener>();

/**
 * Called by `ws-client-core` whenever the socket of the cached client closes
 * (an idle lazy close, a drop, a retry) and when the cached client is disposed.
 */
export function notifyWsConnectionEnded(): void {
  for (const listener of connectionEndedListeners) {
    try {
      listener();
    } catch (error) {
      reportHandledError(error);
    }
  }
}

/**
 * Fires each time the connection behind `getWsClient()` ends, whoever opened it.
 * State bound to one connection, like the party session's cached JOIN_SESSION,
 * is invalid from then on. The realtime engine sees the closes of the client it
 * is bound to, but a join can also run while it is parked and bound to nothing:
 * a queue mutation's `ensureJoined` during a backend outage, for one. Without
 * this the join stayed cached after that socket idled out, and the next
 * mutation or the engine's own resume trusted it on a fresh connection.
 */
export function subscribeWsConnectionEnded(listener: ConnectionEndedListener): () => void {
  connectionEndedListeners.add(listener);
  return () => {
    connectionEndedListeners.delete(listener);
  };
}

/** Drops every listener on both buses, for test teardown. */
export function __resetWsClientLifecycleForTests(): void {
  listeners.clear();
  connectionEndedListeners.clear();
}
