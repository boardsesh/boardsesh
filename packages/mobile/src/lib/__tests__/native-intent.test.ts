import { describe, it, expect, vi, beforeEach } from 'vitest';

const getShareExtensionKeyMock = vi.fn();
vi.mock('expo-share-intent', () => ({
  getShareExtensionKey: () => getShareExtensionKeyMock(),
}));

import { redirectSystemPath } from '../../../app/+native-intent';

const JOIN_LINK = '/join/123e4567-e89b-12d3-a456-426614174000';

describe('redirectSystemPath', () => {
  beforeEach(() => {
    getShareExtensionKeyMock.mockReset();
  });

  it('redirects the share-extension deep link to the home route on cold start', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app://share?dataUrl=SHAREKEY', initial: true })).toBe('/');
  });

  it('returns empty (skips re-navigation) for a warm share so Home is not remounted', () => {
    // initial:false = app already running. Returning '/' here re-fires the root
    // home redirect and remounts the Home tab tree on every share; '' makes Expo
    // Router skip the navigation and lets ShareTargetProvider drive /share-beta.
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app://share?dataUrl=SHAREKEY', initial: false })).toBe('');
  });

  it('suppresses navigation for a warm OAuth fallback callback so the result handler owns it', () => {
    // On Android the browser fallback's com.boardsesh.app://auth/callback redirect
    // is delivered as a real deep link; routing it would hit +not-found and navigate
    // the auth screen to home before runWebFallback can show its error. '' skips that.
    expect(redirectSystemPath({ path: 'com.boardsesh.app://auth/callback?transferToken=abc', initial: false })).toBe(
      '',
    );
    // A ?error= callback is the case the suppression protects (must not navigate away).
    expect(redirectSystemPath({ path: '/auth/callback?error=session_missing', initial: false })).toBe('');
  });

  it('does NOT suppress a cold-start auth/callback (stale intent) — falls through to normal routing', () => {
    // '' is not a safe cold-start destination. A stale queued auth/callback intent
    // (no exchange in flight) must fall through to +not-found → home, not be swallowed.
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: '/auth/callback?error=session_missing', initial: true })).toBe(
      '/auth/callback?error=session_missing',
    );
  });

  it('only matches the auth/callback path segment, not routes that merely contain it', () => {
    // The match is anchored so an unrelated route isn't silently suppressed.
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: '/admin/auth/callback-debug', initial: false })).toBe(
      '/admin/auth/callback-debug',
    );
  });

  it('leaves ordinary deep links untouched', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: JOIN_LINK, initial: true })).toBe(JOIN_LINK);
  });

  it('falls through to the original path (never reroutes) when getShareExtensionKey throws', () => {
    // Off-native (web, tests, module not loaded) getShareExtensionKey can throw.
    getShareExtensionKeyMock.mockImplementation(() => {
      throw new Error('native module not loaded');
    });
    expect(redirectSystemPath({ path: JOIN_LINK, initial: true })).toBe(JOIN_LINK);
  });
});
