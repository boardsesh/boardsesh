import { describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
vi.hoisted(() => vi.resetModules());
const privacy = vi.hoisted(() => ({ callback: undefined as (() => void) | undefined, unsubscribe: vi.fn() }));
vi.mock('../pubsub', () => ({
  pubsub: {
    subscribePrivacy: async (callback: () => void) => {
      privacy.callback = callback;
      return privacy.unsubscribe;
    },
  },
}));
const { createPrivacyAwareIterator } = await import('../graphql/resolvers/shared/privacy-iterator');
const { privacySubscriptions } = await import('../graphql/resolvers/privacy');

describe('quiet subscription privacy invalidation', () => {
  it('wakes a quiet iterator and releases both subscriptions when closed', async () => {
    const unsubscribe = vi.fn();
    const iterator = await createPrivacyAwareIterator<string>(async () => unsubscribe, 'privacy-test');
    const waiting = iterator.next();
    privacy.callback?.();
    expect(await waiting).toEqual({ value: null, done: false });
    await iterator.return();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(privacy.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('privacyChanged subscription', () => {
  // Shipped apps stamp their offline catalogue viewer marker from this first
  // event. It must keep arriving on every connect until a client release stops
  // waiting for it.
  it('yields once on subscribe before any change is published, then once per change', async () => {
    privacy.unsubscribe.mockClear();
    const context = {
      isAuthenticated: true,
      userId: 'privacy-iterator-viewer',
      connectionId: 'privacy-iterator',
    } as ConnectionContext;
    const iterator = privacySubscriptions.privacyChanged.subscribe(undefined, undefined, context);
    try {
      expect(await iterator.next()).toEqual({ value: { privacyChanged: true }, done: false });
      const waiting = iterator.next();
      privacy.callback?.();
      expect(await waiting).toEqual({ value: { privacyChanged: true }, done: false });
    } finally {
      await iterator.return?.(undefined);
    }
    expect(privacy.unsubscribe).toHaveBeenCalledOnce();
  });
});
