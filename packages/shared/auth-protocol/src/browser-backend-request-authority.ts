import type { createBrowserBackendClient } from './browser-backend-client';
import { BrowserBackendConsumerError, type BrowserBackendConsumerScope } from './browser-backend-consumer';
import { sameBrowserBackendLeaseOwner } from './browser-backend-lease';

/** A client may be constructed before its first lease arrives. Pin its actual
 * accepted owner/revision and platform generation now; only an original issued
 * result may initialize its opaque consumer scope later. Metadata cannot attach
 * a bearer, and a later account or ABA cannot initialize this old client. */
export function createBrowserBackendRequestAuthority(options: {
  readonly client: ReturnType<typeof createBrowserBackendClient>;
  readonly captureGeneration: () => number;
  readonly isGenerationCurrent: (generation: number) => boolean;
}) {
  const { client, captureGeneration, isGenerationCurrent } = options;
  const initial = client.getSnapshot();
  const owner = initial.owner;
  const generation = captureGeneration();
  if (!client.isSelected() || initial.closed || !owner || !Number.isSafeInteger(generation) || generation < 0)
    throw new BrowserBackendConsumerError('unavailable');
  const revision = initial.revision;
  let scope: BrowserBackendConsumerScope | undefined;
  let disposed = false;
  const isCurrent = () => {
    try {
      const current = client.getSnapshot();
      return (
        !disposed &&
        isGenerationCurrent(generation) &&
        !current.closed &&
        current.revision === revision &&
        current.owner !== null &&
        sameBrowserBackendLeaseOwner(current.owner, owner) &&
        (scope === undefined || client.isCurrent(scope))
      );
    } catch {
      return false;
    }
  };
  const assertScope = () => {
    if (!isCurrent()) throw new BrowserBackendConsumerError('superseded');
  };
  return {
    isCurrent,
    async acquire() {
      assertScope();
      const lease = scope ? await client.acquireScope(scope) : await client.acquire(owner);
      assertScope();
      if (!scope) {
        const actual = client.capture(lease.token);
        if (!actual) throw new BrowserBackendConsumerError('superseded');
        scope = actual;
      }
      client.assertCurrent(scope, lease);
      return lease;
    },
    assertCurrent(lease: unknown): void {
      assertScope();
      if (!scope) throw new BrowserBackendConsumerError('unavailable');
      client.assertCurrent(scope, lease);
    },
    invalidate(): void {
      if (scope && isCurrent()) client.invalidate(scope);
    },
    dispose(): void {
      disposed = true;
      scope = undefined;
    },
  };
}
