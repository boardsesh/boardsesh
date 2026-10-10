import { beforeEach, describe, expect, it, vi } from 'vitest';

const consent = vi.hoisted(() => ({ settled: false }));
vi.mock('../consent-state', () => ({ getConsentSnapshot: () => ({ settled: consent.settled }) }));

import { consumeConsentDestination, deferConsentDestination } from '../consent-navigation';

describe('deferConsentDestination', () => {
  beforeEach(() => {
    consent.settled = false;
    consumeConsentDestination();
  });

  // Expo Router hands `redirectSystemPath` the app's own root URL on every plain
  // cold start. It used to be stored as `//`, which the router treats as a
  // protocol-relative external link: once consent settled, the app opened a
  // blank Safari tab at `https://` on every launch.
  it.each([
    'com.boardsesh.app:///',
    'com.boardsesh.app://',
    '/',
    'https://www.boardsesh.com',
    'https://www.boardsesh.com/',
  ])('does not defer the root destination %s', (path) => {
    expect(deferConsentDestination(path)).toBe(false);
    expect(consumeConsentDestination()).toBeNull();
  });

  it.each([
    ['com.boardsesh.app://join/abc123', '/join/abc123'],
    ['com.boardsesh.app:///join/abc123', '/join/abc123'],
    ['com.boardsesh.app://b/kilter?angle=40', '/b/kilter?angle=40'],
    ['https://www.boardsesh.com/join/abc123?src=qr#top', '/join/abc123?src=qr#top'],
    ['https://www.boardsesh.com?src=qr', '/?src=qr'],
    ['/changelog', '/changelog'],
  ])('keeps the in-app route of %s', (path, destination) => {
    expect(deferConsentDestination(path)).toBe(true);
    expect(consumeConsentDestination()).toBe(destination);
  });

  it('never stores a destination Expo Router would open in the browser', () => {
    for (const path of ['com.boardsesh.app:///', 'com.boardsesh.app://join/x', 'https://www.boardsesh.com/a/b']) {
      deferConsentDestination(path);
      const destination = consumeConsentDestination();
      if (destination !== null) expect(destination.startsWith('//')).toBe(false);
    }
  });

  it('leaves auth and the consent step itself alone', () => {
    expect(deferConsentDestination('/privacy-consent')).toBe(false);
    expect(deferConsentDestination('/auth/login')).toBe(false);
    expect(deferConsentDestination('com.boardsesh.app://auth/callback?code=1')).toBe(false);
    // Three slashes is the same route; the check is on the route, not the link.
    expect(deferConsentDestination('com.boardsesh.app:///auth/callback?code=1')).toBe(false);
    expect(deferConsentDestination('com.boardsesh.app://privacy-consent')).toBe(false);
    expect(consumeConsentDestination()).toBeNull();
  });

  it('does not defer once consent has settled', () => {
    consent.settled = true;
    expect(deferConsentDestination('/join/abc123')).toBe(false);
    expect(consumeConsentDestination()).toBeNull();
  });

  it('keeps only the last destination and hands it out once', () => {
    deferConsentDestination('/join/first');
    deferConsentDestination('/join/second');
    expect(consumeConsentDestination()).toBe('/join/second');
    expect(consumeConsentDestination()).toBeNull();
  });
});
