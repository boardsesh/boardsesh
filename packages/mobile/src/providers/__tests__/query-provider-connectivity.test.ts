import { describe, it, expect, vi } from 'vitest';
import {
  BACKEND_UNAVAILABLE_ERROR_NAME,
  GRAPHQL_REQUEST_TIMEOUT_CODE,
} from '@boardsesh/offline-sync/error-classification';

// Capture the listeners the query-provider module wires at load so we can drive
// them and assert the React Query managers respond. The holder is created with
// vi.hoisted so it's initialised before the (hoisted) mock factories and the
// hoisted `import '../query-provider'` run — a plain `let` would be in its TDZ
// when the module's load-time wiring fires. These mocks take precedence over
// the vite.config NetInfo alias and any global react-native handling.
const captured = vi.hoisted(() => ({
  netInfoListener: null as ((state: { isConnected: boolean | null }) => void) | null,
  appStateHandlers: [] as ((status: string) => void)[],
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: (listener: (state: { isConnected: boolean | null }) => void) => {
      captured.netInfoListener = listener;
      return () => {};
    },
    // The store seeds its device state via fetch() before the live listener
    // arrives; resolve to connected so the seed leaves the app online (the
    // default the tests below then drive away from).
    fetch: () => Promise.resolve({ isConnected: true }),
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, handler: (status: string) => void) => {
      captured.appStateHandlers.push(handler);
      return { remove: () => {} };
    },
  },
  Platform: { OS: 'ios' },
}));

vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn(), addErrorBreadcrumb: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

import { onlineManager, focusManager } from '@tanstack/react-query';
// Importing the provider runs the module-level connectivity wiring: it starts
// the connectivity store, which captures the NetInfo + AppState listeners via
// the mocks above.
import { createQueryClient } from '../query-provider';

function retryPolicy(): (failureCount: number, error: unknown) => boolean {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== 'function') throw new Error('expected a retry predicate on the default query options');
  return retry as (failureCount: number, error: unknown) => boolean;
}

describe('query-provider connectivity wiring', () => {
  // The provider no longer talks to NetInfo itself (#4862). It starts the
  // connectivity store, and the store is the single writer of onlineManager —
  // which is what stops a dead BACKEND from reading as "online".
  it('bridges NetInfo connectivity into onlineManager through the store', () => {
    expect(captured.netInfoListener).not.toBeNull();

    captured.netInfoListener?.({ isConnected: false });
    expect(onlineManager.isOnline()).toBe(false);

    captured.netInfoListener?.({ isConnected: true });
    expect(onlineManager.isOnline()).toBe(true);
  });

  // `null` is "NetInfo has not finished probing", never "no network". Reading it
  // as a disconnect would strand the first fetch of every cold start — the same
  // `isConnected ?? true` semantics this provider shipped before the store.
  it('treats unknown connectivity as online', () => {
    captured.netInfoListener?.({ isConnected: null });
    expect(onlineManager.isOnline()).toBe(true);
  });

  it('bridges AppState foreground/background into focusManager', () => {
    expect(captured.appStateHandlers.length).toBeGreaterThan(0);

    for (const handler of captured.appStateHandlers) handler('background');
    expect(focusManager.isFocused()).toBe(false);

    for (const handler of captured.appStateHandlers) handler('active');
    expect(focusManager.isFocused()).toBe(true);
  });
});

describe('query-provider retry policy', () => {
  // Nothing was sent: the client short-circuited on known-bad connectivity, so a
  // retry can only produce the identical local rejection two more times and
  // delay the degraded UI by exactly that long.
  it('never retries a backend-unavailable short-circuit', () => {
    const backendUnavailable = new Error('offline');
    backendUnavailable.name = BACKEND_UNAVAILABLE_ERROR_NAME;

    expect(retryPolicy()(0, backendUnavailable)).toBe(false);
  });

  // The store's backoff ladder is already asking whether the server is back.
  // Three more 20s hangs per query on top of that is how an outage turns into a
  // frozen app.
  it('never retries our own request deadline', () => {
    const timedOut: Error & { code?: string } = new Error('GraphQL request timed out after 20000ms');
    timedOut.name = 'AbortError';
    timedOut.code = GRAPHQL_REQUEST_TIMEOUT_CODE;

    expect(retryPolicy()(0, timedOut)).toBe(false);
  });

  it('still retries an ordinary failure twice', () => {
    const retry = retryPolicy();
    const ordinary = new Error('boom');

    expect(retry(0, ordinary)).toBe(true);
    expect(retry(1, ordinary)).toBe(true);
    expect(retry(2, ordinary)).toBe(false);
  });
});
