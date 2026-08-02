import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { raceBrowserSignIn, type AuthSessionAppState, type AuthSessionRaceIo } from '../auth-session-race';

const CALLBACK_PREFIX = 'com.boardsesh.app://auth/callback';
const AUTH_URL = 'https://www.boardsesh.com/auth/native-start?provider=google';
const CALLBACK_GRACE_MS = 1_000;
const AUTH_DEADLINE_MS = 5 * 60_000;

function createIoHarness({
  platform = 'android',
  initialAppState = 'active',
}: {
  platform?: 'ios' | 'android';
  initialAppState?: AuthSessionAppState | null;
} = {}) {
  let urlListener: ((event: { url: string }) => void) | null = null;
  let appStateListener: ((state: AuthSessionAppState) => void) | null = null;
  let retainedUrlListener: ((event: { url: string }) => void) | null = null;
  let retainedAppStateListener: ((state: AuthSessionAppState) => void) | null = null;
  let currentAppState = initialAppState;
  let resolveBrowser: ((result: unknown) => void) | null = null;
  let rejectBrowser: ((reason: unknown) => void) | null = null;

  const removeUrlListener = vi.fn(() => {
    urlListener = null;
  });
  const removeAppStateListener = vi.fn(() => {
    appStateListener = null;
  });
  const addUrlListener = vi.fn((listener: (event: { url: string }) => void) => {
    urlListener = listener;
    retainedUrlListener = listener;
    return { remove: removeUrlListener };
  });
  const addAppStateListener = vi.fn((listener: (state: AuthSessionAppState) => void) => {
    appStateListener = listener;
    retainedAppStateListener = listener;
    return { remove: removeAppStateListener };
  });
  const dismissBrowser = vi.fn(() => Promise.resolve());
  const openBrowser = vi.fn(
    () =>
      new Promise<unknown>((resolve, reject) => {
        resolveBrowser = resolve;
        rejectBrowser = reject;
      }),
  );
  const setTimer = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  const io: AuthSessionRaceIo = {
    platform,
    addUrlListener,
    addAppStateListener,
    getCurrentAppState: () => currentAppState,
    openBrowser,
    dismissBrowser,
    setTimer,
    clearTimer,
  };

  return {
    io,
    addUrlListener,
    addAppStateListener,
    openBrowser,
    removeUrlListener,
    removeAppStateListener,
    dismissBrowser,
    setTimer,
    clearTimer,
    fireDeepLink: (url: string) => urlListener?.({ url }),
    fireAppState: (state: AuthSessionAppState) => {
      currentAppState = state;
      appStateListener?.(state);
    },
    resolveBrowser: (result: unknown) => resolveBrowser?.(result),
    failBrowser: (reason: unknown) => rejectBrowser?.(reason),
    fireRetainedDeepLink: (url: string) => retainedUrlListener?.({ url }),
    fireRetainedAppState: (state: AuthSessionAppState) => {
      currentAppState = state;
      retainedAppStateListener?.(state);
    },
  };
}

async function expectPending(promise: Promise<unknown>) {
  const resolution = vi.fn();
  void promise.then(resolution);
  await Promise.resolve();
  expect(resolution).not.toHaveBeenCalled();
}

