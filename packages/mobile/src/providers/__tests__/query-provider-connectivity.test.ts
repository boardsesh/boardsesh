import { describe, it, expect, vi } from 'vitest';

// Capture the listeners the query-provider module wires at load so we can drive
// them and assert the React Query managers respond. The holder is created with
// vi.hoisted so it's initialised before the (hoisted) mock factories and the
// hoisted `import '../query-provider'` run — a plain `let` would be in its TDZ
// when the module's load-time setEventListener fires. These mocks take
// precedence over the vite.config NetInfo alias and any global react-native
// handling.
const captured = vi.hoisted(() => ({
  netInfoListener: null as ((state: { isConnected: boolean | null }) => void) | null,
  appStateHandler: null as ((status: string) => void) | null,
  policyListener: null as (() => void) | null,
  policyAllowsBackend: true,
}));

vi.mock('../../lib/network-policy', () => ({
  isNetworkAllowed: () => captured.policyAllowsBackend,
  subscribeNetworkPolicy: (listener: () => void) => {
    captured.policyListener = listener;
    return () => {};
  },
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (listener: (state: { isConnected: boolean | null }) => void) => {
      captured.netInfoListener = listener;
      return () => {};
    },
    // The provider seeds the initial state via fetch() before registering the
    // live listener; resolve to connected so the seed leaves onlineManager
    // online (the default the tests below then drive away from).
    fetch: () => Promise.resolve({ isConnected: true }),
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, handler: (status: string) => void) => {
      captured.appStateHandler = handler;
      return { remove: () => {} };
    },
  },
  Platform: { OS: 'ios' },
}));

vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));

import { onlineManager, focusManager } from '@tanstack/react-query';
// Importing the provider runs the module-level connectivity wiring, capturing
// the NetInfo + AppState listeners via the mocks above.
import '../query-provider';

describe('query-provider connectivity wiring', () => {
  it('bridges NetInfo connectivity into onlineManager', () => {
    expect(captured.netInfoListener).not.toBeNull();

    captured.netInfoListener?.({ isConnected: false });
    expect(onlineManager.isOnline()).toBe(false);

    captured.netInfoListener?.({ isConnected: true });
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('forces React Query offline while the app network policy blocks backend traffic', () => {
    captured.netInfoListener?.({ isConnected: true });
    captured.policyAllowsBackend = false;
    captured.policyListener?.();
    expect(onlineManager.isOnline()).toBe(false);

    captured.policyAllowsBackend = true;
    captured.policyListener?.();
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('treats unknown connectivity as online', () => {
    captured.netInfoListener?.({ isConnected: null });
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('bridges AppState foreground/background into focusManager', () => {
    expect(captured.appStateHandler).not.toBeNull();

    captured.appStateHandler?.('background');
    expect(focusManager.isFocused()).toBe(false);

    captured.appStateHandler?.('active');
    expect(focusManager.isFocused()).toBe(true);
  });
});
