import { describe, expect, it } from 'vite-plus/test';
import { NATIVE_OAUTH_CALLBACK_SCHEME } from '../auth/native-oauth-config';
import { NATIVE_APP_SCHEME, buildNativeBoardListUrl } from '../native-app-link';

describe('buildNativeBoardListUrl', () => {
  it("opens a public board's list in the app", () => {
    expect(buildNativeBoardListUrl('garage-wall', 40)).toBe('com.boardsesh.app://b/garage-wall/40/list');
  });

  it('carries the wall capability, which the app needs to open an unlisted Spraywall', () => {
    expect(buildNativeBoardListUrl('garage-wall', 40, 'ab12cd34ef56ab12cd34ef56ab12cd34')).toBe(
      'com.boardsesh.app://b/garage-wall/40/list?wall=ab12cd34ef56ab12cd34ef56ab12cd34',
    );
  });

  it('encodes a slug that would otherwise open a query or a fragment', () => {
    expect(buildNativeBoardListUrl('odd#slug?x', 25)).toBe('com.boardsesh.app://b/odd%23slug%3Fx/25/list');
  });

  it('uses the one scheme the OAuth callback uses too', () => {
    expect(NATIVE_APP_SCHEME).toBe('com.boardsesh.app');
    expect(NATIVE_OAUTH_CALLBACK_SCHEME).toBe('com.boardsesh.app://auth/callback');
  });
});
