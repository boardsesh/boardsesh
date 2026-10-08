import { describe, expect, it, vi } from 'vite-plus/test';
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
