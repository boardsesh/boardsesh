import { describe, expect, it } from 'vite-plus/test';
import { AD_MEASUREMENT_COPY_SINCE, CONSENT_VERSION, type ConsentRecord } from '@boardsesh/consent';
import {
  isAdMeasurementPermitted,
  isAdPixelPath,
  parseMetaPixelId,
  parseRedditPixelId,
  resolveAdPixels,
  type AdPixelInput,
} from '../ad-pixels';

const META_ID = '123456789012345';
const REDDIT_ID = 'a2_abc123def';
const COPY_SINCE_MS = Date.parse(AD_MEASUREMENT_COPY_SINCE);
const AFTER_COPY = new Date(COPY_SINCE_MS + 1000).toISOString();
const BEFORE_COPY = new Date(COPY_SINCE_MS - 1000).toISOString();

function record(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return { analytics: 'granted', version: CONSENT_VERSION, decidedAt: AFTER_COPY, source: 'web', ...overrides };
}
const regionDefault = record({ basis: 'region_default', decidedAt: BEFORE_COPY });

function input(overrides: Partial<AdPixelInput> = {}): AdPixelInput {
  return {
    metaPixelId: META_ID,
    redditPixelId: REDDIT_ID,
    record: regionDefault,
    analyticsAuthorized: true,
    globalPrivacyControl: false,
    pathname: '/',
    hostname: 'www.boardsesh.com',
    ...overrides,
  };
}
const BOTH = { meta: META_ID, reddit: REDDIT_ID };
const NONE = { meta: null, reddit: null };

describe('isAdMeasurementPermitted (record-level consent table)', () => {
  it.each<[string, ConsentRecord | null, boolean, boolean]>([
    ['no answer', null, false, false],
    ['region default', regionDefault, false, true],
    // The website never writes a default under GPC; a stale one must not count either.
    ['region default + GPC', regionDefault, true, false],
    ['explicit web Allow on the copy date', record({ decidedAt: AD_MEASUREMENT_COPY_SINCE }), false, true],
    ['explicit web Allow after the copy date', record(), false, true],
    ['explicit web Allow before the copy date', record({ decidedAt: BEFORE_COPY }), false, false],
    ['explicit web Allow after the copy date + GPC', record(), true, false],
    ['explicit Allow from the iOS app', record({ source: 'ios' }), false, false],
    ['explicit Allow from the Android app', record({ source: 'android' }), false, false],
    ['explicit basis spelled out', record({ basis: 'explicit' }), false, true],
    ['explicit No thanks', record({ analytics: 'denied' }), false, false],
    ['outdated consent version', record({ version: CONSENT_VERSION - 1 }), false, false],
    ['unparseable decidedAt', record({ decidedAt: 'not-a-date' }), false, false],
  ])('%s', (_label, consent, gpc, expected) => {
    expect(isAdMeasurementPermitted(consent, gpc)).toBe(expected);
  });
});

describe('resolveAdPixels', () => {
  it('loads both pixels on a confirmed region default', () => {
    expect(resolveAdPixels(input())).toEqual(BOTH);
  });

  it('loads both pixels on a web Allow given after the copy date', () => {
    expect(resolveAdPixels(input({ record: record() }))).toEqual(BOTH);
  });

  it.each<[string, Partial<AdPixelInput>]>([
    ['no answer', { record: null }],
    ['region default + GPC', { globalPrivacyControl: true }],
    ['explicit Allow before the copy date', { record: record({ decidedAt: BEFORE_COPY }) }],
    ['explicit No thanks', { record: record({ analytics: 'denied' }) }],
    // Account still resolving, or the region lookup has not confirmed the default yet.
    ['analytics not yet authorized this page load', { analyticsAuthorized: false }],
    ['both ids unset', { metaPixelId: undefined, redditPixelId: undefined }],
    ['both ids empty', { metaPixelId: '', redditPixelId: '' }],
    ['both ids malformed', { metaPixelId: 'fb-123', redditPixelId: 'a2 abc' }],
    ['kiosk', { pathname: '/kiosk/some-gym' }],
    ['embed', { pathname: '/embed/board/abc' }],
    ['auth', { pathname: '/auth/login' }],
    ['admin', { pathname: '/admin' }],
    ['localized auth', { pathname: '/es/auth/login' }],
    ['upper-case embed', { pathname: '/EMBED/board/x' }],
    ['preview host', { hostname: 'pr-12.preview.boardsesh.com' }],
    ['localhost', { hostname: 'localhost' }],
    ['the browser app host', { hostname: 'app.boardsesh.com' }],
  ])('loads nothing: %s', (_label, overrides) => {
    expect(resolveAdPixels(input(overrides))).toEqual(NONE);
  });

  it('loads only the pixel whose id is set', () => {
    expect(resolveAdPixels(input({ redditPixelId: undefined }))).toEqual({ meta: META_ID, reddit: null });
    expect(resolveAdPixels(input({ metaPixelId: undefined }))).toEqual({ meta: null, reddit: REDDIT_ID });
  });
});

describe('pixel id validation', () => {
  it('accepts a numeric Meta id and trims whitespace', () => {
    expect(parseMetaPixelId(` ${META_ID} `)).toBe(META_ID);
  });
  it.each(['', '12345', 'abc123456', '123456789012345678901', '123 456', '1234567"><script>'])(
    'rejects Meta id %j',
    (raw) => {
      expect(parseMetaPixelId(raw)).toBeNull();
    },
  );
  it('accepts Reddit ids', () => {
    expect(parseRedditPixelId(REDDIT_ID)).toBe(REDDIT_ID);
    expect(parseRedditPixelId('t2_XyZ9')).toBe('t2_XyZ9');
  });
  it.each(['', 'abc', 'a2_', '_abc', 'a2_abc;alert(1)', "a2_abc'"])('rejects Reddit id %j', (raw) => {
    expect(parseRedditPixelId(raw)).toBeNull();
  });
});

describe('isAdPixelPath', () => {
  it.each(['/', '/gyms', '/es', '/es/gyms', '/kilter', '/kiosks-are-not-kiosk', '/authors'])('allows %s', (path) => {
    expect(isAdPixelPath(path)).toBe(true);
  });
  it.each([
    '/kiosk',
    '/kiosk/x',
    '/embed',
    '/embed/x',
    '/auth',
    '/auth/error',
    '/de/kiosk/x',
    '/fr/embed/x',
    '/DE/auth/x',
    '/Es/Embed/x',
    '/oauth/consent',
    '/it/oauth/sign-in',
    '/developers/apps',
    '/fr/Developers/Apps',
  ])('excludes %s', (path) => {
    expect(isAdPixelPath(path)).toBe(false);
  });
});
