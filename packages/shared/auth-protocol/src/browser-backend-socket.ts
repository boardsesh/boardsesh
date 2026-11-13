/** Browser-only transport composition with all platform constructors/time I/O
 * injected. A close can renew only the client scope captured by its owner;
 * neither this module nor its events carry source credentials or new owners. */
export function browserBackendLeaseWebSocket(
  Socket: typeof WebSocket,
  options: {
    readonly isCurrent: (socket: WebSocket) => boolean;
    readonly canSend: (socket: WebSocket) => boolean;
    readonly recover: (socket: WebSocket) => Promise<'admitted' | 'unavailable' | 'denied' | 'conflict' | 'superseded'>;
    readonly created?: (socket: WebSocket) => void;
    readonly opening?: (socket: WebSocket, deliver: () => void) => void;
    readonly receiving?: (socket: WebSocket, deliver: () => void) => void;
    readonly closeEvent: (code: number, reason: string, wasClean: boolean) => CloseEvent;
    readonly schedule: (callback: () => void, milliseconds: number) => () => void;
    readonly recoveryTimeoutMs?: number;
  },
): typeof WebSocket {
  const timeoutMs = options.recoveryTimeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error('BROWSER_BACKEND_SOCKET_CONFIGURATION_INVALID');
  const current = (socket: WebSocket) => {
    try {
      return options.isCurrent(socket);
    } catch {
      return false;
    }
  };
  return class SelectedLeaseWebSocket extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      let openHandler: WebSocket['onopen'] = null;
      let messageHandler: WebSocket['onmessage'] = null;
      // graphql-ws uses the on* properties. Own their dispatch so the exact
      // socket context survives through its synchronous protocol callbacks;
      // a later socket cannot lend its receipt to an earlier frame.
      Object.defineProperties(this, {
        onopen: {
          configurable: true,
          get: () => openHandler,
          set: (handler: WebSocket['onopen']) => {
            openHandler = handler;
          },
        },
        onmessage: {
          configurable: true,
          get: () => messageHandler,
          set: (handler: WebSocket['onmessage']) => {
            messageHandler = handler;
          },
        },
      });
      this.addEventListener('open', (event) => {
        const deliver = () => {
          openHandler?.call(this, event);
        };
        if (options.opening) options.opening(this, deliver);
        else deliver();
      });
      this.addEventListener('message', (event) => {
        try {
          if (!current(this) || !options.canSend(this)) throw new Error('BROWSER_BACKEND_SOCKET_STALE');
          const deliver = () => {
            messageHandler?.call(this, event);
          };
          if (options.receiving) options.receiving(this, deliver);
          else deliver();
        } catch {
          event.stopImmediatePropagation();
          this.close(4401, 'Browser credential changed');
        }
      });
      const forwarded = new WeakSet<Event>();
      // Installed before graphql-ws attaches its onclose property. A 4401 is
      // otherwise fatal to graphql-ws, including an ordinary expired lease.
      this.addEventListener('close', (event) => {
        if (event.code !== 4401 || forwarded.has(event)) return;
        event.stopImmediatePropagation();
        // Always leave the original dispatch before forwarding, even when the
        // owner was already superseded and no asynchronous reader is called.
        void Promise.resolve().then(async () => {
          let retry = false;
          let cancelTimeout: (() => void) | undefined;
          try {
            if (current(this)) {
              const timeout = new Promise<'unavailable'>((resolve) => {
                cancelTimeout = options.schedule(() => resolve('unavailable'), timeoutMs);
              });
              const outcome = await Promise.race([options.recover(this), timeout]);
              // An expired source must obtain an actual new admitted lease.
              // Uncertainty can be retried by the owner later; it cannot turn
              // this 4401 into an authenticated reconnect on its own.
              retry = outcome === 'admitted' && current(this);
            }
          } catch {
            retry = false;
          } finally {
            try {
              cancelTimeout?.();
            } catch {
              /* Timer cleanup never grants a credential. */
            }
          }
          let completion: CloseEvent;
          try {
            completion = options.closeEvent(retry ? 4403 : 4401, event.reason, event.wasClean);
          } catch {
            completion = event;
          }
          forwarded.add(completion);
          this.dispatchEvent(completion);
        });
      });
      options.created?.(this);
    }
    send(contents: Parameters<WebSocket['send']>[0]): void {
      let admitted = false;
      try {
        admitted = current(this) && options.canSend(this);
      } catch {
        /* No queued frame may cross an uncertain owner/lease check. */
      }
      if (!admitted) {
        this.close(4401, 'Browser credential changed');
        return;
      }
      super.send(contents);
    }
  };
}
