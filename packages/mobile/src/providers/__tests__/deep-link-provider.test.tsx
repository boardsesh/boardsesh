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
const gate = vi.hoisted(() => ({ relaxesAnonymousRoutes: false }));
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
vi.mock('../../lib/routing/anonymous-auth-gate', () => ({
  get RELAXES_ANONYMOUS_ROUTES() {
    return gate.relaxesAnonymousRoutes;
  },
}));

import { DeepLinkProvider, PENDING_BOARD_LINK_MAX_AGE_MS } from '../deep-link-provider';
import { clearBoardLinkReplay, didReplayBoardLink } from '../../lib/routing/board-link-replay';

const PENDING_LEGACY_PREVIEW_KEY = 'boardsesh_pending_legacy_preview';
const LEGACY_PREVIEW_LINK = 'https://www.boardsesh.com/preview/pr-1234';

beforeEach(() => {
  navigateMock.mockClear();
  linkState.initialUrl = null;
  linkState.listener = null;
  authState.isAuthenticated = false;
  gate.relaxesAnonymousRoutes = false;
  store.clear();
  clearBoardLinkReplay();
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

const PENDING_BOARD_LINK_KEY = 'boardsesh_pending_board_link';
const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A climb link no other test has launched with: the provider handles each launch URL once per process. */
let climbLinkCount = 0;
function nextClimbPath(): string {
  climbLinkCount += 1;
  return `/kilter/1/7/1,20/40/view/the-proj-${climbLinkCount}`;
}

function storedBoardLink(): { path: string; stashedAt: number } | null {
  const stored = store.get(PENDING_BOARD_LINK_KEY);
  return stored ? (JSON.parse(stored) as { path: string; stashedAt: number }) : null;
}

/** Let the provider's mount effects (launch URL read, pending replays) run dry. */
async function settleProvider(): Promise<void> {
  await waitFor(() => expect(linkState.listener).not.toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('DeepLinkProvider — board and climb links', () => {
  it('stashes the climb a signed-out cold start was launched with', async () => {
    const climbPath = nextClimbPath();
    linkState.initialUrl = `https://www.boardsesh.com${climbPath}`;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(storedBoardLink()?.path).toBe(climbPath));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('lands on the climb after sign-in, once', async () => {
    const climbPath = nextClimbPath();
    linkState.initialUrl = `https://www.boardsesh.com${climbPath}`;
    const { unmount } = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(storedBoardLink()?.path).toBe(climbPath));

    // The auth gate swaps the tree on sign-in, so the provider mounts again
    // with the same launch URL and a session.
    unmount();
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(climbPath));
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);

    // A later remount in the same session finds nothing left to replay.
    signedIn.unmount();
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it('stashes a link tapped while the login screen is already up', async () => {
    render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(linkState.listener).not.toBeNull());

    linkState.listener?.({ url: 'https://www.boardsesh.com/es/b/the-garage/40/list' });

    // The locale prefix is gone: the app's route tree has none.
    await waitFor(() => expect(storedBoardLink()?.path).toBe('/b/the-garage/40/list'));
  });

  it('keeps the wall an unlisted spray-wall link names, and nothing else from the query', async () => {
    render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(linkState.listener).not.toBeNull());

    linkState.listener?.({ url: `https://www.boardsesh.com/b/the-garage?wall=${WALL_UUID}&utm_source=share` });

    await waitFor(() => expect(storedBoardLink()?.path).toBe(`/b/the-garage?wall=${WALL_UUID}`));
  });

  it('keeps the latest link when a second one is tapped before sign-in', async () => {
    render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(linkState.listener).not.toBeNull());

    linkState.listener?.({ url: 'https://www.boardsesh.com/b/the-garage' });
    await waitFor(() => expect(storedBoardLink()?.path).toBe('/b/the-garage'));
    linkState.listener?.({ url: 'https://www.boardsesh.com/b/the-shed' });

    await waitFor(() => expect(storedBoardLink()?.path).toBe('/b/the-shed'));
  });

  it('leaves a signed-in link to Expo Router: no stash, no second navigation', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = `https://www.boardsesh.com${nextClimbPath()}`;

    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    linkState.listener?.({ url: 'https://www.boardsesh.com/b/the-garage' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not stash the launch link again after a sign-out in the same run', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = `https://www.boardsesh.com${nextClimbPath()}`;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    // Hours later they sign out. The launch URL is still what it was.
    signedIn.unmount();
    authState.isAuthenticated = false;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
  });

  it.each([
    ['a profile link', 'https://www.boardsesh.com/profile/someone'],
    ['a gym page', 'https://www.boardsesh.com/gym/the-gym'],
    ['another host', 'https://evil.example/kilter/1/7/1,20/40/list'],
    ['a board path the app has no route for', 'https://www.boardsesh.com/kilter/1/7/1,20/40/edit/x'],
  ])('ignores %s', async (_label, url) => {
    linkState.initialUrl = url;

    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
  });

  it('drops a stashed link older than a day instead of opening it', async () => {
    store.set(
      PENDING_BOARD_LINK_KEY,
      JSON.stringify({ path: '/b/the-garage', stashedAt: Date.now() - PENDING_BOARD_LINK_MAX_AGE_MS - 1_000 }),
    );
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false));
    await settleProvider();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a path that is not a board route', JSON.stringify({ path: '/auth/login', stashedAt: Date.now() })],
    ['a full URL', JSON.stringify({ path: 'https://evil.example/b/x', stashedAt: Date.now() })],
    ['a link stamped in the future', JSON.stringify({ path: '/b/the-garage', stashedAt: Date.now() + 60_000 })],
    ['a link with no timestamp', JSON.stringify({ path: '/b/the-garage' })],
    ['a bare path from some other writer', '/b/the-garage'],
    ['a JSON value that is not an object', 'null'],
  ])('never navigates to %s found in storage', async (_label, stored) => {
    store.set(PENDING_BOARD_LINK_KEY, stored);
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false));
    await settleProvider();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('stays out of the way in the browser app, which carries the path on the login URL', async () => {
    gate.relaxesAnonymousRoutes = true;
    linkState.initialUrl = `https://www.boardsesh.com${nextClimbPath()}`;
    store.set(PENDING_BOARD_LINK_KEY, JSON.stringify({ path: '/b/the-garage', stashedAt: Date.now() }));

    const signedOut = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(storedBoardLink()?.path).toBe('/b/the-garage');

    signedOut.unmount();
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    expect(navigateMock).not.toHaveBeenCalled();
  });

  // The onboarding gate reads this before it pushes the first-board picker, so
  // a new account is not shown "Where do you climb?" over the shared climb.
  it('tells the onboarding gate when a sign-in opened a stashed climb', async () => {
    const climbPath = nextClimbPath();
    store.set(PENDING_BOARD_LINK_KEY, JSON.stringify({ path: climbPath, stashedAt: Date.now() }));
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    // Asked straight after mount, while the stash read is still in flight.
    await expect(didReplayBoardLink()).resolves.toBe(true);
    expect(navigateMock).toHaveBeenCalledWith(climbPath);
  });

  it('tells the onboarding gate "no" when a sign-in had nothing stashed, or only an expired link', async () => {
    authState.isAuthenticated = true;
    const nothingStashed = render(createElement(DeepLinkProvider, { children: null }));
    await expect(didReplayBoardLink()).resolves.toBe(false);
    nothingStashed.unmount();

    store.set(
      PENDING_BOARD_LINK_KEY,
      JSON.stringify({ path: '/b/the-garage', stashedAt: Date.now() - PENDING_BOARD_LINK_MAX_AGE_MS - 1_000 }),
    );
    render(createElement(DeepLinkProvider, { children: null }));
    await expect(didReplayBoardLink()).resolves.toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('forgets the last sign-in once signed out, so the next account starts from "no"', async () => {
    store.set(PENDING_BOARD_LINK_KEY, JSON.stringify({ path: nextClimbPath(), stashedAt: Date.now() }));
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await expect(didReplayBoardLink()).resolves.toBe(true);

    signedIn.unmount();
    authState.isAuthenticated = false;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    await expect(didReplayBoardLink()).resolves.toBe(false);
  });

  it('does not put a join link in the board stash', async () => {
    linkState.initialUrl = `https://www.boardsesh.com/join/${WALL_UUID}`;

    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
  });
});
