import { browserBackendLeaseWebSocket } from './browser-backend-socket';
import { BrowserBackendConsumerError } from './browser-backend-consumer';
import type { BrowserBackendLease } from './browser-backend-lease';

export type BrowserBackendSocketAuthority = {
  readonly isCurrent: () => boolean;
  readonly assertCurrent: (lease: unknown) => void;
  readonly acquire: () => Promise<BrowserBackendLease>;
  readonly invalidate: () => void;
};
type Sink<Result> = {
  next(result: Result): void;
  error(error: unknown): void;
  complete(): void;
};
type SingleSendOperation = {
  socket: WebSocket | undefined;
  refuse(status: 'superseded' | 'unavailable'): void;
};

/** Hosts pass the result of their installed GraphQL parser, never a claimed
 * operation kind. Select exactly one operation; duplicate names are ambiguous. */
export function browserSubscriptionReplayPolicy(
  document: unknown,
  operationName?: string | null,
): 'never' | 'subscription' {
  if (!document || typeof document !== 'object' || !('kind' in document) || document.kind !== 'Document')
    return 'never';
  if (!('definitions' in document) || !Array.isArray(document.definitions)) return 'never';
  const operations: { name: string | undefined; operation: string }[] = [];
  const names = new Set<string>();
  for (const entry of document.definitions as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('kind' in entry) || entry.kind !== 'OperationDefinition') continue;
    const definition = entry as Record<string, unknown>;
    const operation = definition.operation;
    if (typeof operation !== 'string' || !['query', 'mutation', 'subscription'].includes(operation)) return 'never';
    const nameNode = definition.name;
    if (nameNode !== undefined && (!nameNode || typeof nameNode !== 'object' || !('value' in nameNode))) return 'never';
    const name: unknown = nameNode && typeof nameNode === 'object' && 'value' in nameNode ? nameNode.value : undefined;
    if (name !== undefined && (typeof name !== 'string' || !name || names.has(name))) return 'never';
    if (typeof name === 'string') names.add(name);
    operations.push({ name: typeof name === 'string' ? name : undefined, operation });
  }
  if (operations.length > 1 && operations.some((entry) => entry.name === undefined)) return 'never';
  const selected =
    operationName === undefined || operationName === null
      ? operations
      : operations.filter((entry) => entry.name === operationName);
  return selected.length === 1 && selected[0].operation === 'subscription' ? 'subscription' : 'never';
}

/** Shared selected-browser composition. Each actual socket owns its original
 * receipt; neither a later connection nor renewal may extend an older frame.
 * The host pins the authority to one process-local owner/revision scope. */
