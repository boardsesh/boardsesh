import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NetworkPolicyBlockedError,
  assertNetworkAllowed,
  isNetworkAllowed,
  setNetworkPolicy,
  subscribeNetworkPolicy,
} from '../network-policy';

describe('network policy', () => {
  afterEach(() => setNetworkPolicy('online'));

  it('allows only public catalog transfers for a login-free profile', () => {
    setNetworkPolicy('local-catalog-only');

    expect(isNetworkAllowed('catalog')).toBe(true);
    expect(isNetworkAllowed('backend')).toBe(false);
    expect(isNetworkAllowed('telemetry')).toBe(false);
    expect(isNetworkAllowed('ota')).toBe(false);
    expect(() => assertNetworkAllowed('backend')).toThrow(NetworkPolicyBlockedError);
  });

  it('blocks every request kind in signed-in hard offline mode', () => {
    setNetworkPolicy('account-offline');

    for (const kind of ['backend', 'catalog', 'telemetry', 'ota'] as const) {
      expect(isNetworkAllowed(kind)).toBe(false);
    }
  });

  it('notifies subscribers only when the policy changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNetworkPolicy(listener);

    setNetworkPolicy('account-offline');
    setNetworkPolicy('account-offline');
    unsubscribe();
    setNetworkPolicy('online');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
