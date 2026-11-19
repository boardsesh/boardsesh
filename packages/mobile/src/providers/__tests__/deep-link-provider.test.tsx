// @vitest-environment jsdom
// Existing flow fixtures begin after the privacy choice has settled.
vi.mock('../../lib/consent-hooks', () => ({ useConsentSettled: () => true }));
import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateMock = vi.hoisted(() => vi.fn());
const linkState = vi.hoisted(() => ({
  initialUrl: null as string | null,
  listener: null as ((event: { url: string }) => void) | null,
}));
const authState = vi.hoisted(() => ({ isAuthenticated: false }));
const gate = vi.hoisted(() => ({ relaxesAnonymousRoutes: false, appWorkoutsEnabled: true }));
vi.mock('../feature-flags-provider', () => ({ useAppWorkoutsFlag: () => gate.appWorkoutsEnabled }));
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

import {
  DeepLinkProvider,
  PENDING_BOARD_LINK_MAX_AGE_MS,
  resetHandledLaunchBoardUrlForTests,
} from '../deep-link-provider';
import { clearBoardLinkReplay, didReplayBoardLink } from '../../lib/routing/board-link-replay';
import {
  PENDING_APP_WORKOUT_KEY,
  serializePendingAppWorkout,
  readPendingAppWorkout,
  PENDING_APP_WORKOUT_MAX_AGE_MS,
} from '../../lib/partner-workout-link';
import {
  PENDING_SESSION_HISTORY_KEY,
  readPendingSessionHistory,
  serializePendingSessionHistory,
} from '../../lib/partner-session-history-link';

const PENDING_LEGACY_PREVIEW_KEY = 'boardsesh_pending_legacy_preview';
const LEGACY_PREVIEW_LINK = 'https://www.boardsesh.com/preview/pr-1234';

beforeEach(() => {
  navigateMock.mockClear();
  linkState.initialUrl = null;
  linkState.listener = null;
  authState.isAuthenticated = false;
  gate.relaxesAnonymousRoutes = false;
  gate.appWorkoutsEnabled = true;
  store.clear();
  clearBoardLinkReplay();
  // Each test is its own launch: the provider handles a launch URL once per process.
  resetHandledLaunchBoardUrlForTests();
});

