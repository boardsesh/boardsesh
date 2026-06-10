import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => ({ OS: 'ios' }));
const linking = vi.hoisted(() => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));
vi.mock('react-native', () => ({ Platform: platformState, Linking: linking }));

const webBrowser = vi.hoisted(() => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  dismissBrowser: vi.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss' },
}));
vi.mock('expo-web-browser', () => webBrowser);

vi.mock('../auth-store', () => ({
  storeTokens: vi.fn(),
  clearTokens: vi.fn(),
  getRefreshToken: vi.fn(async () => null),
}));

const race = vi.hoisted(() => ({ raceBrowserSignIn: vi.fn() }));
vi.mock('../auth-session-race', () => ({ raceBrowserSignIn: race.raceBrowserSignIn }));

import { clearPendingOAuthProvider, getPendingOAuthProvider, signOut, startSignIn } from '../auth';
import type { AuthSessionRaceIo } from '../auth-session-race';

const CALLBACK_URL = 'com.boardsesh.app://auth/callback';

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingOAuthProvider();
  platformState.OS = 'ios';
});

describe('startSignIn', () => {
  it('delegates to openAuthSessionAsync off iOS and records the pending provider', async () => {
    platformState.OS = 'android';
    const sessionResult = { type: 'dismiss' };
    webBrowser.openAuthSessionAsync.mockResolvedValue(sessionResult);

    const result = await startSignIn('google');

    expect(result).toBe(sessionResult);
    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      expect.stringContaining('/auth/native-start?provider=google'),
      CALLBACK_URL,
    );
    expect(race.raceBrowserSignIn).not.toHaveBeenCalled();
    expect(getPendingOAuthProvider()).toBe('google');
  });

  it('maps the iOS race success to a redirect result', async () => {
    const callbackUrl = `${CALLBACK_URL}?transferToken=tok`;
    race.raceBrowserSignIn.mockResolvedValue({ type: 'success', url: callbackUrl });

    await expect(startSignIn('apple')).resolves.toEqual({ type: 'success', url: callbackUrl });
    expect(race.raceBrowserSignIn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/auth/native-start?provider=apple'),
      CALLBACK_URL,
    );
    expect(getPendingOAuthProvider()).toBe('apple');
  });

  it('maps the iOS race cancel to a WebBrowser cancel result', async () => {
    race.raceBrowserSignIn.mockResolvedValue({ type: 'cancel' });

    await expect(startSignIn('apple')).resolves.toEqual({ type: 'cancel' });
  });

  it('promotes an iOS race error to a thrown exception', async () => {
    race.raceBrowserSignIn.mockResolvedValue({ type: 'error', message: 'no browser available' });

    await expect(startSignIn('apple')).rejects.toThrow('no browser available');
  });

  it('hands the race an io whose dismissBrowser always returns a promise', async () => {
    race.raceBrowserSignIn.mockResolvedValue({ type: 'cancel' });
    await startSignIn('apple');
    const io = race.raceBrowserSignIn.mock.calls[0][0] as AuthSessionRaceIo;

    // Some SDK versions return void instead of a promise…
    webBrowser.dismissBrowser.mockReturnValue(undefined);
    await expect(io.dismissBrowser()).resolves.toBeUndefined();

    // …and a synchronous throw must become a rejection the race can swallow.
    webBrowser.dismissBrowser.mockImplementation(() => {
      throw new Error('sync throw');
    });
    await expect(io.dismissBrowser()).rejects.toThrow('sync throw');
  });
});

describe('pendingOAuthProvider lifecycle', () => {
  it('is overwritten per attempt, cleared explicitly, and cleared on sign-out', async () => {
    platformState.OS = 'android';
    webBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'dismiss' });

    await startSignIn('google');
    expect(getPendingOAuthProvider()).toBe('google');

    clearPendingOAuthProvider();
    expect(getPendingOAuthProvider()).toBeNull();

    await startSignIn('apple');
    expect(getPendingOAuthProvider()).toBe('apple');

    await signOut();
    expect(getPendingOAuthProvider()).toBeNull();
  });
});
