// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Covers the OTA-preview half of the provider: a link that arrives while signed
// out must survive the auth gate's redirect to /auth/login and replay once the
// user is back. react-native (via expo-linking / expo-router) can't be imported
// in a test env, so every native edge is mocked; the URL parsing itself is pure
// and tested in lib/__tests__/preview-link.test.ts.
const navigateMock = vi.hoisted(() => vi.fn());
const linkState = vi.hoisted(() => ({
  initialUrl: null as string | null,
  listener: null as ((event: { url: string }) => void) | null,
}));
const authState = vi.hoisted(() => ({ isAuthenticated: false }));
const store = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: navigateMock }) }));

vi.mock('expo-linking', () => ({
  getInitialURL: () => Promise.resolve(linkState.initialUrl),
  addEventListener: (_event: string, handler: (event: { url: string }) => void) => {
    linkState.listener = handler;
    return {
      remove: () => {
        linkState.listener = null;
      },
    };
  },
  // Only the join parser uses parse(); preview parsing is pure string work.
  parse: () => ({ hostname: null, path: null }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => Promise.resolve(store.get(key) ?? null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  },
}));

vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../auth-provider', () => ({ useAuth: () => ({ isAuthenticated: authState.isAuthenticated }) }));

import { DeepLinkProvider } from '../deep-link-provider';

const PENDING_PREVIEW_KEY = 'boardsesh_pending_preview_channel';
const PREVIEW_LINK = 'https://www.boardsesh.com/preview/pr-1234';

beforeEach(() => {
  navigateMock.mockClear();
  linkState.initialUrl = null;
  linkState.listener = null;
  authState.isAuthenticated = false;
  store.clear();
});

describe('DeepLinkProvider — OTA preview links', () => {
  it('routes straight to the preview screen when already signed in', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = PREVIEW_LINK;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ pathname: '/preview/[channel]', params: { channel: 'pr-1234' } }),
    );
    expect(store.get(PENDING_PREVIEW_KEY)).toBeUndefined();
  });

  it('stashes instead of navigating when signed out', async () => {
    // The auth gate is about to redirect to /auth/login and swallow the route —
    // this stash is the whole reason the link survives.
    linkState.initialUrl = PREVIEW_LINK;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(store.get(PENDING_PREVIEW_KEY)).toBe('pr-1234'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('replays the stashed channel once authenticated, and clears it', async () => {
    store.set(PENDING_PREVIEW_KEY, 'pr-1234');
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ pathname: '/preview/[channel]', params: { channel: 'pr-1234' } }),
    );
    // Cleared on consume, so a later launch doesn't re-open the preview.
    await waitFor(() => expect(store.has(PENDING_PREVIEW_KEY)).toBe(false));
  });

  it('drops a stashed value that is not a channel we would switch onto', async () => {
    // The stash outlives the launch that wrote it, so it is re-validated on the
    // way out — an older build's value (or an edited one) must not reach the
    // switcher.
    store.set(PENDING_PREVIEW_KEY, 'not-a-channel');
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(store.has(PENDING_PREVIEW_KEY)).toBe(false));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('handles a warm link that arrives while the app is already running', async () => {
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(linkState.listener).not.toBeNull());
    linkState.listener?.({ url: 'com.boardsesh.app:///preview/pr-99' });

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({ pathname: '/preview/[channel]', params: { channel: 'pr-99' } }),
    );
  });

  it('ignores a link that is neither a join nor a preview link', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = 'https://www.boardsesh.com/settings';

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(linkState.listener).not.toBeNull());
    expect(navigateMock).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});