describe('raceBrowserSignIn — Android', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers both listeners before opening and keeps {type: opened} pending', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

    expect(harness.addUrlListener.mock.invocationCallOrder[0]).toBeLessThan(
      harness.openBrowser.mock.invocationCallOrder[0],
    );
    expect(harness.addAppStateListener.mock.invocationCallOrder[0]).toBeLessThan(
      harness.openBrowser.mock.invocationCallOrder[0],
    );
    expect(harness.setTimer).toHaveBeenCalledWith(expect.any(Function), AUTH_DEADLINE_MS);

    harness.resolveBrowser({ type: 'opened' });
    await expectPending(racePromise);

    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=opened-tok`;
    harness.fireDeepLink(callbackUrl);
    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
  });

  it('lets a callback arriving before foreground win and dismisses the Custom Tab', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');

    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=before-active`;
    harness.fireDeepLink(callbackUrl);

    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
    expect(harness.dismissBrowser).toHaveBeenCalledOnce();
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledOnce();
  });

  it('lets a callback arriving after foreground beat the one-second cancel grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');
    harness.fireAppState('active');

    expect(harness.setTimer).toHaveBeenLastCalledWith(expect.any(Function), CALLBACK_GRACE_MS);
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS - 1);
    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=after-active`;
    harness.fireDeepLink(callbackUrl);

    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
    expect(harness.clearTimer).toHaveBeenCalledTimes(2);
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
  });

  it('cancels after an observed background-to-active return and callback grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');
    harness.fireAppState('active');

    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);

    await expect(racePromise).resolves.toEqual({ type: 'cancel' });
    expect(harness.dismissBrowser).not.toHaveBeenCalled();
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledTimes(2);
  });

  it('ignores lone active plus initial null, unknown, and inactive states', async () => {
    const harness = createIoHarness({ initialAppState: null });
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });

    harness.fireAppState('active');
    harness.fireAppState('unknown');
    harness.fireAppState('inactive');
    harness.fireAppState('active');
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);
    await expectPending(racePromise);

    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=ignored-states`;
    harness.fireDeepLink(callbackUrl);
    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
  });

  it('cancels pending foreground grace when the app backgrounds again', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');
    harness.fireAppState('active');
    await vi.advanceTimersByTimeAsync(500);

    harness.fireAppState('background');
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);
    await expectPending(racePromise);

    harness.fireAppState('active');
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);
    await expect(racePromise).resolves.toEqual({ type: 'cancel' });
  });

  it('waits through a backgrounded deadline, then times out after resumed callback grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');

    await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS * 10);
    await expectPending(racePromise);

    harness.fireAppState('active');
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS - 1);
    await expectPending(racePromise);
    await vi.advanceTimersByTimeAsync(1);

    await expect(racePromise).resolves.toEqual({ type: 'timeout' });
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledTimes(2);
  });

  it('lets a resumed Linking callback beat deadline settlement', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');
    await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS);

    harness.fireAppState('active');
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS - 1);
    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=resumed-deadline`;
    harness.fireDeepLink(callbackUrl);

    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
    expect(harness.clearTimer).toHaveBeenCalledTimes(2);
  });

  it('returns a distinct timeout after the never-backgrounded deadline and final grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });

    await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS);
    await expectPending(racePromise);
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);

    await expect(racePromise).resolves.toEqual({ type: 'timeout' });
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledTimes(2);
  });

  it('replaces an active cancel grace with the deadline timeout grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });

    await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS - 500);
    harness.fireAppState('background');
    harness.fireAppState('active');
    expect(harness.setTimer).toHaveBeenLastCalledWith(expect.any(Function), CALLBACK_GRACE_MS);

    await vi.advanceTimersByTimeAsync(500);
    await expectPending(racePromise);
    expect(harness.clearTimer).toHaveBeenCalledOnce();

    // The old cancel grace would have fired here. The deadline replaces it with
    // a fresh timeout grace so a final Linking callback still gets a full turn.
    await vi.advanceTimersByTimeAsync(500);
    await expectPending(racePromise);
    await vi.advanceTimersByTimeAsync(500);

    await expect(racePromise).resolves.toEqual({ type: 'timeout' });
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated URLs throughout the foreground grace', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');
    harness.fireAppState('active');
    harness.fireDeepLink('com.boardsesh.app://join/some-session');

    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);
    await expect(racePromise).resolves.toEqual({ type: 'cancel' });
    expect(harness.dismissBrowser).not.toHaveBeenCalled();
  });

  it.each([{ type: 'cancel' }, { type: 'dismiss' }, { type: 'future-terminal-result' }, null])(
    'treats terminal or unknown browser result $type as cancel',
    async (browserResult) => {
      const harness = createIoHarness();
      const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

      harness.resolveBrowser(browserResult);

      await expect(racePromise).resolves.toEqual({ type: 'cancel' });
      expect(harness.removeUrlListener).toHaveBeenCalledOnce();
      expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
      expect(harness.clearTimer).toHaveBeenCalledOnce();
    },
  );

  it('returns browser-open errors and cleans up exactly once', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

    harness.failBrowser(new Error('Custom Tab unavailable'));

    await expect(racePromise).resolves.toEqual({ type: 'error', message: 'Custom Tab unavailable' });
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledOnce();
  });

  it('keeps retained URL and AppState callbacks side-effect free after settlement', async () => {
    const harness = createIoHarness();
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    harness.resolveBrowser({ type: 'opened' });
    harness.fireAppState('background');

    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=settled-token`;
    harness.fireDeepLink(callbackUrl);
    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });

    expect(harness.dismissBrowser).toHaveBeenCalledOnce();
    expect(harness.setTimer).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledOnce();
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();

    harness.fireRetainedAppState('active');
    harness.fireRetainedAppState('background');
    harness.fireRetainedDeepLink(`${CALLBACK_PREFIX}?transferToken=late-token`);
    await vi.advanceTimersByTimeAsync(CALLBACK_GRACE_MS);

    expect(harness.dismissBrowser).toHaveBeenCalledOnce();
    expect(harness.setTimer).toHaveBeenCalledOnce();
    expect(harness.clearTimer).toHaveBeenCalledOnce();
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.removeAppStateListener).toHaveBeenCalledOnce();
  });
});