export function createBrowserBackendSocketController(options: {
  readonly Socket: typeof WebSocket;
  readonly authority: BrowserBackendSocketAuthority;
  readonly closeEvent: (code: number, reason: string, wasClean: boolean) => CloseEvent;
  readonly schedule: (callback: () => void, milliseconds: number) => () => void;
  readonly terminate: () => void;
}) {
  const { authority } = options;
  const socketLeases = new WeakMap<WebSocket, BrowserBackendLease>();
  let currentSocket: WebSocket | undefined;
  let openingSocket: WebSocket | undefined;
  let delivery: { socket: WebSocket; lease: BrowserBackendLease } | undefined;
  let cancelRenewal: (() => void) | undefined;
  let disposed = false;
  const singleSendOperations = new Set<SingleSendOperation>();
  const clearRenewal = () => {
    cancelRenewal?.();
    cancelRenewal = undefined;
  };
  const Socket = browserBackendLeaseWebSocket(options.Socket, {
    isCurrent: (socket) => !disposed && currentSocket === socket && authority.isCurrent(),
    canSend(socket) {
      authority.assertCurrent(socketLeases.get(socket));
      return true;
    },
    created(socket) {
      currentSocket = socket;
      socket.addEventListener(
        'close',
        () => {
          if (currentSocket === socket) clearRenewal();
        },
        { once: true },
      );
      try {
        // Consumer callbacks can register new work; it belongs to the new
        // socket and must not extend this retirement pass indefinitely.
        const pendingAtCreation = Array.from(singleSendOperations);
        for (const operation of pendingAtCreation) {
          if (operation.socket && operation.socket !== socket) operation.refuse('unavailable');
          else operation.socket = socket;
        }
        if (disposed) throw new BrowserBackendConsumerError('superseded');
      } catch (error) {
        socket.close(4401, 'Browser operation unavailable');
        throw error;
      }
    },
    opening(socket, deliver) {
      const previous = openingSocket;
      openingSocket = socket;
      try {
        deliver();
      } finally {
        openingSocket = previous;
      }
    },
    receiving(socket, deliver) {
      const lease = socketLeases.get(socket);
      authority.assertCurrent(lease);
      if (!lease || socket !== currentSocket) throw new BrowserBackendConsumerError('superseded');
      const previous = delivery;
      delivery = { socket, lease };
      try {
        deliver();
      } finally {
        delivery = previous;
      }
    },
    async recover(socket) {
      if (socket !== currentSocket || !authority.isCurrent()) return 'superseded';
      let unexpired = false;
      try {
        authority.assertCurrent(socketLeases.get(socket));
        unexpired = true;
      } catch {
        /* An expired same-owner lease needs a real new admission. */
      }
      if (unexpired) {
        authority.invalidate();
        return 'denied';
      }
      try {
        const renewed = await authority.acquire();
        authority.assertCurrent(renewed);
        return 'admitted';
      } catch (error) {
        return error instanceof BrowserBackendConsumerError ? error.status : 'unavailable';
      }
    },
    closeEvent: options.closeEvent,
    schedule: options.schedule,
  });

  return {
    Socket,
    async connectionToken(): Promise<string> {
      // Capture synchronously in THIS socket's onopen, before the first await.
      const socket = openingSocket;
      if (!socket || socket !== currentSocket || socketLeases.has(socket))
        throw new BrowserBackendConsumerError('superseded');
      const lease = await authority.acquire();
      authority.assertCurrent(lease);
      if (disposed || socket !== currentSocket || socket.readyState !== options.Socket.OPEN)
        throw new BrowserBackendConsumerError('superseded');
      socketLeases.set(socket, lease);
      clearRenewal();
      const renewAfter =
        lease.usableForMs > 30_000 ? lease.usableForMs - 30_000 : Math.max(1, lease.usableForMs - 1000);
      cancelRenewal = options.schedule(() => {
        if (!disposed && socket === currentSocket && socketLeases.get(socket) === lease && authority.isCurrent())
          options.terminate();
      }, renewAfter);
      return lease.token;
    },
    subscribe<Result>(
      subscribe: (sink: Sink<Result>) => () => void,
      sink: Sink<Result>,
      policy: { readonly replay?: 'never' | 'subscription' } = {},
    ): () => void {
      if (disposed || !authority.isCurrent()) {
        sink.error(new BrowserBackendConsumerError('superseded'));
        return () => {};
      }
      let stopped = false;
      let release = () => {};
      let firstDelivery: { socket: WebSocket; lease: BrowserBackendLease } | undefined;
      let singleSend: SingleSendOperation | undefined;
      const forget = () => {
        if (singleSend) singleSendOperations.delete(singleSend);
      };
      const cancel = () => {
        try {
          release();
        } catch (error) {
          // An unproven cancellation cannot authorize another queued frame.
          // Retire this transport only; the account/manager is unchanged.
          disposed = true;
          clearRenewal();
          throw error;
        }
      };
      if (policy.replay !== 'subscription') {
        singleSend = {
          socket: currentSocket && currentSocket.readyState <= options.Socket.OPEN ? currentSocket : undefined,
          refuse(status) {
            if (stopped) return;
            stopped = true;
            forget();
            try {
              cancel();
            } finally {
              sink.error(new BrowserBackendConsumerError(status));
            }
          },
        };
        singleSendOperations.add(singleSend);
      }
      release = subscribe({
        next(result) {
          if (stopped) return;
          try {
            if (!delivery || delivery.socket !== currentSocket) throw new BrowserBackendConsumerError('superseded');
            authority.assertCurrent(delivery.lease);
            // execute() buffers a next payload until graphql-ws asynchronously
            // completes. A later next/socket must not extend that old payload.
            firstDelivery ??= delivery;
          } catch (error) {
            stopped = true;
            forget();
            cancel();
            sink.error(error);
            return;
          }
          sink.next(result);
        },
        error(error) {
          if (stopped) return;
          stopped = true;
          forget();
          sink.error(authority.isCurrent() ? error : new BrowserBackendConsumerError('superseded'));
        },
        complete() {
          if (stopped) return;
          stopped = true;
          forget();
          try {
            if (disposed || !authority.isCurrent() || !firstDelivery || firstDelivery.socket !== currentSocket)
              throw new BrowserBackendConsumerError('superseded');
            authority.assertCurrent(firstDelivery.lease);
          } catch (error) {
            sink.error(error);
            return;
          }
          sink.complete();
        },
      });
      if (stopped) cancel();
      return () => {
        stopped = true;
        forget();
        cancel();
      };
    },
    dispose(): void {
      disposed = true;
      clearRenewal();
      for (const operation of singleSendOperations) {
        try {
          operation.refuse('superseded');
        } catch {
          // Every pending operation retires even if a consumer throws.
        }
      }
      singleSendOperations.clear();
    },
  };
}
