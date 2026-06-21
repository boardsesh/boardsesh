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
});
