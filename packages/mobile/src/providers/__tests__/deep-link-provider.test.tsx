// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    return { remove: () => (linkState.listener = null) };
  },
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

const PENDING_LEGACY_PREVIEW_KEY = 'boardsesh_pending_legacy_preview';
const LEGACY_PREVIEW_LINK = 'https://www.boardsesh.com/preview/pr-1234';

beforeEach(() => {
  navigateMock.mockClear();
  linkState.initialUrl = null;
  linkState.listener = null;
  authState.isAuthenticated = false;
  store.clear();
});

describe('DeepLinkProvider — legacy OTA preview links', () => {
  it('keeps the safe changelog destination when already signed in', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = LEGACY_PREVIEW_LINK;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/changelog'));
    expect(store.has(PENDING_LEGACY_PREVIEW_KEY)).toBe(false);
  });

  it('handles a warm legacy preview link while already signed in', async () => {
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(linkState.listener).not.toBeNull());
    linkState.listener?.({ url: 'https://www.boardsesh.com/preview/pr-99' });

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/changelog'));
  });

  it('stashes the destination while signed out', async () => {
    linkState.initialUrl = LEGACY_PREVIEW_LINK;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(store.get(PENDING_LEGACY_PREVIEW_KEY)).toBe('1'));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('replays the destination after authentication and consumes it once', async () => {
    store.set(PENDING_LEGACY_PREVIEW_KEY, '1');
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/changelog'));
    await waitFor(() => expect(store.has(PENDING_LEGACY_PREVIEW_KEY)).toBe(false));
  });

  it('ignores an invalid pending marker', async () => {
    store.set(PENDING_LEGACY_PREVIEW_KEY, 'unexpected');
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(linkState.listener).not.toBeNull());
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
