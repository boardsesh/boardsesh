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

  // The browser-OAuth fallback (src/lib/auth.ts raceBrowserSignIn) owns the
  // auth/callback deep link via its own Linking listener; redirectSystemPath must
  // return '' so Expo Router doesn't flash +not-found on the non-existent route.
  const CALLBACK = 'com.boardsesh.app://auth/callback?transferToken=tok-1&next=%2F';

  it('skips navigation for the OAuth callback deep link on cold start', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: CALLBACK, initial: true })).toBe('');
  });

  it('skips navigation for the OAuth callback deep link on a warm open', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: CALLBACK, initial: false })).toBe('');
  });

  it('also matches the bare-path callback form (defensive against Expo normalising the URL)', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: '/auth/callback?transferToken=tok-2', initial: false })).toBe('');
  });

  it('suppresses the callback even when getShareExtensionKey throws (guard runs before the share branch)', () => {
    // The load-bearing property: the callback guard is checked before the
    // throwing getShareExtensionKey() call, so an off-native throw can't let the
    // callback fall through to navigation.
    getShareExtensionKeyMock.mockImplementation(() => {
      throw new Error('native module not loaded');
    });
    expect(redirectSystemPath({ path: CALLBACK, initial: true })).toBe('');
  });

  // The OTA-preview link from a PR comment. Written with two slashes, `preview`
  // is the URL host rather than the first path segment, so Expo Router's prefix
  // stripping drops it and app/preview/[channel].tsx never matches.
  it('normalises the two-slash preview scheme link to the bare route path', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app://preview/pr-1234', initial: true })).toBe('/preview/pr-1234');
  });

  it('normalises the three-slash preview scheme link (what Linking.createURL emits)', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app:///preview/pr-1234', initial: false })).toBe(
      '/preview/pr-1234',
    );
  });

  it('leaves the universal-link form (already a bare path) untouched', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: '/preview/pr-1234', initial: true })).toBe('/preview/pr-1234');
  });

  it('normalises the preview link even when getShareExtensionKey throws', () => {
    getShareExtensionKeyMock.mockImplementation(() => {
      throw new Error('native module not loaded');
    });
    expect(redirectSystemPath({ path: 'com.boardsesh.app://preview/pr-1234', initial: true })).toBe('/preview/pr-1234');
  });

  it('does not rewrite a scheme link that merely starts with the word preview', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app://previews/pr-1234', initial: true })).toBe(
      'com.boardsesh.app://previews/pr-1234',
    );
  });

  it('does not treat a non-callback deep link on the same scheme as the callback', () => {
    getShareExtensionKeyMock.mockReturnValue('SHAREKEY');
    expect(redirectSystemPath({ path: 'com.boardsesh.app://join/some-session', initial: true })).toBe(
      'com.boardsesh.app://join/some-session',
    );
  });
});