describe('DeepLinkProvider — read-only session history', () => {
  const exportId = '3c2d56f7-1f63-4c63-9c48-3c239b14727d';

  it.each([
    `com.boardsesh.app://history/session/${exportId}`,
    `https://www.boardsesh.com/zh-CN/history/session/${exportId}`,
  ])('preserves a signed-out history launch through sign-in: %s', async (url) => {
    linkState.initialUrl = url;
    const signedOut = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() =>
      expect(readPendingSessionHistory(store.get(PENDING_SESSION_HISTORY_KEY) ?? null)).toBe(exportId),
    );
    expect(navigateMock).not.toHaveBeenCalled();
    signedOut.unmount();
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        pathname: '/history/session/[exportId]',
        params: { exportId },
      }),
    );
    expect(store.has(PENDING_SESSION_HISTORY_KEY)).toBe(false);
  });

  it('opens a warm history link without entering the join flow', async () => {
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    linkState.listener?.({ url: `https://www.boardsesh.com/history/session/${exportId}` });
    expect(navigateMock).toHaveBeenCalledWith({
      pathname: '/history/session/[exportId]',
      params: { exportId },
    });
    expect(navigateMock.mock.calls.some(([destination]) => destination?.pathname === '/join/[sessionId]')).toBe(false);
  });

  it('does not reopen a consumed launch after signing out again', async () => {
    linkState.initialUrl = `com.boardsesh.app://history/session/${exportId}`;
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    signedIn.unmount();
    authState.isAuthenticated = false;
    navigateMock.mockClear();
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(store.has(PENDING_SESSION_HISTORY_KEY)).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('discards an expired history link at sign-in', async () => {
    authState.isAuthenticated = true;
    store.set(PENDING_SESSION_HISTORY_KEY, serializePendingSessionHistory(exportId, Date.now() - 25 * 60 * 60 * 1000));
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(store.has(PENDING_SESSION_HISTORY_KEY)).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe('DeepLinkProvider — partner workout links', () => {
  it('discards a disabled launch and never replays it after a later flag change', async () => {
    gate.appWorkoutsEnabled = false;
    linkState.initialUrl = 'com.boardsesh.app://w/wk_disabled';
    store.set(PENDING_APP_WORKOUT_KEY, serializePendingAppWorkout('wk_old'));
    const view = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(store.has(PENDING_APP_WORKOUT_KEY)).toBe(false);
    gate.appWorkoutsEnabled = true;
    authState.isAuthenticated = true;
    view.rerender(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it.each([
    serializePendingAppWorkout('wk_old', Date.now() - PENDING_APP_WORKOUT_MAX_AGE_MS - 1000),
    serializePendingAppWorkout('wk_future', Date.now() + 60_000),
    'wk_legacy_without_expiry',
  ])('drops expired, future-clock, and legacy stashes on a cold sign-in: %s', async (stored) => {
    store.set(PENDING_APP_WORKOUT_KEY, stored);
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(store.has(PENDING_APP_WORKOUT_KEY)).toBe(false);
  });
  it('preserves a signed-out launch through sign-in and consumes it once', async () => {
    linkState.initialUrl = 'com.boardsesh.app://w/wk_training';
    const signedOut = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(readPendingAppWorkout(store.get(PENDING_APP_WORKOUT_KEY) ?? null)).toBe('wk_training'));
    expect(navigateMock).not.toHaveBeenCalled();
    signedOut.unmount();
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledExactlyOnceWith({
        pathname: '/w/[workoutId]',
        params: { workoutId: 'wk_training' },
      }),
    );
    expect(store.has(PENDING_APP_WORKOUT_KEY)).toBe(false);
    signedIn.unmount();
    authState.isAuthenticated = false;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(store.has(PENDING_APP_WORKOUT_KEY)).toBe(false);
  });

  it('does not navigate an arbitrary stored path after sign-in', async () => {
    store.set(PENDING_APP_WORKOUT_KEY, '//evil.example');
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(navigateMock).not.toHaveBeenCalled();
  });
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

const CLIMB_PATH = '/kilter/1/7/1,20/40/view/the-proj';

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
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;

    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(storedBoardLink()?.path).toBe(CLIMB_PATH));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('lands on the climb after sign-in, once', async () => {
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;
    const { unmount } = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(storedBoardLink()?.path).toBe(CLIMB_PATH));

    // The auth gate swaps the tree on sign-in, so the provider mounts again
    // with the same launch URL and a session.
    unmount();
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(CLIMB_PATH));
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

  it("keeps a board share link's token through sign-in, then opens it so the board can redeem it", async () => {
    const token = 'Ab3_dE-fGhIjKlMnOpQrSt';
    const { unmount } = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(linkState.listener).not.toBeNull());

    linkState.listener?.({ url: `https://www.boardsesh.com/b/the-garage?invite=${token}&utm_source=share` });
    await waitFor(() => expect(storedBoardLink()?.path).toBe(`/b/the-garage?invite=${token}`));

    unmount();
    authState.isAuthenticated = true;
    render(createElement(DeepLinkProvider, { children: null }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(`/b/the-garage?invite=${token}`));
    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
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
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;

    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    linkState.listener?.({ url: 'https://www.boardsesh.com/b/the-garage' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not stash the launch link again after a sign-out in the same run', async () => {
    authState.isAuthenticated = true;
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    // Hours later they sign out. The launch URL is still what it was.
    signedIn.unmount();
    authState.isAuthenticated = false;
    render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();

    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);
  });

  it('stashes a launch link once per run, however often the provider remounts', async () => {
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;
    const signedOut = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(storedBoardLink()?.path).toBe(CLIMB_PATH));

    // Sign in: the stash is opened and cleared.
    signedOut.unmount();
    authState.isAuthenticated = true;
    const signedIn = render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(CLIMB_PATH));

    // Sign out. The provider sees the same launch URL a second time, signed out.
    signedIn.unmount();
    authState.isAuthenticated = false;
    const signedOutAgain = render(createElement(DeepLinkProvider, { children: null }));
    await settleProvider();
    expect(store.has(PENDING_BOARD_LINK_KEY)).toBe(false);

    // The same link tapped again is a new tap, not the launch: it is stashed.
    linkState.listener?.({ url: `https://www.boardsesh.com${CLIMB_PATH}` });
    await waitFor(() => expect(storedBoardLink()?.path).toBe(CLIMB_PATH));

    // A new process launched with that URL starts over.
    signedOutAgain.unmount();
    store.clear();
    resetHandledLaunchBoardUrlForTests();
    render(createElement(DeepLinkProvider, { children: null }));
    await waitFor(() => expect(storedBoardLink()?.path).toBe(CLIMB_PATH));
    expect(navigateMock).toHaveBeenCalledTimes(1);
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
    linkState.initialUrl = `https://www.boardsesh.com${CLIMB_PATH}`;
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
    store.set(PENDING_BOARD_LINK_KEY, JSON.stringify({ path: CLIMB_PATH, stashedAt: Date.now() }));
    authState.isAuthenticated = true;

    render(createElement(DeepLinkProvider, { children: null }));

    // Asked straight after mount, while the stash read is still in flight.
    await expect(didReplayBoardLink()).resolves.toBe(true);
    expect(navigateMock).toHaveBeenCalledWith(CLIMB_PATH);
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
    store.set(PENDING_BOARD_LINK_KEY, JSON.stringify({ path: CLIMB_PATH, stashedAt: Date.now() }));
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

import { grantAnalyticsForTest } from '../../../test/consent-fixture';
beforeEach(() => grantAnalyticsForTest());
