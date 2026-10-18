import { describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// The subscription must open no pubsub channel: any use of pubsub fails the test.
vi.mock('../pubsub', () => ({
  pubsub: new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'symbol' || key === 'then') return undefined;
        throw new Error(`pubsub.${key} used`);
      },
    },
  ),
}));
const { privacySubscriptions } = await import('../graphql/resolvers/privacy');

const viewer = {
  isAuthenticated: true,
  userId: 'privacy-changed-viewer',
  connectionId: 'privacy-changed',
} as ConnectionContext;

/** Whether `promise` is still unsettled after `ms` milliseconds. */
async function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timeout = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms));
  return (await Promise.race([promise.then(() => 'settled' as const), timeout])) === 'pending';
}

describe('privacyChanged subscription', () => {
  // App bundles from before 2026-10-12 stamp their offline catalogue viewer
  // marker from the first event. Privacy changes are no longer broadcast
  // (#6406), so nothing follows it, and the subscription must not complete.
  it('yields once on subscribe, then stays open until the client closes it', async () => {
    const iterator = privacySubscriptions.privacyChanged.subscribe(undefined, undefined, viewer);
    expect(await iterator.next()).toEqual({ value: { privacyChanged: true }, done: false });
    const second = iterator.next();
    expect(await stillPending(second, 50)).toBe(true);
    await iterator.return(undefined);
    expect(await second).toEqual({ value: undefined, done: true });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('closes cleanly when the client leaves before the first event is read', async () => {
    const iterator = privacySubscriptions.privacyChanged.subscribe(undefined, undefined, viewer);
    await iterator.return(undefined);
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('refuses a signed-out connection', async () => {
    const iterator = privacySubscriptions.privacyChanged.subscribe(undefined, undefined, {
      isAuthenticated: false,
      connectionId: 'privacy-changed-anon',
    } as ConnectionContext);
    await expect(iterator.next()).rejects.toThrow();
  });
});