describe('raceBrowserSignIn — unchanged iOS semantics', () => {
  it('lets the matching callback win, dismisses, and removes only the URL listener', async () => {
    const harness = createIoHarness({ platform: 'ios' });
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);
    const callbackUrl = `${CALLBACK_PREFIX}?transferToken=ios-token`;

    harness.fireDeepLink('com.boardsesh.app://join/some-session');
    harness.fireDeepLink(callbackUrl);
    harness.resolveBrowser({ type: 'dismiss' });

    await expect(racePromise).resolves.toEqual({ type: 'success', url: callbackUrl });
    expect(harness.dismissBrowser).toHaveBeenCalledOnce();
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.addAppStateListener).not.toHaveBeenCalled();
    expect(harness.setTimer).not.toHaveBeenCalled();
  });

  it('treats every browser resolution, including opened, as cancel', async () => {
    const harness = createIoHarness({ platform: 'ios' });
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

    harness.resolveBrowser({ type: 'opened' });

    await expect(racePromise).resolves.toEqual({ type: 'cancel' });
    expect(harness.removeUrlListener).toHaveBeenCalledOnce();
    expect(harness.addAppStateListener).not.toHaveBeenCalled();
    expect(harness.setTimer).not.toHaveBeenCalled();
  });

  it('keeps browser rejection as an error with the original message', async () => {
    const harness = createIoHarness({ platform: 'ios' });
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

    harness.failBrowser(new Error('Another WebBrowser is already being presented.'));

    await expect(racePromise).resolves.toEqual({
      type: 'error',
      message: 'Another WebBrowser is already being presented.',
    });
    expect(harness.addAppStateListener).not.toHaveBeenCalled();
    expect(harness.setTimer).not.toHaveBeenCalled();
  });

  it('keeps the generic browser rejection message for non-Errors', async () => {
    const harness = createIoHarness({ platform: 'ios' });
    const racePromise = raceBrowserSignIn(harness.io, AUTH_URL, CALLBACK_PREFIX);

    harness.failBrowser('boom');

    await expect(racePromise).resolves.toEqual({ type: 'error', message: 'browser failed to open' });
  });
});
