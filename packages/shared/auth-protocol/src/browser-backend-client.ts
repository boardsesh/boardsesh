import {
  createBrowserBackendLeaseConsumer,
  BrowserBackendConsumerError,
  type BrowserBackendConsumerScope,
} from './browser-backend-consumer';
import {
  createBrowserBackendLeaseManager,
  browserBackendLeaseReplySchema,
  type BrowserBackendLeaseOwner,
} from './browser-backend-lease';
import { readBrowserBackendSessionScope, browserBackendSessionKey } from './browser-backend-session';

async function readLeaseReply(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new BrowserBackendConsumerError('unavailable');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let contents = '';
    while (true) {
      if (signal.aborted) throw new BrowserBackendConsumerError('unavailable');
      const chunk = await reader.read();
      if (signal.aborted) throw new BrowserBackendConsumerError('unavailable');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) throw new BrowserBackendConsumerError('unavailable');
      contents += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(contents + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** The browser owns only an in-memory lease, never the underlying credential cookie.
 * The owned browser proof can inject readiness; production remains hardfalse. */
export function createBrowserBackendClient(options: {
  readonly ready: () => boolean;
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly now: () => number;
  readonly schedule: (callback: () => void, milliseconds: number) => () => void;
}) {
  let selected = false;
  let confirmedAnonymous = false;
  const manager = createBrowserBackendLeaseManager({
    now: options.now,
    schedule: options.schedule,
    refreshLeadMs: 30_000,
    async fetchLease(_expectedOwner, signal) {
      if (!options.ready()) return { status: 'unavailable' };
      const response = await options.fetch(options.endpoint, {
        credentials: 'include',
        cache: 'no-store',
        keepalive: false,
        headers: { Accept: 'application/json' },
        signal,
      });
      const reply = browserBackendLeaseReplySchema.parse(await readLeaseReply(response, signal));
      const expectedStatus =
        reply.status === 'admitted' ? 200 : reply.status === 'denied' ? 401 : reply.status === 'conflict' ? 409 : 503;
      if (!options.ready() || response.status !== expectedStatus) return { status: 'unavailable' };
      return reply;
    },
  });
  const consumer = createBrowserBackendLeaseConsumer(manager);
  return {
    /** Call only after an owned successful session request, before publishing
     * the new SessionContext. Missing selected metadata never restores legacy. */
    acceptSession(session: unknown): string | null {
      confirmedAnonymous = false;
      // A malformed reserved marker also retires legacy dispatch. It cannot
      // be treated as evidence that this browser has no selected credential.
      if (session !== null && typeof session === 'object' && 'browserSelection' in session) selected = true;
      const observed = readBrowserBackendSessionScope(session);
      if (observed.status === 'selected') {
        selected = true;
        if (options.ready()) {
          manager.setOwner(observed.owner);
          return browserBackendSessionKey(observed.owner);
        }
      } else if (observed.status === 'anonymous') {
        confirmedAnonymous = true;
        manager.setOwner(null);
        return selected ? 'selected-anonymous' : null;
      } else if (observed.status === 'legacy' && !selected) {
        manager.setOwner(null);
        return null;
      }
      manager.setOwner(null);
      throw new BrowserBackendConsumerError('unavailable');
    },
    async acquire(owner: BrowserBackendLeaseOwner) {
      if (!selected || !options.ready()) throw new BrowserBackendConsumerError('unavailable');
      const lease = await manager.acquire(owner);
      if (!options.ready()) throw new BrowserBackendConsumerError('unavailable');
      if (lease.status !== 'admitted') throw new BrowserBackendConsumerError(lease.status);
      if (!consumer.remember(lease)) throw new BrowserBackendConsumerError('superseded');
      return lease;
    },
    capture: (token: string) => (options.ready() ? consumer.capture(token) : null),
    isCurrent: (scope: unknown) => options.ready() && consumer.isCurrent(scope),
    async acquireScope(scope: BrowserBackendConsumerScope) {
      if (!options.ready()) throw new BrowserBackendConsumerError('unavailable');
      const lease = await consumer.acquire(scope);
      if (!options.ready()) throw new BrowserBackendConsumerError('unavailable');
      consumer.assertCurrent(scope, lease);
      return lease;
    },
    assertCurrent(scope: BrowserBackendConsumerScope, lease: unknown): void {
      if (!options.ready()) throw new BrowserBackendConsumerError('unavailable');
      consumer.assertCurrent(scope, lease);
    },
    invalidate: (scope: BrowserBackendConsumerScope) => consumer.invalidate(scope),
    getSnapshot: manager.getSnapshot,
    subscribe: (listener: () => void) => manager.subscribe(listener),
    isSelected: () => selected,
    isAnonymous: () => confirmedAnonymous,
    dispose() {
      consumer.dispose();
      manager.dispose();
    },
  };
}
