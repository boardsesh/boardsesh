import {
  createBrowserBackendLeaseManager,
  sameBrowserBackendLeaseOwner,
  type BrowserBackendLease,
  type BrowserBackendLeaseOwner,
} from './browser-backend-lease';

type LeaseManager = ReturnType<typeof createBrowserBackendLeaseManager>;
/** Opaque process-local intent scope. Its contents cannot authorize a request. */
export type BrowserBackendConsumerScope = Readonly<Record<never, never>>;
type ScopeReceipt = {
  readonly owner: Readonly<BrowserBackendLeaseOwner>;
  readonly revision: number;
};

export class BrowserBackendConsumerError extends Error {
  constructor(readonly status: 'superseded' | 'denied' | 'conflict' | 'unavailable') {
    super('Selected browser credential is unavailable');
    this.name = 'BrowserBackendConsumerError';
  }
}

/** Bridges existing token-taking clients to original manager receipts. All
 * tokens and receipts remain in this closure; snapshots/channels/storage must
 * never contain them. Capture a scope when constructing a client, then reuse
 * that scope on reconnect. Never resolve a new account from an old client. */
export function createBrowserBackendLeaseConsumer(manager: LeaseManager) {
  const registered = new Map<string, { lease: BrowserBackendLease; scope: BrowserBackendConsumerScope }>();
  const scopes = new WeakMap<object, ScopeReceipt>();
  let closed = false;
  const isCurrent = (scope: unknown): scope is BrowserBackendConsumerScope => {
    if (scope === null || typeof scope !== 'object') return false;
    const receipt = scopes.get(scope);
    const current = manager.getSnapshot();
    return (
      !closed &&
      receipt !== undefined &&
      !current.closed &&
      receipt.revision === current.revision &&
      current.owner !== null &&
      sameBrowserBackendLeaseOwner(receipt.owner, current.owner)
    );
  };
  const assertScope = (scope: BrowserBackendConsumerScope): ScopeReceipt => {
    if (!isCurrent(scope)) throw new BrowserBackendConsumerError('superseded');
    return scopes.get(scope)!;
  };
  const remember = (lease: unknown): lease is BrowserBackendLease => {
    if (closed || !manager.isCurrent(lease)) return false;
    // Entries are a compatibility bridge, not an unbounded bearer history.
    for (const [token, entry] of registered) {
      if (!manager.isCurrent(entry.lease)) registered.delete(token);
    }
    const existing = registered.get(lease.token);
    if (existing && isCurrent(existing.scope)) {
      existing.lease = lease;
      return true;
    }
    while (registered.size >= 64) registered.delete(registered.keys().next().value!);
    const scope = Object.freeze({});
    scopes.set(scope, { owner: lease.owner, revision: manager.getSnapshot().revision });
    registered.set(lease.token, { lease, scope });
    return true;
  };
  // Drop retired bearer strings synchronously, rather than waiting for a later
  // render, acquisition or successful login to prune a previous account.
  const unsubscribe = manager.subscribe(() => {
    for (const [token, entry] of registered) {
      if (!isCurrent(entry.scope) || !manager.isCurrent(entry.lease)) registered.delete(token);
    }
  });
  return {
    remember,
    /** Raw token strings, copied leases and invented owner metadata cannot
     * create scopes unless the original live manager receipt was registered. */
    capture(token: string): BrowserBackendConsumerScope | null {
      const entry = registered.get(token);
      if (!entry || !manager.isCurrent(entry.lease) || !isCurrent(entry.scope)) return null;
      return entry.scope;
    },
    isCurrent,
    /** The client keeps this scope, including across ordinary lease renewal. */
    async acquire(scope: BrowserBackendConsumerScope): Promise<BrowserBackendLease> {
      const receipt = assertScope(scope);
      const lease = await manager.acquire(receipt.owner);
      assertScope(scope);
      if (lease.status !== 'admitted') throw new BrowserBackendConsumerError(lease.status);
      if (!manager.isCurrent(lease)) throw new BrowserBackendConsumerError('superseded');
      remember(lease);
      return lease;
    },
    /** Check the original lease immediately before attaching its bearer and
     * after every asynchronous body/decoder step before publishing data. */
    assertCurrent(scope: BrowserBackendConsumerScope, lease: unknown): void {
      const receipt = assertScope(scope);
      if (!manager.isCurrent(lease) || !sameBrowserBackendLeaseOwner(receipt.owner, lease.owner))
        throw new BrowserBackendConsumerError('superseded');
    },
    invalidate(scope: BrowserBackendConsumerScope): void {
      if (!isCurrent(scope)) return;
      manager.invalidate(scopes.get(scope)!.owner);
    },
    dispose(): void {
      closed = true;
      registered.clear();
      unsubscribe();
    },
  };
}
